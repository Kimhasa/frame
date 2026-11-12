#include "streamer.h"

#include <avrt.h>
#include <bcrypt.h>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <set>
#include <sstream>

#include "http_client.h"

namespace fc {

namespace {

// H.264 settings shared by the main stream, the on-demand qualities and the encoder probe.
// rateControl "vbr": quality-targeted variable bitrate capped at mbps (static screens use far fewer bits, motion is capped);
// "cbr": constant mbps. Intel QSV and AMD AMF always use CBR here (their capped-quality modes were not validated).
std::vector<std::string> VideoEncoderArgs(const std::string& encoder, int fps, double mbps, const std::string& rateControl) {
  std::string kbps = std::to_string(static_cast<int>(std::lround(mbps * 1000))) + "k";
  std::string gop = std::to_string(fps);  // one IDR per second so new viewers and quality switches start quickly
  bool vbr = rateControl == "vbr";
  std::vector<std::string> a;
  if (encoder == "h264_nvenc") {
    a = {"-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-profile:v", "high", "-zerolatency", "1", "-delay", "0", "-rc-lookahead", "0",
         "-no-scenecut", "1", "-forced-idr", "1", "-spatial-aq", "1", "-aq-strength", "8"};
    if (vbr) a.insert(a.end(), {"-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", kbps, "-bufsize", kbps});
    else a.insert(a.end(), {"-rc", "cbr", "-b:v", kbps, "-maxrate", kbps, "-bufsize", kbps});
  } else if (encoder == "h264_qsv") {
    a = {"-c:v", "h264_qsv", "-preset", "veryfast", "-profile:v", "high", "-look_ahead", "0", "-async_depth", "1", "-low_delay_brc", "1", "-forced_idr", "1",
         "-b:v", kbps, "-maxrate", kbps, "-bufsize", kbps};
  } else if (encoder == "h264_amf") {
    a = {"-c:v", "h264_amf", "-usage", "ultralowlatency", "-quality", "speed", "-profile:v", "high", "-rc", "cbr", "-header_insertion_mode", "idr",
         "-b:v", kbps, "-maxrate", kbps, "-bufsize", kbps};
  } else {
    a = {"-c:v", "libx264", "-preset", fps > 90 ? "superfast" : "veryfast", "-tune", "zerolatency", "-profile:v", "high", "-sc_threshold", "0"};
    if (vbr) a.insert(a.end(), {"-crf", "23", "-maxrate", kbps, "-bufsize", kbps});
    else a.insert(a.end(), {"-b:v", kbps, "-maxrate", kbps, "-bufsize", kbps});
  }
  // No B-frames: browsers' WebRTC H.264 decoders do not accept them.
  std::vector<std::string> common = {"-bf", "0", "-g", gop, "-keyint_min", gop, "-pix_fmt", "nv12", "-colorspace", "bt709", "-color_primaries", "bt709",
                                     "-color_trc", "bt709", "-color_range", "tv"};
  a.insert(a.end(), common.begin(), common.end());
  return a;
}


// AAC-LC track for HLS (every browser viewer) and the recording; the Opus track stays first for WebRTC.
constexpr int kAacKbps = 128;
// HLS DVR media segments: consecutive recorded parts, each segment starting with a video sync sample, about this long.
constexpr double kDvrSegmentSeconds = 4.0;

// H.264 level_idc for a High-profile stream of this size, rate and bitrate (ITU-T H.264 Table A-1, MaxBR x1.25 for
// High). Used for the CODECS attribute when MediaMTX has not reported the real SPS yet.
int AvcLevelIdc(int width, int height, int fps, double mbps) {
  struct Level {
    int idc;
    double maxMbps, maxFs, maxKbps;
  };
  static const Level levels[] = {{10, 1485, 99, 64},          {11, 3000, 396, 192},         {12, 6000, 396, 384},
                                 {13, 11880, 396, 768},       {20, 11880, 396, 2000},       {21, 19800, 792, 4000},
                                 {22, 20250, 1620, 4000},     {30, 40500, 1620, 10000},     {31, 108000, 3600, 14000},
                                 {32, 216000, 5120, 20000},   {40, 245760, 8192, 20000},    {41, 245760, 8192, 50000},
                                 {42, 522240, 8704, 50000},   {50, 589824, 22080, 135000},  {51, 983040, 36864, 240000},
                                 {52, 2073600, 36864, 240000}, {60, 4177920, 139264, 240000}, {61, 8355840, 139264, 480000},
                                 {62, 16711680, 139264, 800000}};
  double fs = std::ceil(width / 16.0) * std::ceil(height / 16.0);
  for (const auto& l : levels)
    if (fs <= l.maxFs && fs * fps <= l.maxMbps && mbps * 1000 <= l.maxKbps * 1.25) return l.idc;
  return 62;
}

// "avc1.PPCCLL" from MediaMTX's track description of a path (tracks2[].codecProps when this MediaMTX reports them).
std::string AvcCodecFromApi(const json& item) {
  if (!item.is_object() || !item.contains("tracks2") || !item["tracks2"].is_array()) return "";
  for (const auto& t : item["tracks2"]) {
    if (!t.is_object() || t.value("codec", std::string()) != "H264" || !t.contains("codecProps") || !t["codecProps"].is_object()) continue;
    const json& p = t["codecProps"];
    std::string profile = p.value("profile", std::string()), level = p.value("level", std::string());
    static const std::map<std::string, int> profiles = {{"Baseline", 66}, {"Constrained Baseline", 66}, {"Main", 77}, {"Extended", 88},
                                                        {"High", 100},    {"High 10", 110},            {"High 4:2:2", 122}, {"High 4:4:4", 244}};
    auto it = profiles.find(profile);
    double l = level.empty() ? 0 : atof(level.c_str());
    if (it == profiles.end() || l <= 0) return "";
    int constraints = profile == "Constrained Baseline" ? 0x40 : 0;
    return Printf("avc1.%02x%02x%02x", it->second, constraints, static_cast<int>(std::lround(l * 10)));
  }
  return "";
}

std::string RandomHex(size_t bytes) {
  std::vector<unsigned char> buffer(bytes);
  BCryptGenRandom(nullptr, buffer.data(), static_cast<ULONG>(buffer.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  std::string out;
  for (unsigned char b : buffer) out += Printf("%02x", b);
  return out;
}

std::string ComputerName() {
  wchar_t name[256] = {};
  DWORD size = 256;
  if (!GetComputerNameExW(ComputerNameDnsHostname, name, &size)) return "FRAME";
  return Utf8(name);
}

std::string YamlQuote(const std::string& s) {
  std::string out = "'";
  for (char c : s) out += c == '\'' ? std::string("''") : std::string(1, c);
  return out + "'";
}

bool PortFree(int type, const char* ip, int port) {
  SOCKET s = socket(AF_INET, type, type == SOCK_STREAM ? IPPROTO_TCP : IPPROTO_UDP);
  if (s == INVALID_SOCKET) return false;
  BOOL exclusive = TRUE;
  setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  inet_pton(AF_INET, ip, &addr.sin_addr);
  bool ok = bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
  closesocket(s);
  return ok;
}

int FreeLoopbackPort() {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  int port = 0;
  if (bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
    int len = sizeof(addr);
    getsockname(s, reinterpret_cast<sockaddr*>(&addr), &len);
    port = ntohs(addr.sin_port);
  }
  closesocket(s);
  return port;
}

// Last FFmpeg/MediaMTX messages for an error report, without the expected notices about the streaming WAV input.
std::string JoinTail(const std::vector<std::string>& tail, size_t count) {
  std::vector<std::string> useful;
  for (const auto& line : tail)
    if (line.find("Ignoring maximum wav data size") == std::string::npos && line.find("Guessed Channel Layout") == std::string::npos) useful.push_back(line);
  std::string out;
  for (size_t i = useful.size() > count ? useful.size() - count : 0; i < useful.size(); ++i) out += (out.empty() ? "" : " / ") + useful[i];
  return out;
}

bool WaitUntilQpc(HANDLE timer, int64_t deadline, HANDLE stop) {
  for (;;) {
    int64_t now = QpcNow();
    int64_t remaining = deadline - now;
    if (remaining <= 0) return true;
    double ms = QpcSeconds(remaining) * 1000.0;
    if (ms > 1.5 && timer) {
      LARGE_INTEGER due;
      due.QuadPart = -static_cast<LONGLONG>((ms - 1.0) * 10000.0);
      SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
      HANDLE handles[2] = {timer, stop};
      if (WaitForMultipleObjects(2, handles, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) return false;
    } else if (ms > 0.2) {
      Sleep(0);
    } else {
      YieldProcessor();
    }
  }
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// NamedPipe

bool NamedPipe::Create(const std::wstring& name, DWORD bufferSize, std::string& error) {
  Close();
  name_ = name;
  pipe_.Reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                               PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, bufferSize, 0, 0, nullptr));
  if (!pipe_.Valid()) {
    error = "인코더 입력 파이프를 만들 수 없습니다: " + LastErrorMessage();
    return false;
  }
  event_.Reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  return true;
}

bool NamedPipe::Connect(HANDLE stop, DWORD timeoutMs) {
  OVERLAPPED ov{};
  ov.hEvent = event_.Get();
  ResetEvent(ov.hEvent);
  if (ConnectNamedPipe(pipe_.Get(), &ov)) return true;
  DWORD err = GetLastError();
  if (err == ERROR_PIPE_CONNECTED) return true;
  if (err != ERROR_IO_PENDING) return false;
  HANDLE handles[2] = {ov.hEvent, stop};
  DWORD w = WaitForMultipleObjects(2, handles, FALSE, timeoutMs);
  if (w != WAIT_OBJECT_0) {
    CancelIoEx(pipe_.Get(), &ov);
    DWORD ignored = 0;
    GetOverlappedResult(pipe_.Get(), &ov, &ignored, TRUE);
    return false;
  }
  DWORD ignored = 0;
  return GetOverlappedResult(pipe_.Get(), &ov, &ignored, FALSE) != FALSE;
}

bool NamedPipe::Write(const void* data, size_t size, HANDLE stop) {
  // Frames are written in 1 MB pieces: one multi-megabyte buffered pipe write needs kernel pool for the whole buffer
  // and fails with ERROR_NO_SYSTEM_RESOURCES under load, which would tear a frame and end the stream.
  constexpr size_t kChunk = 1024 * 1024;
  const char* p = static_cast<const char*>(data);
  int retries = 0;
  lastError_ = ERROR_SUCCESS;
  while (size > 0) {
    OVERLAPPED ov{};
    ov.hEvent = event_.Get();
    ResetEvent(ov.hEvent);
    DWORD chunk = static_cast<DWORD>(std::min(size, kChunk));
    DWORD written = 0;
    DWORD err = ERROR_SUCCESS;
    if (!WriteFile(pipe_.Get(), p, chunk, &written, &ov)) {
      err = GetLastError();
      if (err == ERROR_IO_PENDING) {
        HANDLE handles[2] = {ov.hEvent, stop};
        if (WaitForMultipleObjects(2, handles, FALSE, INFINITE) != WAIT_OBJECT_0) {
          CancelIoEx(pipe_.Get(), &ov);
          GetOverlappedResult(pipe_.Get(), &ov, &written, TRUE);
          return false;
        }
        err = GetOverlappedResult(pipe_.Get(), &ov, &written, FALSE) ? ERROR_SUCCESS : GetLastError();
      }
    }
    if ((err == ERROR_NO_SYSTEM_RESOURCES || err == ERROR_WORKING_SET_QUOTA) && retries < 50) {
      ++retries;
      if (WaitForSingleObject(stop, 2) == WAIT_OBJECT_0) return false;
      continue;
    }
    if (err != ERROR_SUCCESS) {
      lastError_ = err;
      LogFile("pipe", Utf8(name_) + " write failed: " + LastErrorMessage(err));
      return false;
    }
    if (retries) LogFile("pipe", Utf8(name_) + Printf(" write needed %d retries", retries));
    retries = 0;
    p += written;
    size -= written;
  }
  return true;
}

void NamedPipe::Close() {
  if (pipe_.Valid()) {
    FlushFileBuffers(pipe_.Get());
    DisconnectNamedPipe(pipe_.Get());
  }
  pipe_.Reset();
  event_.Reset();
}

// ---------------------------------------------------------------------------------------------
// Streamer

Streamer::Streamer(Gpu& gpu, TaskQueue& control) : gpu_(gpu), control_(control) {
  ffmpegExe_ = ExeDir() / L"bin" / L"ffmpeg.exe";
  mediamtxExe_ = ExeDir() / L"bin" / L"mediamtx.exe";
  stopEvent_.Reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
}

Streamer::~Streamer() { Stop("프로그램 종료", false); }

void Streamer::ProbeEncoders() {
  fs::path ffmpeg = ffmpegExe_;
  probe_ = std::async(std::launch::async, [ffmpeg] {
             CoInitializeEx(nullptr, COINIT_MULTITHREADED);
             EncoderProbe result;
             std::error_code ec;
             if (!fs::exists(ffmpeg, ec)) {
               result.notes.push_back("bin\\ffmpeg.exe가 없습니다.");
               return result;
             }
             auto run = [&](const std::vector<std::string>& args, std::string* output, DWORD timeout) {
               std::vector<std::wstring> wide;
               for (const auto& a : args) wide.push_back(Wide(a));
               ChildProcess p;
               std::string err;
               std::mutex m;
               auto collect = [&](const std::string& line) {
                 std::lock_guard<std::mutex> lock(m);
                 if (output) *output += line + "\n";
               };
               if (!p.Start(ffmpeg, wide, ffmpeg.parent_path(), collect, collect, err)) return -1;
               if (!p.Wait(timeout)) {
                 p.Terminate();
                 return -2;
               }
               return static_cast<int>(p.ExitCode());
             };
             std::string version, encoders;
             run({"-hide_banner", "-version"}, &version, 10000);
             result.ffmpegVersion = version.substr(0, version.find('\n'));
             run({"-hide_banner", "-encoders"}, &encoders, 10000);
             result.ffmpegFound = encoders.find("libx264") != std::string::npos || encoders.find("h264_nvenc") != std::string::npos;
             for (std::string encoder : {"h264_nvenc", "h264_qsv", "h264_amf", "libx264"}) {
               if (encoders.find(" " + encoder + " ") == std::string::npos) {
                 result.notes.push_back(encoder + ": FFmpeg 빌드에 없음");
                 continue;
               }
               // Test with the same options the stream uses; a missing GPU/driver fails here instead of at broadcast time.
               std::vector<std::string> args = {"-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60",
                                                "-frames:v", "30"};
               auto enc = VideoEncoderArgs(encoder, 60, 4, "vbr");
               args.insert(args.end(), enc.begin(), enc.end());
               args.insert(args.end(), {"-f", "null", "-"});
               std::string out;
               int code = run(args, &out, 20000);
               if (code == 0) {
                 result.available.push_back(encoder);
               } else {
                 std::string reason = out.substr(0, out.find('\n'));
                 result.notes.push_back(encoder + ": 사용할 수 없음 (" + (reason.empty() ? "exit " + std::to_string(code) : reason) + ")");
               }
             }
             LogFile("encoder", result.ffmpegVersion);
             for (const auto& a : result.available) LogFile("encoder", "available: " + a);
             for (const auto& n : result.notes) LogFile("encoder", n);
             CoUninitialize();
             return result;
           }).share();
}

EncoderProbe Streamer::Probe() {
  if (!probe_.valid()) return {};
  return probe_.get();
}

std::string Streamer::StreamPath() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return settings_.streamPath;
}

bool Streamer::KnownStreamPath(const std::string& path) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (path == settings_.streamPath) return true;
  for (const auto& p : LadderPathsLocked())
    if (path == p) return true;
  return false;
}

std::vector<std::string> Streamer::LadderPathsLocked() const {
  // The source copy and the lower qualities; none when qualities are off (then HLS plays the stream's own path).
  std::vector<std::string> out;
  if (renditions_.empty()) return out;
  out.push_back(settings_.streamPath + "/src");
  for (const auto& r : renditions_) out.push_back(settings_.streamPath + "/" + r.name);
  return out;
}

bool Streamer::WaitPathReady(const std::string& path, DWORD waitMs) {
  int64_t until = EpochMillis() + waitMs;
  do {
    {
      std::lock_guard<std::mutex> lock(ladderMutex_);
      if (ladderReady_.count(path)) return true;
      if (!ladder_ || !ladder_->Running()) return false;
    }
    HttpResponse r;
    if (HttpRequest("GET", apiPort_, "/v3/paths/get/" + path, "", {}, r, 1000) && r.status == 200) {
      json j = json::parse(r.body, nullptr, false);
      if (!j.is_discarded() && j.value("ready", false)) {
        std::lock_guard<std::mutex> lock(ladderMutex_);
        ladderReady_.insert(path);  // a failure streak ends only once the ladder has also run for a while (StatsLoop)
        return true;
      }
    }
    Sleep(100);
  } while (running_ && EpochMillis() < until);
  return false;
}

bool Streamer::EnsureLadder(const std::string& path, DWORD waitMs) {
  std::vector<std::string> paths;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_) return false;
    paths = LadderPathsLocked();
  }
  if (std::find(paths.begin(), paths.end(), path) == paths.end()) return false;
  ladderUseMs_ = EpochMillis();
  std::thread oldWarm;  // a previous ladder's warm-up, joined outside the lock (it takes the lock itself)
  {
    std::lock_guard<std::mutex> lock(ladderMutex_);
    if (!running_) return false;  // Stop() takes this lock after clearing running_, so no ladder outlives a broadcast
    if (ladderReady_.count(path) && ladder_ && ladder_->Running()) return true;
    if (LadderEndedLocked() || !ladder_) {
      if (EpochMillis() < ladderRetryAtMs_) return false;
      // Every output's clock: the wall time at PTS 0 (MediaMTX takes these absolute times for the ladder paths).
      int64_t startUs = EpochMillis() * 1000;
      std::vector<std::wstring> args;
      {
        std::lock_guard<std::mutex> settings(mutex_);
        args = LadderArgs(startUs);
      }
      auto child = std::make_unique<ChildProcess>();
      std::string error;
      auto log = [](const std::string& line) { LogFile("ladder", line); };
      if (!child->Start(ffmpegExe_, args, RuntimeDir(), log, log, error)) {
        LadderFailedLocked("start failed", error);
        return false;
      }
      LogFile("ladder", Printf("started (pid %lu): source copy + %zu qualities", static_cast<unsigned long>(child->Pid()), paths.size() - 1));
      ladder_ = std::move(child);
      ladderPathCount_ = paths.size();
      ladderStartedMs_ = EpochMillis();
      // Warm-up: once published, open each variant's HLS muxer (it takes about a segment to produce a playlist), so the
      // first switch to a quality finds it ready. MediaMTX closes a muxer 60 s after its last request.
      int hls = hlsPort_;
      std::thread warm([this, paths, hls] {
        std::vector<std::thread> each;
        for (const auto& p : paths)
          each.emplace_back([this, p, hls] {
            if (!WaitPathReady(p, 15000)) return;
            HttpResponse r;
            HttpRequest("GET", hls, "/" + p + "/index.m3u8?cookieCheck=1", "", {}, r, 8000);
          });
        for (auto& t : each) t.join();
      });
      // The previous warm-up leaves the member only now, when nothing can fail any more: a joinable thread destroyed on
      // an early return or a throw would terminate the app (it stays in ladderWarm_ for StopLadder or the next start).
      oldWarm = std::move(ladderWarm_);
      ladderWarm_ = std::move(warm);
    }
  }
  if (oldWarm.joinable()) oldWarm.join();
  return !waitMs || WaitPathReady(path, waitMs);
}

