// FRAME Console host: a Win32 window with WebView2 that shows the approved UI from ui\index.html and connects it to
// window capture, FFmpeg, MediaMTX and the LAN viewer server through validated messages.
#include "common.h"

#include <shellapi.h>
#include <wrl.h>

#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>

#include <regex>

#include "capture.h"
#include "config.h"
#include "http_server.h"
#include "chat.h"
#include "directory.h"
#include "streamer.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;

namespace fc {
namespace {

constexpr wchar_t kWindowClass[] = L"FrameConsoleWindow";
constexpr wchar_t kUiHost[] = L"frame-console.example";
constexpr wchar_t kUiOrigin[] = L"http://frame-console.example/";
constexpr UINT WM_APP_SHUTDOWN_DONE = WM_APP + 10;
constexpr UINT_PTR kShutdownTimer = 1;

class App {
 public:
  int Run(HINSTANCE instance, int show);

 private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
  LRESULT Handle(UINT msg, WPARAM wp, LPARAM lp);
  bool CheckRuntime(std::wstring& browserFolder);
  void CreateWebView(const std::wstring& browserFolder);
  void OnWebMessage(const std::string& text);
  void SendToPage(const std::string& jsonText);
  json InitEvent();
  void ListWindows();
  void SelectWindow(const std::string& id);
  void ListMonitors();
  void SelectMonitor(const std::string& id);
  bool StartViewerServer(int port, std::string& error);
  void OnSourceClosed(std::shared_ptr<WindowCapture> capture);
  void StartStream(const json& request);
  void PreviewLoop();
  void SetFullscreen(bool on);
  void CopyText(const std::string& text);
  void BeginShutdown();
  SIZE InitialClientSize() const;

  HINSTANCE instance_ = nullptr;
  HWND hwnd_ = nullptr;
  ComPtr<ICoreWebView2Environment> env_;
  ComPtr<ICoreWebView2Controller> controller_;
  ComPtr<ICoreWebView2> webview_;
  bool pageReady_ = false;
  std::vector<std::string> pending_;
  bool fullscreen_ = false;
  WINDOWPLACEMENT placement_{sizeof(WINDOWPLACEMENT)};
  bool closing_ = false;

  Gpu gpu_;
  bool gpuReady_ = false;
  std::string gpuError_;
  Settings settings_;
  std::string detectedHost_;
  std::string settingsWarning_;
  std::unique_ptr<TaskQueue> control_, thumbs_;
  std::unique_ptr<Streamer> streamer_;
  std::unique_ptr<Directory> directory_;
  std::unique_ptr<ChatHub> chat_;
  std::unique_ptr<HttpServer> http_;
  std::string httpError_;
  std::mutex sourceMutex_;
  std::shared_ptr<WindowCapture> source_;
  std::string sourceId_, sourceTitle_;
  std::atomic<int> listGeneration_{0};

