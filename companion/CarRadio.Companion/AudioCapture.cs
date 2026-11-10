using System.Diagnostics;
using System.Text.Json;

namespace CarRadio.Companion;

/// <summary>A program that currently has a Windows audio session.</summary>
public sealed record AudioProgram(uint Pid, string Exe, bool Active)
{
    public override string ToString() => Active ? $"{Exe}  (playing)" : Exe;
}

/// <summary>
/// Captures one program's audio (and its child processes) through the bundled
/// appcapture.exe helper, which uses Windows process-loopback capture.
/// Delivers 48 kHz stereo 16-bit PCM, wall-clock paced (silence when quiet).
/// </summary>
public sealed class AudioCapture : IDisposable
{
    public const int SampleRate = 48000;
    public const int Channels = 2;

    static string HelperPath => Path.Combine(AppContext.BaseDirectory, "appcapture.exe");

    Process? _proc;
    CancellationTokenSource? _cts;

    /// <summary>Called with interleaved stereo samples as they arrive.</summary>
    public event Action<short[], int>? Samples;
    /// <summary>Peak level 0..1 roughly once a second.</summary>
    public event Action<float>? Level;
    /// <summary>Capture stopped (program closed, helper error, or Stop()).</summary>
    public event Action<string>? Stopped;

    public bool Running => _proc is { HasExited: false };
    public AudioProgram? Program { get; private set; }

    public static List<AudioProgram> ListPrograms()
    {
        var psi = new ProcessStartInfo(HelperPath, "--list")
        {
            RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("appcapture.exe did not start");
        var list = new List<AudioProgram>();
        string? line;
        while ((line = p.StandardOutput.ReadLine()) != null)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var r = doc.RootElement;
                var exe = r.GetProperty("exe").GetString() ?? "unknown";
                // The game itself and the Windows audio engine are never sensible sources.
                if (exe.Equals("audiodg.exe", StringComparison.OrdinalIgnoreCase) ||
                    exe.StartsWith("BeamNG", StringComparison.OrdinalIgnoreCase)) continue;
                list.Add(new AudioProgram(r.GetProperty("pid").GetUInt32(), exe, r.GetProperty("active").GetBoolean()));
            }
            catch (JsonException) { }
        }
        p.WaitForExit(3000);
        return list.OrderByDescending(x => x.Active).ThenBy(x => x.Exe, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public void Start(AudioProgram program)
    {
        Stop();
        Program = program;
        var psi = new ProcessStartInfo(HelperPath, $"--pid {program.Pid}")
        {
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            UseShellExecute = false, CreateNoWindow = true
        };
        _proc = Process.Start(psi) ?? throw new InvalidOperationException("appcapture.exe did not start");
        _cts = new CancellationTokenSource();
        var proc = _proc;
        var token = _cts.Token;

        // PCM reader: 20 ms blocks of interleaved s16.
        Task.Run(async () =>
        {
            var stream = proc.StandardOutput.BaseStream;
            var bytes = new byte[SampleRate / 50 * Channels * 2];
            var samples = new short[bytes.Length / 2];
            int fill = 0;
            try
            {
                while (!token.IsCancellationRequested)
                {
                    int n = await stream.ReadAsync(bytes.AsMemory(fill, bytes.Length - fill), token);
                    if (n <= 0) break;
                    fill += n;
                    if (fill < bytes.Length) continue;
                    Buffer.BlockCopy(bytes, 0, samples, 0, bytes.Length);
                    Samples?.Invoke(samples, samples.Length);
                    fill = 0;
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            Stopped?.Invoke(token.IsCancellationRequested ? "stopped" : "the program stopped or closed");
        }, token);

        // Status reader: JSON lines on stderr ("level", "error", ...).
        Task.Run(() =>
        {
            string? line;
            try
            {
                while ((line = proc.StandardError.ReadLine()) != null)
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(line);
                        var r = doc.RootElement;
                        var ev = r.GetProperty("event").GetString();
                        if (ev == "level" && r.TryGetProperty("peak", out var pk)) Level?.Invoke(pk.GetSingle());
                    }
                    catch (JsonException) { }
                }
            }
            catch (IOException) { }
        });
    }

    /// <summary>
    /// Quiet the program on this PC's speakers (to -60 dB) while capture continues at full
    /// quality: the helper scales the capture back up. Muting is not used because Windows
    /// mutes the capture too. Volumes are restored on Unduck/Stop, and after a crash on the next run.
    /// </summary>
    public void SetDucked(bool ducked)
    {
        if (_proc is not { HasExited: false } p) return;
        try { p.StandardInput.WriteLine(ducked ? "duck 0.001" : "unduck"); p.StandardInput.Flush(); } catch { }
    }

    public void Stop()
    {
        _cts?.Cancel();
        if (_proc is { HasExited: false } p)
        {
            // Closing stdin lets the helper stop cleanly; kill only if it does not.
            try { p.StandardInput.Close(); } catch { }
            if (!p.WaitForExit(1500)) { try { p.Kill(); } catch { } }
        }
        _proc?.Dispose();
        _proc = null;
        Program = null;
    }

    public void Dispose() => Stop();
}