bool Streamer::LadderEndedLocked() {
  // The ladder exited by itself (encoder error, stream gone): forget it; the next request starts a new one after 3 s (or
  // later, see LadderFailedLocked, when it had not published every path).
  if (!ladder_ || ladder_->Running()) return false;
  std::string tail = JoinTail(ladder_->Tail(), 3);
  // The source copy publishes before the encoders open (they open on the first decoded frame), so a ladder whose
  // encoder cannot open shows a ready "src" first; only one that published every path had really started.
  // One that ends soon after publishing (a runtime encoder error, out of memory) fails the same way: counting it as a
  // normal end would restart it every 3 s with an event each time.
  bool published = ladderPathCount_ && ladderReady_.size() >= ladderPathCount_;
  bool brief = EpochMillis() - ladderStartedMs_ < kLadderStableMs;
  ladder_.reset();
  ladderReady_.clear();
  if (!published || brief) {
    LadderFailedLocked(published ? "ended within 30 s of its start" : "ended before publishing every path", tail);
    return true;
  }
  LogFile("ladder", "ended by itself: " + tail);
  UiLog("화질", "화질 인코더가 종료되었습니다. 다음 시청 요청 때 다시 시작합니다. " + tail);
  ladderRetryAtMs_ = EpochMillis() + 3000;
  return true;
}

void Streamer::LadderFailedLocked(const std::string& what, const std::string& detail) {
  // A ladder that cannot run (e.g. the GPU's encoder session limit, reached with a game's recorder or another streaming
  // app): restarts back off (3 s, 6 s, 12 s ... 60 s), only the first failure of a streak reaches the event table, and
  // until a ladder publishes every path again live.m3u8 offers the stream's own path, so browser viewers keep the source.
  ++ladderFailures_;
  int64_t delay = std::min<int64_t>(60000, int64_t{3000} << std::min(ladderFailures_ - 1, 5));
  ladderRetryAtMs_ = EpochMillis() + delay;
  LogFile("ladder", Printf("%s (%d in a row, next start in %lld s): ", what.c_str(), ladderFailures_, static_cast<long long>(delay / 1000)) + detail);
  if (ladderFailures_ == 1)
    UiLog("화질", "화질 인코더를 시작하지 못했습니다. 브라우저 시청자는 원본 화질로 계속 시청하며, 화질 인코더는 잠시 후 다시 시작합니다. " + detail);
}

void Streamer::StopLadder() {
  std::unique_ptr<ChildProcess> ladder;
  std::thread warm;
  {
    std::lock_guard<std::mutex> lock(ladderMutex_);
    ladder = std::move(ladder_);
    ladderReady_.clear();
    ladderRetryAtMs_ = 0;
    ladderFailures_ = 0;  // idle stop or end of the broadcast: the next start begins a new streak
    warm = std::move(ladderWarm_);
  }
  if (ladder) {
    ladder->Terminate();
    LogFile("ladder", "stopped");
  }
  if (warm.joinable()) warm.join();
}

void Streamer::SetVolume(const std::string& channel, int volume) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (channel == "system") settings_.systemVolume = volume;
  if (channel == "mic") settings_.micVolume = volume;
  if (audio_) audio_->SetVolume(channel, volume);
}

void Streamer::ConfigureEncoderLocked(const std::string& encoder) {
  encoder_ = encoder;
  if (settings_.bitrateAuto) settings_.bitrateMbps = AutoBitrateMbps(width_, height_, settings_.fps, encoder);
  renditions_.clear();
  if (!settings_.renditions) return;
  for (int h : {1440, 1080, 720, 480, 360, 240}) {
    if (h >= height_) continue;
    int w = static_cast<int>(std::lround(static_cast<double>(width_) * h / height_)) & ~1;
    double mbps = std::min(settings_.bitrateMbps, AutoBitrateMbps(w, h, settings_.fps, encoder));
    renditions_.push_back({std::to_string(h) + "p", w, h, mbps});
  }
}

void Streamer::UpdateThumbnail() {
  std::lock_guard<std::mutex> build(thumbBuildMutex_);
  std::shared_ptr<WindowCapture> capture = capture_;
  if (!capture) return;
  std::vector<uint8_t> bgr;
  UINT w = 0, h = 0;
  bool ok = false;
  std::string error;
  capture->WithLatest([&](ID3D11Texture2D* texture, UINT sw, UINT sh, uint64_t) { ok = thumbConverter_.ToBgr(gpu_, texture, sw, sh, 480, 270, bgr, w, h, error); });
  std::string jpeg;
  if (!ok || !EncodeJpeg(bgr, w, h, 0.75f, jpeg)) return;
  std::lock_guard<std::mutex> lock(thumbMutex_);
  thumbnail_ = std::move(jpeg);
}

std::string Streamer::Thumbnail(const std::string& id) const {
  if (!running_) return {};
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (id != broadcastId_) return {};
  }
  std::lock_guard<std::mutex> lock(thumbMutex_);
  return thumbnail_;
}

bool Streamer::LocalItem(BroadcastItem& item) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_) return false;
  item.id = broadcastId_;
  item.title = title_;
  item.publisher = publisher_;
  item.host = settings_.serverHost;
  item.port = settings_.viewerPort;
  item.path = settings_.streamPath;
  item.width = width_;
  item.height = height_;
  item.fps = settings_.fps;
  item.startedAtMs = startedAtMs_;
  return true;
}

std::string Streamer::BroadcastId() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return running_ ? broadcastId_ : std::string();
}

bool Streamer::SetRecording(bool on, std::string& error) {
  HttpResponse r;
  std::string path = StreamPath() + "/rec";  // only the copy path records
  if (!HttpRequest("PATCH", apiPort_, "/v3/config/paths/patch/" + path, json{{"record", on}}.dump(), {{"Content-Type", "application/json"}}, r, 3000, &error))
    return false;
  if (r.status != 200) {
    error = Printf("MediaMTX %d ", r.status) + r.body.substr(0, 200);
    return false;
  }
  std::lock_guard<std::mutex> lock(dvrMutex_);
  dvrCache_ = json();
  return true;
}

