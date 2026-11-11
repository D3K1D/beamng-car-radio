using System.Runtime.InteropServices;
using Windows.Media.Control;

namespace CarRadio.Companion;

/// <summary>
/// Play/pause/next/previous and now-playing info for the captured program, through
/// Windows' media sessions (the same controls as the volume pop-up). Targets the session
/// whose app matches the captured exe; falls back to the global media keys.
/// </summary>
public sealed class MediaControl
{
    GlobalSystemMediaTransportControlsSessionManager? _manager;

    public string? Title { get; private set; }
    public string? Artist { get; private set; }
    public bool? Playing { get; private set; }

    public async Task InitAsync()
    {
        try { _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync(); }
        catch { _manager = null; } // media sessions unavailable: media keys still work
    }

    GlobalSystemMediaTransportControlsSession? SessionFor(string? exe)
    {
        if (_manager == null || string.IsNullOrEmpty(exe)) return null;
        var name = Path.GetFileNameWithoutExtension(exe);
        // Win32 apps report their exe name (e.g. "chrome.exe", "Spotify.exe"); Store apps an AUMID containing the name.
        foreach (var s in _manager.GetSessions())
            if (s.SourceAppUserModelId.Contains(name, StringComparison.OrdinalIgnoreCase)) return s;
        return null;
    }

    /// <summary>cmd: "playpause", "next" or "prev".</summary>
    public async Task CommandAsync(string cmd, string? exe)
    {
        var s = SessionFor(exe);
        bool done = false;
        try
        {
            if (s != null)
                done = cmd switch
                {
                    "playpause" => await s.TryTogglePlayPauseAsync(),
                    "next" => await s.TrySkipNextAsync(),
                    "prev" => await s.TrySkipPreviousAsync(),
                    _ => true,
                };
        }
        catch { done = false; }
        if (!done) SendMediaKey(cmd);
    }

    /// <summary>Refresh title/artist/playing for the captured program.</summary>
    public async Task RefreshAsync(string? exe)
    {
        var s = SessionFor(exe);
        if (s == null) { Title = Artist = null; Playing = null; return; }
        try
        {
            var p = await s.TryGetMediaPropertiesAsync();
            Title = string.IsNullOrWhiteSpace(p?.Title) ? null : p!.Title;
            Artist = string.IsNullOrWhiteSpace(p?.Artist) ? null : p!.Artist;
            Playing = s.GetPlaybackInfo()?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        }
        catch { Title = Artist = null; Playing = null; }
    }

    // ---- fallback: the keyboard's media keys
    const ushort VK_MEDIA_NEXT = 0xB0, VK_MEDIA_PREV = 0xB1, VK_MEDIA_PLAY_PAUSE = 0xB3;

    static void SendMediaKey(string cmd)
    {
        ushort vk = cmd switch { "next" => VK_MEDIA_NEXT, "prev" => VK_MEDIA_PREV, _ => VK_MEDIA_PLAY_PAUSE };
        var inputs = new INPUT[2];
        inputs[0].type = 1; inputs[0].ki.wVk = vk;
        inputs[1].type = 1; inputs[1].ki.wVk = vk; inputs[1].ki.dwFlags = 2; // KEYEVENTF_KEYUP
        SendInput(2, inputs, Marshal.SizeOf<INPUT>());
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] inputs, int size);
}
