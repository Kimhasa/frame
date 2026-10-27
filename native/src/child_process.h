// Child processes started by FRAME Console (FFmpeg, MediaMTX). Every child joins one Job Object so it ends with the app,
// even after a crash; shutdown only touches handles this process created.
#pragma once

#include "common.h"

namespace fc {

class ChildProcess {
 public:
  using LineHandler = std::function<void(const std::string& line)>;
  ChildProcess() = default;
  ~ChildProcess();
  ChildProcess(const ChildProcess&) = delete;
  ChildProcess& operator=(const ChildProcess&) = delete;

  bool Start(const fs::path& exe, const std::vector<std::wstring>& args, const fs::path& workDir, LineHandler onStdout, LineHandler onStderr,
             std::string& error);
  bool Running() const;
  bool Wait(DWORD milliseconds);
  void Terminate();
  DWORD ExitCode() const;
  DWORD Pid() const { return pid_; }
  // Last stderr lines, kept for error messages.
  std::vector<std::string> Tail() const;

 private:
  void ReadLoop(HANDLE pipe, LineHandler handler, bool keepTail);
  ScopedHandle process_;
  DWORD pid_ = 0;
  std::thread outThread_, errThread_;
  mutable std::mutex tailMutex_;
  std::vector<std::string> tail_;
};

std::wstring QuoteArg(const std::wstring& arg);

}  // namespace fc