  std::thread previewThread_;
  std::atomic<bool> previewQuit_{false}, previewVisible_{true}, previewAcked_{true};
  std::mutex previewMutex_;
  std::string previewSlot_;
  bool previewQueued_ = false;
};

App* g_app = nullptr;

SIZE App::InitialClientSize() const {
  // Matches the approved 1440 px wide layout; --client-size=WxH (CSS px) is used for screenshot comparison.
  SIZE size{1440, 1000};
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; ++i) {
    int w = 0, h = 0;
    if (swscanf_s(argv[i], L"--client-size=%dx%d", &w, &h) == 2 && w >= 320 && h >= 320 && w <= 7680 && h <= 4320) size = {w, h};
  }
  LocalFree(argv);
  return size;
}

bool App::CheckRuntime(std::wstring& browserFolder) {
  // A Fixed Version runtime placed at runtime\webview2 is preferred; otherwise the installed Evergreen runtime is used.
  fs::path fixed = ExeDir() / L"runtime" / L"webview2";
  std::error_code ec;
  if (fs::exists(fixed / L"msedgewebview2.exe", ec)) browserFolder = fixed.wstring();
  LPWSTR version = nullptr;
  HRESULT hr = GetAvailableCoreWebView2BrowserVersionString(browserFolder.empty() ? nullptr : browserFolder.c_str(), &version);
  bool ok = SUCCEEDED(hr) && version && *version;
  if (ok) LogFile("webview2", "runtime " + Utf8(version) + (browserFolder.empty() ? " (Evergreen)" : " (Fixed Version)"));
  if (version) CoTaskMemFree(version);
  if (ok) return true;
  fs::path installer = ExeDir() / L"redist" / L"MicrosoftEdgeWebView2RuntimeInstallerX64.exe";
  std::wstring text =
      L"화면을 표시하는 Microsoft Edge WebView2 Runtime이 이 PC에 없습니다.\n\n"
      L"배포 폴더의 redist\\MicrosoftEdgeWebView2RuntimeInstallerX64.exe는 인터넷 없이 설치할 수 있는 설치 파일입니다.\n"
      L"지금 설치 프로그램을 실행할까요? 설치를 마친 뒤 FRAME Console을 다시 실행하세요.";
  if (fs::exists(installer, ec) && MessageBoxW(nullptr, text.c_str(), L"FRAME Console", MB_YESNO | MB_ICONWARNING) == IDYES)
    ShellExecuteW(nullptr, L"open", installer.c_str(), nullptr, installer.parent_path().c_str(), SW_SHOWNORMAL);
  else if (!fs::exists(installer, ec))
    MessageBoxW(nullptr, L"Microsoft Edge WebView2 Runtime이 없습니다. README.txt의 설치 안내를 확인하세요.", L"FRAME Console", MB_OK | MB_ICONERROR);
  return false;
}

int App::Run(HINSTANCE instance, int show) {
  instance_ = instance;
  HANDLE single = CreateMutexW(nullptr, TRUE, L"Local\\FrameConsole.SingleInstance");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (HWND existing = FindWindowW(kWindowClass, nullptr)) {
      ShowWindow(existing, SW_RESTORE);
      SetForegroundWindow(existing);
    }
    return 0;
  }
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  LogFile("app", std::string("FRAME Console ") + kVersion + " starting from " + Utf8(ExeDir().wstring()));
  std::wstring browserFolder;
  if (!CheckRuntime(browserFolder)) return 1;

  settings_ = LoadSettings(&settingsWarning_);
  detectedHost_ = PreferredLanAddress();
  if (settings_.serverHost == "auto") settings_.serverHost = detectedHost_;
  gpuReady_ = gpu_.Init(gpuError_);
  if (gpuReady_) LogFile("gpu", "adapter: " + gpu_.AdapterName());
  control_ = std::make_unique<TaskQueue>("control");
  thumbs_ = std::make_unique<TaskQueue>("thumbnails");
  streamer_ = std::make_unique<Streamer>(gpu_, *control_);
  directory_ = std::make_unique<Directory>();
  std::vector<std::string> servers;
  for (const auto& s : settings_.directoryServers) servers.push_back(s.get<std::string>());
  directory_->Configure(settings_.discoveryPort, servers);
  chat_ = std::make_unique<ChatHub>();
  http_ = std::make_unique<HttpServer>(*streamer_, *directory_, *chat_);
  streamer_->onStopped = [this](const std::string& reason) {
    directory_->SetLocal(nullptr);
    chat_->CloseRoom("송출이 종료되었습니다. " + reason);
  };
  streamer_->ProbeEncoders();
  // The list, list thumbnails and chat are served whenever the app runs, so other PCs can browse before a broadcast starts.
  StartViewerServer(settings_.viewerPort, httpError_);

