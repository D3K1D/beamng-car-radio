// appcapture: capture one program's audio (and its child processes) on Windows.
//
//   appcapture --list                 list programs that have audio sessions (JSON lines)
//   appcapture --pid N [--mute]       write 48 kHz stereo s16le PCM to stdout until stdin closes
//
// Uses the documented process-loopback activation (Windows 10 2004 / Windows 11).
// The output is wall-clock paced: silence is inserted when the program is quiet,
// so downstream encoders see a continuous stream. --mute mutes the program's own
// audio sessions while capturing and restores their previous state on exit.
// Status lines go to stderr as JSON.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <fcntl.h>
#include <io.h>
#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <vector>

// ---- process-loopback activation types (audioclientactivationparams.h is absent in MinGW) ----
enum AUDIOCLIENT_ACTIVATION_TYPE_ { ACT_TYPE_DEFAULT = 0, ACT_TYPE_PROCESS_LOOPBACK = 1 };
enum PROCESS_LOOPBACK_MODE_ { LOOPBACK_INCLUDE_TREE = 0, LOOPBACK_EXCLUDE_TREE = 1 };
struct PROCESS_LOOPBACK_PARAMS_ { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE_ Mode; };
struct ACTIVATION_PARAMS_ { AUDIOCLIENT_ACTIVATION_TYPE_ ActivationType; PROCESS_LOOPBACK_PARAMS_ Loopback; };
static const wchar_t *kProcessLoopbackDevice = L"VAD\\Process_Loopback";
static const GUID kIID_IAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

static const int kRate = 48000, kChannels = 2, kBytesPerFrame = 4;

static void status(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap); fputc('\n', stderr); fflush(stderr);
}

static std::string narrow(const std::wstring &w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::string jsonEscape(const std::string &s) {
  std::string o;
  for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if ((unsigned char)c < 0x20) o += ' '; else o += c; }
  return o;
}

// ---- process tree helpers ----
struct ProcInfo { DWORD parent; std::wstring exe; };
static std::map<DWORD, ProcInfo> snapshotProcesses() {
  std::map<DWORD, ProcInfo> m;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return m;
  PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) m[pe.th32ProcessID] = {pe.th32ParentProcessID, pe.szExeFile};
  CloseHandle(snap);
  return m;
}

// Walk up while the parent runs the same executable (e.g. chrome.exe audio service -> browser root).
static DWORD rootOf(DWORD pid, const std::map<DWORD, ProcInfo> &procs) {
  auto it = procs.find(pid);
  if (it == procs.end()) return pid;
  DWORD cur = pid;
  for (int guard = 0; guard < 32; ++guard) {
    auto c = procs.find(cur);
    auto p = procs.find(c->second.parent);
    if (p == procs.end() || _wcsicmp(p->second.exe.c_str(), it->second.exe.c_str()) != 0) break;
    cur = c->second.parent;
  }
  return cur;
}

static bool inTree(DWORD pid, DWORD root, const std::map<DWORD, ProcInfo> &procs) {
  for (int guard = 0; guard < 64 && pid; ++guard) {
    if (pid == root) return true;
    auto it = procs.find(pid);
    if (it == procs.end()) return false;
    pid = it->second.parent;
  }
  return false;
}

// ---- audio session enumeration across all active render devices ----
struct SessionRef { DWORD pid; AudioSessionState state; ISimpleAudioVolume *volume; std::wstring device; std::wstring instance; };

static std::vector<SessionRef> enumerateSessions() {
  std::vector<SessionRef> out;
  IMMDeviceEnumerator *en = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en))) return out;
  IMMDeviceCollection *devices = nullptr;
  if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
    UINT count = 0; devices->GetCount(&count);
    for (UINT d = 0; d < count; ++d) {
      IMMDevice *dev = nullptr; if (FAILED(devices->Item(d, &dev))) continue;
      LPWSTR devId = nullptr; dev->GetId(&devId);
      IAudioSessionManager2 *mgr = nullptr;
      if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void **)&mgr))) {
        IAudioSessionEnumerator *se = nullptr;
        if (SUCCEEDED(mgr->GetSessionEnumerator(&se))) {
          int n = 0; se->GetCount(&n);
          for (int i = 0; i < n; ++i) {
            IAudioSessionControl *ctl = nullptr; if (FAILED(se->GetSession(i, &ctl))) continue;
            IAudioSessionControl2 *ctl2 = nullptr;
            if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void **)&ctl2))) {
              DWORD pid = 0; ctl2->GetProcessId(&pid);
              AudioSessionState st = AudioSessionStateInactive; ctl2->GetState(&st);
              ISimpleAudioVolume *vol = nullptr; ctl->QueryInterface(__uuidof(ISimpleAudioVolume), (void **)&vol);
              LPWSTR inst = nullptr; ctl2->GetSessionInstanceIdentifier(&inst);
              if (pid) out.push_back({pid, st, vol, devId ? devId : L"", inst ? inst : L""}); else if (vol) vol->Release();
              if (inst) CoTaskMemFree(inst);
              ctl2->Release();
            }
            ctl->Release();
          }
          se->Release();
        }
        mgr->Release();
      }
      if (devId) CoTaskMemFree(devId);
      dev->Release();
    }
    devices->Release();
  }
  en->Release();
  return out;
}

