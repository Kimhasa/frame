#include "audio.h"

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <algorithm>
#include <cmath>

namespace fc {

using Microsoft::WRL::ComPtr;

namespace {

constexpr REFERENCE_TIME kBufferDuration = 100000;  // 10 ms
constexpr size_t kRingFrames = kAudioRate * 2;       // 2 s per source
constexpr size_t kMaxSourceBacklog = kAudioRate / 25;  // keep at most 40 ms queued per source (latency and A/V sync)
constexpr size_t kMaxFifoFrames = kAudioRate * 2;
// The mixer runs this far behind the wall clock so device packets are already queued when it needs them.
constexpr int kMixerLagMs = 20;

class ActivationHandler : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase,
                                                              IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() { done_.Reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activateResult = E_FAIL;
    ComPtr<IUnknown> unknown;
    result_ = operation->GetActivateResult(&activateResult, &unknown);
    if (SUCCEEDED(result_)) result_ = activateResult;
    if (SUCCEEDED(result_)) result_ = unknown.As(&client_);
    SetEvent(done_.Get());
    return S_OK;
  }
  HRESULT Wait(ComPtr<IAudioClient>& client) {
    if (WaitForSingleObject(done_.Get(), 5000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    client = client_;
    return result_;
  }

 private:
  ScopedHandle done_;
  HRESULT result_ = E_PENDING;
  ComPtr<IAudioClient> client_;
};

std::string DeviceError(HRESULT hr, bool microphone) {
  if (hr == E_ACCESSDENIED) return microphone ? "마이크 사용 권한이 꺼져 있습니다. Windows 설정 > 개인 정보 및 보안 > 마이크에서 데스크톱 앱 접근을 허용하세요."
                                              : "시스템 소리 접근이 거부되었습니다.";
  if (hr == static_cast<HRESULT>(0x80070490) /* E_NOTFOUND */) return microphone ? "마이크 장치를 찾을 수 없습니다." : "소리 출력 장치를 찾을 수 없습니다.";
  if (hr == AUDCLNT_E_DEVICE_IN_USE) return microphone ? "다른 프로그램이 마이크를 독점 사용 중입니다." : "다른 프로그램이 소리 장치를 독점 사용 중입니다.";
  return (microphone ? "마이크를 열 수 없습니다: " : "시스템 소리를 열 수 없습니다: ") + HrMessage(hr);
}

}  // namespace

// One WASAPI capture stream converted to 48 kHz stereo float in a ring buffer.
class AudioSource {
 public:
  enum class Kind { System, Microphone };
  explicit AudioSource(Kind kind) : kind_(kind) { ring_.assign(kRingFrames * 2, 0.0f); }
  ~AudioSource() { Close(); }

  bool Open(std::string& error) {
    HRESULT hr = OpenClient();
    if (FAILED(hr)) {
      error = DeviceError(hr, kind_ == Kind::Microphone);
      return false;
    }
    running_ = true;
    thread_ = std::thread([this] { Loop(); });
    return true;
  }

  void Close() {
    running_ = false;
    if (thread_.joinable()) thread_.join();
    if (client_) client_->Stop();
    capture_.Reset();
    client_.Reset();
  }

  size_t Pull(float* dst, size_t frames) {
    std::lock_guard<std::mutex> lock(mutex_);
    size_t n = std::min(frames, count_);
    for (size_t i = 0; i < n; ++i) {
      size_t index = (head_ + i) % kRingFrames;
      dst[i * 2] = ring_[index * 2];
      dst[i * 2 + 1] = ring_[index * 2 + 1];
    }
    head_ = (head_ + n) % kRingFrames;
    count_ -= n;
    return n;
  }

  size_t Discard(size_t keep) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (count_ <= keep) return 0;
    size_t drop = count_ - keep;
    head_ = (head_ + drop) % kRingFrames;
    count_ = keep;
    return drop;
  }

  uint64_t TakeCaptured() { return captured_.exchange(0); }
  const char* Path() const { return path_; }