  WNDCLASSEXW wc{sizeof(wc)};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(0xf5, 0xf6, 0xf8));
  wc.lpszClassName = kWindowClass;
  wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  wc.hIconSm = wc.hIcon;
  RegisterClassExW(&wc);

  hwnd_ = CreateWindowExW(0, kWindowClass, L"FRAME Console", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, nullptr,
                          nullptr, instance, this);
  // Size the client area in DIPs for the monitor the window actually opened on (monitors can use different scaling).
  SIZE client = InitialClientSize();
  UINT dpi = GetDpiForWindow(hwnd_);
  RECT rect{0, 0, MulDiv(client.cx, dpi, 96), MulDiv(client.cy, dpi, 96)};
  AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
  MONITORINFO monitor{sizeof(monitor)};
  GetMonitorInfoW(MonitorFromWindow(hwnd_, MONITOR_DEFAULTTOPRIMARY), &monitor);
  const RECT& work = monitor.rcWork;
  int w = std::min<int>(rect.right - rect.left, work.right - work.left);
  int h = std::min<int>(rect.bottom - rect.top, work.bottom - work.top);
  SetWindowPos(hwnd_, nullptr, work.left + (work.right - work.left - w) / 2, work.top + (work.bottom - work.top - h) / 2, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
  RECT actual{};
  GetClientRect(hwnd_, &actual);
  int dx = MulDiv(client.cx, dpi, 96) - actual.right, dy = MulDiv(client.cy, dpi, 96) - actual.bottom;
  if ((dx || dy) && w + dx <= work.right - work.left && h + dy <= work.bottom - work.top)
    SetWindowPos(hwnd_, nullptr, 0, 0, w + dx, h + dy, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  GetClientRect(hwnd_, &actual);
  LogFile("app", Printf("client %ldx%ld px at %u dpi", actual.right, actual.bottom, dpi));
  SetUiWindow(hwnd_);
  ShowWindow(hwnd_, show == SW_SHOWMAXIMIZED || show == SW_MAXIMIZE ? show : SW_SHOWNORMAL);
  UpdateWindow(hwnd_);
  CreateWebView(browserFolder);
  previewThread_ = std::thread([this] { PreviewLoop(); });

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  previewQuit_ = true;
  if (previewThread_.joinable()) previewThread_.join();
  thumbs_->Shutdown();
  control_->Shutdown();
  http_.reset();
  streamer_.reset();
  chat_.reset();
  directory_.reset();
  LogFile("app", "exit");
  WSACleanup();
  CoUninitialize();
  if (single) CloseHandle(single);
  return 0;
}

void App::CreateWebView(const std::wstring& browserFolder) {
  auto options = Make<CoreWebView2EnvironmentOptions>();
  fs::path userData = DataDir() / L"WebView2";
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      browserFolder.empty() ? nullptr : browserFolder.c_str(), userData.c_str(), options.Get(),
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([this](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
        if (FAILED(result) || !env) {
          LogFile("webview2", "environment failed " + HrMessage(result));
          MessageBoxW(hwnd_, Wide("WebView2를 시작할 수 없습니다: " + HrMessage(result)).c_str(), L"FRAME Console", MB_OK | MB_ICONERROR);
          return S_OK;
        }
        env_ = env;
        return env_->CreateCoreWebView2Controller(
            hwnd_, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([this](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT {
                     if (FAILED(res) || !controller) {
                       LogFile("webview2", "controller failed " + HrMessage(res));
                       return S_OK;
                     }
                     controller_ = controller;
                     controller_->get_CoreWebView2(&webview_);
                     ComPtr<ICoreWebView2Controller2> controller2;
                     if (SUCCEEDED(controller_.As(&controller2))) controller2->put_DefaultBackgroundColor({255, 0xf5, 0xf6, 0xf8});
                     ComPtr<ICoreWebView2Settings> settings;
                     webview_->get_Settings(&settings);
                     wchar_t devtools[8] = {};
                     bool allowDevtools = GetEnvironmentVariableW(L"FRAME_CONSOLE_DEVTOOLS", devtools, 8) > 0;
                     settings->put_AreDevToolsEnabled(allowDevtools);
                     settings->put_IsStatusBarEnabled(FALSE);
                     settings->put_IsZoomControlEnabled(FALSE);
                     settings->put_AreHostObjectsAllowed(FALSE);
                     settings->put_IsWebMessageEnabled(TRUE);
                     // Only the bundled local UI is shown; skip the online SmartScreen lookup (closed networks).
                     ComPtr<ICoreWebView2Settings8> settings8;
                     if (SUCCEEDED(settings.As(&settings8))) settings8->put_IsReputationCheckingRequired(FALSE);
                     ComPtr<ICoreWebView2_3> webview3;
                     if (SUCCEEDED(webview_.As(&webview3)))
                       webview3->SetVirtualHostNameToFolderMapping(kUiHost, (ExeDir() / L"ui").c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY);
                     EventRegistrationToken token;
                     webview_->add_WebMessageReceived(
                         Callback<ICoreWebView2WebMessageReceivedEventHandler>([this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                           LPWSTR source = nullptr;
                           args->get_Source(&source);
                           std::wstring origin = source ? source : L"";
                           CoTaskMemFree(source);
                           // Only the bundled UI may talk to the native side.
                           if (origin.rfind(kUiOrigin, 0) != 0) {
                             LogFile("bridge", "rejected message from " + Utf8(origin));
                             return S_OK;
                           }
                           LPWSTR message = nullptr;
                           if (SUCCEEDED(args->TryGetWebMessageAsString(&message)) && message) {
                             std::wstring text = message;
                             CoTaskMemFree(message);
                             if (text.size() <= 256 * 1024) OnWebMessage(Utf8(text));
                           }
                           return S_OK;
                         }).Get(),
                         &token);
                     webview_->add_NavigationStarting(
                         Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                           LPWSTR uri = nullptr;
                           args->get_Uri(&uri);
                           std::wstring target = uri ? uri : L"";
                           CoTaskMemFree(uri);
                           if (target.rfind(kUiOrigin, 0) != 0) {
                             LogFile("webview2", "blocked navigation to " + Utf8(target));
                             args->put_Cancel(TRUE);
                           }
                           return S_OK;
                         }).Get(),
                         &token);
                     webview_->add_NewWindowRequested(
                         Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                           args->put_Handled(TRUE);
                           return S_OK;
                         }).Get(),
                         &token);
                     webview_->add_PermissionRequested(
                         Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                           // The page never needs camera, microphone or other permissions; audio is captured natively.
                           args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                           return S_OK;
                         }).Get(),
                         &token);
                     webview_->add_ContainsFullScreenElementChanged(
                         Callback<ICoreWebView2ContainsFullScreenElementChangedEventHandler>([this](ICoreWebView2* sender, IUnknown*) -> HRESULT {
                           BOOL full = FALSE;
                           sender->get_ContainsFullScreenElement(&full);
                           SetFullscreen(full != FALSE);
                           return S_OK;
                         }).Get(),
                         &token);
                     webview_->add_ProcessFailed(
                         Callback<ICoreWebView2ProcessFailedEventHandler>([this](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
                           COREWEBVIEW2_PROCESS_FAILED_KIND kind;
                           args->get_ProcessFailedKind(&kind);
                           LogFile("webview2", "process failed kind " + std::to_string(static_cast<int>(kind)));
                           if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE) {
                             pageReady_ = false;
                             webview_->Reload();
                           }
                           return S_OK;
                         }).Get(),
                         &token);
                     RECT bounds;
                     GetClientRect(hwnd_, &bounds);
                     controller_->put_Bounds(bounds);
                     webview_->Navigate((std::wstring(kUiOrigin) + L"index.html").c_str());
                     return S_OK;
                   }).Get());
      }).Get());
  if (FAILED(hr)) {
    LogFile("webview2", "CreateCoreWebView2EnvironmentWithOptions failed " + HrMessage(hr));
    MessageBoxW(hwnd_, Wide("WebView2를 시작할 수 없습니다: " + HrMessage(hr)).c_str(), L"FRAME Console", MB_OK | MB_ICONERROR);
  }
}