static int listPrograms() {
  auto procs = snapshotProcesses();
  auto sessions = enumerateSessions();
  std::map<DWORD, std::pair<std::string, bool>> roots; // root pid -> exe, anyActive
  for (auto &s : sessions) {
    DWORD root = rootOf(s.pid, procs);
    auto it = procs.find(root);
    std::string exe = it != procs.end() ? narrow(it->second.exe) : "unknown";
    auto &e = roots[root];
    e.first = exe;
    e.second = e.second || s.state == AudioSessionStateActive;
    if (s.volume) s.volume->Release();
  }
  for (auto &r : roots) printf("{\"pid\":%lu,\"exe\":\"%s\",\"active\":%s}\n", (unsigned long)r.first, jsonEscape(r.second.first).c_str(), r.second.second ? "true" : "false");
  return 0;
}

// ---- activation completion handler ----
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;
  STDMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) || riid == kIID_IAgileObject) { *ppv = this; return S_OK; }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT hrActivate = E_FAIL; IUnknown *unk = nullptr;
    HRESULT hr = op->GetActivateResult(&hrActivate, &unk);
    if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && unk) { result = unk->QueryInterface(__uuidof(IAudioClient), (void **)&client); unk->Release(); }
    else result = FAILED(hr) ? hr : hrActivate;
    SetEvent(done);
    return S_OK;
  }
};

static std::atomic<bool> g_stop{false};
static std::atomic<float> g_duckRequest{1.0f};
static BOOL WINAPI onCtrl(DWORD) { g_stop = true; return TRUE; }

// ---- ducking: turn the captured program's own Windows volume down (not mute: muting
// also silences process-loopback capture), and put it back afterwards.
// Windows remembers per-app volume, so original volumes are also saved to a file and
// restored on the next run if this process ever dies while a program is ducked.
// Tracked per audio SESSION (a program has one per output device it uses), not per process.
struct Ducked { ISimpleAudioVolume *vol; float original; DWORD pid; std::wstring exe; std::wstring instance; };
static std::vector<Ducked> g_ducked;

static std::wstring restoreFilePath() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
  std::wstring dir = (n ? std::wstring(buf) : std::wstring(L".")) + L"\\CarRadio";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir + L"\\duck-restore.txt";
}

static void saveRestoreFile() {
  FILE *f = _wfopen(restoreFilePath().c_str(), L"w");
  if (!f) return;
  for (auto &d : g_ducked) fprintf(f, "%s|%.6f\n", narrow(d.exe).c_str(), d.original);
  fclose(f);
}

// Undo a duck left behind by a crashed run: restore saved volumes for matching programs.
static void recoverFromCrash() {
  FILE *f = _wfopen(restoreFilePath().c_str(), L"r");
  if (!f) return;
  std::map<std::string, float> saved;
  char line[512];
  while (fgets(line, sizeof(line), f)) {
    char *bar = strrchr(line, '|');
    if (!bar) continue;
    *bar = 0;
    saved[line] = (float)atof(bar + 1);
  }
  fclose(f);
  if (saved.empty()) { _wremove(restoreFilePath().c_str()); return; }
  auto procs = snapshotProcesses();
  int restored = 0;
  for (auto &s : enumerateSessions()) {
    auto it = procs.find(s.pid);
    if (s.volume && it != procs.end()) {
      auto sv = saved.find(narrow(it->second.exe));
      if (sv != saved.end()) { s.volume->SetMasterVolume(sv->second, nullptr); restored++; }
    }
    if (s.volume) s.volume->Release();
  }
  status("{\"event\":\"recovered\",\"sessions\":%d}", restored);
  _wremove(restoreFilePath().c_str());
}