 private:
  HRESULT OpenClient() {
    capture_.Reset();
    client_.Reset();
    event_.Reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    HRESULT hr = E_FAIL;
    WAVEFORMATEX desired{};
    desired.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    desired.nChannels = kAudioChannels;
    desired.nSamplesPerSec = kAudioRate;
    desired.wBitsPerSample = 32;
    desired.nBlockAlign = desired.nChannels * desired.wBitsPerSample / 8;
    desired.nAvgBytesPerSec = desired.nSamplesPerSec * desired.nBlockAlign;
    if (kind_ == Kind::System) {
      // Prefer process loopback that excludes FRAME Console (and its WebView2 player), so a local preview does not echo.
      AUDIOCLIENT_ACTIVATION_PARAMS params{};
      params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
      params.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
      params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
      PROPVARIANT pv{};
      pv.vt = VT_BLOB;
      pv.blob.cbSize = sizeof(params);
      pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
      auto handler = Microsoft::WRL::Make<ActivationHandler>();
      ComPtr<IActivateAudioInterfaceAsyncOperation> op;
      hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
      if (SUCCEEDED(hr)) hr = handler->Wait(client_);
      if (SUCCEEDED(hr)) {
        WAVEFORMATEX pcm = desired;
        pcm.wFormatTag = WAVE_FORMAT_PCM;
        pcm.wBitsPerSample = 16;
        pcm.nBlockAlign = pcm.nChannels * 2;
        pcm.nAvgBytesPerSec = pcm.nSamplesPerSec * pcm.nBlockAlign;
        hr = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                                 kBufferDuration, 0, &pcm, nullptr);
        if (SUCCEEDED(hr)) {
          SetFormat(&pcm);
          hr = client_->SetEventHandle(event_.Get());
          path_ = "process-loopback";
        }
      }
      if (FAILED(hr)) {
        LogFile("audio", "process loopback unavailable (" + HrMessage(hr) + "), using endpoint loopback");
        client_.Reset();
        hr = OpenEndpoint(eRender, AUDCLNT_STREAMFLAGS_LOOPBACK, desired);
        path_ = "endpoint-loopback";
      }
    } else {
      hr = OpenEndpoint(eCapture, 0, desired);
      path_ = "microphone";
    }
    if (FAILED(hr)) return hr;
    hr = client_->GetService(IID_PPV_ARGS(&capture_));
    if (SUCCEEDED(hr)) hr = client_->Start();
    if (SUCCEEDED(hr)) LogFile("audio", Printf("%s opened: %u Hz, %u ch, %u bit, float=%d", path_, rate_, channels_, bits_, isFloat_ ? 1 : 0));
    return hr;
  }