void App::SendToPage(const std::string& jsonText) {
  if (!webview_ || !pageReady_) {
    if (pending_.size() < 200) pending_.push_back(jsonText);
    return;
  }
  webview_->PostWebMessageAsJson(Wide(jsonText).c_str());
}

json App::InitEvent() {
  json addresses = json::array();
  for (const auto& a : LocalIPv4Addresses()) addresses.push_back({{"ip", a.ip}, {"adapter", a.adapter}});
  json init = {{"type", "init"},
               {"version", kVersion},
               {"settings", SettingsToJson(settings_)},
               {"detectedHost", detectedHost_},
               {"addresses", addresses},
               {"gpu", gpuReady_ ? gpu_.AdapterName() : ""},
               {"status", streamer_->Status()},
               {"viewerServer", http_->Listening() ? http_->Port() : 0},
               {"viewerServerError", httpError_}};
  std::lock_guard<std::mutex> lock(sourceMutex_);
  if (source_) init["source"] = {{"id", sourceId_}, {"title", sourceTitle_}};
  return init;
}

void App::OnWebMessage(const std::string& text) {
  json msg = json::parse(text, nullptr, false);
  if (msg.is_discarded() || !msg.is_object() || !msg.contains("cmd") || !msg["cmd"].is_string()) return;
  const std::string cmd = msg["cmd"];
  if (cmd == "hello") {
    pageReady_ = true;
    webview_->PostWebMessageAsJson(Wide(InitEvent().dump()).c_str());
    for (const auto& p : pending_) webview_->PostWebMessageAsJson(Wide(p).c_str());
    pending_.clear();
    if (!settingsWarning_.empty()) {
      UiLog("설정", settingsWarning_);
      settingsWarning_.clear();
    }
    if (!gpuReady_) UiLog("오류", gpuError_);
    control_->Post([this] {
      EncoderProbe probe = streamer_->Probe();
      json available = probe.available;
      PostUi({{"type", "encoders"}, {"available", available}, {"ffmpeg", probe.ffmpegVersion}});
      if (!probe.ffmpegFound) UiLog("오류", "FFmpeg를 실행할 수 없습니다. 배포 폴더의 bin\\ffmpeg.exe를 확인하세요.");
    });
  } else if (cmd == "listMonitors") {
    thumbs_->Post([this] { ListMonitors(); });
  } else if (cmd == "selectMonitor" && msg.contains("id") && msg["id"].is_string() && msg["id"].get<std::string>().size() <= 40) {
    std::string id = msg["id"];
    control_->Post([this, id] { SelectMonitor(id); });
  } else if (cmd == "listWindows") {
    thumbs_->Post([this] { ListWindows(); });
  } else if (cmd == "selectWindow" && msg.contains("id") && msg["id"].is_string()) {
    std::string id = msg["id"];
    control_->Post([this, id] { SelectWindow(id); });
  } else if (cmd == "start" && msg.contains("settings") && msg["settings"].is_object()) {
    json request = msg["settings"];
    control_->Post([this, request] { StartStream(request); });
  } else if (cmd == "stop") {
    control_->Post([this] { streamer_->Stop("사용자 중지", false); });
  } else if (cmd == "setVolume" && msg.contains("channel") && msg["channel"].is_string() && msg.contains("value") && msg["value"].is_number()) {
    std::string channel = msg["channel"];
    int value = std::clamp(msg["value"].get<int>(), 0, 100);
    if (channel == "system" || channel == "mic") {
      streamer_->SetVolume(channel, value);
      (channel == "system" ? settings_.systemVolume : settings_.micVolume) = value;
    }
  } else if (cmd == "copyText" && msg.contains("text") && msg["text"].is_string()) {
    CopyText(msg["text"]);
  } else if (cmd == "previewAck") {
    previewAcked_ = true;
  } else if (cmd == "previewVisible" && msg.contains("visible") && msg["visible"].is_boolean()) {
    previewVisible_ = msg["visible"].get<bool>();
  } else if (cmd == "viewerStats" && msg.contains("stats") && msg["stats"].is_object()) {
    // Receive-side measurements from the built-in player (numbers only) for the diagnostic log.
    json clean = json::object();
    for (auto& [key, value] : msg["stats"].items())
      if (value.is_number() && key.size() < 40) clean[key] = value;
    LogFile("viewer", clean.dump());
  } else {
    LogFile("bridge", "ignored command " + cmd.substr(0, 40));
  }
}

