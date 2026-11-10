using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace CarRadio.Companion;

/// <summary>
/// Loopback TCP link to the game's Lua (see protocol/companion-link.md).
/// Listens on 127.0.0.1:38742; one game connection at a time.
/// </summary>
public sealed class GameLink : IDisposable
{
    public const int Port = 38742;
    public const int Proto = 1;

    const byte HelloOut = 0x01, Opus = 0x02, Status = 0x03, Remote = 0x04, RelayState = 0x05, HelloIn = 0x10, Session = 0x11;

    /// <summary>(relay "host:port" or null, secret, key) from the game's SESSION message.</summary>
    public event Action<string?, string?, string?>? SessionChanged;

    readonly TcpListener _listener = new(IPAddress.Loopback, Port);
    readonly object _lock = new();
    TcpClient? _client;
    NetworkStream? _stream;
    readonly CancellationTokenSource _cts = new();
    readonly byte[] _frame = new byte[4 + 1 + 4 + 4000];

    public event Action<bool>? ConnectionChanged;
    public bool Connected { get { lock (_lock) return _client != null; } }
    public string? GameVersion { get; private set; }

    public void Start()
    {
        _listener.Start();
        Task.Run(AcceptLoop);
    }

    async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
            catch { break; }
            client.NoDelay = true;
            lock (_lock)
            {
                CloseClient();
                _client = client;
                _stream = client.GetStream();
            }
            SendJson(HelloOut, new { proto = Proto, app = "CarRadio Companion", version = AppInfo.Version });
            ConnectionChanged?.Invoke(true);
            _ = Task.Run(() => ReadLoop(client));
        }
    }

    async Task ReadLoop(TcpClient client)
    {
        var stream = client.GetStream();
        var header = new byte[4];
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                await stream.ReadExactlyAsync(header, _cts.Token);
                int len = BitConverter.ToInt32(header, 0);
                if (len < 1 || len > 65536) break;
                var body = new byte[len];
                await stream.ReadExactlyAsync(body, _cts.Token);
                if (body[0] == HelloIn)
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(body.AsMemory(1));
                        GameVersion = doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() : null;
                        if (doc.RootElement.TryGetProperty("proto", out var p) && p.GetInt32() != Proto) break;
                    }
                    catch (JsonException) { }
                }
                else if (body[0] == Session)
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(body.AsMemory(1));
                        var r = doc.RootElement;
                        string? Str(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                        SessionChanged?.Invoke(Str("relay"), Str("secret"), Str("key"));
                    }
                    catch (JsonException) { }
                }
            }
        }
        catch { }
        lock (_lock) { if (_client == client) CloseClient(); }
        SessionChanged?.Invoke(null, null, null); // game gone: leave the relay
        ConnectionChanged?.Invoke(false);
    }

    public void SendOpus(uint seq, byte[] packet, int length)
    {
        lock (_lock)
        {
            if (_stream == null) return;
            int body = 1 + 4 + length;
            BitConverter.TryWriteBytes(_frame.AsSpan(0, 4), body);
            _frame[4] = Opus;
            BitConverter.TryWriteBytes(_frame.AsSpan(5, 4), seq);
            Buffer.BlockCopy(packet, 0, _frame, 9, length);
            Write(_frame, 4 + body);
        }
    }

    public void SendStatus(string? source, bool capturing, float level) =>
        SendJson(Status, new { source, capturing, level });

    readonly byte[] _remoteFrame = new byte[4 + 1 + 1 + 32 + 4 + 4000];

    /// <summary>Forward another player's Opus packet (same layout as relay AUDIO).</summary>
    public void SendRemote(string key, uint seq, byte[] buf, int offset, int length)
    {
        lock (_lock)
        {
            if (_stream == null || key.Length > 32 || length > 4000) return;
            int body = 1 + 1 + key.Length + 4 + length;
            BitConverter.TryWriteBytes(_remoteFrame.AsSpan(0, 4), body);
            _remoteFrame[4] = Remote;
            _remoteFrame[5] = (byte)key.Length;
            Encoding.ASCII.GetBytes(key, 0, key.Length, _remoteFrame, 6);
            BitConverter.TryWriteBytes(_remoteFrame.AsSpan(6 + key.Length, 4), seq);
            Buffer.BlockCopy(buf, offset, _remoteFrame, 10 + key.Length, length);
            Write(_remoteFrame, 4 + body);
        }
    }

    public void SendRelayStatus(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var buf = new byte[5 + bytes.Length];
        BitConverter.TryWriteBytes(buf.AsSpan(0, 4), 1 + bytes.Length);
        buf[4] = RelayState;
        bytes.CopyTo(buf, 5);
        lock (_lock) { if (_stream != null) Write(buf, buf.Length); }
    }

    void SendJson(byte type, object value)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(value);
        var buf = new byte[5 + json.Length];
        BitConverter.TryWriteBytes(buf.AsSpan(0, 4), 1 + json.Length);
        buf[4] = type;
        json.CopyTo(buf, 5);
        lock (_lock) { if (_stream != null) Write(buf, buf.Length); }
    }

    void Write(byte[] buf, int count)
    {
        try { _stream!.Write(buf, 0, count); }
        catch { CloseClient(); ConnectionChanged?.Invoke(false); }
    }

    void CloseClient()
    {
        try { _client?.Close(); } catch { }
        _client = null;
        _stream = null;
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }
        lock (_lock) CloseClient();
    }
}

static class AppInfo
{
    public static string Version => typeof(AppInfo).Assembly.GetName().Version?.ToString(3) ?? "0.1.0";
}