  HRESULT OpenEndpoint(EDataFlow flow, DWORD flags, const WAVEFORMATEX& desired) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) return hr;
    ComPtr<IMMDevice> device;
    hr = enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device);
    if (FAILED(hr)) return hr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client_.GetAddressOf()));
    if (FAILED(hr)) return hr;
    // Ask the audio engine to convert to 48 kHz stereo float; fall back to the device mix format and convert here.
    hr = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                             kBufferDuration, 0, &desired, nullptr);
    if (SUCCEEDED(hr)) {
      SetFormat(&desired);
      return hr;
    }
    if (hr == E_ACCESSDENIED) return hr;
    client_.Reset();
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client_.GetAddressOf()));
    if (FAILED(hr)) return hr;
    WAVEFORMATEX* mix = nullptr;
    hr = client_->GetMixFormat(&mix);
    if (FAILED(hr)) return hr;
    hr = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0, mix, nullptr);
    if (SUCCEEDED(hr)) SetFormat(mix);
    CoTaskMemFree(mix);
    return hr;
  }

  void SetFormat(const WAVEFORMATEX* f) {
    rate_ = f->nSamplesPerSec;
    channels_ = std::max<WORD>(1, f->nChannels);
    bits_ = f->wBitsPerSample;
    isFloat_ = f->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (f->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
      auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(f);
      isFloat_ = ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
      if (ext->Samples.wValidBitsPerSample) validBits_ = ext->Samples.wValidBitsPerSample;
    }
    blockAlign_ = f->nBlockAlign;
    resamplePos_ = 0;
    havePrev_ = false;
  }

  float SampleAt(const BYTE* frame, WORD channel) const {
    const BYTE* p = frame + channel * (bits_ / 8);
    if (isFloat_ && bits_ == 32) return *reinterpret_cast<const float*>(p);
    if (bits_ == 16) return *reinterpret_cast<const int16_t*>(p) / 32768.0f;
    if (bits_ == 24) return static_cast<float>((static_cast<int32_t>(p[0] << 8 | p[1] << 16 | p[2] << 24)) >> 8) / 8388608.0f;
    if (bits_ == 32) return *reinterpret_cast<const int32_t*>(p) / 2147483648.0f;
    return 0;
  }

  void Push(float left, float right) {
    std::lock_guard<std::mutex> lock(mutex_);
    size_t tail = (head_ + count_) % kRingFrames;
    ring_[tail * 2] = left;
    ring_[tail * 2 + 1] = right;
    if (count_ < kRingFrames) {
      ++count_;
    } else {
      head_ = (head_ + 1) % kRingFrames;
    }
  }

  void Convert(const BYTE* data, UINT32 frames, bool silent) {
    for (UINT32 i = 0; i < frames; ++i) {
      float l = 0, r = 0;
      if (!silent) {
        const BYTE* f = data + static_cast<size_t>(i) * blockAlign_;
        l = SampleAt(f, 0);
        r = channels_ > 1 ? SampleAt(f, 1) : l;
      }
      if (rate_ == static_cast<UINT>(kAudioRate)) {
        Push(l, r);
        continue;
      }
      // Linear interpolation resampler for devices that are not 48 kHz.
      if (!havePrev_) {
        prevL_ = l;
        prevR_ = r;
        havePrev_ = true;
        continue;
      }
      double step = static_cast<double>(rate_) / kAudioRate;
      while (resamplePos_ < 1.0) {
        float t = static_cast<float>(resamplePos_);
        Push(prevL_ + (l - prevL_) * t, prevR_ + (r - prevR_) * t);
        resamplePos_ += step;
      }
      resamplePos_ -= 1.0;
      prevL_ = l;
      prevR_ = r;
    }
    captured_ += frames;
  }

  void Loop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD taskIndex = 0;
    HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
    int64_t lastReopen = 0;
    bool reportedLoss = false;
    while (running_) {
      if (!capture_) {
        if (QpcSeconds(QpcNow() - lastReopen) > 2.0) {
          lastReopen = QpcNow();
          if (SUCCEEDED(OpenClient())) {
            UiLog("오디오", std::string(kind_ == Kind::Microphone ? "마이크" : "시스템 소리") + " 장치를 다시 연결했습니다.");
            reportedLoss = false;
          }
        }
        Sleep(20);
        continue;
      }
      WaitForSingleObject(event_.Get(), 10);
      UINT32 packet = 0;
      HRESULT hr = capture_->GetNextPacketSize(&packet);
      while (SUCCEEDED(hr) && packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;
        Convert(data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
        capture_->ReleaseBuffer(frames);
        hr = capture_->GetNextPacketSize(&packet);
      }
      if (FAILED(hr)) {
        if (!reportedLoss) {
          UiLog("오디오", std::string(kind_ == Kind::Microphone ? "마이크" : "시스템 소리") + " 장치 연결이 끊어졌습니다. 다시 연결을 시도합니다. " + HrMessage(hr));
          reportedLoss = true;
        }
        capture_.Reset();
        client_.Reset();
        lastReopen = QpcNow();
      }
    }
    if (task) AvRevertMmThreadCharacteristics(task);
    CoUninitialize();
  }

  Kind kind_;
  const char* path_ = "";
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioCaptureClient> capture_;
  ScopedHandle event_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  UINT rate_ = kAudioRate;
  WORD channels_ = 2, bits_ = 32, validBits_ = 0, blockAlign_ = 8;
  bool isFloat_ = true;
  double resamplePos_ = 0;
  bool havePrev_ = false;
  float prevL_ = 0, prevR_ = 0;
  std::mutex mutex_;
  std::vector<float> ring_;
  size_t head_ = 0, count_ = 0;
  std::atomic<uint64_t> captured_{0};
};