void App::CopyText(const std::string& text) {
  static const std::regex allowed(R"(^http://[A-Za-z0-9.\-]{1,253}:\d{1,5}/[A-Za-z0-9_-]{1,64}$)");
  if (!std::regex_match(text, allowed)) return;
  std::wstring wide = Wide(text);
  if (!OpenClipboard(hwnd_)) return;
  EmptyClipboard();
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, (wide.size() + 1) * sizeof(wchar_t));
  if (mem) {
    memcpy(GlobalLock(mem), wide.c_str(), (wide.size() + 1) * sizeof(wchar_t));
    GlobalUnlock(mem);
    if (!SetClipboardData(CF_UNICODETEXT, mem)) GlobalFree(mem);
  }
  CloseClipboard();
  PostUi({{"type", "copied"}});
}

void App::ListWindows() {
  int generation = ++listGeneration_;
  auto windows = EnumerateSourceWindows(hwnd_);
  json items = json::array();
  for (const auto& w : windows)
    items.push_back({{"id", SourceId(w.hwnd, w.pid)},
                     {"title", Utf8(w.title)},
                     {"exe", Utf8(w.exe)},
                     {"width", w.rect.right - w.rect.left},
                     {"height", w.rect.bottom - w.rect.top},
                     {"minimized", w.minimized}});
  PostUi({{"type", "windows"}, {"items", items}});
  if (!gpuReady_) return;
  FrameConverter converter;
  for (const auto& w : windows) {
    if (generation != listGeneration_) return;  // the dialog was reopened
    if (w.minimized) continue;
    WindowCapture capture(gpu_);
    std::string error;
    if (!capture.Start(w.hwnd, false, error)) continue;
    for (int i = 0; i < 40 && capture.FrameCount() == 0; ++i) Sleep(10);
    std::vector<uint8_t> bgr;
    UINT tw = 0, th = 0;
    bool ok = false;
    capture.WithLatest([&](ID3D11Texture2D* texture, UINT sw, UINT sh, uint64_t) { ok = converter.ToBgr(gpu_, texture, sw, sh, 480, 270, bgr, tw, th, error); });
    capture.Stop();
    std::string jpeg;
    if (ok && EncodeJpeg(bgr, tw, th, 0.8f, jpeg)) PostUi({{"type", "thumb"}, {"id", SourceId(w.hwnd, w.pid)}, {"jpeg", Base64(jpeg)}});
  }
}

