#include "thumbnails.h"

#include <dwmapi.h>

#include <algorithm>

namespace fc {
namespace {

constexpr wchar_t kHelperClass[] = L"FrameConsoleThumbnailHelper";
// The helper window's own colour. The DWM thumbnail covers the whole helper, so a frame of only this colour means the
// thumbnail was not composed yet, not that the window shows this colour.
constexpr int kHelperR = 255, kHelperG = 0, kHelperB = 255;
constexpr int64_t kWatchMs = 500;  // closed / minimized / restored checks while the list is open (no capture)

int64_t NowMs() { return static_cast<int64_t>(GetTickCount64()); }

// Share of sampled pixels within tolerance of a colour in a 24-bit BGR image.
double ShareNear(const std::vector<uint8_t>& bgr, UINT w, UINT h, int b, int g, int r, int tolerance) {
  size_t n = 0, hits = 0;
  for (UINT y = 0; y < h; y += 4) {
    for (UINT x = 0; x < w; x += 4) {
      const uint8_t* p = bgr.data() + (static_cast<size_t>(y) * w + x) * 3;
      ++n;
      if (std::abs(p[0] - b) <= tolerance && std::abs(p[1] - g) <= tolerance && std::abs(p[2] - r) <= tolerance) ++hits;
    }
  }
  return n ? static_cast<double>(hits) / static_cast<double>(n) : 0;
}

// The app asked Windows to keep the window out of captures (SetWindowDisplayAffinity); that choice is respected.
bool ExcludedFromCapture(HWND hwnd) {
  DWORD affinity = WDA_NONE;
  return GetWindowDisplayAffinity(hwnd, &affinity) && affinity != WDA_NONE;
}

// Client area of a shown window in physical pixels (this process is per-monitor DPI aware); empty when unknown.
SIZE ClientSize(HWND hwnd) {
  RECT client{};
  if (IsIconic(hwnd) || !GetClientRect(hwnd, &client)) return {};
  POINT a{client.left, client.top}, b{client.right, client.bottom};
  if (!ClientToScreen(hwnd, &a) || !ClientToScreen(hwnd, &b)) return {};
  return SIZE{std::abs(b.x - a.x), std::abs(b.y - a.y)};
}

}  // namespace

static const char* StateName(int state) {
  static const char* names[] = {"queued", "loading", "retrying", "ready", "minimized", "timeout", "failed", "closed", "excluded"};
  return names[state];
}

WindowThumbnails::WindowThumbnails(Gpu& gpu, bool gpuReady, HWND appWindow)
    : gpu_(gpu), gpuReady_(gpuReady), appWindow_(appWindow), wake_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {
  wchar_t fault[256] = {};
  if (GetEnvironmentVariableW(L"FRAME_CONSOLE_THUMB_FAULT", fault, 256) > 0) {
    std::wstring text = fault;
    size_t a = text.find(L':'), b = a == std::wstring::npos ? a : text.find(L':', a + 1);
    if (b != std::wstring::npos) {
      fault_.mode = Utf8(text.substr(0, a));
      fault_.ms = _wtoi(text.substr(a + 1, b - a - 1).c_str());
      fault_.prefix = text.substr(b + 1);
    }
    if (fault_.mode != "delay" && fault_.mode != "drop" && fault_.mode != "corrupt") fault_ = Fault{};
  }
  thread_ = std::thread([this] { Run(); });
}

WindowThumbnails::~WindowThumbnails() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.quit = true;
  }
  SetEvent(wake_.Get());
  if (thread_.joinable()) thread_.join();
}

void WindowThumbnails::Configure(const WindowPreviewSettings& settings) {
  std::lock_guard<std::mutex> lock(mutex_);
  next_ = settings;
}

void WindowThumbnails::Open(int generation, const std::vector<SourceWindow>& windows, int thumbWidth) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.close = false;
    commands_.open = std::make_unique<std::pair<int, std::vector<SourceWindow>>>(generation, windows);
    commands_.thumbWidth = thumbWidth;
    commands_.priority = false;
    commands_.retries.clear();
  }
  SetEvent(wake_.Get());
}

void WindowThumbnails::Prioritize(int generation, std::vector<std::string> visible, std::string selected) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.priority = true;
    commands_.priorityGeneration = generation;
    commands_.visible = std::move(visible);
    commands_.selected = std::move(selected);
  }
  SetEvent(wake_.Get());
}

