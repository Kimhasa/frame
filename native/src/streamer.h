// One streaming session: captured window -> NV12 frames + mixed audio -> FFmpeg (H.264/Opus) -> MediaMTX (RTSP in, WebRTC out).
#pragma once

#include "audio.h"
#include "capture.h"
#include "config.h"
#include "child_process.h"
#include "directory.h"
#include "recorder.h"

#include <future>
#include <map>

namespace fc {

struct EncoderProbe {
  std::vector<std::string> available;  // usable H.264 encoders in preference order
  std::vector<std::string> notes;      // why hardware encoders were skipped
  bool ffmpegFound = false;
  std::string ffmpegVersion;
};

struct Rendition {
  std::string name;  // "720p"
  int width = 0, height = 0;
  double mbps = 0;
};

class NamedPipe {
 public:
  ~NamedPipe() { Close(); }
  bool Create(const std::wstring& name, DWORD bufferSize, std::string& error);
  bool Connect(HANDLE stop, DWORD timeoutMs);
  bool Write(const void* data, size_t size, HANDLE stop);
  void Close();
  const std::wstring& Name() const { return name_; }
  DWORD LastError() const { return lastError_; }

 private:
  ScopedHandle pipe_, event_;
  std::wstring name_;
  DWORD lastError_ = ERROR_SUCCESS;
};

class Streamer {
 public:
  Streamer(Gpu& gpu, TaskQueue& control);
  ~Streamer();

  // Starts encoder probing in the background; Start() waits for it.
  void ProbeEncoders();
  EncoderProbe Probe();

  // Blocking; runs on the control queue. On failure field names the UI input to highlight (may be empty).
  bool Start(const Settings& settings, std::shared_ptr<WindowCapture> capture, const std::string& sourceTitle, std::string& field, std::string& error);
  // Blocking; runs on the control queue.
  void Stop(const std::string& reason, bool failed);
  bool Running() const { return running_; }
  void SetVolume(const std::string& channel, int volume);

  // Thread-safe snapshots for the UI and the viewer HTTP server.
  json Status() const;
  json ViewerInfo(const std::string& path) const;
  int WebrtcHttpPort() const { return running_ ? webrtcHttpPort_.load() : 0; }
  std::string StreamPath() const;
  bool KnownStreamPath(const std::string& path) const;
  // Latest list-card JPEG for the running broadcast (empty when the id is not the current broadcast).
  std::string Thumbnail(const std::string& id) const;
  bool LocalItem(BroadcastItem& item) const;
  std::string BroadcastId() const;
  // DVR: time index of what is recorded for the running broadcast (cached for 1 s, shared by all viewers), and the
  // loopback playback-server request for one media chunk. id must be the running broadcast's id.
  json DvrIndex(const std::string& path);
  bool DvrMediaTarget(const std::string& path, const std::string& id, double startMs, double durationMs, int& port, std::string& target,
                      int& status, std::string& error) const;
  // Called (on the thread that stops the session) once a running broadcast has ended, for any reason.
  std::function<void(const std::string& reason)> onStopped;

 private:
  bool StartMediaMtx(std::string& field, std::string& error);
  bool StartFfmpeg(const std::string& encoder, std::string& error);
  void StopFfmpeg();
  void PumpLoop();
  void AudioWriterLoop();
  void StatsLoop();
  void OnProgressLine(const std::string& line);
  std::vector<std::wstring> FfmpegArgs(const std::string& encoder) const;
  void ConfigureEncoderLocked(const std::string& encoder);
  void UpdateThumbnail();
  std::string RenditionCommand(const Rendition& r) const;
  bool WaitPublished(DWORD timeoutMs, std::string& error);
  void Fail(const std::string& reason);
  void KeepAwake(bool on);

  Gpu& gpu_;
  TaskQueue& control_;
  std::shared_future<EncoderProbe> probe_;
  fs::path ffmpegExe_, mediamtxExe_;

  mutable std::mutex mutex_;
  Settings settings_;
  int width_ = 0, height_ = 0;
  LONG sourceWidth_ = 0, sourceHeight_ = 0;
  std::string broadcastId_, title_, publisher_;
  std::string encoder_;
  std::vector<Rendition> renditions_;
  std::atomic<bool> running_{false};
  std::atomic<bool> failing_{false};
  std::atomic<uint64_t> session_{0};  // incremented for every broadcast that starts
  ScopedHandle powerRequest_;          // held while live
  int64_t startedAtMs_ = 0;
  std::atomic<int> webrtcHttpPort_{0};
  int apiPort_ = 0;
  int playbackPort_ = 0;

  // Recording (DVR): MediaMTX records the published stream; recording_ is its current on/off state.
  RecordStore record_;
  std::atomic<bool> recording_{false};
  std::atomic<uint64_t> recordBytes_{0};
  std::mutex dvrMutex_;
  json dvrCache_;
  int64_t dvrCacheQpc_ = 0;
  bool SetRecording(bool on, std::string& error);

  std::shared_ptr<WindowCapture> capture_;
  std::unique_ptr<ChildProcess> mediamtx_, ffmpeg_;
  std::unique_ptr<AudioEngine> audio_;
  NamedPipe videoPipe_, audioPipe_;
  ScopedHandle stopEvent_;
  std::thread pump_, audioWriter_, stats_;
  std::atomic<bool> statsStop_{false};

  // Measurements (reset at start).
  std::atomic<uint64_t> written_{0}, uniqueSent_{0}, duplicates_{0}, skipped_{0};
  std::atomic<int64_t> writeTicks_{0}, latencyTicks_{0};
  std::atomic<uint64_t> latencySamples_{0};
  std::atomic<int64_t> pumpStartQpc_{0};
  mutable std::mutex progressMutex_;
  std::map<std::string, std::string> progress_;
  int64_t progressQpc_ = 0, progressFrame_ = 0;
  std::atomic<double> encoderRate_{0};
  std::atomic<int> viewers_{0};
  std::atomic<double> measuredMbps_{0};
  mutable std::mutex thumbMutex_;
  std::mutex thumbBuildMutex_;
  std::string thumbnail_;
  FrameConverter thumbConverter_;
};

}  // namespace fc
