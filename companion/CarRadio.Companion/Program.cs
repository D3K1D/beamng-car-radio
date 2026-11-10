namespace CarRadio.Companion;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // Headless mode for testing / power users: CarRadioCompanion --headless chrome.exe [seconds]
        int h = Array.IndexOf(args, "--headless");
        if (h >= 0 && h + 1 < args.Length) { Headless(args[h + 1], h + 2 < args.Length ? int.Parse(args[h + 2]) : 0); return; }

        // One companion per user session: the game link port can only be owned once.
        using var single = new Mutex(true, @"Local\CarRadioCompanion", out bool first);
        if (!first)
        {
            MessageBox.Show("CarRadio Companion is already running (check the system tray).", "CarRadio Companion");
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }

    static void Headless(string exe, int seconds)
    {
        var program = AudioCapture.ListPrograms().FirstOrDefault(p => p.Exe.Equals(exe, StringComparison.OrdinalIgnoreCase))
                      ?? throw new InvalidOperationException($"{exe} has no audio session");
        using var link = new GameLink();
        using var relay = new RelayClient();
        using var capture = new AudioCapture();
        var opus = new OpusStream();
        capture.Samples += (s, n) => opus.Encode(s, n);
        opus.Packet += (seq, pkt, len) => { link.SendOpus(seq, pkt, len); relay.SendOwn(seq, pkt, len); };
        link.SessionChanged += (r, s, k) => relay.SetSession(r, s, k);
        relay.RemotePacket += (key, seq, buf, off, len) => link.SendRemote(key, seq, buf, off, len);
        relay.Status += json => { link.SendRelayStatus(json); Console.WriteLine("relay: " + json); };
        link.Start();
        capture.Start(program);
        link.ConnectionChanged += c => capture.SetDucked(c);
        if (seconds > 0) Thread.Sleep(seconds * 1000); else Thread.Sleep(Timeout.Infinite);
    }
}