void WindowThumbnails::Retry(int generation, const std::string& id) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.retries.emplace_back(generation, id);
  }
  SetEvent(wake_.Get());
}

void WindowThumbnails::ShowFailed(int generation, const std::string& id, int request) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.showFailures.emplace_back(generation, id, request);
  }
  SetEvent(wake_.Get());
}

void WindowThumbnails::Close() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.close = true;
    commands_.open.reset();
    commands_.priority = false;
    commands_.retries.clear();
  }
  SetEvent(wake_.Get());
}

void WindowThumbnails::Run() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  FrameConverter converter;
  for (;;) {
    Commands c;
    WindowPreviewSettings next;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      c = std::move(commands_);
      commands_ = Commands{};
      next = next_;
    }
    if (c.quit) break;
    int64_t now = NowMs();
    if (c.close && session_) EndSession("closed");
    if (c.open) {
      if (session_) EndSession("replaced by a new list");
      cfg_ = next;
      thumbW_ = static_cast<UINT>(std::clamp(c.thumbWidth, 320, 1280)) & ~1u;
      thumbH_ = (thumbW_ * 9 / 16) & ~1u;
      BeginSession(c.open->first, c.open->second, now);
    }
    if (session_ && c.priority && c.priorityGeneration == generation_) {
      visible_ = std::move(c.visible);
      selected_ = std::move(c.selected);
    }
    for (const auto& [generation, id] : c.retries) {
      if (!session_ || generation != generation_) continue;
      for (auto& item : items_) {
        // Only a finished failure is retried by hand; a running, queued or successful job is left alone (no duplicates).
        if (item.id != id || (item.state != State::Timeout && item.state != State::Failed)) continue;
        LogFile("thumb", Printf("gen %d %s %s: manual retry after %s", generation_, item.id.c_str(), item.exe.c_str(), item.stage.c_str()));
        NewJob(item, now, true);
      }
    }
    for (const auto& [generation, id, request] : c.showFailures) {
      if (!session_ || generation != generation_) continue;
      for (auto& item : items_) {
        if (item.id != id || item.req != request || (item.state != State::Ready && item.state != State::Minimized && item.state != State::Excluded)) continue;
        item.state = State::Failed;
        item.stage = "decode";
        PostState(item);
      }
    }
    if (!session_) {
      WaitForSingleObject(wake_.Get(), INFINITE);
      continue;
    }
    for (size_t i = 0; i < active_.size();) {
      if (Advance(active_[i], converter, now)) {
        EndAttempt(active_[i]);
        active_.erase(active_.begin() + static_cast<std::ptrdiff_t>(i));
      } else {
        ++i;
      }
    }
    if (now >= nextWatch_) {
      Watch(now);
      nextWatch_ = now + kWatchMs;
    }
    StartAttempts(now, converter);
    // Sleep until a frame arrives, a command comes in, or the next attempt deadline, retry time or watch tick.
    int64_t wakeAt = nextWatch_;
    for (const auto& a : active_) wakeAt = std::min(wakeAt, a.until);
    for (const auto& item : items_)
      if (item.state == State::Retrying) wakeAt = std::min(wakeAt, item.nextAt);
    std::vector<HANDLE> handles{wake_.Get()};
    for (const auto& a : active_) handles.push_back(a.capture->FrameEvent());
    DWORD timeout = static_cast<DWORD>(std::clamp<int64_t>(wakeAt - NowMs(), 0, kWatchMs));
    MsgWaitForMultipleObjectsEx(static_cast<DWORD>(handles.size()), handles.data(), timeout, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    MSG msg;  // the helper windows belong to this thread
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&msg);
  }
  if (session_) EndSession("exit");
  CoUninitialize();
}