void App::SelectWindow(const std::string& id) {
  HWND hwnd = nullptr;
  DWORD pid = 0;
  if (streamer_->Running()) return;
  if (!ParseSourceId(id, hwnd, pid)) {
    PostUi({{"type", "source"}, {"ok", false}, {"message", "선택한 창이 닫혔습니다. 다시 선택하세요."}});
    return;
  }
  if (!gpuReady_) {
    PostUi({{"type", "source"}, {"ok", false}, {"message", gpuError_}});
    return;
  }
  int length = GetWindowTextLengthW(hwnd);
  std::wstring title(static_cast<size_t>(std::max(length, 0)) + 1, L'\0');
  title.resize(static_cast<size_t>(GetWindowTextW(hwnd, title.data(), length + 1)));
  auto capture = std::make_shared<WindowCapture>(gpu_);
  std::weak_ptr<WindowCapture> weak = capture;
  capture->onClosed = [this, weak] {
    control_->Post([this, weak] {
      if (auto c = weak.lock()) OnSourceClosed(c);
    });
  };
  std::string error;
  if (!capture->Start(hwnd, settings_.captureCursor, error)) {
    PostUi({{"type", "source"}, {"ok", false}, {"message", error}});
    UiLog("오류", error);
    return;
  }
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    source_ = capture;
    sourceId_ = id;
    sourceTitle_ = Utf8(title);
  }
  previewAcked_ = true;
  PostUi({{"type", "source"}, {"ok", true}, {"id", id}, {"kind", "window"}, {"title", Utf8(title)}, {"minimized", IsIconic(hwnd) != FALSE}});
  UiLog("소스", Utf8(title) + " 선택");
}

bool App::StartViewerServer(int port, std::string& error) {
  if (http_->Start(port, error)) {
    httpError_.clear();
    return true;
  }
  httpError_ = error;
  UiLog("오류", error);
  return false;
}

void App::ListMonitors() {
  auto monitors = EnumerateMonitors();
  json items = json::array();
  FrameConverter converter;
  for (const auto& m : monitors) {
    json item = {{"id", m.id}, {"number", m.number}, {"width", m.width}, {"height", m.height}, {"scale", m.scale}, {"primary", m.primary}, {"refresh", m.refresh}};
    // The thumbnail is a real frame of that monitor; it only travels over the app's private bridge, never over HTTP.
    if (gpuReady_) {
      WindowCapture capture(gpu_);
      std::string error;
      if (capture.StartMonitor(m.handle, m.device, false, error)) {
        for (int i = 0; i < 40 && capture.FrameCount() == 0; ++i) Sleep(10);
        std::vector<uint8_t> bgr;
        UINT tw = 0, th = 0;
        bool ok = false;
        capture.WithLatest([&](ID3D11Texture2D* texture, UINT sw, UINT sh, uint64_t) { ok = converter.ToBgr(gpu_, texture, sw, sh, 480, 270, bgr, tw, th, error); });
        capture.Stop();
        std::string jpeg;
        if (ok && EncodeJpeg(bgr, tw, th, 0.8f, jpeg)) item["thumbnailUrl"] = "data:image/jpeg;base64," + Base64(jpeg);
      }
    }
    items.push_back(item);
  }
  PostUi({{"type", "monitors"}, {"items", items}});
}

void App::SelectMonitor(const std::string& id) {
  if (streamer_->Running()) return;
  SourceMonitor monitor;
  if (!FindMonitor(id, monitor)) {
    PostUi({{"type", "source"}, {"ok", false}, {"kind", "monitor"}, {"message", "선택한 모니터를 찾을 수 없습니다. 연결 상태를 확인한 뒤 다시 선택하십시오."}});
    return;
  }
  if (!gpuReady_) {
    PostUi({{"type", "source"}, {"ok", false}, {"kind", "monitor"}, {"message", gpuError_}});
    return;
  }
  auto capture = std::make_shared<WindowCapture>(gpu_);
  std::weak_ptr<WindowCapture> weak = capture;
  capture->onClosed = [this, weak] {
    control_->Post([this, weak] {
      if (auto c = weak.lock()) OnSourceClosed(c);
    });
  };
  std::string error;
  if (!capture->StartMonitor(monitor.handle, monitor.device, settings_.captureCursor, error)) {
    PostUi({{"type", "source"}, {"ok", false}, {"kind", "monitor"}, {"message", error}});
    UiLog("오류", error);
    return;
  }
  std::string title = "모니터 " + std::to_string(monitor.number);
  std::string sourceId = "monitor:" + id;
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    source_ = capture;
    sourceId_ = sourceId;
    sourceTitle_ = title;
  }
  previewAcked_ = true;
  PostUi({{"type", "source"}, {"ok", true}, {"id", sourceId}, {"kind", "monitor"}, {"title", title}, {"minimized", false}});
  UiLog("소스", Printf("%s 선택 (%dx%d, %d%%, %dHz)", title.c_str(), monitor.width, monitor.height, monitor.scale, monitor.refresh));
}