json Streamer::DvrIndex(const std::string& path) {
  std::string id;
  int port = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ || path != settings_.streamPath) return {{"running", false}, {"path", path}};
    id = broadcastId_;
    port = playbackPort_;
  }
  if (!record_.Active()) return {{"running", true}, {"id", id}, {"dvr", false}};
  std::lock_guard<std::mutex> lock(dvrMutex_);
  int64_t now = QpcNow();
  if (dvrCache_.is_object() && dvrCache_.value("id", "") == id && QpcSeconds(now - dvrCacheQpc_) < 1.0) return dvrCache_;
  // Playable ranges from MediaMTX's playback server: contiguous segments are merged, recording pauses leave gaps, and
  // the last range grows in 1 s steps while the broadcast runs (the newest part on disk is the DVR live edge).
  json ranges = json::array();
  HttpResponse r;
  std::string error;
  const std::string recordPath = path + "/rec";
  bool ok = HttpRequest("GET", port, "/list?path=" + recordPath, "", {}, r, 3000, &error);
  if (ok && r.status == 200) {
    json list = json::parse(r.body, nullptr, false);
    if (list.is_array())
      for (const auto& entry : list) {
        double start = 0;
        if (!entry.is_object() || !ParseRfc3339(entry.value("start", ""), start)) continue;
        double duration = entry.value("duration", 0.0);
        if (duration > 0) ranges.push_back({{"startMs", start}, {"endMs", start + duration * 1000.0}});
      }
  } else if (!ok || r.status != 400) {
    // 400 only means that nothing has been written yet (the folder appears with the first part).
    LogFile("dvr", "playback list failed: " + (ok ? Printf("%d ", r.status) + r.body.substr(0, 200) : error));
  }
  dvrCache_ = {{"running", true},
               {"id", id},
               {"dvr", true},
               {"recording", recording_.load()},
               {"ranges", ranges},
               {"segments", record_.SegmentStarts(recordPath)},
               {"gopMs", 1000},
               {"nowMs", EpochMillis()}};
  dvrCacheQpc_ = now;
  return dvrCache_;
}

bool Streamer::DvrMediaTarget(const std::string& path, const std::string& id, double startMs, double durationMs, int& port, std::string& target,
                              int& status, std::string& error) const {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ || path != settings_.streamPath) {
      status = 404, error = "not-running";
      return false;
    }
    if (id != broadcastId_) {
      status = 409, error = "broadcast-changed";  // a new broadcast on the same path: the viewer must reload its index
      return false;
    }
    port = playbackPort_;
  }
  if (!record_.Active() || !port) {
    status = 404, error = "no-dvr";
    return false;
  }
  int64_t now = EpochMillis();
  // One bounded chunk per request (the client asks for a few seconds at a time); never a whole broadcast.
  if (!std::isfinite(startMs) || !std::isfinite(durationMs) || durationMs < 200 || durationMs > 30000 || startMs < now - 8.0 * 86400000 ||
      startMs > now + 10000) {
    status = 400, error = "bad-range";
    return false;
  }
  std::string start = FormatRfc3339Utc(startMs);
  std::string encoded;
  for (char c : start) encoded += c == ':' ? std::string("%3A") : std::string(1, c);
  // The recording holds the video and the AAC track (the copy path "<stream>/rec").
  target = "/get?path=" + path + "/rec&start=" + encoded + Printf("&duration=%.3f", durationMs / 1000.0) + "&format=fmp4";
  return true;
}

bool Streamer::HlsMultivariant(const std::string& path, const std::string& quality, std::string& body, int& status) {
  struct Entry {
    std::string name, prefix, mtxPath;
    int width = 0, height = 0;
    double mbps = 0;
  };
  std::vector<Entry> entries;
  bool audio = false, vbr = false, ladderFailing = false;
  int fps = 0, opusKbps = 0;
  {
    // Taken before mutex_ (the order EnsureLadder uses); a ladder that has just died is accounted for first.
    std::lock_guard<std::mutex> lock(ladderMutex_);
    LadderEndedLocked();
    ladderFailing = ladderFailures_ > 0;
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ || path != settings_.streamPath) {
      status = 404;
      return false;
    }
    audio = settings_.audio != "none";
    fps = settings_.fps;
    opusKbps = settings_.audioBitrateKbps;
    vbr = settings_.rateControl == "vbr" && (encoder_ == "h264_nvenc" || encoder_ == "libx264");
    // With qualities, the source variant is the ladder's copy ("src/", same clock as the qualities); its codec and rate
    // are the stream's own (mtxPath stays the stream's path for those). While the ladder keeps failing, the source is
    // the stream's own path (served without the ladder) and no quality is offered, so browser viewers keep watching.
    // A player that asks for one quality then (?q=720p, Safari's manual choice, also on its reconnect) gets the source
    // instead of a 404 that would end its playback while the source plays fine.
    const bool ladder = !renditions_.empty() && !ladderFailing;
    if (quality.empty() || quality == "source" || (!ladder && !renditions_.empty()))
      entries.push_back({"source", ladder ? "src/" : "", path, width_, height_, settings_.bitrateMbps});
    // Only the qualities below the source exist (ConfigureEncoderLocked), already ordered high to low.
    if (ladder)
      for (const auto& r : renditions_)
        if (quality.empty() || quality == r.name) entries.push_back({r.name, r.name + "/", path + "/" + r.name, r.width, r.height, r.mbps});
  }
  if (entries.empty()) {
    status = 404;
    return false;
  }
  std::map<std::string, PathMedia> media;
  {
    std::lock_guard<std::mutex> lock(rateMutex_);
    media = pathMedia_;
  }
  const double audioBps = audio ? kAacKbps * 1000.0 : 0;
  const double publishedAudioBps = audio ? (opusKbps + kAacKbps) * 1000.0 : 0;  // both tracks reach MediaMTX
  // Average video bitrate measured on a path of this broadcast (>= 10 s of data), or 0.
  auto measuredVideo = [&](const std::string& name) {
    auto it = media.find(name);
    if (it == media.end() || it->second.seconds < 10) return 0.0;
    return std::max(0.0, it->second.bits / it->second.seconds - publishedAudioBps);
  };
  double sourceRatio = 0;  // measured / cap of the source, for qualities that have not run yet (VBR only)
  {
    double v = measuredVideo(path);
    std::lock_guard<std::mutex> lock(mutex_);
    if (v > 0 && settings_.bitrateMbps > 0) sourceRatio = std::min(1.0, v / (settings_.bitrateMbps * 1e6));
  }
  std::ostringstream out;
  out << "#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-INDEPENDENT-SEGMENTS\n";
  for (const auto& e : entries) {
    // BANDWIDTH: the configured or automatic video rate (the VBR cap) plus the AAC track. AVERAGE-BANDWIDTH: what this
    // path really averaged in this broadcast; a quality that has not run yet uses the source's measured share of its cap.
    double peak = e.mbps * 1e6 + audioBps;
    double average = peak;
    if (vbr) {
      double v = measuredVideo(e.mtxPath);
      if (v <= 0 && sourceRatio > 0) v = e.mbps * 1e6 * sourceRatio;
      if (v > 0) average = std::min(peak, v + audioBps);
    }
    auto codecIt = media.find(e.mtxPath);
    std::string codec = codecIt != media.end() && !codecIt->second.codec.empty() ? codecIt->second.codec
                                                                                  : Printf("avc1.6400%02x", AvcLevelIdc(e.width, e.height, fps, e.mbps));
    std::string group = "aac-" + e.name;
    if (audio)
      out << "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"" << group << "\",NAME=\"audio\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"2\",URI=\"" << e.prefix
          << "hls/audio3_stream.m3u8\"\n";
    out << "#EXT-X-STREAM-INF:BANDWIDTH=" << static_cast<int64_t>(std::llround(peak)) << ",AVERAGE-BANDWIDTH=" << static_cast<int64_t>(std::llround(average))
        << ",RESOLUTION=" << e.width << "x" << e.height << ",FRAME-RATE=" << Printf("%.3f", static_cast<double>(fps)) << ",CODECS=\"" << codec
        << (audio ? ",mp4a.40.2" : "") << "\"" << (audio ? ",AUDIO=\"" + group + "\"" : std::string()) << "\n"
        << e.prefix << "hls/video1_stream.m3u8\n";
  }
  body = out.str();
  status = 200;
  return true;
}

void Streamer::RefreshDvrFilesLocked(const std::string& id) {
  if (dvrFilesId_ != id) {
    dvrFiles_.clear();
    dvrPlaylist_.clear();
    dvrFilesId_ = id;
  }
  // Files are only added while the broadcast runs (retention never removes the current broadcast), so known entries keep
  // their index; a file that disappeared from disk is dropped and never listed again.
  std::vector<RecordFile> next;
  std::string recordPath;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    recordPath = RecordPathName();
  }
  for (const auto& entry : record_.Files(recordPath)) {
    const fs::path& file = entry.first;
    auto it = std::find_if(dvrFiles_.begin(), dvrFiles_.end(), [&](const RecordFile& f) { return f.path == file; });
    if (it != dvrFiles_.end()) {
      next.push_back(std::move(*it));
    } else {
      RecordFile f;
      f.path = file;
      f.startMs = entry.second;
      next.push_back(std::move(f));
    }
  }
  dvrFiles_ = std::move(next);
  int64_t now = EpochMillis();
  for (size_t i = 0; i < dvrFiles_.size(); ++i) {
    RecordFile& f = dvrFiles_[i];
    if (f.complete) continue;
    ScanRecordFile(f);
    // MediaMTX writes one file at a time: every file but the newest is finished. The newest is final once it has not
    // grown for 5 s (recording paused or stopped); until then its open last group is not listed.
    bool final = i + 1 < dvrFiles_.size() || now - f.grewAtMs >= 5000;
    GroupRecordFile(f, final, kDvrSegmentSeconds);
    if (i + 1 < dvrFiles_.size() || f.broken) f.complete = true;
  }
  dvrFilesQpc_ = QpcNow();
}

bool Streamer::DvrPlaylist(const std::string& path, std::string& body, int& status) {
  std::string id;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ || path != settings_.streamPath) {
      status = 404;
      return false;
    }
    id = broadcastId_;
  }
  if (!record_.Active()) {
    status = 404;
    return false;
  }
  std::lock_guard<std::mutex> lock(dvrHlsMutex_);
  if (dvrFilesId_ == id && !dvrPlaylist_.empty() && QpcSeconds(QpcNow() - dvrPlaylistQpc_) < 1.0) {
    body = dvrPlaylist_;
    status = 200;
    return true;
  }
  RefreshDvrFilesLocked(id);
  // EVENT playlist: segments are only appended. Each recorded file has its own init (EXT-X-MAP) and its own timeline,
  // so a discontinuity separates files (and with them every gap where recording was paused).
  std::ostringstream segments;
  long long target = 1;
  bool first = true;
  for (size_t k = 0; k < dvrFiles_.size(); ++k) {
    const RecordFile& f = dvrFiles_[k];
    const double ts = f.VideoTimescale();
    if (f.segments.empty() || ts <= 0) continue;
    // ".mp4" in the path: players that check segment extensions (FFmpeg's HLS demuxer) accept it; /dvr/file is the same.
    std::string uri = "dvr/file.mp4?id=" + id + "&f=" + std::to_string(k);
    if (!first) segments << "#EXT-X-DISCONTINUITY\n";
    first = false;
    // The init is the file's own ftyp+moov (a byte range of the file); each segment is cut at a video keyframe and
    // built from the file's parts (see RecordFile). Decode time 0 is the file's first sample, the time in its name.
    segments << "#EXT-X-MAP:URI=\"" << uri << "\",BYTERANGE=\"" << f.initSize << "@0\"\n";
    for (size_t s = 0; s < f.segments.size(); ++s) {
      const RecordSegment& seg = f.segments[s];
      double seconds = static_cast<double>(seg.end - seg.start) / ts;  // the video samples' durations
      target = std::max(target, std::llround(seconds));
      segments << "#EXT-X-PROGRAM-DATE-TIME:" << FormatIso8601Ms(f.startMs + static_cast<double>(seg.start) * 1000.0 / ts) << "\n#EXTINF:"
               << Printf("%.5f", seconds) << ",\n"
               << uri << "&s=" << s << "\n";
    }
  }
  std::ostringstream out;
  out << "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:"
      << std::max<long long>(target, static_cast<long long>(std::ceil(kDvrSegmentSeconds))) << "\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n"
      << segments.str();
  dvrPlaylist_ = out.str();
  dvrPlaylistQpc_ = QpcNow();
  body = dvrPlaylist_;
  status = 200;
  return true;
}