AudioEngine::AudioEngine() = default;
AudioEngine::~AudioEngine() { Stop(); }

bool AudioEngine::Start(const std::string& mode, int systemVolume, int micVolume, std::string& error) {
  Stop();
  SetVolume("system", systemVolume);
  SetVolume("mic", micVolume);
  if (mode == "system" || mode == "mix") {
    system_ = std::make_unique<AudioSource>(AudioSource::Kind::System);
    if (!system_->Open(error)) {
      system_.reset();
      return false;
    }
  }
  if (mode == "mic" || mode == "mix") {
    mic_ = std::make_unique<AudioSource>(AudioSource::Kind::Microphone);
    if (!mic_->Open(error)) {
      mic_.reset();
      system_.reset();
      return false;
    }
  }
  {
    std::lock_guard<std::mutex> lock(fifoMutex_);
    fifo_.clear();
    fifoStart_ = 0;
    timelineStarted_ = false;
    dropPending_ = 0;
  }
  {
    std::lock_guard<std::mutex> lock(levelMutex_);
    levels_ = AudioLevels{};
    levels_.systemPath = system_ ? system_->Path() : "";
  }
  running_ = true;
  mixer_ = std::thread([this] { MixLoop(); });
  return true;
}

void AudioEngine::Stop() {
  running_ = false;
  fifoCv_.notify_all();
  if (mixer_.joinable()) mixer_.join();
  system_.reset();
  mic_.reset();
}

void AudioEngine::SetVolume(const std::string& channel, int volume) {
  float gain = std::clamp(volume, 0, 100) / 100.0f;
  if (channel == "system") systemGain_ = gain;
  if (channel == "mic") micGain_ = gain;
}

void AudioEngine::BeginTimeline() {
  std::lock_guard<std::mutex> lock(fifoMutex_);
  fifo_.clear();
  fifoStart_ = 0;
  timelineStarted_ = true;
  // Samples mixed right after this instant describe sound from kMixerLagMs earlier; skipping them puts audio and video
  // content captured at the same moment on the same timestamp.
  dropPending_ = static_cast<uint64_t>(kAudioRate) * kMixerLagMs / 1000;
  // Sound queued while devices were opening (opening a microphone can take a few hundred ms) would otherwise stay in
  // front of everything that follows and delay audio for the whole session.
  for (AudioSource* source : {system_.get(), mic_.get()})
    if (source) source->Discard(kAudioRate / 100);
}

void AudioEngine::DropDuration(double seconds) {
  std::lock_guard<std::mutex> lock(fifoMutex_);
  dropPending_ += static_cast<uint64_t>(std::llround(seconds * kAudioRate));
}

size_t AudioEngine::Read(int16_t* dst, size_t maxFrames, DWORD timeoutMs) {
  std::unique_lock<std::mutex> lock(fifoMutex_);
  fifoCv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return !running_ || fifo_.size() > fifoStart_; });
  size_t available = (fifo_.size() - fifoStart_) / kAudioChannels;
  size_t n = std::min(maxFrames, available);
  memcpy(dst, fifo_.data() + fifoStart_, n * kAudioChannels * sizeof(int16_t));
  fifoStart_ += n * kAudioChannels;
  if (fifoStart_ > kAudioRate * kAudioChannels) {
    fifo_.erase(fifo_.begin(), fifo_.begin() + static_cast<std::ptrdiff_t>(fifoStart_));
    fifoStart_ = 0;
  }
  return n;
}

