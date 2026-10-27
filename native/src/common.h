// Shared helpers for the FRAME Console host: string conversion, paths, logging and UI event posting.
#pragma once

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <unknwn.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

namespace fc {

using json = nlohmann::json;
namespace fs = std::filesystem;

constexpr const char* kVersion = "0.5.0";
constexpr UINT WM_APP_UI_EVENT = WM_APP + 1;
constexpr UINT WM_APP_PREVIEW = WM_APP + 2;
constexpr UINT WM_APP_FULLSCREEN = WM_APP + 3;

std::string Utf8(const std::wstring& value);
std::wstring Wide(const std::string& value);
std::string Printf(const char* format, ...);
std::string HrMessage(HRESULT hr);
std::string LastErrorMessage(DWORD error = GetLastError());

fs::path ExeDir();
fs::path DataDir();
fs::path LogDir();
fs::path RuntimeDir();

int64_t QpcNow();
int64_t QpcFrequency();
double QpcSeconds(int64_t ticks);
int64_t EpochMillis();
std::string ClockText();

// File log shared by every component. Thread safe.
void LogFile(const std::string& category, const std::string& message);

// Events for the UI thread. Safe to call from any thread.
void SetUiWindow(HWND hwnd);
void PostUi(const json& event);
// Writes to the file log and the UI event table.
void UiLog(const std::string& kind, const std::string& message);

// Single-thread task queue used for blocking work that must not run on the UI thread.
class TaskQueue {
 public:
  explicit TaskQueue(const char* name);
  ~TaskQueue();
  void Post(std::function<void()> task);
  void Shutdown();

 private:
  void Run();
  std::string name_;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::vector<std::function<void()>> tasks_;
  bool stopping_ = false;
  std::thread thread_;
};

class ScopedHandle {
 public:
  ScopedHandle() = default;
  explicit ScopedHandle(HANDLE h) : h_(h) {}
  ~ScopedHandle() { Reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : h_(other.Release()) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) Reset(other.Release());
    return *this;
  }
  HANDLE Get() const { return h_; }
  bool Valid() const { return h_ != nullptr && h_ != INVALID_HANDLE_VALUE; }
  HANDLE Release() {
    HANDLE h = h_;
    h_ = nullptr;
    return h;
  }
  void Reset(HANDLE h = nullptr) {
    if (Valid()) CloseHandle(h_);
    h_ = h;
  }

 private:
  HANDLE h_ = nullptr;
};

}  // namespace fc
