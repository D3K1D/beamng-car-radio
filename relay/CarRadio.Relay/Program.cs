// CarRadio relay: forwards car-radio audio between players' companions.
// See protocol/multiplayer.md. Run next to the BeamMP server:
//   CarRadioRelay --port 38800 --secret <passcode>
// The passcode must match the BeamMP plugin's config. Plain TCP, no external dependencies.
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

var port = 38800;
string? secret = null;
string? configPath = null;
for (int i = 0; i < args.Length - 1; i++)
{
    if (args[i] == "--port") port = int.Parse(args[i + 1]);
    if (args[i] == "--secret") secret = args[i + 1];
    if (args[i] == "--config") configPath = args[i + 1];
}
// The BeamMP plugin's carradio.json holds the same passcode; reading it keeps them in sync.
if (configPath != null)
{
    try
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
        var root = doc.RootElement;
        if (root.TryGetProperty("relay_port", out var p) && p.TryGetInt32(out var pp)) port = pp;
        if (secret == null && root.TryGetProperty("secret", out var s)) secret = s.GetString();
    }
    catch (Exception ex) { Console.Error.WriteLine($"could not read {configPath}: {ex.Message}"); return 2; }
}
secret ??= Environment.GetEnvironmentVariable("CARRADIO_SECRET");
if (string.IsNullOrWhiteSpace(secret) || secret.Length < 8 || secret.Contains("change", StringComparison.OrdinalIgnoreCase))
{
    Console.Error.WriteLine("Set a passcode of at least 8 characters: CarRadioRelay --config Resources/Server/CarRadio/carradio.json");
    Console.Error.WriteLine("(or --secret <passcode>, or the CARRADIO_SECRET environment variable)");
    return 2;
}

var relay = new Relay(secret);
var listener = new TcpListener(IPAddress.Any, port);
listener.Start();
Relay.Log($"CarRadio relay {Relay.Version} listening on TCP {port}");
Console.CancelKeyPress += (_, e) => { e.Cancel = true; listener.Stop(); };
while (true)
{
    TcpClient tcp;
    try { tcp = await listener.AcceptTcpClientAsync(); }
    catch { break; }
    _ = relay.Serve(tcp);
}
Relay.Log("stopped");
return 0;

sealed class Relay(string secret)
{
    public const string Version = "0.1.2";
    const int Proto = 1;
    const byte Join = 0x20, Audio = 0x21, Welcome = 0x22, Error = 0x23, Key = 0x24;
    const int MaxFrame = 65536;
    const int QueueLimit = 50; // ~1 s of 20 ms packets per sending car before old ones are dropped

    readonly ConcurrentDictionary<Peer, byte> _peers = new();

    public static void Log(string msg) => Console.WriteLine($"{DateTime.Now:HH:mm:ss} {msg}");

    sealed class Peer(TcpClient tcp)
    {
        public readonly TcpClient Tcp = tcp;
        public readonly Channel<byte[]> Out = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(QueueLimit * 8)
            { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
        public string Key = "";
        public readonly string Address = tcp.Client.RemoteEndPoint?.ToString() ?? "?";
    }

    public async Task Serve(TcpClient tcp)
    {
        tcp.NoDelay = true;
        var peer = new Peer(tcp);
        var stream = tcp.GetStream();
        var writer = Task.Run(() => WriteLoop(peer, stream));
        bool joined = false;
        try
        {
            var header = new byte[4];
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (true)
            {
                var token = joined ? CancellationToken.None : timeout.Token; // must JOIN within 10 s
                await stream.ReadExactlyAsync(header, token);
                int len = BitConverter.ToInt32(header);
                if (len < 1 || len > MaxFrame) break;
                var body = new byte[len];
                await stream.ReadExactlyAsync(body, token);
                byte type = body[0];
                if (!joined)
                {
                    if (type != Join) break;
                    using var doc = JsonDocument.Parse(body.AsMemory(1));
                    var root = doc.RootElement;
                    int proto = root.TryGetProperty("proto", out var p) ? p.GetInt32() : 0;
                    string given = root.TryGetProperty("secret", out var s) ? s.GetString() ?? "" : "";
                    if (proto != Proto) { Send(peer, Error, Json(new { error = $"relay speaks protocol {Proto}, client {proto}" })); break; }
                    if (!CryptoEquals(given, secret)) { Send(peer, Error, Json(new { error = "bad secret" })); Log($"{peer.Address} rejected: bad secret"); break; }
                    peer.Key = root.TryGetProperty("key", out var k) ? Sanitize(k.GetString()) : "";
                    joined = true;
                    _peers[peer] = 0;
                    Send(peer, Welcome, Json(new { proto = Proto, peers = _peers.Count - 1 }));
                    Log($"{peer.Address} joined as '{peer.Key}' ({_peers.Count} connected)");
                }
                else if (type == Key)
                {
                    peer.Key = Sanitize(Encoding.ASCII.GetString(body, 1, len - 1));
                }
                else if (type == Audio && peer.Key.Length > 0 && len > 2)
                {
                    int keyLen = body[1];
                    int rest = len - 2 - keyLen; // seq + opus
                    if (rest < 5) continue;
                    // Rebuild with the sender's registered key: clients cannot impersonate others.
                    var key = Encoding.ASCII.GetBytes(peer.Key);
                    var frame = new byte[4 + 1 + 1 + key.Length + rest];
                    BitConverter.TryWriteBytes(frame.AsSpan(0, 4), frame.Length - 4);
                    frame[4] = Audio;
                    frame[5] = (byte)key.Length;
                    key.CopyTo(frame, 6);
                    Buffer.BlockCopy(body, 2 + keyLen, frame, 6 + key.Length, rest);
                    foreach (var other in _peers.Keys)
                        if (other != peer) other.Out.Writer.TryWrite(frame);
                }
            }
        }
        catch { }
        finally
        {
            if (_peers.TryRemove(peer, out _)) Log($"{peer.Address} left ({_peers.Count} connected)");
            peer.Out.Writer.TryComplete();
            await Task.WhenAny(writer, Task.Delay(2000)); // flush e.g. the ERROR frame before closing
            try { tcp.Close(); } catch { }
        }
    }

    static async Task WriteLoop(Peer peer, NetworkStream stream)
    {
        try { await foreach (var frame in peer.Out.Reader.ReadAllAsync()) await stream.WriteAsync(frame); }
        catch { }
    }

    static void Send(Peer peer, byte type, byte[] payload)
    {
        var frame = new byte[5 + payload.Length];
        BitConverter.TryWriteBytes(frame.AsSpan(0, 4), 1 + payload.Length);
        frame[4] = type;
        payload.CopyTo(frame, 5);
        peer.Out.Writer.TryWrite(frame);
    }

    static byte[] Json(object o) => JsonSerializer.SerializeToUtf8Bytes(o);

    // Keys are BeamMP server vehicle IDs like "3-0"; anything else is cut down to that alphabet.
    static string Sanitize(string? key) =>
        new string((key ?? "").Where(c => char.IsAsciiDigit(c) || c == '-').Take(24).ToArray());

    static bool CryptoEquals(string a, string b) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}