bool Streamer::DvrFile(const std::string& path, const std::string& id, int index, RecordFile& file, int& status) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ || path != settings_.streamPath) {
      status = 404;
      return false;
    }
    if (id != broadcastId_) {
      status = 409;  // a new broadcast on the same path: the player must reload the playlist
      return false;
    }
  }
  if (!record_.Active() || index < 0) {
    status = 404;
    return false;
  }
  std::lock_guard<std::mutex> lock(dvrHlsMutex_);
  // An unknown index rescans the folder at most once a second: players only ask for listed files, so a flood of
  // unlisted ones (a misbehaving client) must not keep every DVR request waiting on this lock behind rescans.
  if (dvrFilesId_ != id || (static_cast<size_t>(index) >= dvrFiles_.size() && QpcSeconds(QpcNow() - dvrFilesQpc_) >= 1.0)) RefreshDvrFilesLocked(id);
  if (static_cast<size_t>(index) >= dvrFiles_.size() || dvrFiles_[static_cast<size_t>(index)].segments.empty()) {
    status = 404;
    return false;
  }
  file = dvrFiles_[static_cast<size_t>(index)];  // a copy: one file holds about 60 parts
  status = 200;
  return true;
}

std::string Streamer::HlsSessionOpen(const std::string& path, int& status) {
  if (!running_ || path != StreamPath()) {
    status = 404;
    return "";
  }
  int64_t now = EpochMillis();
  std::lock_guard<std::mutex> lock(sessionMutex_);
  for (auto it = hlsSessions_.begin(); it != hlsSessions_.end();) it = now - it->second > 30000 ? hlsSessions_.erase(it) : std::next(it);
  // Memory bound only; this server sets no viewer cap, so a full table (one client can fill it) drops its oldest
  // heartbeat instead of refusing a viewer (the page awaits this before playing; a dropped viewer simply opens anew).
  if (hlsSessions_.size() >= 20000)
    hlsSessions_.erase(std::min_element(hlsSessions_.begin(), hlsSessions_.end(), [](const auto& a, const auto& b) { return a.second < b.second; }));
  std::string sid = RandomHex(16);
  hlsSessions_[sid] = now;
  status = 200;
  return sid;
}

bool Streamer::HlsSessionTouch(const std::string& path, const std::string& sid, bool close) {
  if (!running_ || path != StreamPath()) return false;
  std::lock_guard<std::mutex> lock(sessionMutex_);
  auto it = hlsSessions_.find(sid);
  if (it == hlsSessions_.end() || EpochMillis() - it->second > 30000) {
    if (it != hlsSessions_.end()) hlsSessions_.erase(it);
    return false;
  }
  if (close) hlsSessions_.erase(it);
  else it->second = EpochMillis();
  return true;
}

int Streamer::ActiveHlsSessions() {
  int64_t now = EpochMillis();
  std::lock_guard<std::mutex> lock(sessionMutex_);
  for (auto it = hlsSessions_.begin(); it != hlsSessions_.end();) it = now - it->second > 30000 ? hlsSessions_.erase(it) : std::next(it);
  return static_cast<int>(hlsSessions_.size());
}

json Streamer::Status() const {
  std::lock_guard<std::mutex> lock(mutex_);
  json renditions = json::array();
  for (const auto& r : renditions_) renditions.push_back(r.name);
  return {{"running", running_.load()},
          {"startedAtMs", startedAtMs_},
          {"elapsedMs", running_ ? EpochMillis() - startedAtMs_ : 0},
          {"path", settings_.streamPath},
          {"resolution", settings_.resolution},
          {"fps", settings_.fps},
          {"bitrate", settings_.bitrateMbps},
          {"audio", settings_.audio},
          {"encoder", encoder_},
          {"renditions", renditions},
          {"broadcastId", running_ ? broadcastId_ : std::string()},
          {"title", title_},
          {"width", width_},
          {"height", height_},
          {"bitrateAuto", settings_.bitrateAuto},
          {"rateControl", settings_.rateControl},
          {"recording", recording_.load()}};
}

json Streamer::ViewerInfo(const std::string& path) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!running_ || path != settings_.streamPath) return {{"running", false}, {"path", path}};
  json renditions = json::array();
  // What each shared quality really is, for the viewers' automatic quality choice (same codec and frame rate as the source).
  for (const auto& r : renditions_)
    renditions.push_back({{"name", r.name}, {"width", r.width}, {"height", r.height}, {"mbps", r.mbps}, {"fps", settings_.fps}, {"codec", "H.264"}});
  return {{"running", true},
          {"path", settings_.streamPath},
          {"width", width_},
          {"height", height_},
          {"fps", settings_.fps},
          {"bitrate", settings_.bitrateMbps},
          {"audio", settings_.audio},
          {"codec", "H.264"},
          {"elapsedMs", EpochMillis() - startedAtMs_},
          {"startedAtMs", startedAtMs_},
          {"broadcastId", broadcastId_},
          {"dvr", record_.Active()},
          // HLS for every browser viewer (paths relative to /<stream>/): the multivariant live playlist with the AAC
          // track, and the full-broadcast recording as an HLS EVENT playlist when this broadcast is recorded.
          {"hls",
           {{"master", "live.m3u8"},
            {"lowLatency", true},
            {"audio", settings_.audio == "none" ? "none" : "aac"},
            {"dvr", record_.Active() ? json("dvr.m3u8") : json(nullptr)}}},
          {"title", title_},
          {"publisher", publisher_},
          {"renditions", renditions},
          {"iceServers", settings_.iceServers}};
}

std::string Streamer::IceHostsYaml() const {
  std::string out;
  for (const auto& host : settings_.iceHosts)
    if (host.is_string() && host.get<std::string>() != settings_.serverHost) out += ", " + YamlQuote(host.get<std::string>());
  return out;
}

static std::string PercentEncode(const std::string& text) {
  std::string out;
  for (unsigned char c : text) out += isalnum(c) || c == '-' || c == '.' || c == '_' || c == '~' ? std::string(1, static_cast<char>(c)) : Printf("%%%02X", c);
  return out;
}

bool Streamer::RelayTarget(std::string& url, std::string& error) const {
  // relayPublishUrl may name the relay only (the broadcast's stream ID is appended) or include the path; the relay lists
  // and serves the broadcast under the announced stream ID, so a different path would never be playable there.
  url = settings_.relayPublishUrl;
  size_t slash = url.find('/', url.find("://") + 3);
  if (slash == std::string::npos) url += "/" + settings_.streamPath;
  else if (url.substr(slash + 1) != settings_.streamPath) {
    error = "중계 송출 주소의 경로(" + url.substr(slash + 1) + ")가 방송 스트림 ID(" + settings_.streamPath + ")와 다릅니다. 경로를 지우거나 같게 맞추세요.";
    return false;
  }
  Secrets secrets = LoadSecrets();
  if (!secrets.relayUser.empty()) {
    size_t at = url.find("://") + 3;
    url.insert(at, PercentEncode(secrets.relayUser) + ":" + PercentEncode(secrets.relayPassword) + "@");
  }
  return true;
}

std::vector<std::wstring> Streamer::RelayArgs(const std::string& url) const {
  // The stream FFmpeg already encoded, read back from the local MediaMTX and sent unchanged (no second encode). The
  // credentials only reach this process's command line (masked in the log), never mediamtx.yml. 1190-byte RTP packets
  // fit the relay's WebRTC packets without repacketising.
  std::vector<std::string> a = {"-hide_banner", "-nostdin", "-loglevel", "warning", "-rtsp_transport", "tcp",
                                "-i", Printf("rtsp://127.0.0.1:%d/%s", settings_.publishPort, settings_.streamPath.c_str()),
                                "-map", "0", "-c", "copy", "-f", "rtsp", "-rtsp_transport", "tcp", "-pkt_size", "1190"};
  if (!settings_.relayCaFile.empty()) {
    fs::path ca = Wide(settings_.relayCaFile);
    if (ca.is_relative()) ca = ConfigPath().parent_path() / ca;
    a.insert(a.end(), {"-ca_file", Utf8(ca.wstring())});
  }
  a.push_back(url);
  std::vector<std::wstring> out;
  for (const auto& s : a) out.push_back(Wide(s));
  return out;
}

std::string Streamer::RelayApi() const { return !settings_.relayApiUrl.empty() ? settings_.relayApiUrl : settings_.publicUrl; }

void Streamer::RelayLoop() {
  // Sends the copy to the relay (restarted with growing pauses when the relay or the upload drops it), registers the
  // broadcast on the relay's public list (the relay checks the token, not the sender's address), keeps the list thumbnail
  // fresh and reports whether internet viewers can really play it there. Local sending, recording and same-network
  // viewers never depend on the relay.
  const std::string api = RelayApi();
  Secrets secrets = LoadSecrets();
  HttpHeaders auth = {{"Content-Type", "application/json"}};
  if (!secrets.relayToken.empty()) auth.push_back({"Authorization", "Bearer " + secrets.relayToken});
  std::string target, targetError;
  bool copyWanted = !settings_.relayPublishUrl.empty();
  if (copyWanted && !RelayTarget(target, targetError)) {
    UiLog("중계", targetError);
    copyWanted = false;
  }
  std::unique_ptr<ChildProcess> copy;
  int64_t copyStartedAt = 0, nextCopyAt = 0;
  int copyFailures = 0;
  bool copyReported = false;
  int lastState = -1, tick = 0;
  std::string id;
  while (!relayStop_) {
    BroadcastItem item;
    if (copyWanted && LocalItem(item)) {
      int64_t now = EpochMillis();
      if (copy && !copy->Running()) {
        std::string tail = JoinTail(copy->Tail(), 2);
        LogFile("relay", Printf("copy exited (code %lu): ", copy->ExitCode()) + tail);
        copyFailures = now - copyStartedAt > 30000 ? 1 : copyFailures + 1;
        int64_t pause = std::min<int64_t>(30000, 2000LL << std::min(copyFailures - 1, 4));
        if (!copyReported)
          UiLog("중계", Printf("중계 서버로 보내는 연결이 끊겼습니다. %lld초 뒤 다시 연결합니다. ", static_cast<long long>(pause / 1000)) + tail.substr(0, 200));
        copyReported = true;
        nextCopyAt = now + pause;
        copy.reset();
      }
      HttpResponse ready;
      if (!copy && now >= nextCopyAt && HttpRequest("GET", apiPort_, "/v3/paths/get/" + settings_.streamPath, "", {}, ready, 1000) &&
          ready.status == 200 && json::parse(ready.body, nullptr, false).value("ready", false)) {
        copy = std::make_unique<ChildProcess>();
        std::string error;
        auto onLine = [](const std::string& line) { LogFile("relay", line); };
        if (copy->Start(ffmpegExe_, RelayArgs(target), RuntimeDir(), onLine, onLine, error)) {
          copyStartedAt = now;
        } else {
          LogFile("relay", "copy start failed: " + error);
          copy.reset();
          nextCopyAt = now + 10000;
        }
      }
      if (copy && copyReported && now - copyStartedAt > 10000 && copy->Running()) copyReported = false;  // up again; report the next drop
    }
    // Ticks are 100 ms: announcement and relay status every 2 s, thumbnail every 10 s.
    if (tick % 20 == 0 && LocalItem(item)) {
      id = item.id;
      json renditions = ViewerInfo(item.path).value("renditions", json::array());
      json message = {{"v", 1}, {"type", "announce"},
                      {"item", {{"id", item.id}, {"title", item.title}, {"publisher", item.publisher}, {"path", item.path}, {"width", item.width},
                                {"height", item.height}, {"fps", item.fps}, {"startedAtMs", item.startedAtMs}, {"bitrate", settings_.bitrateMbps},
                                {"audio", settings_.audio}, {"renditions", renditions}, {"sentAtMs", EpochMillis()}}}};
      HttpResponse r;
      std::string error;
      int round = tick / 20;
      if (!api.empty() && !secrets.relayToken.empty() &&
          (!HttpRequestUrl(api + "/api/broadcasts/announce", "POST", message.dump(), auth, r, 3000, &error) || r.status / 100 != 2) && round % 15 == 0)
        LogFile("relay", "announce failed: " + (error.empty() ? Printf("%d ", r.status) + r.body.substr(0, 160) : error));
      if (!api.empty() && !secrets.relayToken.empty() && round % 5 == 0) {
        std::string jpeg = Thumbnail(item.id);
        HttpHeaders imageHeaders = {{"Content-Type", "image/jpeg"}, {"Authorization", "Bearer " + secrets.relayToken}};
        if (!jpeg.empty()) HttpRequestUrl(api + "/api/broadcasts/" + item.id + "/thumbnail", "PUT", jpeg, imageHeaders, r, 3000, &error);
      }
      int state = 0;
      if (!api.empty() && HttpRequestUrl(api + "/" + item.path + "/info", "GET", "", {}, r, 3000, &error) && r.status == 200) {
        json info = json::parse(r.body, nullptr, false);
        state = info.is_object() && info.value("running", false) && info.value("mediaReady", true) ? 1 : 0;
      }
      if (state != lastState && !api.empty()) {
        if (state) UiLog("중계", "중계 서버에서 시청할 수 있습니다: " + (settings_.publicUrl.empty() ? api : settings_.publicUrl) + "/" + item.path);
        else if (round >= 3) UiLog("중계", "중계 서버에서 아직 방송을 받지 못했습니다. 중계 주소·인증 정보·방화벽을 확인하세요(로컬 송출은 계속됩니다).");
        if (state || round >= 3) lastState = state;
      }
    }
    ++tick;
    Sleep(100);
  }
  if (copy) copy->Terminate();
  if (!api.empty() && !secrets.relayToken.empty() && !id.empty()) {
    HttpResponse r;
    HttpRequestUrl(api + "/api/broadcasts/announce", "POST", json{{"v", 1}, {"type", "bye"}, {"id", id}}.dump(), auth, r, 2000);
  }
}

