#include "common.h"

#include <shlobj.h>

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <fstream>

namespace fc {

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring out(size, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size);
  return out;
}

std::string Printf(const char* format, ...) {
  va_list args;
  va_start(args, format);
  char buffer[2048];
  int n = vsnprintf(buffer, sizeof(buffer), format, args);
  va_end(args);
  if (n < 0) return {};
  return std::string(buffer, static_cast<size_t>(std::min<int>(n, sizeof(buffer) - 1)));
}

static std::string SystemMessage(DWORD code) {
  wchar_t* text = nullptr;
  DWORD len = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, code,
                             0, reinterpret_cast<wchar_t*>(&text), 0, nullptr);
  std::wstring message = len && text ? std::wstring(text, len) : L"";
  if (text) LocalFree(text);
  while (!message.empty() && (message.back() == L'\n' || message.back() == L'\r' || message.back() == L' ')) message.pop_back();
  return Utf8(message);
}

std::string HrMessage(HRESULT hr) { return Printf("0x%08X ", static_cast<unsigned>(hr)) + SystemMessage(static_cast<DWORD>(hr)); }
std::string LastErrorMessage(DWORD error) { return Printf("%lu ", error) + SystemMessage(error); }

fs::path ExeDir() {
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    DWORD n = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (n < buffer.size()) {
      buffer.resize(n);
      break;
    }
    buffer.resize(buffer.size() * 2);
  }
  return fs::path(buffer).parent_path();
}

static bool DirectoryWritable(const fs::path& dir) {
  std::error_code ec;
  fs::create_directories(dir, ec);
  fs::path probe = dir / L".write-test";
  HANDLE h = CreateFileW(probe.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  CloseHandle(h);
  return true;
}

fs::path DataDir() {
  static const fs::path dir = [] {
    // Portable folder deployment keeps data next to the exe; a read-only install falls back to the user profile.
    fs::path local = ExeDir() / L"data";
    if (DirectoryWritable(local)) return local;
    PWSTR appData = nullptr;
    fs::path fallback = L".";
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &appData))) fallback = fs::path(appData) / L"FrameConsole";
    CoTaskMemFree(appData);
    std::error_code ec;
    fs::create_directories(fallback, ec);
    return fallback;
  }();
  return dir;
}

fs::path LogDir() {
  fs::path dir = DataDir() / L"logs";
  std::error_code ec;
  fs::create_directories(dir, ec);
  return dir;
}

fs::path RuntimeDir() {
  fs::path dir = DataDir() / L"runtime";
  std::error_code ec;
  fs::create_directories(dir, ec);
  return dir;
}

int64_t QpcNow() {
  LARGE_INTEGER v;
  QueryPerformanceCounter(&v);
  return v.QuadPart;
}

int64_t QpcFrequency() {
  static const int64_t f = [] {
    LARGE_INTEGER v;
    QueryPerformanceFrequency(&v);
    return v.QuadPart;
  }();
  return f;
}

double QpcSeconds(int64_t ticks) { return static_cast<double>(ticks) / static_cast<double>(QpcFrequency()); }

int64_t EpochMillis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string ClockText() {
  SYSTEMTIME t;
  GetLocalTime(&t);
  return Printf("%02u:%02u:%02u", t.wHour, t.wMinute, t.wSecond);
}

namespace {
std::mutex g_logMutex;
std::ofstream g_logStream;
HWND g_uiWindow = nullptr;

void OpenLogIfNeeded() {
  if (g_logStream.is_open()) return;
  SYSTEMTIME t;
  GetLocalTime(&t);
  fs::path file = LogDir() / Wide(Printf("frame-console-%04u%02u%02u-%02u%02u%02u.log", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond));
  g_logStream.open(file, std::ios::out | std::ios::binary | std::ios::app);
}
}  // namespace

void LogFile(const std::string& category, const std::string& message) {
  SYSTEMTIME t;
  GetLocalTime(&t);
  std::lock_guard<std::mutex> lock(g_logMutex);
  OpenLogIfNeeded();
  if (!g_logStream) return;
  g_logStream << Printf("%04u-%02u-%02u %02u:%02u:%02u.%03u [", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds)
              << category << "] " << message << "\n";
  g_logStream.flush();
}

void SetUiWindow(HWND hwnd) { g_uiWindow = hwnd; }

void PostUi(const json& event) {
  HWND hwnd = g_uiWindow;
  if (!hwnd) return;
  auto* payload = new std::string(event.dump(-1, ' ', false, json::error_handler_t::replace));
  if (!PostMessageW(hwnd, WM_APP_UI_EVENT, 0, reinterpret_cast<LPARAM>(payload))) delete payload;
}

void UiLog(const std::string& kind, const std::string& message) {
  LogFile(kind, message);
  PostUi({{"type", "log"}, {"kind", kind}, {"message", message}});
}

TaskQueue::TaskQueue(const char* name) : name_(name), thread_([this] { Run(); }) {}

TaskQueue::~TaskQueue() { Shutdown(); }

void TaskQueue::Post(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_) return;
    tasks_.push_back(std::move(task));
  }
  cv_.notify_one();
}

void TaskQueue::Shutdown() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable() && thread_.get_id() != std::this_thread::get_id()) thread_.join();
}

void TaskQueue::Run() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  for (;;) {
    std::vector<std::function<void()>> batch;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
      if (tasks_.empty() && stopping_) break;
      batch.swap(tasks_);
    }
    for (auto& task : batch) {
      try {
        task();
      } catch (const std::exception& e) {
        LogFile("task", name_ + " task failed: " + e.what());
      } catch (...) {
        LogFile("task", name_ + " task failed with an unknown error");
      }
    }
  }
  CoUninitialize();
}

}  // namespace fc
