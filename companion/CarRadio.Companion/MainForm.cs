using System.Diagnostics;

namespace CarRadio.Companion;

/// <summary>
/// Small control window: pick the program to play through the car, start/stop,
/// see whether BeamNG is connected and that sound is arriving.
/// </summary>
public sealed class MainForm : Form
{
    readonly ComboBox _programs = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 250 };
    readonly Button _refresh = new() { Text = "↻", Width = 34 };
    readonly Button _startStop = new() { Text = "Start", Width = 90, Height = 30 };
    readonly Label _gameStatus = new() { AutoSize = true, Text = "BeamNG: waiting for the game…" };
    readonly Label _sourceStatus = new() { AutoSize = true, Text = "Not capturing" };
    readonly ProgressBar _meter = new() { Width = 290, Height = 10, Maximum = 100 };
    readonly CheckBox _duck = new() { AutoSize = true, Checked = true, Text = "Silence the program on my speakers while in game" };
    readonly NotifyIcon _tray = new();

    readonly AudioCapture _capture = new();
    readonly OpusStream _opus = new();
    readonly GameLink _link = new();
    readonly RelayClient _relay = new();
    readonly Label _mpStatus = new() { AutoSize = true, Text = "Multiplayer: not on a CarRadio server" };
    float _level;
    readonly System.Windows.Forms.Timer _statusTimer = new() { Interval = 500 };

    public MainForm()
    {
        Text = $"CarRadio Companion {AppInfo.Version}";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ClientSize = new Size(330, 210);
        Font = new Font("Segoe UI", 9f);
        Icon = SystemIcons.Application;

        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(12), WrapContents = false };
        var pickRow = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0) };
        pickRow.Controls.AddRange(new Control[] { _programs, _refresh });
        layout.Controls.Add(new Label { AutoSize = true, Text = "Play this program through your car:" });
        layout.Controls.Add(pickRow);
        layout.Controls.Add(_startStop);
        layout.Controls.Add(_meter);
        layout.Controls.Add(_sourceStatus);
        layout.Controls.Add(_gameStatus);
        layout.Controls.Add(_mpStatus);
        layout.Controls.Add(_duck);
        Controls.Add(layout);

        _tray.Icon = Icon;
        _tray.Text = "CarRadio Companion";
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        _tray.ContextMenuStrip = new ContextMenuStrip();
        _tray.ContextMenuStrip.Items.Add("Open", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; });
        _tray.ContextMenuStrip.Items.Add("Quit", null, (_, _) => Close());
        Resize += (_, _) => { if (WindowState == FormWindowState.Minimized) Hide(); };

        _refresh.Click += (_, _) => RefreshPrograms();
        _startStop.Click += (_, _) => ToggleCapture();
        _duck.CheckedChanged += (_, _) => UpdateDuck();

        _capture.Samples += (s, n) => _opus.Encode(s, n);
        _capture.Level += l => _level = l;
        _capture.Stopped += reason => BeginInvoke(() => OnCaptureStopped(reason));
        _opus.Packet += (seq, pkt, len) => { _link.SendOpus(seq, pkt, len); _relay.SendOwn(seq, pkt, len); };
        _link.SessionChanged += (relay, secret, key) => _relay.SetSession(relay, secret, key);
        _relay.RemotePacket += (key, seq, buf, off, len) => _link.SendRemote(key, seq, buf, off, len);
        _relay.Status += json =>
        {
            _link.SendRelayStatus(json);
            BeginInvoke(() => _mpStatus.Text = "Multiplayer: " + _relay.State switch
            {
                "connected" => "connected to the server's radio relay",
                "connecting" => "connecting to the radio relay…",
                "rejected" => "relay refused the connection (passcode/version)",
                "error" => "relay unreachable, retrying…",
                _ => "not on a CarRadio server",
            });
        };
        _link.ConnectionChanged += c => BeginInvoke(() =>
        {
            _gameStatus.Text = c
                ? $"BeamNG: connected{(_link.GameVersion != null ? " (mod " + _link.GameVersion + ")" : "")}"
                : "BeamNG: waiting for the game…";
            UpdateDuck();
        });

        _statusTimer.Tick += (_, _) =>
        {
            _meter.Value = Math.Clamp((int)(_level * 100), 0, 100);
            _link.SendStatus(_capture.Program?.Exe, _capture.Running, _level);
        };

        Load += (_, _) =>
        {
            try { _link.Start(); }
            catch (Exception ex)
            {
                MessageBox.Show(this, $"Could not open the game link on port {GameLink.Port}.\nIs another copy of the companion running?\n\n{ex.Message}",
                    "CarRadio Companion", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
            _statusTimer.Start();
            RefreshPrograms();
        };
        FormClosing += (_, _) =>
        {
            _statusTimer.Stop();
            _capture.Dispose();
            _relay.Dispose();
            _link.Dispose();
            _tray.Visible = false;
        };
    }

    void RefreshPrograms()
    {
        var selected = (_programs.SelectedItem as AudioProgram)?.Exe ?? Settings.LastProgram;
        _programs.Items.Clear();
        try
        {
            foreach (var p in AudioCapture.ListPrograms()) _programs.Items.Add(p);
        }
        catch (Exception ex)
        {
            _sourceStatus.Text = "Could not list programs: " + ex.Message;
            return;
        }
        var match = _programs.Items.Cast<AudioProgram>().FirstOrDefault(p => p.Exe.Equals(selected, StringComparison.OrdinalIgnoreCase));
        if (match != null) _programs.SelectedItem = match;
        else if (_programs.Items.Count > 0) _programs.SelectedIndex = 0;
        if (_programs.Items.Count == 0) _sourceStatus.Text = "No programs are playing sound. Start your music, then press ↻.";
    }

    void ToggleCapture()
    {
        if (_capture.Running) { _capture.Stop(); return; }
        if (_programs.SelectedItem is not AudioProgram p) { RefreshPrograms(); return; }
        try
        {
            _capture.Start(p);
            UpdateDuck();
            Settings.LastProgram = p.Exe;
            _startStop.Text = "Stop";
            _programs.Enabled = _refresh.Enabled = false;
            _sourceStatus.Text = $"Capturing {p.Exe}";
        }
        catch (Exception ex) { _sourceStatus.Text = "Could not start capture: " + ex.Message; }
    }

    void OnCaptureStopped(string reason)
    {
        _startStop.Text = "Start";
        _programs.Enabled = _refresh.Enabled = true;
        _sourceStatus.Text = reason == "stopped" ? "Not capturing" : $"Capture ended: {reason}";
        _level = 0;
    }

    // Quiet the captured program on the speakers only while the game is actually playing it.
    void UpdateDuck() => _capture.SetDucked(_duck.Checked && _link.Connected && _capture.Running);
}

static class Settings
{
    static string File => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CarRadio", "last-program.txt");
    public static string? LastProgram
    {
        get { try { return System.IO.File.ReadAllText(File).Trim(); } catch { return null; } }
        set { try { Directory.CreateDirectory(Path.GetDirectoryName(File)!); System.IO.File.WriteAllText(File, value ?? ""); } catch { } }
    }
}