static void duckTree(DWORD root, float level) {
  auto procs = snapshotProcesses();
  for (auto &s : enumerateSessions()) {
    bool mine = s.volume && inTree(s.pid, root, procs);
    bool already = false;
    for (auto &d : g_ducked) if (d.instance == s.instance) { already = true; break; }
    if (mine && !already) {
      float orig = 1.0f; s.volume->GetMasterVolume(&orig);
      auto it = procs.find(s.pid);
      g_ducked.push_back({s.volume, orig, s.pid, it != procs.end() ? it->second.exe : L"", s.instance});
      s.volume->SetMasterVolume(level * orig, nullptr);
      continue; // keep the reference
    }
    if (mine && already) for (auto &d : g_ducked) if (d.instance == s.instance) d.vol->SetMasterVolume(level * d.original, nullptr);
    if (s.volume) s.volume->Release();
  }
  saveRestoreFile();
}

static void restoreDucked() {
  for (auto &d : g_ducked) { d.vol->SetMasterVolume(d.original, nullptr); d.vol->Release(); }
  g_ducked.clear();
  _wremove(restoreFilePath().c_str());
}

static int capture(DWORD targetPid, float startDuck) {
  auto procs = snapshotProcesses();
  DWORD root = rootOf(targetPid, procs);
  auto restore = [] { restoreDucked(); };

  ACTIVATION_PARAMS_ params{};
  params.ActivationType = ACT_TYPE_PROCESS_LOOPBACK;
  params.Loopback.TargetProcessId = root;
  params.Loopback.Mode = LOOPBACK_INCLUDE_TREE;
  PROPVARIANT pv; PropVariantInit(&pv);
  pv.vt = VT_BLOB; pv.blob.cbSize = sizeof(params); pv.blob.pBlobData = (BYTE *)&params;

  ActivateHandler handler;
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, &handler, &op);
  if (SUCCEEDED(hr)) { WaitForSingleObject(handler.done, 5000); hr = handler.result; }
  if (op) op->Release();
  if (FAILED(hr) || !handler.client) { status("{\"event\":\"error\",\"stage\":\"activate\",\"hr\":\"0x%08lx\"}", (unsigned long)hr); restore(); return 2; }
  IAudioClient *client = handler.client;

  // Capture as 32-bit float: the program's own (ducked) volume is applied in float by the
  // audio engine, so dividing it back out restores the signal without quantisation loss.
  WAVEFORMATEX fmt{};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; fmt.nChannels = kChannels; fmt.nSamplesPerSec = kRate;
  fmt.wBitsPerSample = 32; fmt.nBlockAlign = kChannels * 4; fmt.nAvgBytesPerSec = kRate * kChannels * 4;
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 200000, 0, &fmt, nullptr);
  IAudioCaptureClient *cap = nullptr;
  if (SUCCEEDED(hr)) hr = client->SetEventHandle(ready);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void **)&cap);
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) { status("{\"event\":\"error\",\"stage\":\"initialize\",\"hr\":\"0x%08lx\"}", (unsigned long)hr); client->Release(); restore(); return 3; }

  auto it = procs.find(root);
  status("{\"event\":\"capturing\",\"pid\":%lu,\"root\":%lu,\"exe\":\"%s\",\"rate\":%d,\"channels\":%d}", (unsigned long)targetPid, (unsigned long)root,
         jsonEscape(it != procs.end() ? narrow(it->second.exe) : "unknown").c_str(), kRate, kChannels);

  // Commands on stdin, one per line: "duck <level>" turns the program's own Windows volume
  // down to <level> (e.g. 0.001) while the capture is scaled back up; "unduck" restores it.
  // EOF (parent exits) or Ctrl+C stops the capture.
  std::thread([] {
    char line[128];
    while (fgets(line, sizeof(line), stdin)) {
      // Skip anything before the command word (e.g. a UTF-8 byte-order mark some writers add).
      char *cmd = line;
      while (*cmd && !(*cmd >= 'a' && *cmd <= 'z')) cmd++;
      float lv;
      if (sscanf(cmd, "duck %f", &lv) == 1 && lv > 0 && lv <= 1) g_duckRequest = lv;
      else if (strncmp(cmd, "unduck", 6) == 0) g_duckRequest = 1.0f;
    }
    g_stop = true;
  }).detach();
  if (startDuck < 1.0f) g_duckRequest = startDuck;

  LARGE_INTEGER freq, t0, now; QueryPerformanceFrequency(&freq); QueryPerformanceCounter(&t0);
  unsigned long long framesOut = 0, capturedFrames = 0, paddedFrames = 0;
  float peak = 0; double lastReport = 0, lastDuckScan = -10;
  std::vector<char> zeros(kRate / 10 * kBytesPerFrame, 0);
  std::vector<int16_t> pcm;
  bool writeFailed = false;
  float duck = 1.0f;
  double blankUntil = 0;

  while (!g_stop && !writeFailed) {
    WaitForSingleObject(ready, 10);
    QueryPerformanceCounter(&now);
    double tnow = double(now.QuadPart - t0.QuadPart) / freq.QuadPart;
    // Apply duck changes; re-scan every 2 s so sessions the program opens later are ducked too.
    float want = g_duckRequest.load();
    if (want != duck || (duck < 1.0f && tnow - lastDuckScan > 2.0)) {
      if (want < 1.0f) duckTree(root, want); else restoreDucked();
      if (want != duck) {
        status("{\"event\":\"duck\",\"level\":%.4f}", want);
        // Windows applies the volume change a few tens of ms later; scaling by the new
        // factor too early would turn full-volume audio into a full-scale burst (or the
        // reverse). Output silence briefly around every change.
        blankUntil = tnow + 0.25;
      }
      duck = want; lastDuckScan = tnow;
    }
    const float gainBack = tnow < blankUntil ? 0.0f : 1.0f / duck;
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr; UINT32 frames = 0; DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        for (UINT32 left = frames; left;) { UINT32 n = left < (UINT32)(zeros.size() / kBytesPerFrame) ? left : (UINT32)(zeros.size() / kBytesPerFrame); if (fwrite(zeros.data(), kBytesPerFrame, n, stdout) != n) writeFailed = true; left -= n; }
      } else {
        const float *s = (const float *)data;
        pcm.resize(frames * kChannels);
        for (UINT32 i = 0; i < frames * kChannels; ++i) {
          float v = s[i] * gainBack;
          float a = std::fabs(v); if (a > peak) peak = a;
          if (v > 1.0f) v = 1.0f; else if (v < -1.0f) v = -1.0f;
          pcm[i] = (int16_t)lrintf(v * 32767.0f);
        }
        if (fwrite(pcm.data(), kBytesPerFrame, frames, stdout) != frames) writeFailed = true;
      }
      cap->ReleaseBuffer(frames);
      framesOut += frames; capturedFrames += frames;
    }
    // Keep the output continuous: pad with silence if the program delivered nothing.
    QueryPerformanceCounter(&now);
    double elapsed = double(now.QuadPart - t0.QuadPart) / freq.QuadPart;
    long long behind = (long long)(elapsed * kRate) - (long long)framesOut - kRate / 25; // allow 40 ms slack
    while (behind > 0 && !writeFailed) {
      UINT32 n = behind < (long long)(zeros.size() / kBytesPerFrame) ? (UINT32)behind : (UINT32)(zeros.size() / kBytesPerFrame);
      if (fwrite(zeros.data(), kBytesPerFrame, n, stdout) != n) writeFailed = true;
      framesOut += n; paddedFrames += n; behind -= n;
    }
    fflush(stdout);
    if (elapsed - lastReport >= 1.0) {
      status("{\"event\":\"level\",\"t\":%.1f,\"peak\":%.4f,\"captured\":%llu,\"padded\":%llu}", elapsed, peak, capturedFrames, paddedFrames);
      peak = 0; lastReport = elapsed;
    }
  }

  client->Stop();
  cap->Release(); client->Release(); CloseHandle(ready);
  restore();
  status("{\"event\":\"stopped\",\"frames\":%llu,\"captured\":%llu,\"padded\":%llu,\"writeFailed\":%s}", framesOut, capturedFrames, paddedFrames, writeFailed ? "true" : "false");
  return 0;
}

int main(int argc, char **argv) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  SetConsoleCtrlHandler(onCtrl, TRUE);
  int rc = 1;
  recoverFromCrash();
  if (argc >= 2 && strcmp(argv[1], "--list") == 0) rc = listPrograms();
  else if (argc >= 3 && strcmp(argv[1], "--pid") == 0) {
    _setmode(_fileno(stdout), _O_BINARY);
    float duck = (argc >= 5 && strcmp(argv[3], "--duck") == 0) ? (float)atof(argv[4]) : 1.0f;
    if (!(duck > 0 && duck <= 1)) duck = 1.0f;
    rc = capture((DWORD)strtoul(argv[2], nullptr, 10), duck);
  } else fprintf(stderr, "usage: appcapture --list | --pid N [--duck LEVEL]   (stdin: 'duck LEVEL' / 'unduck')\n");
  CoUninitialize();
  return rc;
}