json Streamer::ServerStats() {
  // Aggregate counters only (no addresses, no control), cached for 1 s so frequent polling cannot load MediaMTX.
  std::lock_guard<std::mutex> lock(serverStatsMutex_);
  int64_t now = EpochMillis();
  if (!serverStatsCache_.is_null() && now - serverStatsAt_ < 1000) return serverStatsCache_;
  json out = {{"v", 1}, {"timeMs", now}, {"running", running_.load()}, {"paths", json::object()},
              {"webrtc", {{"sessions", 0}, {"bytesSent", 0}, {"bytesReceived", 0}}}, {"mediaDiscardWarnings", discardWarnings_.load()}};
  int api = running_ ? apiPort_ : 0;
  auto bytes = [](const json& item, const char* a, const char* b) {
    const json* v = item.contains(a) ? &item[a] : item.contains(b) ? &item[b] : nullptr;
    return v && v->is_number() ? v->get<int64_t>() : int64_t{0};
  };
  HttpResponse r;
  if (api && HttpRequest("GET", api, "/v3/paths/list?itemsPerPage=1000", "", {}, r, 1500) && r.status == 200) {
    json list = json::parse(r.body, nullptr, false);
    if (list.is_object() && list["items"].is_array())
      for (const auto& p : list["items"]) {
        if (!p.is_object()) continue;
        out["paths"][p.value("name", std::string())] = {{"ready", p.value("ready", false)},
                                                        {"readers", p.contains("readers") && p["readers"].is_array() ? p["readers"].size() : 0},
                                                        {"bytesReceived", bytes(p, "inboundBytes", "bytesReceived")},
                                                        {"bytesSent", bytes(p, "outboundBytes", "bytesSent")}};
      }
  }
  int64_t sessions = 0, sent = 0, received = 0;
  for (int page = 0; api && page < 20; ++page) {
    if (!HttpRequest("GET", api, Printf("/v3/webrtcsessions/list?itemsPerPage=1000&page=%d", page), "", {}, r, 2000) || r.status != 200) break;
    json list = json::parse(r.body, nullptr, false);
    if (!list.is_object() || !list["items"].is_array()) break;
    for (const auto& s : list["items"]) {
      if (!s.is_object()) continue;
      ++sessions;
      sent += bytes(s, "outboundBytes", "bytesSent");
      received += bytes(s, "inboundBytes", "bytesReceived");
    }
    if (page + 1 >= list.value("pageCount", 1)) break;
  }
  out["webrtc"] = {{"sessions", sessions}, {"bytesSent", sent}, {"bytesReceived", received}};
  out["hls"] = {{"sessions", ActiveHlsSessions()}};
  serverStatsCache_ = out;
  serverStatsAt_ = now;
  return out;
}

std::vector<std::wstring> Streamer::LadderArgs(int64_t startUs) const {
  // One process shared by every viewer of every quality: the stream is decoded once and scaled for each lower quality.
  // All outputs keep the input timestamps (encoder time base = filter time base, no frame-rate conversion: a derived
  // quality has the source's frame rate) and the same -start_time_realtime, so their RTCP sender reports put one frame
  // at one wall time on every path; keyframes are forced where the source has them (GOP unchanged). Both audio tracks
  // (Opus, AAC) are copied in the source's order, so every path's HLS playlists have the source's names.
  const std::string rtsp = Printf("rtsp://127.0.0.1:%d/", settings_.publishPort), t = std::to_string(startUs);
  // One decoding thread up to 1080p60: no frame-threading delay (each extra thread holds a frame) and far less memory;
  // such a stream decodes well within one core. Above that (up to 2160p165) one thread falls behind real time, and since
  // the outputs of this process advance together, a slow decoder would hold back the source copy too: FFmpeg picks.
  const bool oneThread = static_cast<int64_t>(width_) * height_ * settings_.fps <= int64_t{1920} * 1080 * 60;
  std::vector<std::string> a = {"-hide_banner", "-nostdin", "-loglevel", "warning", "-threads", oneThread ? "1" : "0", "-rtsp_transport", "tcp", "-i",
                                rtsp + settings_.streamPath};
  std::string graph = "[0:v:0]split=" + std::to_string(renditions_.size());
  for (size_t i = 0; i < renditions_.size(); ++i) graph += Printf("[s%zu]", i);
  for (size_t i = 0; i < renditions_.size(); ++i)
    graph += Printf(";[s%zu]scale=%d:%d:flags=bilinear[v%zu]", i, renditions_[i].width, renditions_[i].height, i);
  a.insert(a.end(), {"-filter_complex", graph});
  auto output = [&](const std::string& name) {
    a.insert(a.end(), {"-start_time_realtime", t, "-f", "rtsp", "-rtsp_transport", "tcp", "-pkt_size", "1200", rtsp + settings_.streamPath + "/" + name});
  };
  a.insert(a.end(), {"-map", "0:v:0", "-map", "0:a?", "-c", "copy"});
  output("src");
  for (size_t i = 0; i < renditions_.size(); ++i) {
    const auto& r = renditions_[i];
    a.insert(a.end(), {"-map", Printf("[v%zu]", i), "-map", "0:a?", "-fps_mode", "passthrough", "-enc_time_base:v", "filter"});
    for (const auto& v : VideoEncoderArgs(encoder_, settings_.fps, r.mbps, settings_.rateControl)) a.push_back(v);
    a.insert(a.end(), {"-force_key_frames", "source", "-c:a", "copy"});
    output(r.name);
  }
  std::vector<std::wstring> out;
  for (const auto& s : a) out.push_back(Wide(s));
  return out;
}

std::string Streamer::RecordCopyCommand() const {
  // Run by MediaMTX while the broadcast is available (runOnAvailable, restarted if it exits): the video and the AAC track
  // (second audio) copied unchanged into "<stream>/rec", the only path that records. No second encode.
  std::string exe = Utf8(ffmpegExe_.generic_wstring());
  return "'" + exe + "' -hide_banner -nostdin -loglevel warning -rtsp_transport tcp -i rtsp://127.0.0.1:$RTSP_PORT/" + settings_.streamPath +
         " -map 0:v:0 -map 0:a:1? -c copy -f rtsp -rtsp_transport tcp -pkt_size 1200 rtsp://127.0.0.1:$RTSP_PORT/" + RecordPathName();
}

bool Streamer::StartMediaMtx(std::string& field, std::string& error) {
  std::error_code ec;
  if (!fs::exists(mediamtxExe_, ec)) {
    error = "bin\\mediamtx.exe를 찾을 수 없습니다. 배포 폴더를 확인하세요.";
    return false;
  }
  if (!PortFree(SOCK_STREAM, "127.0.0.1", settings_.publishPort)) {
    field = "publish-port";
    error = Printf("송출 포트 %d을(를) 다른 프로그램이 사용 중입니다.", settings_.publishPort);
    return false;
  }
  if (!PortFree(SOCK_DGRAM, "0.0.0.0", settings_.iceUdpPort)) {
    field = "viewer-port";
    error = Printf("WebRTC UDP 포트 %d을(를) 다른 프로그램이 사용 중입니다. config\\frame-console.json의 iceUdpPort를 바꾸세요.", settings_.iceUdpPort);
    return false;
  }
  if (settings_.iceTcpPort && !PortFree(SOCK_STREAM, "0.0.0.0", settings_.iceTcpPort)) {
    field = "viewer-port";
    error = Printf("WebRTC TCP 포트 %d을(를) 다른 프로그램이 사용 중입니다. config\\frame-console.json의 iceTcpPort를 바꾸세요.", settings_.iceTcpPort);
    return false;
  }
  webrtcHttpPort_ = FreeLoopbackPort();
  apiPort_ = FreeLoopbackPort();
  playbackPort_ = FreeLoopbackPort();
  hlsPort_ = FreeLoopbackPort();
  std::set<int> ports = {webrtcHttpPort_.load(), apiPort_, playbackPort_, hlsPort_};
  if (!webrtcHttpPort_ || !apiPort_ || !playbackPort_ || !hlsPort_ || ports.size() != 4) {
    error = "내부 서버 포트를 할당할 수 없습니다.";
    return false;
  }
  std::ostringstream y;
  y << "# Generated by FRAME Console for one session. Edit config\\frame-console.json instead.\n"
    << "logLevel: info\nlogDestinations: [stdout]\nreadTimeout: 10s\nwriteTimeout: 10s\nwriteQueueSize: 4096\n"
    << "authInternalUsers:\n"
    << "  - user: any\n    pass:\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: publish\n      - action: read\n      - action: api\n      - action: playback\n"
    << "  - user: any\n    pass:\n    ips: []\n    permissions:\n      - action: read\n"
    << "api: true\napiAddress: 127.0.0.1:" << apiPort_ << "\nmetrics: false\npprof: false\n"
    // Recorded-media server for the DVR, loopback only; the viewer server forwards bounded chunk requests to it.
    << "playback: true\nplaybackAddress: 127.0.0.1:" << playbackPort_ << "\n"
    << "rtsp: true\nrtspTransports: [tcp]\nrtspEncryption: \"no\"\nrtspAddress: 127.0.0.1:" << settings_.publishPort << "\n"
    << "rtmp: false\nsrt: false\nmoq: false\n"
    // Low-latency HLS (fMP4, H.264 + Opus + AAC as published, no re-encode) on loopback, made when a viewer asks for it:
    // the default for every browser viewer (live.m3u8 points at the video and AAC playlists). The viewer server
    // forwards /<path>[/<quality>]/hls/<file>.
    << "hls: true\nhlsAddress: 127.0.0.1:" << hlsPort_ << "\nhlsVariant: lowLatency\nhlsAlwaysRemux: false\nhlsSegmentCount: 7\n"
    << "hlsSegmentDuration: 1s\nhlsPartDuration: 200ms\nhlsAllowOrigins: ['*']\n"
    << "webrtc: true\nwebrtcAddress: 127.0.0.1:" << webrtcHttpPort_ << "\nwebrtcEncryption: false\nwebrtcAllowOrigins: ['*']\n"
    << "webrtcTrustedProxies: ['127.0.0.1']\nwebrtcLocalUDPAddress: ':" << settings_.iceUdpPort << "'\n"
    << "webrtcLocalTCPAddress: '" << (settings_.iceTcpPort ? ":" + std::to_string(settings_.iceTcpPort) : std::string()) << "'\n"
    << "webrtcIPsFromInterfaces: true\nwebrtcIPsFromInterfacesList: []\nwebrtcAdditionalHosts: [" << YamlQuote(settings_.serverHost) << IceHostsYaml() << "]\n"
    << "webrtcICEServers2:";
  if (settings_.iceServers.empty()) y << " []";
  y << "\n";
  for (const auto& s : settings_.iceServers) {
    if (!s.is_object()) continue;
    std::string url = s.value("urls", s.value("url", std::string()));
    if (url.empty()) continue;
    y << "  - url: " << YamlQuote(url) << "\n    username: " << YamlQuote(s.value("username", std::string()))
      << "\n    password: " << YamlQuote(s.value("credential", std::string())) << "\n";
  }
  y << "paths:\n  " << YamlQuote(settings_.streamPath) << ":\n    source: publisher\n";
  bool record = record_.Active();
  if (record) {
    // Full broadcast, as published (no second encode), recorded from the copy path "<stream>/rec" that carries the video
    // and the AAC track only (what HLS players need): fMP4 parts flushed every second (the DVR live edge), files split at
    // the first keyframe after 60 s, never deleted by MediaMTX (retention is RecordStore's job).
    y << "    runOnAvailable: " << YamlQuote(RecordCopyCommand()) << "\n    runOnAvailableRestart: true\n"
      << "  " << YamlQuote(RecordPathName()) << ":\n    source: publisher\n"
      << "    record: true\n    recordPath: " << YamlQuote(record_.RecordPathPattern()) << "\n    recordFormat: fmp4\n"
      << "    recordPartDuration: 1s\n    recordMaxPartSize: 100M\n    recordSegmentDuration: 60s\n    recordDeleteAfter: 0s\n";
  }
  // The ladder's paths (EnsureLadder publishes them): frames keep the absolute times of the ladder's sender reports, so
  // HLS dates and timestamps match across the source copy and the qualities.
  for (const auto& p : LadderPathsLocked())
    y << "  " << YamlQuote(p) << ":\n    source: publisher\n    useAbsoluteTimestamp: true\n";
  fs::path config = RuntimeDir() / L"mediamtx.yml";
  {
    std::ofstream out(config, std::ios::binary | std::ios::trunc);
    out << y.str();
    if (!out) {
      error = "스트리밍 서버 설정을 쓸 수 없습니다: " + Utf8(config.wstring());
      return false;
    }
  }
  mediamtx_ = std::make_unique<ChildProcess>();
  auto sessions = std::make_shared<std::map<std::string, std::string>>();
  auto onLine = [this, sessions](const std::string& line) {
    LogFile("mediamtx", line);
    if (line.find("too slow") != std::string::npos || line.find("discarding") != std::string::npos) ++discardWarnings_;
    size_t recorder = line.find("[recorder]");
    if (recorder != std::string::npos && (line.find(" ERR ") != std::string::npos || line.find(" WAR ") != std::string::npos)) {
      // Disk full, permission or write errors; at most one entry per 10 s in the event table, all of them in the log file.
      static std::atomic<int64_t> lastShown{0};
      int64_t now = EpochMillis(), last = lastShown;
      if (now - last > 10000 && lastShown.compare_exchange_strong(last, now)) UiLog("녹화", "녹화 오류: " + line.substr(recorder + 11, 240) + " 라이브 송출은 계속됩니다.");
      return;
    }
    // Surface viewer sessions and the negotiated tracks in the UI event table.
    size_t s = line.find("[WebRTC] [session ");
    if (s == std::string::npos) return;
    size_t idStart = s + 18, idEnd = line.find(']', idStart);
    if (idEnd == std::string::npos) return;
    std::string id = line.substr(idStart, idEnd - idStart);
    size_t by = line.find("created by ");
    if (by != std::string::npos) {
      (*sessions)[id] = line.substr(by + 11, line.find(':', by + 11) - (by + 11));
    } else if (line.find("is reading from path") != std::string::npos) {
      size_t q = line.find("path '");
      std::string rest = q == std::string::npos ? "" : line.substr(q + 6);
      size_t end = rest.find('\'');
      std::string who = sessions->count(id) ? (*sessions)[id] + " " : std::string();
      UiLog("수신", "시청 연결: " + who + rest.substr(0, end) + (end == std::string::npos ? "" : rest.substr(end + 1)));
    } else if (line.find("] closed") != std::string::npos) {
      std::string who = sessions->count(id) ? (*sessions)[id] + " " : std::string();
      sessions->erase(id);
      UiLog("수신", "시청 종료: " + who + line.substr(line.find("] closed") + 9));
    }
  };
  // recordPath is relative to the working directory, so the recordings root never appears inside a path pattern.
  if (!mediamtx_->Start(mediamtxExe_, {config.wstring()}, record ? record_.RootDir() : RuntimeDir(), onLine, onLine, error)) return false;
  for (int i = 0; i < 100; ++i) {
    HttpResponse r;
    if (HttpRequest("GET", apiPort_, "/v3/paths/list", "", {}, r, 500) && r.status == 200) {
      LogFile("mediamtx", Printf("ready: api %d, webrtc %d", apiPort_, webrtcHttpPort_.load()));
      return true;
    }
    if (!mediamtx_->Running()) break;
    Sleep(50);
  }
  std::string tail = JoinTail(mediamtx_->Tail(), 3);
  mediamtx_->Terminate();
  mediamtx_.reset();
  if (tail.find("bind") != std::string::npos || tail.find("address") != std::string::npos) field = "publish-port";
  error = "스트리밍 서버(MediaMTX)를 시작할 수 없습니다. " + tail;
  return false;
}

