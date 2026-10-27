#include "child_process.h"

namespace fc {

static HANDLE AppJob() {
  static HANDLE job = [] {
    HANDLE h = CreateJobObjectW(nullptr, nullptr);
    if (h) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info, sizeof(info));
    }
    return h;
  }();
  return job;
}

// CommandLineToArgvW-compatible quoting.
std::wstring QuoteArg(const std::wstring& arg) {
  if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) return arg;
  std::wstring out = L"\"";
  for (size_t i = 0;; ++i) {
    size_t backslashes = 0;
    while (i < arg.size() && arg[i] == L'\\') {
      ++i;
      ++backslashes;
    }
    if (i == arg.size()) {
      out.append(backslashes * 2, L'\\');
      break;
    }
    if (arg[i] == L'"') {
      out.append(backslashes * 2 + 1, L'\\');
      out += L'"';
    } else {
      out.append(backslashes, L'\\');
      out += arg[i];
    }
  }
  out += L'"';
  return out;
}

ChildProcess::~ChildProcess() {
  Terminate();
  if (outThread_.joinable()) outThread_.join();
  if (errThread_.joinable()) errThread_.join();
}

bool ChildProcess::Start(const fs::path& exe, const std::vector<std::wstring>& args, const fs::path& workDir, LineHandler onStdout,
                         LineHandler onStderr, std::string& error) {
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE outRead = nullptr, outWrite = nullptr, errRead = nullptr, errWrite = nullptr;
  if (!CreatePipe(&outRead, &outWrite, &sa, 0) || !CreatePipe(&errRead, &errWrite, &sa, 0)) {
    error = "프로세스 출력 파이프를 만들 수 없습니다: " + LastErrorMessage();
    return false;
  }
  SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
  ScopedHandle nul(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr));

  // Only the three standard handles are inherited; pipe servers and sockets of this process stay private.
  HANDLE inherit[3] = {nul.Get(), outWrite, errWrite};
  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  std::vector<unsigned char> attrBuffer(attrSize);
  auto* attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuffer.data());
  InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize);
  UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit), nullptr, nullptr);

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = nul.Get();
  si.StartupInfo.hStdOutput = outWrite;
  si.StartupInfo.hStdError = errWrite;
  std::wstring commandLine = QuoteArg(exe.wstring());
  for (const auto& a : args) commandLine += L" " + QuoteArg(a);
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(exe.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
                           CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, nullptr,
                           workDir.empty() ? nullptr : workDir.c_str(), &si.StartupInfo, &pi);
  DWORD createError = GetLastError();
  DeleteProcThreadAttributeList(attrs);
  CloseHandle(outWrite);
  CloseHandle(errWrite);
  if (!ok) {
    CloseHandle(outRead);
    CloseHandle(errRead);
    error = "프로그램을 실행할 수 없습니다 (" + Utf8(exe.filename().wstring()) + "): " + LastErrorMessage(createError);
    return false;
  }
  if (AppJob() && !AssignProcessToJobObject(AppJob(), pi.hProcess)) LogFile("process", "AssignProcessToJobObject failed: " + LastErrorMessage());
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  process_.Reset(pi.hProcess);
  pid_ = pi.dwProcessId;
  LogFile("process", "started pid " + std::to_string(pid_) + ": " + Utf8(commandLine));
  outThread_ = std::thread([this, outRead, onStdout] { ReadLoop(outRead, onStdout, false); });
  errThread_ = std::thread([this, errRead, onStderr] { ReadLoop(errRead, onStderr, true); });
  return true;
}

void ChildProcess::ReadLoop(HANDLE pipe, LineHandler handler, bool keepTail) {
  std::string pending;
  char buffer[4096];
  DWORD read = 0;
  auto emit = [&](std::string line) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
    if (line.empty()) return;
    if (keepTail) {
      std::lock_guard<std::mutex> lock(tailMutex_);
      tail_.push_back(line);
      if (tail_.size() > 40) tail_.erase(tail_.begin());
    }
    if (handler) handler(line);
  };
  while (ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
    pending.append(buffer, read);
    size_t pos;
    while ((pos = pending.find_first_of("\r\n")) != std::string::npos) {
      emit(pending.substr(0, pos));
      pending.erase(0, pos + 1);
    }
    if (pending.size() > 65536) pending.clear();
  }
  emit(pending);
  CloseHandle(pipe);
}

bool ChildProcess::Running() const { return process_.Valid() && WaitForSingleObject(process_.Get(), 0) == WAIT_TIMEOUT; }

bool ChildProcess::Wait(DWORD milliseconds) { return !process_.Valid() || WaitForSingleObject(process_.Get(), milliseconds) == WAIT_OBJECT_0; }

void ChildProcess::Terminate() {
  if (Running()) {
    LogFile("process", "terminating pid " + std::to_string(pid_));
    TerminateProcess(process_.Get(), 1);
    WaitForSingleObject(process_.Get(), 5000);
  }
}

DWORD ChildProcess::ExitCode() const {
  DWORD code = STILL_ACTIVE;
  if (process_.Valid()) GetExitCodeProcess(process_.Get(), &code);
  return code;
}

std::vector<std::string> ChildProcess::Tail() const {
  std::lock_guard<std::mutex> lock(tailMutex_);
  return tail_;
}

}  // namespace fc
