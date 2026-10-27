// System sound (WASAPI loopback) and microphone capture, resampled to 48 kHz stereo, mixed with live per-source volume,
// and delivered as s16le to the FFmpeg audio pipe on the same timeline as the video frames.
#pragma once

#include "common.h"

namespace fc {

constexpr int kAudioRate = 48000;
constexpr int kAudioChannels = 2;

class AudioSource;

struct AudioLevels {
  float systemPeak = 0, micPeak = 0, mixPeak = 0;  // linear 0..1 over the last stats interval
  uint64_t systemFrames = 0, micFrames = 0;        // frames captured from each device
  uint64_t paddedFrames = 0;                       // silence inserted because a device delivered nothing
  uint64_t droppedFrames = 0;                      // frames discarded to keep latency or A/V sync bounded
  std::string systemPath;                          // "process-loopback" or "endpoint-loopback"
};

class AudioEngine {
 public:
  AudioEngine();
  ~AudioEngine();
  // mode: system | mic | mix
  bool Start(const std::string& mode, int systemVolume, int micVolume, std::string& error);
  void Stop();
  void SetVolume(const std::string& channel, int volume);
  // Called when the first video frame is handed to the encoder; samples before this instant are discarded.
  void BeginTimeline();
  // Video skipped frames because the encoder fell behind; drop the same duration of audio so A/V stays aligned.
  void DropDuration(double seconds);
  // Blocks up to timeoutMs; returns interleaved s16 frames copied into dst.
  size_t Read(int16_t* dst, size_t maxFrames, DWORD timeoutMs);
  AudioLevels TakeLevels();

 private:
  void MixLoop();
  std::unique_ptr<AudioSource> system_, mic_;
  std::atomic<float> systemGain_{0.8f}, micGain_{1.0f};
  std::thread mixer_;
  std::atomic<bool> running_{false};
  std::mutex fifoMutex_;
  std::condition_variable fifoCv_;
  std::vector<int16_t> fifo_;
  size_t fifoStart_ = 0;
  bool timelineStarted_ = false;
  uint64_t dropPending_ = 0;
  std::mutex levelMutex_;
  AudioLevels levels_;
};

}  // namespace fc
