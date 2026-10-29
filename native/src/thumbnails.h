// Window-picker thumbnails (송출 대상 선택 → 프로그램 창). The window list is shown at once; this fills in the images in
// the background without blocking the dialog: a few windows at a time (cards on screen and the selected one first), each
// waiting for its first capture frame on the frame event within a deadline, with limited retries, an alternative path
// for windows that Windows Graphics Capture cannot deliver (minimized ones) and a final state for every window.
#pragma once

#include "capture.h"
#include "config.h"

#include <dwmapi.h>

#include <map>
#include <tuple>

namespace fc {

class WindowThumbnails {
 public:
  WindowThumbnails(Gpu& gpu, bool gpuReady, HWND appWindow);
  ~WindowThumbnails();
  void Configure(const WindowPreviewSettings& settings);
  // A new list (generation) replaces the previous one: its work is cancelled and its late results never reach the UI.
  // thumbWidth: the card's thumbnail width in device pixels (16:9 box), so the image is not stretched up.
  void Open(int generation, const std::vector<SourceWindow>& windows, int thumbWidth);
  // Cards now on screen (in order) and the selected card: these are captured first.
  void Prioritize(int generation, std::vector<std::string> visible, std::string selected);
  // Manual retry of a window whose automatic attempts are used up.
  void Retry(int generation, const std::string& id);
  // The UI could not show an image the native side delivered: the window counts as failed (and can be retried).
  void ShowFailed(int generation, const std::string& id, int request);
  // The dialog closed: cancel every attempt and release captures, helper windows and GPU resources.
  void Close();

 private:
  enum class State { Queued, Loading, Retrying, Ready, Minimized, Timeout, Failed, Closed, Excluded };
  struct Item {
    std::string id, exe;
    HWND hwnd = nullptr;
    DWORD pid = 0;
    int order = 0;
    State state = State::Queued;
    bool minimized = false;
    bool excluded = false;  // the app excludes the window from capture (display affinity): no alternative path
    bool faulty = false;    // matched by the test hook below
    int req = 0;            // request id of the current job; a restore or a manual retry starts a new one
    int attempts = 0;       // attempts started in the current job
    int64_t queuedAt = 0, startedAt = 0, nextAt = 0, queueMs = -1;
    std::string stage;      // last failure stage of the job
    std::string error;      // and its system message / HRESULT, for the log only
  };
  struct Attempt {
    size_t item = 0;
    bool dwm = false;  // the window's DWM thumbnail drawn into a cloaked helper window, captured there
    int slot = -1;     // helper window
    HTHUMBNAIL thumb = nullptr;
    std::unique_ptr<WindowCapture> capture;
    int64_t startedAt = 0, until = 0;
    int emptyFrames = 0;
  };
  struct Commands {
    bool quit = false, close = false;
    std::unique_ptr<std::pair<int, std::vector<SourceWindow>>> open;
    int thumbWidth = 480;
    int priorityGeneration = 0;
    std::vector<std::string> visible;
    std::string selected;
    bool priority = false;
    std::vector<std::pair<int, std::string>> retries;
    std::vector<std::tuple<int, std::string, int>> showFailures;
  };
  // Test hook, off unless the variable is set: FRAME_CONSOLE_THUMB_FAULT=<mode>:<ms>:<title prefix>, mode delay (frames
  // of matching windows are ignored for ms after the job's first attempt), drop (always ignored) or corrupt (the UI gets
  // an image it cannot decode). Logged at every list; used to check the retry and failure paths on demand.
  struct Fault {
    std::string mode;
    int ms = 0;
    std::wstring prefix;
  };
  struct Cached {
    std::string jpeg;  // base64
    int64_t at = 0;
  };

  void Run();
  void BeginSession(int generation, const std::vector<SourceWindow>& windows, int64_t now);
  void EndSession(const char* reason);
  void Watch(int64_t now);
  void StartAttempts(int64_t now, FrameConverter& converter);
  bool StartAttempt(Item& item, Attempt& attempt, int64_t now);
  // True when the attempt ended (image, failure or cancellation).
  bool Advance(Attempt& attempt, FrameConverter& converter, int64_t now);
  void EndAttempt(Attempt& attempt);
  void CancelAttempts(size_t item);
  // Schedules the next attempt within the window's deadline, or sets the final state.
  void Fail(Item& item, const Attempt* attempt, int64_t now, const std::string& stage, const std::string& error);
  void NewJob(Item& item, int64_t now, bool post);
  void PostState(const Item& item);
  void LogAttempt(const Item& item, const Attempt& attempt, int64_t now, const std::string& result);
  HWND Helper(int slot);
  bool Exists(const Item& item) const;
  int Rank(const Item& item) const;

  Gpu& gpu_;
  const bool gpuReady_;
  const HWND appWindow_;
  std::thread thread_;
  ScopedHandle wake_;
  std::mutex mutex_;
  Commands commands_;
  WindowPreviewSettings next_;

  // Worker thread only.
  WindowPreviewSettings cfg_;
  UINT thumbW_ = 480, thumbH_ = 270;  // largest image of this list (fits the card's 16:9 box)
  int generation_ = 0;
  bool session_ = false;
  int64_t sessionAt_ = 0, nextWatch_ = 0;
  int requests_ = 0;
  std::vector<Item> items_;
  std::vector<Attempt> active_;
  std::vector<std::string> visible_;
  std::string selected_;
  std::vector<HWND> helpers_;
  std::map<std::string, Cached> cache_;
  Fault fault_;
};

}  // namespace fc