std::vector<std::wstring> Streamer::FfmpegArgs(const std::string& encoder) const {
  std::vector<std::string> a = {"-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1", "-stats_period", "1",
                                "-f", "rawvideo", "-pix_fmt", "nv12", "-video_size", std::to_string(width_) + "x" + std::to_string(height_),
                                "-framerate", std::to_string(settings_.fps), "-thread_queue_size", "4", "-i", Utf8(videoPipe_.Name())};
  bool withAudio = settings_.audio != "none";
  // Streaming WAV instead of raw s16le: the raw PCM demuxer reads ~85 ms per packet, WAV honours max_size (10 ms here).
  if (withAudio) a.insert(a.end(), {"-f", "wav", "-max_size", "1920", "-ignore_length", "1", "-thread_queue_size", "64", "-i", Utf8(audioPipe_.Name())});
  a.insert(a.end(), {"-map", "0:v:0"});
  // The one captured mix as two audio tracks: Opus first (WebRTC uses the first audio it supports), AAC-LC second (HLS
  // for every browser viewer and the recording). Audio "none" publishes no audio track.
  if (withAudio) a.insert(a.end(), {"-map", "1:a:0", "-map", "1:a:0"});
  auto video = VideoEncoderArgs(encoder, settings_.fps, settings_.bitrateMbps, settings_.rateControl);
  a.insert(a.end(), video.begin(), video.end());
  if (withAudio)
    a.insert(a.end(), {"-c:a:0", "libopus", "-b:a:0", std::to_string(settings_.audioBitrateKbps) + "k", "-application:a:0", "lowdelay",
                       "-frame_duration:a:0", "10", "-c:a:1", "aac", "-b:a:1", std::to_string(kAacKbps) + "k", "-ar:a:1", "48000"});
  a.insert(a.end(), {"-f", "rtsp", "-rtsp_transport", "tcp", "-pkt_size", "1200", "rtsp://127.0.0.1:" + std::to_string(settings_.publishPort) + "/" + settings_.streamPath});
  std::vector<std::wstring> wide;
  for (const auto& s : a) wide.push_back(Wide(s));
  return wide;
}

void Streamer::OnProgressLine(const std::string& line) {
  size_t eq = line.find('=');
  if (eq == std::string::npos) return;
  std::lock_guard<std::mutex> lock(progressMutex_);
  std::string key = line.substr(0, eq);
  progress_[key] = line.substr(eq + 1);
  if (key == "progress") {
    // Rate between consecutive progress blocks; FFmpeg's own fps/speed fields are averages since the start.
    int64_t frame = atoll(progress_["frame"].c_str()), now = QpcNow();
    if (progressQpc_ && now > progressQpc_ && frame >= progressFrame_) encoderRate_ = (frame - progressFrame_) / QpcSeconds(now - progressQpc_);
    progressFrame_ = frame;
    progressQpc_ = now;
  }
}

bool Streamer::StartFfmpeg(const std::string& encoder, std::string& error) {
  static std::atomic<int> counter{0};
  std::wstring base = Wide(Printf("\\\\.\\pipe\\FrameConsole-%lu-%d-%llu", GetCurrentProcessId(), ++counter, static_cast<unsigned long long>(QpcNow())));
  if (!videoPipe_.Create(base + L"-video", 2 * 1024 * 1024, error)) return false;
  bool withAudio = settings_.audio != "none";
  if (withAudio && !audioPipe_.Create(base + L"-audio", 64 * 1024, error)) return false;
  ResetEvent(stopEvent_.Get());
  {
    std::lock_guard<std::mutex> lock(progressMutex_);
    progress_.clear();
    progressQpc_ = progressFrame_ = 0;
    encoderRate_ = 0;
  }
  ffmpeg_ = std::make_unique<ChildProcess>();
  if (!ffmpeg_->Start(ffmpegExe_, FfmpegArgs(encoder), RuntimeDir(), [this](const std::string& line) { OnProgressLine(line); },
                      [](const std::string& line) { LogFile("ffmpeg", line); }, error)) {
    ffmpeg_.reset();
    return false;
  }
  written_ = uniqueSent_ = duplicates_ = skipped_ = 0;
  writeTicks_ = latencyTicks_ = 0;
  latencySamples_ = 0;
  pumpStartQpc_ = 0;
  pump_ = std::thread([this] { PumpLoop(); });
  if (withAudio) audioWriter_ = std::thread([this] { AudioWriterLoop(); });
  return true;
}

void Streamer::StopFfmpeg() {
  SetEvent(stopEvent_.Get());
  if (pump_.joinable()) pump_.join();
  if (audioWriter_.joinable()) audioWriter_.join();
  // Closing the pipes gives FFmpeg end-of-file so it flushes and closes the RTSP session itself.
  videoPipe_.Close();
  audioPipe_.Close();
  if (ffmpeg_) {
    if (!ffmpeg_->Wait(3000)) ffmpeg_->Terminate();
    ffmpeg_.reset();
  }
}

bool Streamer::WaitPublished(DWORD timeoutMs, std::string& error) {
  int64_t start = QpcNow();
  while (QpcSeconds(QpcNow() - start) * 1000 < timeoutMs) {
    HttpResponse r;
    if (HttpRequest("GET", apiPort_, "/v3/paths/get/" + settings_.streamPath, "", {}, r, 500) && r.status == 200) {
      json j = json::parse(r.body, nullptr, false);
      if (!j.is_discarded() && j.value("ready", false)) return true;
    }
    if (!ffmpeg_ || !ffmpeg_->Running()) {
      error = "인코더가 시작 직후 종료되었습니다. " + (ffmpeg_ ? JoinTail(ffmpeg_->Tail(), 3) : std::string());
      return false;
    }
    Sleep(100);
  }
  error = "인코더가 제한 시간 안에 송출을 시작하지 못했습니다. " + (ffmpeg_ ? JoinTail(ffmpeg_->Tail(), 3) : std::string());
  return false;
}