void App::OnSourceClosed(std::shared_ptr<WindowCapture> capture) {
  std::string title;
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    if (source_ != capture) return;
    title = sourceTitle_;
  }
  bool monitor = capture->IsMonitor();
  if (streamer_->Running()) streamer_->Stop(monitor ? "공유한 모니터(" + title + ") 연결이 끊어졌습니다." : "공유한 창(" + title + ")이 닫혔습니다.", true);
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    source_.reset();
    sourceId_.clear();
    sourceTitle_.clear();
  }
  PostUi({{"type", "source"}, {"ok", false}, {"closed", true}, {"message", monitor ? "공유한 모니터의 연결이 끊어졌습니다. 다른 대상을 선택하세요." : "공유한 창이 닫혔습니다. 다른 대상을 선택하세요."}});
  UiLog("소스", title + (monitor ? " 연결이 끊어졌습니다." : " 창이 닫혔습니다."));
}

void App::StartStream(const json& request) {
  PostUi({{"type", "state"}, {"state", "starting"}});
  auto fail = [](const std::string& field, const std::string& message) {
    PostUi({{"type", "state"}, {"state", "failed"}, {"field", field}, {"message", message}});
    UiLog("송출", "시작 실패: " + message);
  };
  Settings next = settings_;
  std::string field, error;
  if (!ApplyStartRequest(request, next, field, error)) return fail(field, error);
  std::string resolved;
  if (!HostIsLocal(next.serverHost, resolved)) {
    std::string list;
    for (const auto& a : LocalIPv4Addresses()) list += (list.empty() ? "" : ", ") + a.ip;
    return fail("server-host", "이 PC의 네트워크 주소가 아닙니다. 사용할 수 있는 주소: " + list);
  }
  std::shared_ptr<WindowCapture> capture;
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    capture = source_;
  }
  if (!capture) return fail("", "공유할 창을 먼저 선택하세요.");
  if (!StartViewerServer(next.viewerPort, error)) return fail("viewer-port", error);
  std::string title;
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    title = sourceTitle_;
  }
  if (!streamer_->Start(next, capture, title, field, error)) return fail(field, error);
  BroadcastItem item;
  if (streamer_->LocalItem(item)) {
    chat_->OpenRoom(item.id);
    directory_->SetLocal(&item);
  }
  Settings saved = next;
  if (saved.serverHost == detectedHost_) saved.serverHost = "auto";  // keep following the LAN address on other networks
  settings_ = next;
  if (!SaveSettings(saved, &error)) LogFile("config", error);
  PostUi({{"type", "state"}, {"state", "running"}, {"status", streamer_->Status()}});
  UiLog("송출", next.streamPath + " 시작");
}

void App::PreviewLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  FrameConverter converter;
  uint64_t lastSeq = UINT64_MAX;
  std::shared_ptr<WindowCapture> lastCapture;
  int64_t lastSent = 0;
  while (!previewQuit_) {
    Sleep(66);  // about 15 previews per second; the stream itself is paced separately
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      if (source_) source_->PollClosed();
    }
    if (!previewVisible_ || !gpuReady_ || (hwnd_ && IsIconic(hwnd_))) continue;
    if (!previewAcked_ && QpcSeconds(QpcNow() - lastSent) < 1.0) continue;
    std::shared_ptr<WindowCapture> capture;
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      capture = source_;
    }
    if (!capture) {
      lastCapture.reset();
      continue;
    }
    if (capture != lastCapture) {
      lastCapture = capture;
      lastSeq = UINT64_MAX;
    }
    std::vector<uint8_t> bgr;
    UINT w = 0, h = 0, sw = 0, sh = 0;
    bool fresh = false;
    std::string error;
    capture->WithLatest([&](ID3D11Texture2D* texture, UINT srcW, UINT srcH, uint64_t seq) {
      if (seq == lastSeq) return;
      lastSeq = seq;
      sw = srcW;
      sh = srcH;
      fresh = converter.ToBgr(gpu_, texture, srcW, srcH, 1280, 720, bgr, w, h, error);
    });
    if (!fresh) continue;
    std::string jpeg;
    if (!EncodeJpeg(bgr, w, h, 0.78f, jpeg)) continue;
    json event = {{"type", "preview"}, {"width", w}, {"height", h}, {"sourceWidth", sw}, {"sourceHeight", sh}, {"jpeg", Base64(jpeg)}};
    previewAcked_ = false;
    lastSent = QpcNow();
    std::lock_guard<std::mutex> lock(previewMutex_);
    previewSlot_ = event.dump();
    if (!previewQueued_) {
      previewQueued_ = true;
      PostMessageW(hwnd_, WM_APP_PREVIEW, 0, 0);
    }
  }
  CoUninitialize();
}

