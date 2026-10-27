// Full-broadcast recording (DVR) storage: where MediaMTX writes the broadcast, the time index of what is on disk, the
// retention policy and the disk checks. MediaMTX records the stream FFmpeg already encoded (fMP4 segments, no second
// encode); this class only decides the folder, prunes finished broadcasts and tells the streamer when to pause recording.
#pragma once

#include "common.h"
#include "config.h"

namespace fc {

// RFC 3339 ("2026-10-27T17:06:38.943337+09:00", "...Z") <-> Unix epoch milliseconds (fractional).
bool ParseRfc3339(const std::string& text, double& epochMs);
std::string FormatRfc3339Utc(double epochMs);  // microsecond precision, "Z"

class RecordStore {
 public:
  // Folder for all recordings: settings.recordDir (absolute, or relative to the exe folder) or
  // %LOCALAPPDATA%\FrameConsole\recordings. Recordings are kept out of the portable folder by default because it often
  // sits in a synchronised (OneDrive) or small location.
  static fs::path Root(const Settings& settings);

  // Prepares recording for a new broadcast: creates <root>\<id>, writes broadcast.json, removes finished broadcasts that
  // are older than recordKeepDays and then the oldest ones above recordMaxGB, and checks free space. The current broadcast
  // is never removed. Returns false with a user-facing reason when this broadcast cannot be recorded (live still runs).
  bool Prepare(const Settings& settings, const std::string& broadcastId, const json& meta, std::string& reason);
  // Removes what a failed encoder attempt wrote, before the next attempt starts recording into the same folder.
  void ClearCurrent();
  // Removes the folder of a broadcast that never started.
  void Discard();
  // Merges fields into broadcast.json (the encoder and bitrate that actually run after an encoder fallback).
  void UpdateMeta(const json& patch);
  // Writes the end time, size and average bitrate into broadcast.json. Returns a summary line for the event table.
  std::string Finish(int64_t endedAtMs);

  // Thread safe: the viewer server reads the index while the control and stats threads update the store.
  bool Active() const;
  fs::path RootDir() const;
  fs::path CurrentDir() const;  // empty when not recording
  // MediaMTX recordPath relative to its working directory (= RootDir()); %path is the stream path.
  std::string RecordPathPattern() const;
  // Segment start times (epoch ms) of the current broadcast, from the file names MediaMTX writes. Each segment starts with
  // a keyframe, so these anchor the keyframe grid used to request GOP-aligned media.
  std::vector<double> SegmentStarts(const std::string& streamPath) const;
  uint64_t CurrentBytes() const;
  uint64_t TotalBytes() const;  // this program's broadcasts under the root (finished ones counted at Prepare/prune time)
  double FreeGB() const;

  // Every few seconds while live. Returns the recording state the streamer should apply ("record" true/false) and a
  // message when it changes: free space below recordMinFreeGB pauses recording, recovery (2 GB above) resumes it; the
  // total cap first removes older finished broadcasts and pauses only when the current broadcast alone exceeds it.
  struct Check {
    bool record = true;
    bool changed = false;
    std::string message;
  };
  Check Monitor(bool recordingNow);

 private:
  mutable std::mutex mutex_;
  Settings settings_;
  fs::path root_;
  std::string id_;
  int64_t startedAtMs_ = 0;
  uint64_t othersBytes_ = 0;  // finished broadcasts kept under the root
  bool pausedForSpace_ = false, pausedForCap_ = false;
};

}  // namespace fc