bool Streamer::Start(const Settings& settings, std::shared_ptr<WindowCapture> capture, const std::string& sourceTitle, std::string& field,
                     std::string& error) {
  if (running_) {
    error = "이미 송출 중입니다.";
    return false;
  }
  if (!capture || capture->Closed()) {
    error = "공유할 창을 다시 선택하세요.";
    return false;
  }
  EncoderProbe probe = Probe();
  if (!probe.ffmpegFound) {
    error = "FFmpeg를 실행할 수 없습니다. " + (probe.notes.empty() ? std::string() : probe.notes.front());
    return false;
  }
  const Resolution* res = FindResolution(settings.resolution);
  std::vector<std::string> encoders;
  if (settings.encoder != "auto") {
    if (std::find(probe.available.begin(), probe.available.end(), settings.encoder) == probe.available.end()) {
      error = "설정 파일에 지정한 인코더 " + settings.encoder + "를 이 PC에서 사용할 수 없습니다.";
      return false;
    }
    encoders.push_back(settings.encoder);
  } else {
    encoders = probe.available;
  }
  if (encoders.empty()) {
    error = "사용할 수 있는 H.264 인코더가 없습니다.";
    return false;
  }
  // The output keeps the source's aspect ratio inside the selected size and is never larger than the source:
  // upscaling would only spend bits without adding detail.
  SIZE source = capture->ContentSize();
  for (int i = 0; i < 75 && (source.cx < 2 || source.cy < 2); ++i) {
    Sleep(20);
    source = capture->ContentSize();
  }
  // The encoder always outputs the selected resolution: viewers, the recording and the player frame keep one format, and the
  // shared content is scaled with its own aspect ratio and centred inside it (bars only where the shapes differ).
  SIZE output{res->width, res->height};
  {
    std::lock_guard<std::mutex> lock(mutex_);
    settings_ = settings;
    width_ = output.cx;
    height_ = output.cy;
    sourceWidth_ = source.cx;
    sourceHeight_ = source.cy;
    encoder_ = encoders.front();
    capture_ = capture;
    broadcastId_ = RandomHex(16);
    title_ = !settings.broadcastTitle.empty() ? settings.broadcastTitle : sourceTitle.empty() ? settings.streamPath : sourceTitle.substr(0, 120);
    publisher_ = !settings.publisherName.empty() ? settings.publisherName : ComputerName();
    ConfigureEncoderLocked(encoders.front());
  }
  {
    std::lock_guard<std::mutex> lock(thumbMutex_);
    thumbnail_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(dvrMutex_);
    dvrCache_ = json();
  }
  {
    std::lock_guard<std::mutex> lock(dvrHlsMutex_);
    dvrFiles_.clear();
    dvrFilesId_.clear();
    dvrPlaylist_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(rateMutex_);
    pathMedia_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(sessionMutex_);
    hlsSessions_.clear();
  }
  json recordMeta;
  std::string broadcastId;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    broadcastId = broadcastId_;
    recordMeta ={{"title", title_},      {"publisher", publisher_}, {"path", settings_.streamPath}, {"startedAtMs", EpochMillis()},
                  {"width", width_},      {"height", height_},       {"fps", settings_.fps},         {"bitrateMbps", settings_.bitrateMbps},
                  {"rateControl", settings_.rateControl}, {"encoder", encoder_}};
  }
  std::string recordReason;
  recording_ = record_.Prepare(settings, broadcastId, recordMeta, recordReason);
  failing_ = false;
  if (!StartMediaMtx(field, error)) {
    record_.Discard();
    recording_ = false;
    return false;
  }

  if (settings.audio != "none") {
    audio_ = std::make_unique<AudioEngine>();
    if (!audio_->Start(settings.audio, settings.systemVolume, settings.micVolume, error)) {
      field = "audio-source";
      audio_.reset();
      mediamtx_->Terminate();
      mediamtx_.reset();
      record_.Discard();
      recording_ = false;
      return false;
    }
  }

  bool published = false;
  std::string lastError;
  for (size_t i = 0; i < encoders.size() && !published; ++i) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ConfigureEncoderLocked(encoders[i]);
    }
    if (i > 0) {
      // Regenerate the on-demand quality commands for the fallback encoder.
      mediamtx_->Terminate();
      mediamtx_.reset();
      record_.ClearCurrent();  // the DVR starts with the encoder that actually runs
      if (!StartMediaMtx(field, error)) break;
      UiLog("인코더", encoders[i - 1] + "를 시작할 수 없어 " + encoders[i] + (encoders[i] == "libx264" ? " (CPU)" : "") + "로 다시 시도합니다.");
    }
    if (!StartFfmpeg(encoders[i], lastError) || !WaitPublished(12000, lastError)) {
      LogFile("encoder", encoders[i] + " failed: " + lastError);
      StopFfmpeg();
      continue;
    }
    published = true;
  }
  if (!published) {
    if (audio_) audio_->Stop();
    audio_.reset();
    if (mediamtx_) mediamtx_->Terminate();
    mediamtx_.reset();
    capture_.reset();
    record_.Discard();
    recording_ = false;
    if (error.empty()) error = lastError;
    return false;
  }
  startedAtMs_ = EpochMillis();
  record_.UpdateMeta({{"encoder", encoder_}, {"bitrateMbps", settings_.bitrateMbps}, {"startedAtMs", startedAtMs_}});
  failing_ = false;
  ++session_;
  running_ = true;
  KeepAwake(true);
  statsStop_ = false;
  stats_ = std::thread([this] { StatsLoop(); });
  relayStop_ = false;
  if (!settings_.relayPublishUrl.empty() || !settings_.relayApiUrl.empty()) relay_ = std::thread([this] { RelayLoop(); });
  // The quality ladder starts with the broadcast: a new ladder path only takes frames once FFmpeg's second RTCP sender
  // report arrives (MediaMTX drops the first, sent before it knows the SSRC; the next comes 5 s later), so starting it on
  // the first viewer's request made that viewer wait about 8 s. It stops after kLadderIdleMs without a reader and then
  // starts again on the next request.
  EnsureLadder(settings_.streamPath + "/src", 0);

  int refresh = WindowMonitorRefreshRate(capture->Window());
  std::string audioText = settings.audio == "none" ? "없음"
                                                   : "Opus " + std::to_string(settings.audioBitrateKbps) + "kbps + AAC " + std::to_string(kAacKbps) + "kbps 48kHz 스테레오";
  bool vbr = settings_.rateControl == "vbr" && (encoder_ == "h264_nvenc" || encoder_ == "libx264");
  std::string sourceText = sourceWidth_ >= 2 ? Printf("원본 %ldx%ld", sourceWidth_, sourceHeight_) : std::string("원본 크기 미확인: 화면이 아직 들어오지 않음");
  UiLog("송출", Printf("적용: %dx%d (%s), %d fps 고정 프레임, %s %.1f Mbps%s, %s, 오디오 %s", width_, height_, sourceText.c_str(), settings.fps,
                       vbr ? "품질 우선 가변 최대" : "고정", settings_.bitrateMbps, settings_.bitrateAuto ? " (자동)" : "", encoder_.c_str(), audioText.c_str()));
  if (recording_)
    UiLog("녹화", "방송 전체를 재인코딩 없이 저장합니다. 수신자는 시작 부분부터 되감을 수 있습니다. 폴더: " + Utf8(record_.CurrentDir().wstring()));
  else
    UiLog("녹화", recordReason);
  if (sourceWidth_ >= 2 && sourceHeight_ >= 2) {
    RECT fit = FitRect(static_cast<UINT>(sourceWidth_), static_cast<UINT>(sourceHeight_), static_cast<UINT>(width_), static_cast<UINT>(height_));
    LONG fw = fit.right - fit.left, fh = fit.bottom - fit.top;
    UiLog("송출", fw == width_ && fh == height_ ? Printf("원본 %ldx%ld를 출력 %dx%d 전체에 맞춥니다(같은 비율, 여백 없음).", sourceWidth_, sourceHeight_, width_, height_)
                                                : Printf("원본 %ldx%ld를 출력 %dx%d 안에 %ldx%ld로 가운데 배치합니다(원본 비율 유지, %s 여백 %ld px).", sourceWidth_, sourceHeight_,
                                                         width_, height_, fw, fh, fw < width_ ? "좌우" : "상하", fw < width_ ? (width_ - fw) / 2 : (height_ - fh) / 2));
  }
  UpdateThumbnail();
  if (refresh > 0 && settings.fps > refresh)
    UiLog("성능", Printf("원본 모니터 주사율이 %dHz라 새로 캡처되는 화면은 최대 %d fps입니다. 나머지 프레임은 직전 화면을 반복합니다.", refresh, refresh));
  if (encoder_ == "libx264") UiLog("인코더", "GPU 인코더를 사용할 수 없어 CPU 인코딩(libx264)으로 송출합니다. 고해상도/고프레임에서는 따라가지 못할 수 있습니다.");
  if (audio_) {
    auto levels = audio_->TakeLevels();
    if (levels.systemPath == "endpoint-loopback")
      UiLog("오디오", "이 Windows에서는 프로그램별 소리 캡처를 사용할 수 없어 출력 장치 전체 소리를 송출합니다. 이 PC에서 수신 화면 소리를 켜면 반복될 수 있습니다.");
  }
  return true;
}

void Streamer::Fail(const std::string& reason) {
  // Failures while Start() is still trying encoders are handled there (WaitPublished sees FFmpeg exit); only a running
  // session is stopped, and only the session that failed, never one started after it.
  if (!running_ || failing_.exchange(true)) return;
  uint64_t session = session_;
  control_.Post([this, reason, session] {
    if (session == session_ && running_) Stop(reason, true);
  });
}

void Streamer::KeepAwake(bool on) {
  // While live, idle sleep or the display turning off would end the broadcast (capture needs the composed desktop).
  // A power request is not tied to a thread and is listed by "powercfg /requests"; it changes no power settings.
  if (on && !powerRequest_.Valid()) {
    static wchar_t reason[] = L"FRAME Console: 화면 송출 중";
    REASON_CONTEXT context{};
    context.Version = POWER_REQUEST_CONTEXT_VERSION;
    context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
    context.Reason.SimpleReasonString = reason;
    powerRequest_.Reset(PowerCreateRequest(&context));
    if (!powerRequest_.Valid() || !PowerSetRequest(powerRequest_.Get(), PowerRequestSystemRequired) ||
        !PowerSetRequest(powerRequest_.Get(), PowerRequestDisplayRequired))
      LogFile("power", "could not keep the PC awake while live: " + LastErrorMessage());
  } else if (!on && powerRequest_.Valid()) {
    PowerClearRequest(powerRequest_.Get(), PowerRequestSystemRequired);
    PowerClearRequest(powerRequest_.Get(), PowerRequestDisplayRequired);
    powerRequest_.Reset();
  }
}

void Streamer::Stop(const std::string& reason, bool failed) {
  bool wasRunning = running_.exchange(false);
  KeepAwake(false);
  statsStop_ = true;
  if (stats_.joinable() && stats_.get_id() != std::this_thread::get_id()) stats_.join();
  relayStop_ = true;
  if (relay_.joinable()) relay_.join();
  StopLadder();
  StopFfmpeg();
  if (audio_) audio_->Stop();
  audio_.reset();
  // The publisher has left: MediaMTX ends the record copy and the recorder of "<stream>/rec" closes its last segment.
  if (mediamtx_ && record_.Active()) Sleep(600);
  if (mediamtx_) mediamtx_->Terminate();
  mediamtx_.reset();
  capture_.reset();
  viewers_ = 0;
  recording_ = false;
  std::string recordSummary = record_.Finish(EpochMillis());
  {
    std::lock_guard<std::mutex> lock(dvrMutex_);
    dvrCache_ = json();
  }
  {
    std::lock_guard<std::mutex> lock(dvrHlsMutex_);
    dvrFiles_.clear();
    dvrFilesId_.clear();
    dvrPlaylist_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(sessionMutex_);
    hlsSessions_.clear();
  }
  if (!recordSummary.empty()) UiLog("녹화", recordSummary);
  if (!wasRunning) return;
  if (onStopped) onStopped(reason);
  UiLog("송출", failed ? "송출 실패: " + reason : StreamPath() + " 종료");
  PostUi({{"type", "state"}, {"state", failed ? "failed" : "stopped"}, {"message", reason}});
}

void Streamer::PumpLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Capture", &taskIndex);
  ScopedHandle timer(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS));
  HANDLE stop = stopEvent_.Get();
  if (!videoPipe_.Connect(stop, 15000)) {
    if (WaitForSingleObject(stop, 0) != WAIT_OBJECT_0) LogFile("pump", "FFmpeg did not open the video pipe");
    if (task) AvRevertMmThreadCharacteristics(task);
    CoUninitialize();
    return;
  }
  const int fps = settings_.fps;
  const double period = static_cast<double>(QpcFrequency()) / fps;
  // Skip ahead only when more than 100 ms (or 3 frames) late; the same duration of audio is dropped to keep sync.
  const double maxLate = std::max(3.0, fps * 0.1);
  FrameConverter converter;
  std::vector<uint8_t> frame(static_cast<size_t>(width_) * height_ * 3 / 2);
  memset(frame.data(), 16, static_cast<size_t>(width_) * height_);
  memset(frame.data() + static_cast<size_t>(width_) * height_, 128, frame.size() - static_cast<size_t>(width_) * height_);
  uint64_t lastSeq = UINT64_MAX;
  uint64_t n = 0;
  std::string error;
  int64_t t0 = QpcNow();
  pumpStartQpc_ = t0;
  if (audio_) audio_->BeginTimeline();
  bool reportedConvertError = false;
  for (;;) {
    int64_t deadline = t0 + static_cast<int64_t>(static_cast<double>(n) * period);
    if (!WaitUntilQpc(timer.Get(), deadline, stop)) break;
    double late = static_cast<double>(QpcNow() - deadline) / period;
    if (late > maxLate) {
      uint64_t skip = static_cast<uint64_t>(late);
      n += skip;
      skipped_ += skip;
      if (audio_) audio_->DropDuration(static_cast<double>(skip) / fps);
      continue;
    }
    bool fresh = false;
    int64_t captureQpc = capture_->LastFrameQpc();
    capture_->WithLatest([&](ID3D11Texture2D* texture, UINT w, UINT h, uint64_t seq) {
      if (seq == lastSeq) return;
      if (converter.ToNv12(gpu_, texture, w, h, width_, height_, frame, error)) {
        lastSeq = seq;
        fresh = true;
      } else if (!reportedConvertError) {
        reportedConvertError = true;
        LogFile("pump", error);
      }
    });
    if (fresh) {
      ++uniqueSent_;
      latencyTicks_ += QpcNow() - captureQpc;
      ++latencySamples_;
    } else {
      ++duplicates_;
    }
    int64_t w0 = QpcNow();
    if (!videoPipe_.Write(frame.data(), frame.size(), stop)) {
      if (WaitForSingleObject(stop, 0) != WAIT_OBJECT_0) {
        DWORD err = videoPipe_.LastError();
        Fail(err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA || err == ERROR_SUCCESS
                 ? "인코더가 영상 입력을 닫았습니다. " + (ffmpeg_ ? JoinTail(ffmpeg_->Tail(), 2) : std::string())
                 : "인코더로 영상을 보낼 수 없습니다: " + LastErrorMessage(err));
      }
      break;
    }
    writeTicks_ += QpcNow() - w0;
    ++written_;
    ++n;
  }
  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