void WindowThumbnails::BeginSession(int generation, const std::vector<SourceWindow>& windows, int64_t now) {
  session_ = true;
  generation_ = generation;
  sessionAt_ = now;
  nextWatch_ = now + kWatchMs;
  items_.clear();
  visible_.clear();
  selected_.clear();
  int minimized = 0;
  for (const auto& w : windows) {
    Item item;
    item.id = SourceId(w.hwnd, w.pid);
    item.exe = Utf8(w.exe);
    item.hwnd = w.hwnd;
    item.pid = w.pid;
    item.order = static_cast<int>(items_.size());
    item.minimized = w.minimized;
    item.excluded = ExcludedFromCapture(w.hwnd);
    item.faulty = !fault_.mode.empty() && !fault_.prefix.empty() && w.title.rfind(fault_.prefix, 0) == 0;
    minimized += w.minimized ? 1 : 0;
    items_.push_back(std::move(item));
  }
  // A list reopened shortly after shows the last image at once, marked as earlier; the new capture replaces it. The id
  // holds the window handle and process id, so an image never moves to another window.
  std::map<std::string, Cached> keep;
  for (auto& item : items_) {
    auto it = cache_.find(item.id);
    if (it == cache_.end() || now - it->second.at > cfg_.cacheMs) continue;
    PostUi({{"type", "thumb"}, {"gen", generation_}, {"id", item.id}, {"req", 0}, {"jpeg", it->second.jpeg}, {"source", "cache"}, {"fresh", false}, {"ageMs", now - it->second.at}});
    keep.insert(*it);
  }
  cache_.swap(keep);
  for (auto& item : items_) NewJob(item, now, false);  // the UI starts every card as queued
  if (!gpuReady_) {
    for (auto& item : items_) {
      item.state = State::Failed;
      item.stage = "gpu";
      PostState(item);
    }
  }
  LogFile("thumb", Printf("gen %d: %zu windows (%d minimized); images up to %ux%u; first frame %d ms, %d attempts, deadline %d ms, %d at a time, cache %d ms (%zu shown)",
                          generation_, items_.size(), minimized, thumbW_, thumbH_, cfg_.firstFrameMs, cfg_.attempts, cfg_.deadlineMs, cfg_.concurrency, cfg_.cacheMs, cache_.size()));
  if (!fault_.mode.empty())
    LogFile("thumb", Printf("TEST HOOK FRAME_CONSOLE_THUMB_FAULT active: %s %d ms for %d window(s)", fault_.mode.c_str(), fault_.ms,
                            static_cast<int>(std::count_if(items_.begin(), items_.end(), [](const Item& item) { return item.faulty; }))));
}

void WindowThumbnails::EndSession(const char* reason) {
  for (auto& a : active_) EndAttempt(a);
  active_.clear();
  for (HWND h : helpers_)
    if (h) DestroyWindow(h);
  helpers_.clear();
  int counts[9] = {};
  for (const auto& item : items_) ++counts[static_cast<int>(item.state)];
  LogFile("thumb", Printf("gen %d %s after %lld ms: ready %d, minimized %d, timeout %d, failed %d, closed %d, excluded %d, unfinished %d", generation_, reason,
                          NowMs() - sessionAt_, counts[3], counts[4], counts[5], counts[6], counts[7], counts[8], counts[0] + counts[1] + counts[2]));
  items_.clear();
  session_ = false;
}

void WindowThumbnails::NewJob(Item& item, int64_t now, bool post) {
  item.req = ++requests_;
  item.attempts = 0;
  item.queuedAt = now;
  item.startedAt = item.nextAt = 0;
  item.queueMs = -1;
  item.stage.clear();
  item.error.clear();
  item.state = State::Queued;
  if (post) PostState(item);
}

bool WindowThumbnails::Exists(const Item& item) const {
  DWORD pid = 0;
  // An HWND value can be reused by another process after the window closes.
  return IsWindow(item.hwnd) && GetWindowThreadProcessId(item.hwnd, &pid) && pid == item.pid;
}

int WindowThumbnails::Rank(const Item& item) const {
  if (!selected_.empty() && item.id == selected_) return -1;
  auto it = std::find(visible_.begin(), visible_.end(), item.id);
  if (it != visible_.end()) return static_cast<int>(it - visible_.begin());
  return 1000 + item.order;
}

void WindowThumbnails::Watch(int64_t now) {
  for (size_t i = 0; i < items_.size(); ++i) {
    Item& item = items_[i];
    bool exists = Exists(item), shown = exists && IsWindowVisible(item.hwnd);
    if (item.state == State::Closed) {
      if (shown && item.stage == "hidden") {  // a hidden window came back
        LogFile("thumb", Printf("gen %d %s %s: shown again", generation_, item.id.c_str(), item.exe.c_str()));
        item.minimized = IsIconic(item.hwnd) != FALSE;
        NewJob(item, now, true);
      }
      continue;
    }
    if (!shown) {
      CancelAttempts(i);
      item.state = State::Closed;
      item.stage = exists ? "hidden" : "closed";
      PostState(item);
      LogFile("thumb", Printf("gen %d %s %s: window %s", generation_, item.id.c_str(), item.exe.c_str(), exists ? "hidden" : "closed"));
      continue;
    }
    bool minimized = IsIconic(item.hwnd) != FALSE;
    if (minimized == item.minimized) continue;
    item.minimized = minimized;
    LogFile("thumb", Printf("gen %d %s %s: %s", generation_, item.id.c_str(), item.exe.c_str(), minimized ? "minimized" : "restored"));
    if (minimized && item.state == State::Ready) {
      item.state = State::Minimized;  // the card keeps the image taken while the window was shown
      PostState(item);
    } else {
      // Restored: a new image from the window itself. Minimized while loading or after a failure: the minimized path.
      CancelAttempts(i);
      NewJob(item, now, true);
    }
  }
}

