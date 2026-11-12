// Full-broadcast recording (DVR) storage: where MediaMTX writes the broadcast, the time index of what is on disk, the
// retention policy and the disk checks. MediaMTX records a copy path ("<stream>/rec": the video and the AAC track of the
// stream FFmpeg already encoded, fMP4 segments, no second encode); this class only decides the folder, prunes finished
// broadcasts, tells the streamer when to pause recording and indexes the files for the HLS DVR playlist.
#pragma once

#include "common.h"
#include "config.h"

namespace fc {

// RFC 3339 ("2026-10-27T17:06:38.943337+09:00", "...Z") <-> Unix epoch milliseconds (fractional).
bool ParseRfc3339(const std::string& text, double& epochMs);
std::string FormatRfc3339Utc(double epochMs);  // microsecond precision, "Z"
std::string FormatIso8601Ms(double epochMs);   // millisecond precision, "Z" (HLS EXT-X-PROGRAM-DATE-TIME)

// HLS DVR over the recorded fMP4 files. MediaMTX 1.21 closes a recorded part (moof+mdat) every recordPartDuration
// regardless of keyframes, so a part's first video sample is normally not a sync sample and whole parts cannot form HLS
// segments that start with a keyframe. Segments are therefore cut at the video sync samples and served as new fragments
// whose samples are copied byte for byte from the recorded parts (no re-encode); the init is the file's own ftyp+moov.
struct RecordTrack {
  uint32_t id = 0, timescale = 0, handler = 0;
  uint32_t trexDuration = 0, trexSize = 0, trexFlags = 0;  // mvex/trex defaults
};

// One complete moof+mdat pair of a recorded file, with the decode-time range of its video samples.
struct RecordPart {
  uint64_t offset = 0, size = 0;
  uint64_t videoStart = 0, videoEnd = 0;  // video timescale
};

// One HLS media segment: video samples with decode time in [start, end) (video timescale) and the other tracks' samples
// of the same time span, read from parts [firstPart, lastPart]. openStart: the file's first segment (it also carries
// the audio before the first keyframe); openEnd: the last segment of a finished file (everything after start).
// Once listed a segment never changes (EVENT playlist).
struct RecordSegment {
  uint64_t start = 0, end = 0;
  size_t firstPart = 0, lastPart = 0;
  bool openStart = false, openEnd = false;
};

// Index of one recorded fMP4 file: the init length, its complete parts, the video keyframe times and the segments cut
// from them. Scanned incrementally while MediaMTX appends to it; only complete boxes are ever indexed.
struct RecordFile {
  fs::path path;
  double startMs = 0;        // wall-clock time of decode time 0 (the file's first sample), from the file name
  uint64_t size = 0;         // file size at the last scan
  uint64_t next = 0;         // offset after the last complete box (the next scan continues here)
  uint64_t initSize = 0;     // bytes before the first moof; 0 until the moov is complete
  std::vector<RecordTrack> tracks;
  size_t video = SIZE_MAX;   // index of the video track in tracks
  bool broken = false;       // not a readable fragmented MP4: nothing more is listed
  bool complete = false;     // finished and fully indexed (a newer file exists): never scanned again
  int64_t grewAtMs = 0;      // when the scan last saw the file grow
  std::vector<RecordPart> parts;
  std::vector<uint64_t> keyframes;  // decode times of the video sync samples, ascending
  std::vector<RecordSegment> segments;
  size_t nextKeyframe = 0;   // keyframes before this index are already segment boundaries

  uint32_t VideoTimescale() const { return video < tracks.size() ? tracks[video].timescale : 0; }
  // Bytes of the file a client may read directly: the init and the parts the listed segments are made of.
  uint64_t ListedBytes() const;
};

// Reads the boxes MediaMTX appended to f since the last scan (complete moof+mdat pairs only).
void ScanRecordFile(RecordFile& f);
// Cuts new segments of about targetSeconds at video keyframes. A segment is listed once the keyframe that ends it and one
// more second of media are on disk (so every track's samples of its span are complete), or when the file is final.
void GroupRecordFile(RecordFile& f, bool final, double targetSeconds);

// A media segment built from recorded parts: the moof (one traf per track, every sample's values explicit) followed by
// the mdat header, and the byte runs of the file that form the mdat payload, in order.
struct RecordFragment {
  std::string moof;  // moof box + mdat header
  std::vector<std::pair<uint64_t, uint64_t>> runs;  // (file offset, length)
  uint64_t payload = 0;                              // mdat payload bytes (sum of the runs)
};
// Builds one segment of f from the file on disk (reads the moofs of the segment's parts).
bool BuildRecordFragment(const RecordFile& f, const RecordSegment& segment, uint32_t sequence, RecordFragment& out);

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
  // a keyframe, so these anchor the keyframe grid used to request GOP-aligned media. recordPath is the MediaMTX path
  // that records ("<stream>/rec").
  std::vector<double> SegmentStarts(const std::string& recordPath) const;
  // The current broadcast's recorded files of recordPath with their start times, oldest first.
  std::vector<std::pair<fs::path, double>> Files(const std::string& recordPath) const;
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