void Streamer::AudioWriterLoop() {
  HANDLE stop = stopEvent_.Get();
  if (!audioPipe_.Connect(stop, 15000)) return;
  // Streaming WAV header (48 kHz, stereo, s16le) with unknown length.
  uint8_t header[44] = {'R', 'I', 'F', 'F', 0xFF, 0xFF, 0xFF, 0xFF, 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ', 16, 0, 0, 0, 1, 0, kAudioChannels, 0};
  auto put32 = [&](int offset, uint32_t v) { memcpy(header + offset, &v, 4); };
  put32(24, kAudioRate);
  put32(28, kAudioRate * kAudioChannels * 2);
  header[32] = kAudioChannels * 2;
  header[34] = 16;
  memcpy(header + 36, "data", 4);
  put32(40, 0xFFFFFFFF);
  if (!audioPipe_.Write(header, sizeof(header), stop)) return;
  std::vector<int16_t> buffer(kAudioRate / 100 * kAudioChannels);  // 10 ms chunks
  while (WaitForSingleObject(stop, 0) != WAIT_OBJECT_0) {
    size_t frames = audio_->Read(buffer.data(), buffer.size() / kAudioChannels, 20);
    if (frames && !audioPipe_.Write(buffer.data(), frames * kAudioChannels * sizeof(int16_t), stop)) {
      if (WaitForSingleObject(stop, 0) != WAIT_OBJECT_0) Fail("인코더가 오디오 입력을 닫았습니다.");
      break;
    }
  }
}

void Streamer::StatsLoop() {
  SYSTEMTIME t;
  GetLocalTime(&t);
  fs::path csvPath = LogDir() / Wide(Printf("stats-%04u%02u%02u-%02u%02u%02u.csv", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond));
  std::ofstream csv(csvPath, std::ios::binary);
  csv << "time,elapsed_s,target_fps,capture_fps,sent_fps,new_frames_fps,duplicate_fps,skipped,encoder_fps,encoder_speed,ffmpeg_dup,ffmpeg_drop,"
         "server_in_mbps,viewers,capture_to_pipe_ms,pipe_write_ms,audio_system_peak,audio_mic_peak,audio_mix_peak,audio_padded,audio_dropped,record_mb,recording\n";
  uint64_t lastFrames = capture_ ? capture_->FrameCount() : 0, lastWritten = 0, lastUnique = 0, lastDup = 0, lastSkipped = 0;
  int64_t lastWriteTicks = 0, lastLatencyTicks = 0;
  uint64_t lastLatencySamples = 0;
  int64_t lastBytes = -1;
  int64_t lastQpc = QpcNow();
  int seconds = 0, behindSeconds = 0, lastWarning = -100;
  bool reportedMinimized = false;
  SIZE seenSource{sourceWidth_, sourceHeight_}, reportedSource = seenSource;
  int seenSince = 0;
  std::vector<std::string> ladderPaths;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    ladderPaths = LadderPathsLocked();
  }
  while (!statsStop_) {
    for (int i = 0; i < 10 && !statsStop_; ++i) Sleep(100);
    if (statsStop_) break;
    ++seconds;
    if (seconds % 5 == 0) UpdateThumbnail();  // list card image; one 480x270 JPEG every 5 s
    if (ffmpeg_ && !ffmpeg_->Running()) {
      Fail("인코더(FFmpeg)가 종료되었습니다. " + JoinTail(ffmpeg_->Tail(), 3));
      break;
    }
    if (mediamtx_ && !mediamtx_->Running()) {
      Fail("스트리밍 서버(MediaMTX)가 종료되었습니다. " + JoinTail(mediamtx_->Tail(), 2));
      break;
    }
    int64_t now = QpcNow();
    double dt = std::max(0.001, QpcSeconds(now - lastQpc));
    lastQpc = now;
    uint64_t frames = capture_ ? capture_->FrameCount() : 0;
    uint64_t w = written_, u = uniqueSent_, d = duplicates_, s = skipped_;
    int64_t wt = writeTicks_, lt = latencyTicks_;
    uint64_t ls = latencySamples_;
    double captureFps = (frames - lastFrames) / dt, sentFps = (w - lastWritten) / dt, uniqueFps = (u - lastUnique) / dt, dupFps = (d - lastDup) / dt;
    uint64_t skippedNow = s - lastSkipped;
    double writeMs = w > lastWritten ? QpcSeconds(wt - lastWriteTicks) * 1000 / static_cast<double>(w - lastWritten) : 0;
    double latencyMs = ls > lastLatencySamples ? QpcSeconds(lt - lastLatencyTicks) * 1000 / static_cast<double>(ls - lastLatencySamples) : 0;
    lastFrames = frames, lastWritten = w, lastUnique = u, lastDup = d, lastSkipped = s, lastWriteTicks = wt, lastLatencyTicks = lt, lastLatencySamples = ls;
    std::map<std::string, std::string> progress;
    {
      std::lock_guard<std::mutex> lock(progressMutex_);
      progress = progress_;
    }
    double encoderFps = encoderRate_;
    double speed = encoderFps / std::max(1, settings_.fps);
    // Server side: viewers (WebRTC sessions on the main path and its qualities) and the bitrate actually received.
    int viewers = 0, ladderReaders = 0;
    double serverMbps = 0;
    HttpResponse r;
    std::string path = StreamPath();
    bool listed = false;
    if (HttpRequest("GET", apiPort_, "/v3/paths/list?itemsPerPage=1000", "", {}, r, 800) && r.status == 200) {
      json j = json::parse(r.body, nullptr, false);
      if (!j.is_discarded() && j.contains("items") && j["items"].is_array()) {
        listed = true;
        std::lock_guard<std::mutex> lock(rateMutex_);
        for (const auto& item : j["items"]) {
          if (!item.is_object()) continue;
          std::string name = item.value("name", "");
          if (name != path && name.rfind(path + "/", 0) != 0) continue;
          if (item.contains("readers") && item["readers"].is_array()) {
            for (const auto& reader : item["readers"])
              if (reader.is_object() && reader.value("type", "") == "webRTCSession") ++viewers;
            // HLS muxers (alive 60 s after their last request) and WebRTC sessions keep the ladder running.
            if (std::find(ladderPaths.begin(), ladderPaths.end(), name) != ladderPaths.end()) ladderReaders += static_cast<int>(item["readers"].size());
          }
          const json* in = item.contains("inboundBytes") ? &item["inboundBytes"] : item.contains("bytesReceived") ? &item["bytesReceived"] : nullptr;
          int64_t bytes = in && in->is_number() ? in->get<int64_t>() : 0;
          if (name == path) {
            if (lastBytes >= 0 && bytes >= lastBytes) serverMbps = (bytes - lastBytes) * 8.0 / dt / 1e6;
            lastBytes = bytes;
          }
          // Per path (source, qualities while they run): average received rate and the codec MediaMTX parsed from the SPS.
          PathMedia& m = pathMedia_[name];
          if (!item.value("ready", false)) {
            m.lastBytes = -1;
            continue;
          }
          if (m.lastBytes >= 0 && bytes >= m.lastBytes && seconds > 3) {
            m.bits += (bytes - m.lastBytes) * 8.0;
            m.seconds += dt;
          }
          m.lastBytes = bytes;
          if (m.codec.empty()) m.codec = AvcCodecFromApi(item);
        }
      }
    }
    if (!ladderPaths.empty()) {
      if (ladderReaders) ladderUseMs_ = EpochMillis();
      bool stopLadder = false;
      {
        std::lock_guard<std::mutex> lock(ladderMutex_);
        LadderEndedLocked();
        stopLadder = ladder_ && listed && EpochMillis() - ladderUseMs_ > kLadderIdleMs;
        if (ladderFailures_ && ladder_ && ladderReady_.size() >= ladderPathCount_ && EpochMillis() - ladderStartedMs_ >= kLadderStableMs) {
          // A restarted ladder published every path and kept running: the streak ends, live.m3u8 lists the qualities again.
          LogFile("ladder", Printf("running with every path for %d s after %d failed starts", kLadderStableMs / 1000, ladderFailures_));
          UiLog("화질", "화질 인코더가 다시 시작되었습니다. 새로 접속하는 브라우저 시청자에게 화질 선택이 다시 제공됩니다.");
          ladderFailures_ = 0;
        }
      }
      if (stopLadder) {
        LogFile("ladder", Printf("no reader on any quality for %d s", kLadderIdleMs / 1000));
        StopLadder();
      }
    }
    viewers += ActiveHlsSessions();  // browser viewers on HLS (session heartbeats), next to the WebRTC sessions
    viewers_ = viewers;
    measuredMbps_ = serverMbps;
    AudioLevels levels = audio_ ? audio_->TakeLevels() : AudioLevels{};
    bool minimized = capture_ && IsIconic(capture_->Window());
    if (minimized != reportedMinimized) {
      reportedMinimized = minimized;
      UiLog("소스", minimized ? "공유한 창이 최소화되어 화면이 갱신되지 않습니다. 마지막 화면을 계속 송출합니다." : "공유한 창이 다시 표시되어 화면을 갱신합니다.");
    }
    if (capture_) {
      // The encoder size is fixed for the whole broadcast (viewers and the recording keep one format). When the shared
      // content changes shape, say so once it has settled: the picture keeps its aspect inside the output with bars.
      SIZE content = capture_->ContentSize();
      if (content.cx != seenSource.cx || content.cy != seenSource.cy) {
        seenSource = content;
        seenSince = seconds;
      } else if (seconds - seenSince == 2 && content.cx >= 2 && content.cy >= 2 && (content.cx != reportedSource.cx || content.cy != reportedSource.cy)) {
        reportedSource = content;
        double ratio = (static_cast<double>(content.cx) / content.cy) / (static_cast<double>(width_) / height_);
        UiLog("소스", Printf("공유 대상의 크기가 %ldx%ld로 바뀌었습니다. 출력 %dx%d는 그대로 두고 내용을 원본 비율로 가운데 배치합니다%s.", content.cx, content.cy,
                             width_, height_, std::fabs(ratio - 1) > 0.01 ? "(비율 차이만큼 여백)" : ""));
      }
    }
    int fps = settings_.fps;
    // The first seconds include encoder start-up and the first RTSP handshake.
    if (seconds > 3 && (sentFps < fps * 0.95 || skippedNow > 0 || encoderFps < fps * 0.95)) {
      ++behindSeconds;
    } else {
      behindSeconds = 0;
    }
    if (behindSeconds >= 3 && seconds - lastWarning >= 30) {
      lastWarning = seconds;
      UiLog("성능", Printf("설정 프레임 %d fps를 유지하지 못하고 있습니다. 송출 %.0f fps, 인코딩 %.0f fps, 건너뜀 %llu프레임.", fps, sentFps, encoderFps,
                           static_cast<unsigned long long>(skippedNow)));
    }
    if (seconds % 10 == 0 && record_.Active()) {
      // Recording size for the stats file, and the disk checks: recording pauses (live continues) when space runs out.
      recordBytes_ = record_.CurrentBytes();
      RecordStore::Check check = record_.Monitor(recording_);
      if (check.changed) {
        std::string error;
        if (SetRecording(check.record, error)) {
          recording_ = check.record;
          UiLog("녹화", check.message);
        } else {
          UiLog("녹화", "녹화 상태를 바꿀 수 없습니다: " + error);
        }
      }
    }
    json stats = {{"type", "stats"},
                  {"elapsedMs", EpochMillis() - startedAtMs_},
                  {"targetFps", fps},
                  {"captureFps", captureFps},
                  {"sentFps", sentFps},
                  {"newFrameFps", uniqueFps},
                  {"duplicateFps", dupFps},
                  {"skipped", skippedNow},
                  {"encoderFps", encoderFps},
                  {"speed", speed},
                  {"bitrateMbps", serverMbps},
                  {"viewers", viewers},
                  {"latencyMs", latencyMs},
                  {"encoder", encoder_}};
    PostUi(stats);
    if (seconds % 5 == 0)
      PostUi({{"type", "perf"},
              {"message", Printf("캡처 %.0f fps / 송출 %.0f fps (새 화면 %.0f) / 인코딩 %.0f fps / 건너뜀 %llu / %s", captureFps, sentFps, uniqueFps, encoderFps, static_cast<unsigned long long>(skipped_.load()), encoder_.c_str())}});
    csv << ClockText() << "," << (EpochMillis() - startedAtMs_) / 1000.0 << "," << fps << "," << captureFps << "," << sentFps << "," << uniqueFps << ","
        << dupFps << "," << skippedNow << "," << encoderFps << "," << speed << "," << progress["dup_frames"] << "," << progress["drop_frames"] << ","
        << serverMbps << "," << viewers << "," << latencyMs << "," << writeMs << "," << levels.systemPeak << "," << levels.micPeak << "," << levels.mixPeak
        << "," << levels.paddedFrames << "," << levels.droppedFrames << "," << recordBytes_ / 1048576.0 << "," << (recording_ ? 1 : 0) << "\n";
    csv.flush();
  }
}

}  // namespace fc