void WindowThumbnails::StartAttempts(int64_t now, FrameConverter&) {
  // Nothing new starts while the app itself is minimized or hidden: the list cannot be seen.
  if (!IsWindowVisible(appWindow_) || IsIconic(appWindow_)) return;
  while (static_cast<int>(active_.size()) < cfg_.concurrency) {
    Item* best = nullptr;
    for (auto& item : items_) {
      bool ready = item.state == State::Queued || (item.state == State::Retrying && item.nextAt <= now);
      if (!ready) continue;
      size_t index = static_cast<size_t>(&item - items_.data());
      if (std::any_of(active_.begin(), active_.end(), [&](const Attempt& a) { return a.item == index; })) continue;
      if (!best || Rank(item) < Rank(*best)) best = &item;
    }
    if (!best) break;
    Attempt attempt;
    attempt.item = static_cast<size_t>(best - items_.data());
    if (StartAttempt(*best, attempt, now)) active_.push_back(std::move(attempt));
  }
}

bool WindowThumbnails::StartAttempt(Item& item, Attempt& a, int64_t now) {
  if (!Exists(item) || !IsWindowVisible(item.hwnd)) {
    item.state = State::Closed;
    item.stage = Exists(item) ? "hidden" : "closed";
    PostState(item);
    return false;
  }
  item.minimized = IsIconic(item.hwnd) != FALSE;
  item.excluded = ExcludedFromCapture(item.hwnd);
  if (item.attempts == 0) {
    item.startedAt = now;
    item.queueMs = now - item.queuedAt;
  }
  ++item.attempts;
  if (item.attempts == 1) {
    item.state = State::Loading;  // later attempts keep showing the retry state
    PostState(item);
  }
  if (item.excluded) {
    // The app keeps this window out of captures (measured: Windows Graphics Capture delivers no frame, its DWM thumbnail
    // is black). A known, lasting state: no attempts, no retries, and no other path around the app's choice.
    item.state = item.minimized ? State::Minimized : State::Excluded;
    item.stage = "excluded";
    PostState(item);
    LogFile("thumb", Printf("gen %d req %d %s %s%s: excluded from capture by the app (display affinity); no attempt", generation_, item.req, item.id.c_str(), item.exe.c_str(),
                            item.minimized ? " minimized" : ""));
    return false;
  }
  // Windows Graphics Capture delivers no frames for a minimized window, so its DWM thumbnail is used. A shown window is
  // captured itself (the same path and crop as the broadcast); its second attempt uses the DWM thumbnail instead.
  a.dwm = item.minimized || item.attempts == 2;
  a.startedAt = now;
  a.until = std::min<int64_t>(now + cfg_.firstFrameMs, item.startedAt + cfg_.deadlineMs);
  a.capture = std::make_unique<WindowCapture>(gpu_);
  std::string error;
  if (!a.dwm) {
    if (a.capture->Start(item.hwnd, false, error)) return true;
    Fail(item, &a, now, "capture-start", error);
    EndAttempt(a);
    return false;
  }
  for (int slot = 0; slot < cfg_.concurrency && a.slot < 0; ++slot)
    if (std::none_of(active_.begin(), active_.end(), [&](const Attempt& other) { return other.dwm && other.slot == slot; })) a.slot = slot;
  HWND helper = a.slot >= 0 ? Helper(a.slot) : nullptr;
  HRESULT hr = helper ? DwmRegisterThumbnail(helper, item.hwnd, &a.thumb) : E_HANDLE;
  if (FAILED(hr)) {
    a.thumb = nullptr;
    Fail(item, &a, now, "dwm-register", helper ? HrMessage(hr) : "helper window: " + LastErrorMessage());
    EndAttempt(a);
    return false;
  }
  SIZE source{};
  DwmQueryThumbnailSourceSize(a.thumb, &source);
  SIZE client = ClientSize(item.hwnd);
  if (client.cx >= 2 && client.cy >= 2) source = client;  // a shown window: the real aspect of its content
  if (source.cx < 2 || source.cy < 2) {
    Fail(item, &a, now, "dwm-size", Printf("source %ldx%ld", source.cx, source.cy));
    EndAttempt(a);
    return false;
  }
  UINT sw = static_cast<UINT>(source.cx), sh = static_cast<UINT>(source.cy);
  RECT fit = FitRect(sw, sh, std::min(thumbW_, sw), std::min(thumbH_, sh));
  int w = fit.right - fit.left, h = fit.bottom - fit.top;
  SetWindowPos(helper, nullptr, 0, 0, w, h, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  DWM_THUMBNAIL_PROPERTIES props{};
  props.dwFlags = DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY;
  props.rcDestination = RECT{0, 0, w, h};
  props.fVisible = TRUE;
  props.opacity = 255;
  props.fSourceClientAreaOnly = TRUE;
  hr = DwmUpdateThumbnailProperties(a.thumb, &props);
  if (FAILED(hr)) {
    Fail(item, &a, now, "dwm-update", HrMessage(hr));
    EndAttempt(a);
    return false;
  }
  DwmFlush();
  a.capture->SetClientCrop(false);
  if (a.capture->Start(helper, false, error)) return true;
  Fail(item, &a, now, "dwm-capture-start", error);
  EndAttempt(a);
  return false;
}

bool WindowThumbnails::Advance(Attempt& a, FrameConverter& converter, int64_t now) {
  Item& item = items_[a.item];
  if (!Exists(item) || (!a.dwm && a.capture->Closed())) {
    item.state = State::Closed;
    item.stage = "closed";
    PostState(item);
    LogAttempt(item, a, now, "window closed");
    return true;
  }
  const bool held = item.faulty && (fault_.mode == "drop" || (fault_.mode == "delay" && now - item.startedAt < fault_.ms));
  if (!held && a.capture->FrameCount() > 0) {
    std::vector<uint8_t> bgr;
    UINT w = 0, h = 0;
    bool converted = false;
    std::string error;
    bool have = a.capture->WithLatest([&](ID3D11Texture2D* texture, UINT sw, UINT sh, uint64_t) { converted = converter.ToBgr(gpu_, texture, sw, sh, thumbW_, thumbH_, bgr, w, h, error); });
    if (have) {
      if (!converted) {
        Fail(item, &a, now, "convert", error);
        return true;
      }
      if (a.dwm && ShareNear(bgr, w, h, kHelperB, kHelperG, kHelperR, 24) > 0.9) {
        // The helper was captured before the thumbnail was composed: wait for the next frame.
        ++a.emptyFrames;
        if (now < a.until) return false;
        Fail(item, &a, now, "dwm-empty", "");
        return true;
      }
      if (a.dwm && item.minimized && ShareNear(bgr, w, h, 0, 0, 0, 1) > 0.999) {
        // Nothing left to show: Chromium-based apps (Edge, Chrome, Electron) drop their drawing a few seconds after they
        // are minimized, and the DWM thumbnail is then all zero (measured). That is not a picture of the window, so none
        // is shown; the window's own capture gives one again when it is shown.
        item.state = State::Minimized;
        item.stage = "minimized-empty";
        PostState(item);
        LogAttempt(item, a, now, "minimized, nothing drawn (all-zero thumbnail)");
        return true;
      }
      // A black image is a frame like any other (a dark window is not a capture failure); it is only noted in the log.
      bool black = ShareNear(bgr, w, h, 0, 0, 0, 8) > 0.98;
      std::string jpeg;
      if (!EncodeJpeg(bgr, w, h, 0.8f, jpeg)) {
        Fail(item, &a, now, "jpeg", "");
        return true;
      }
      std::string data = item.faulty && fault_.mode == "corrupt" ? Base64("not a jpeg image") : Base64(jpeg);
      // A minimized window's DWM thumbnail is the last thing it drew before it was minimized: not a current image.
      const bool live = !item.minimized;
      PostUi({{"type", "thumb"}, {"gen", generation_}, {"id", item.id}, {"req", item.req}, {"jpeg", data}, {"source", item.minimized ? "minimized" : a.dwm ? "dwm" : "capture"},
              {"fresh", live}, {"black", black}, {"attempt", item.attempts}, {"ms", now - item.queuedAt}});
      if (live && cfg_.cacheMs > 0) cache_[item.id] = Cached{data, now};
      item.state = item.excluded ? State::Excluded : item.minimized ? State::Minimized : State::Ready;
      item.stage = item.excluded ? "excluded" : "";
      PostState(item);
      LogAttempt(item, a, now, std::string(black ? "image, black content" : "image") + Printf(" %ux%u", w, h));
      return true;
    }
  }
  if (now >= a.until) {
    Fail(item, &a, now, a.dwm ? "dwm-timeout" : "first-frame-timeout", "");
    return true;
  }
  return false;
}

void WindowThumbnails::Fail(Item& item, const Attempt* a, int64_t now, const std::string& stage, const std::string& error) {
  item.stage = stage;
  item.error = error;
  const int64_t deadline = item.startedAt + cfg_.deadlineMs;
  std::string next;
  if (item.attempts < cfg_.attempts) {
    int delay = cfg_.retryDelaysMs[std::min<size_t>(static_cast<size_t>(item.attempts - 1), cfg_.retryDelaysMs.size() - 1)];
    // The window's deadline wins over the remaining attempts.
    if (now + delay < deadline) {
      item.state = State::Retrying;
      item.nextAt = now + delay;
      next = Printf("retry in %d ms", delay);
    }
  }
  if (next.empty()) {
    bool timeout = stage == "first-frame-timeout" || stage == "dwm-timeout" || stage == "dwm-empty";
    item.state = item.minimized ? State::Minimized : timeout ? State::Timeout : State::Failed;
    next = std::string("final ") + StateName(static_cast<int>(item.state));
  }
  if (a) LogAttempt(item, *a, now, stage + (error.empty() ? "" : " (" + error + ")") + ", " + next);
  PostState(item);
}

void WindowThumbnails::EndAttempt(Attempt& a) {
  if (a.capture) {
    a.capture->Stop();
    a.capture.reset();
  }
  if (a.thumb) {
    DwmUnregisterThumbnail(a.thumb);
    a.thumb = nullptr;
  }
}

void WindowThumbnails::CancelAttempts(size_t index) {
  for (size_t i = 0; i < active_.size();) {
    if (active_[i].item == index) {
      EndAttempt(active_[i]);
      active_.erase(active_.begin() + static_cast<std::ptrdiff_t>(i));
    } else {
      ++i;
    }
  }
}

void WindowThumbnails::PostState(const Item& item) {
  json event = {{"type", "thumbState"}, {"gen", generation_}, {"id", item.id}, {"req", item.req}, {"state", StateName(static_cast<int>(item.state))},
                {"attempt", item.attempts}, {"attempts", cfg_.attempts}};
  if (!item.stage.empty()) event["stage"] = item.stage;
  PostUi(event);
}

void WindowThumbnails::LogAttempt(const Item& item, const Attempt& a, int64_t now, const std::string& result) {
  LogFile("thumb", Printf("gen %d req %d %s %s%s%s attempt %d/%d via %s: %s (queue %lld ms, attempt %lld ms, job %lld ms%s)", generation_, item.req, item.id.c_str(),
                          item.exe.c_str(), item.minimized ? " minimized" : "", item.excluded ? " capture-excluded" : "", item.attempts, cfg_.attempts,
                          a.dwm ? "dwm-thumbnail" : "capture", result.c_str(), item.queueMs, now - a.startedAt, now - item.startedAt,
                          a.emptyFrames ? Printf(", %d uncomposed frames", a.emptyFrames).c_str() : ""));
}

HWND WindowThumbnails::Helper(int slot) {
  static const bool registered = [] {
    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hbrBackground = CreateSolidBrush(RGB(kHelperR, kHelperG, kHelperB));
    wc.lpszClassName = kHelperClass;
    return RegisterClassExW(&wc) != 0;
  }();
  if (!registered) return nullptr;
  if (static_cast<int>(helpers_.size()) <= slot) helpers_.resize(static_cast<size_t>(slot) + 1, nullptr);
  if (helpers_[slot]) return helpers_[slot];
  // Cloaked before it is shown: never on screen, in the taskbar or in Alt+Tab, yet DWM still composes it for capture.
  HWND h = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kHelperClass, L"", WS_POPUP, 0, 0, 16, 16, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!h) return nullptr;
  BOOL cloak = TRUE;
  DwmSetWindowAttribute(h, DWMWA_CLOAK, &cloak, sizeof(cloak));
  ShowWindow(h, SW_SHOWNOACTIVATE);
  helpers_[slot] = h;
  return h;
}

}  // namespace fc
