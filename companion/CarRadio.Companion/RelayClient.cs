using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace CarRadio.Companion;

/// <summary>
/// Connection to the server's CarRadio relay (protocol/multiplayer.md). Sends this
/// player's Opus packets under its car key and receives other players' packets.
/// Reconnects automatically while a session is set.
/// </summary>
public sealed class RelayClient : IDisposable
{
    const int Proto = 1;
    const byte Join = 0x20, Audio = 0x21, Welcome = 0x22, Error = 0x23, Key = 0x24;

    readonly object _lock = new();
    string? _host; int _port; string _secret = ""; string _key = "";
    TcpClient? _tcp; NetworkStream? _stream;
    CancellationTokenSource? _cts;
    readonly byte[] _frame = new byte[4 + 1 + 1 + 32 + 4 + 4000];

    /// <summary>(key, seq, packet, offset, length) from another player.</summary>
    public event Action<string, uint, byte[], int, int>? RemotePacket;
    /// <summary>JSON status for the game: connected/peers or error.</summary>
    public event Action<string>? Status;

    public string State { get; private set; } = "off";

    /// <summary>Set or clear the session (from the game's SESSION message).</summary>
    public void SetSession(string? relay, string? secret, string? key)
    {
        string? host = null; int port = 38800;
        if (!string.IsNullOrWhiteSpace(relay))
        {
            var i = relay.LastIndexOf(':');
            host = i > 0 ? relay[..i] : relay;
            if (i > 0) int.TryParse(relay[(i + 1)..], out port);
        }
        lock (_lock)
        {
            bool sameServer = host == _host && port == _port && (secret ?? "") == _secret;
            if (sameServer && host != null)
            {
                if ((key ?? "") != _key) { _key = key ?? ""; SendFrame(Key, Encoding.ASCII.GetBytes(_key)); }
                return;
            }
            Disconnect();
            _host = host; _port = port; _secret = secret ?? ""; _key = key ?? "";
            if (host == null) { SetState("off", null); return; }
            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            Task.Run(() => RunLoop(token));
        }
    }

    async Task RunLoop(CancellationToken token)
    {
        int delay = 1000;
        while (!token.IsCancellationRequested)
        {
            try
            {
                SetState("connecting", null);
                // Try the server's public address first; if that fails, try this PC. Hosts who
                // play on the server machine often can't reach their own public IP (no NAT loopback).
                TcpClient? tcp = null;
                foreach (var host in new[] { _host!, "127.0.0.1" }.Distinct())
                {
                    var attempt = new TcpClient { NoDelay = true };
                    try
                    {
                        using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                        connectTimeout.CancelAfter(host == "127.0.0.1" ? 1000 : 5000);
                        await attempt.ConnectAsync(host, _port, connectTimeout.Token);
                        tcp = attempt;
                        break;
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { attempt.Dispose(); throw; }
                    catch { attempt.Dispose(); }
                }
                if (tcp == null) throw new IOException($"cannot reach the relay at {_host}:{_port}");
                var stream = tcp.GetStream();
                lock (_lock) { _tcp = tcp; _stream = stream; }
                SendFrame(Join, JsonSerializer.SerializeToUtf8Bytes(new { proto = Proto, secret = _secret, key = _key }));
                delay = 1000;
                await ReadLoop(stream, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception ex) { SetState("error", ex.Message); }
            lock (_lock) { try { _tcp?.Close(); } catch { } _tcp = null; _stream = null; }
            if (State == "rejected") break; // wrong secret/protocol: don't hammer the relay
            try { await Task.Delay(delay, token); } catch { break; }
            delay = Math.Min(delay * 2, 15000);
        }
    }

    async Task ReadLoop(NetworkStream stream, CancellationToken token)
    {
        var header = new byte[4];
        var body = new byte[65536];
        while (!token.IsCancellationRequested)
        {
            await stream.ReadExactlyAsync(header, token);
            int len = BitConverter.ToInt32(header);
            if (len < 1 || len > body.Length) throw new IOException("bad frame from relay");
            await stream.ReadExactlyAsync(body.AsMemory(0, len), token);
            switch (body[0])
            {
                case Welcome:
                    using (var doc = JsonDocument.Parse(body.AsMemory(1, len - 1)))
                        SetState("connected", null, doc.RootElement.TryGetProperty("peers", out var p) ? p.GetInt32() : 0);
                    break;
                case Error:
                    using (var doc = JsonDocument.Parse(body.AsMemory(1, len - 1)))
                        SetState("rejected", doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : "rejected");
                    return;
                case Audio:
                    int keyLen = body[1];
                    if (len < 2 + keyLen + 5) break;
                    var key = Encoding.ASCII.GetString(body, 2, keyLen);
                    uint seq = BitConverter.ToUInt32(body, 2 + keyLen);
                    int opusOffset = 2 + keyLen + 4;
                    RemotePacket?.Invoke(key, seq, body, opusOffset, len - opusOffset);
                    break;
            }
        }
    }

    /// <summary>Send this player's packet to the relay (ignored when not connected or not broadcasting).</summary>
    public void SendOwn(uint seq, byte[] packet, int length)
    {
        lock (_lock)
        {
            if (_stream == null || _key.Length == 0 || State != "connected") return;
            var key = Encoding.ASCII.GetBytes(_key);
            int body = 1 + 1 + key.Length + 4 + length;
            BitConverter.TryWriteBytes(_frame.AsSpan(0, 4), body);
            _frame[4] = Audio;
            _frame[5] = (byte)key.Length;
            key.CopyTo(_frame, 6);
            BitConverter.TryWriteBytes(_frame.AsSpan(6 + key.Length, 4), seq);
            Buffer.BlockCopy(packet, 0, _frame, 10 + key.Length, length);
            try { _stream.Write(_frame, 0, 4 + body); } catch { try { _tcp?.Close(); } catch { } }
        }
    }

    void SendFrame(byte type, byte[] payload)
    {
        lock (_lock)
        {
            if (_stream == null) return;
            var buf = new byte[5 + payload.Length];
            BitConverter.TryWriteBytes(buf.AsSpan(0, 4), 1 + payload.Length);
            buf[4] = type;
            payload.CopyTo(buf, 5);
            try { _stream.Write(buf); } catch { try { _tcp?.Close(); } catch { } }
        }
    }

    void SetState(string state, string? error, int peers = 0)
    {
        State = state;
        Status?.Invoke(JsonSerializer.Serialize(new { state, error, peers, relay = _host == null ? null : $"{_host}:{_port}" }));
    }

    void Disconnect()
    {
        _cts?.Cancel();
        _cts = null;
        try { _tcp?.Close(); } catch { }
        _tcp = null; _stream = null;
    }

    public void Dispose() { lock (_lock) Disconnect(); }
}