void App::SetFullscreen(bool on) {
  if (on == fullscreen_) return;
  fullscreen_ = on;
  if (on) {
    GetWindowPlacement(hwnd_, &placement_);
    MONITORINFO mi{sizeof(mi)};
    GetMonitorInfoW(MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST), &mi);
    SetWindowLongPtrW(hwnd_, GWL_STYLE, WS_POPUP | WS_VISIBLE);
    SetWindowPos(hwnd_, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
  } else {
    SetWindowLongPtrW(hwnd_, GWL_STYLE, WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    SetWindowPlacement(hwnd_, &placement_);
    SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  }
}

void App::BeginShutdown() {
  if (closing_) return;
  closing_ = true;
  ShowWindow(hwnd_, SW_HIDE);
  previewQuit_ = true;
  SetTimer(hwnd_, kShutdownTimer, 8000, nullptr);  // the Job Object still ends children if this takes too long
  control_->Post([this] {
    streamer_->Stop("프로그램 종료", false);
    http_->Stop();
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      source_.reset();
    }
    PostMessageW(hwnd_, WM_APP_SHUTDOWN_DONE, 0, 0);
  });
}

LRESULT CALLBACK App::WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    reinterpret_cast<App*>(cs->lpCreateParams)->hwnd_ = hwnd;
  }
  auto* app = reinterpret_cast<App*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  return app ? app->Handle(msg, wp, lp) : DefWindowProcW(hwnd, msg, wp, lp);
}

LRESULT App::Handle(UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      if (controller_) {
        RECT bounds;
        GetClientRect(hwnd_, &bounds);
        controller_->put_Bounds(bounds);
      }
      return 0;
    case WM_MOVE:
    case WM_MOVING:
      if (controller_) controller_->NotifyParentWindowPositionChanged();
      break;
    case WM_DPICHANGED: {
      auto* r = reinterpret_cast<RECT*>(lp);
      SetWindowPos(hwnd_, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_GETMINMAXINFO: {
      auto* info = reinterpret_cast<MINMAXINFO*>(lp);
      UINT dpi = GetDpiForWindow(hwnd_);
      info->ptMinTrackSize = {MulDiv(400, dpi, 96), MulDiv(480, dpi, 96)};
      return 0;
    }
    case WM_APP_UI_EVENT: {
      std::unique_ptr<std::string> payload(reinterpret_cast<std::string*>(lp));
      if (!closing_) SendToPage(*payload);
      return 0;
    }
    case WM_APP_PREVIEW: {
      std::string frame;
      {
        std::lock_guard<std::mutex> lock(previewMutex_);
        frame.swap(previewSlot_);
        previewQueued_ = false;
      }
      if (!frame.empty() && webview_ && pageReady_ && !closing_) {
        webview_->PostWebMessageAsJson(Wide(frame).c_str());
      } else {
        previewAcked_ = true;
      }
      return 0;
    }
    case WM_CLOSE:
      BeginShutdown();
      return 0;
    case WM_TIMER:
      if (wp == kShutdownTimer) DestroyWindow(hwnd_);
      return 0;
    case WM_APP_SHUTDOWN_DONE:
      DestroyWindow(hwnd_);
      return 0;
    case WM_DESTROY:
      if (controller_) controller_->Close();
      controller_.Reset();
      webview_.Reset();
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd_, msg, wp, lp);
}

}  // namespace
}  // namespace fc

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
  fc::App app;
  fc::g_app = &app;
  return app.Run(instance, show);
}
