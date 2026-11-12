// One streaming session: captured window -> NV12 frames + mixed audio -> FFmpeg (H.264 + Opus + AAC) -> MediaMTX (RTSP in;
// WebRTC for the desktop app, LL-HLS for browsers, a video+AAC copy path that records the broadcast for the HLS DVR).
#pragma once

#include "audio.h"
#include "capture.h"
#include "config.h"
#include "child_process.h"
#include "directory.h"
#include "recorder.h"

#include <future>
#include <map>
#include <set>

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
  // Aggregate media-server counters for /api/stats (paths, readers, WebRTC sessions, bytes); cached for 1 s, no addresses.
  json ServerStats();
  int WebrtcHttpPort() const { return running_ ? webrtcHttpPort_.load() : 0; }
  int HlsPort() const { return running_ ? hlsPort_ : 0; }
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
  // HLS for every browser viewer. Multivariant playlist (live.m3u8) of the running stream: the source first, then the
  // on-demand qualities high to low, each with its AAC audio rendition; quality ("source", "720p", empty for all) limits
  // the list to one entry. While the ladder keeps failing, the stream's own path is the only entry (the source).
  // Returns false with an HTTP status when the stream does not run or the quality is unknown (or not offered).
  bool HlsMultivariant(const std::string& path, const std::string& quality, std::string& body, int& status);
  // HLS EVENT playlist (dvr.m3u8) over the current broadcast's recorded fMP4 files, byte ranges only; cached for 1 s.
  bool DvrPlaylist(const std::string& path, std::string& body, int& status);
  // One recorded file listed in dvr.m3u8 (a copy of its index): its listed segments, the raw bytes a client may read
  // ([0, ListedBytes())) and whether it is finished (complete: cacheable).
  bool DvrFile(const std::string& path, const std::string& id, int index, RecordFile& file, int& status);
  // Viewer sessions of HLS clients (counting only, no cap; at the memory bound the oldest is dropped, nobody is refused):
  // open returns the session id, touch keeps it active for 30 s.
  std::string HlsSessionOpen(const std::string& path, int& status);
  bool HlsSessionTouch(const std::string& path, const std::string& sid, bool close);
  int ActiveHlsSessions();
  static constexpr int kHlsHeartbeatMs = 15000;
  // Qualities (HLS variants, WebRTC qualities): one FFmpeg, the ladder, decodes the stream once and publishes a copy of
  // the source ("<stream>/src") and every lower quality ("<stream>/<h>p") on one clock, so the variants' segments carry
  // the same timestamps and dates. Started with the broadcast (and again by a request after an idle stop), stopped when
  // none of them had a reader for 5 min. With waitMs it also waits until `path` is published; false when not (yet).
  bool EnsureLadder(const std::string& path, DWORD waitMs);
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
  std::vector<std::wstring> LadderArgs(int64_t startUs) const;
  std::vector<std::string> LadderPathsLocked() const;
  bool WaitPathReady(const std::string& path, DWORD waitMs);
  void StopLadder();
  std::string RecordCopyCommand() const;
  std::string RecordPathName() const { return settings_.streamPath + "/rec"; }  // MediaMTX path that records
  void RefreshDvrFilesLocked(const std::string& id);
  bool RelayTarget(std::string& url, std::string& error) const;
  std::vector<std::wstring> RelayArgs(const std::string& url) const;
  std::string RelayApi() const;
  std::string IceHostsYaml() const;
  void RelayLoop();
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
  int hlsPort_ = 0;

  // Recording (DVR): MediaMTX records the published stream; recording_ is its current on/off state.
  RecordStore record_;
  std::atomic<bool> recording_{false};
  std::atomic<uint64_t> recordBytes_{0};
  std::mutex dvrMutex_;
  json dvrCache_;
  int64_t dvrCacheQpc_ = 0;
  bool SetRecording(bool on, std::string& error);
  // HLS DVR: index of the current broadcast's recorded files (grows only) and the last playlist built from it, each with
  // its own time (a refresh of the index alone, e.g. for an unlisted file, must not keep an old playlist fresh).
  std::mutex dvrHlsMutex_;
  std::string dvrFilesId_;
  std::vector<RecordFile> dvrFiles_;
  int64_t dvrFilesQpc_ = 0;
  std::string dvrPlaylist_;
  int64_t dvrPlaylistQpc_ = 0;
  // What each MediaMTX path of this broadcast really carried (sampled by StatsLoop): received bits over the seconds it
  // was measured (AVERAGE-BANDWIDTH) and its "avc1.PPCCLL" codec from MediaMTX (empty until reported).
  struct PathMedia {
    double bits = 0, seconds = 0;
    int64_t lastBytes = -1;
    std::string codec;
  };
  std::mutex rateMutex_;
  std::map<std::string, PathMedia> pathMedia_;
  // HLS viewer sessions: id -> last heartbeat (epoch ms).
  std::mutex sessionMutex_;
  std::map<std::string, int64_t> hlsSessions_;

  std::shared_ptr<WindowCapture> capture_;
  std::unique_ptr<ChildProcess> mediamtx_, ffmpeg_;
  // Quality ladder: the process, the paths confirmed published since it started, its warm-up (creates each variant's
  // HLS muxer so a first quality switch does not wait for it) and the last time a ladder path was requested or read.
  std::mutex ladderMutex_;
  std::unique_ptr<ChildProcess> ladder_;
  std::set<std::string> ladderReady_;
  std::thread ladderWarm_;
  std::atomic<int64_t> ladderUseMs_{0};
  int64_t ladderRetryAtMs_ = 0;  // after the ladder exited on its own, no restart before this (no restart storm)
  // Consecutive ladders that could not start or exited before publishing every path (the count of its paths is kept per
  // start); while above 0, live.m3u8 offers the stream's own path as the only variant.
  int ladderFailures_ = 0;
  size_t ladderPathCount_ = 0;
  static constexpr int kLadderIdleMs = 300000;  // no reader on any ladder path this long: stop it
  static constexpr int kLadderStableMs = 30000;  // a ladder that ends sooner counts as failed; one running this long ends a streak
  int64_t ladderStartedMs_ = 0;
  bool LadderEndedLocked();
  void LadderFailedLocked(const std::string& what, const std::string& detail);
  std::unique_ptr<AudioEngine> audio_;
  NamedPipe videoPipe_, audioPipe_;
  ScopedHandle stopEvent_;
  std::thread pump_, audioWriter_, stats_;
  std::atomic<bool> statsStop_{false};
  std::thread relay_;  // relay list announcements and status, when an internet relay is configured
  std::atomic<bool> relayStop_{false};
  std::atomic<int64_t> discardWarnings_{0};  // MediaMTX "too slow" / discarding lines: a reader could not keep up
  std::mutex serverStatsMutex_;
  json serverStatsCache_;
  int64_t serverStatsAt_ = 0;

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