AudioLevels AudioEngine::TakeLevels() {
  std::lock_guard<std::mutex> lock(levelMutex_);
  AudioLevels out = levels_;
  levels_.systemPeak = levels_.micPeak = levels_.mixPeak = 0;
  levels_.systemFrames = levels_.micFrames = 0;
  levels_.paddedFrames = levels_.droppedFrames = 0;
  return out;
}

void AudioEngine::MixLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
  ScopedHandle timer(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS));
  const int64_t start = QpcNow() + QpcFrequency() * kMixerLagMs / 1000;
  uint64_t produced = 0;
  std::vector<float> mix, tmp;
  std::vector<int16_t> pcm;
  while (running_) {
    LARGE_INTEGER due;
    due.QuadPart = -100000;  // 10 ms
    if (timer.Valid() && SetWaitableTimer(timer.Get(), &due, 0, nullptr, nullptr, FALSE)) {
      WaitForSingleObject(timer.Get(), 50);
    } else {
      Sleep(10);
    }
    int64_t now = QpcNow();
    if (now < start) continue;
    uint64_t target = static_cast<uint64_t>(static_cast<double>(now - start) * kAudioRate / QpcFrequency());
    if (target <= produced) continue;
    size_t n = static_cast<size_t>(std::min<uint64_t>(target - produced, kAudioRate / 5));
    produced = target;
    mix.assign(n * 2, 0.0f);
    tmp.resize(n * 2);
    AudioLevels local;
    auto add = [&](AudioSource* source, float gain, float& peak, uint64_t& captured) {
      if (!source) return;
      size_t got = source->Pull(tmp.data(), n);
      for (size_t i = 0; i < got * 2; ++i) {
        float v = tmp[i] * gain;
        mix[i] += v;
        peak = std::max(peak, std::fabs(v));
      }
      local.paddedFrames += n - got;
      local.droppedFrames += source->Discard(kMaxSourceBacklog);
      captured += source->TakeCaptured();
    };
    add(system_.get(), systemGain_.load(), local.systemPeak, local.systemFrames);
    add(mic_.get(), micGain_.load(), local.micPeak, local.micFrames);
    pcm.resize(n * 2);
    for (size_t i = 0; i < n * 2; ++i) {
      float v = std::clamp(mix[i], -1.0f, 1.0f);
      local.mixPeak = std::max(local.mixPeak, std::fabs(v));
      pcm[i] = static_cast<int16_t>(std::lrint(v * 32767.0f));
    }
    {
      std::lock_guard<std::mutex> lock(fifoMutex_);
      if (timelineStarted_) {
        size_t skip = static_cast<size_t>(std::min<uint64_t>(dropPending_, n));
        dropPending_ -= skip;
        local.droppedFrames += skip;
        fifo_.insert(fifo_.end(), pcm.begin() + static_cast<std::ptrdiff_t>(skip * 2), pcm.end());
        size_t queued = (fifo_.size() - fifoStart_) / kAudioChannels;
        if (queued > kMaxFifoFrames) {
          // FFmpeg stopped reading audio: drop the oldest samples instead of growing without bound.
          size_t drop = queued - kMaxFifoFrames;
          fifoStart_ += drop * kAudioChannels;
          local.droppedFrames += drop;
        }
      }
    }
    fifoCv_.notify_all();
    std::lock_guard<std::mutex> lock(levelMutex_);
    levels_.systemPeak = std::max(levels_.systemPeak, local.systemPeak);
    levels_.micPeak = std::max(levels_.micPeak, local.micPeak);
    levels_.mixPeak = std::max(levels_.mixPeak, local.mixPeak);
    levels_.systemFrames += local.systemFrames;
    levels_.micFrames += local.micFrames;
    levels_.paddedFrames += local.paddedFrames;
    levels_.droppedFrames += local.droppedFrames;
  }
  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

}  // namespace fc
