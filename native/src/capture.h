// Window capture with Windows Graphics Capture and GPU scaling/colour conversion for encoding and previews.
#pragma once

#include "common.h"

#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

namespace fc {

using Microsoft::WRL::ComPtr;

class Gpu {
 public:
  bool Init(std::string& error);
  ID3D11Device* Device() const { return device_.Get(); }
  ID3D11DeviceContext* Context() const { return context_.Get(); }
  ID3D11VideoDevice* VideoDevice() const { return videoDevice_.Get(); }
  ID3D11VideoContext* VideoContext() const { return videoContext_.Get(); }
  const winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice& WinrtDevice() const { return winrtDevice_; }
  // Serialises every use of the immediate context across capture, encoding and preview threads.
  std::mutex& Lock() { return lock_; }
  const std::string& AdapterName() const { return adapterName_; }

 private:
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11VideoDevice> videoDevice_;
  ComPtr<ID3D11VideoContext> videoContext_;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
  std::mutex lock_;
  std::string adapterName_;
};

// Aspect-preserving placement of a w x h image inside a box (even coordinates for 4:2:0 output).
RECT FitRect(UINT srcW, UINT srcH, UINT boxW, UINT boxH);

struct ClientInsets;  // capture.cpp: frame-to-client insets of a captured window

class WindowCapture {
 public:
  explicit WindowCapture(Gpu& gpu) : gpu_(gpu) {}
  ~WindowCapture() { Stop(); }
  WindowCapture(const WindowCapture&) = delete;
  WindowCapture& operator=(const WindowCapture&) = delete;

  bool Start(HWND hwnd, bool cursor, std::string& error);
  // Captures one whole monitor (device is its GDI name, e.g. DISPLAY1 device, used to notice disconnection).
  bool StartMonitor(HMONITOR monitor, const std::wstring& device, bool cursor, std::string& error);
  void Stop();
  bool Closed() const { return closed_; }
  // Windows Graphics Capture does not always raise Closed for destroyed windows; callers poll this as well.
  void PollClosed();
  HWND Window() const { return hwnd_; }  // nullptr for a monitor
  bool IsMonitor() const { return !monitorDevice_.empty(); }
  // Unique frames delivered by Windows Graphics Capture (a static window produces few frames).
  uint64_t FrameCount() const { return frames_; }
  int64_t LastFrameQpc() const { return lastFrameQpc_; }
  SIZE ContentSize() const;  // for a window: its client area (title bar and borders removed), in physical pixels
  // Runs fn with the newest frame while the GPU lock is held. Returns false until the first frame arrives.
  bool WithLatest(const std::function<void(ID3D11Texture2D*, UINT, UINT, uint64_t)>& fn);
  std::function<void()> onClosed;

 private:
  bool StartItem(const winrt::Windows::Graphics::Capture::GraphicsCaptureItem& item, HWND hwnd, const std::wstring& monitorDevice, bool cursor,
                 std::string& error);
  void OnFrameArrived(const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool& pool);
  void LogGeometry(int surfaceW, int surfaceH, const ClientInsets& insets, UINT x, UINT y, UINT w, UINT h);

  Gpu& gpu_;
  HWND hwnd_ = nullptr;
  std::wstring monitorDevice_;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::FrameArrived_revoker frameRevoker_;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem::Closed_revoker closedRevoker_;
  winrt::Windows::Graphics::SizeInt32 poolSize_{};
  std::mutex frameMutex_;
  bool running_ = false;
  ComPtr<ID3D11Texture2D> latest_;
  UINT latestW_ = 0, latestH_ = 0;
  uint64_t latestSeq_ = 0;
  std::atomic<uint64_t> frames_{0};
  std::atomic<int64_t> lastFrameQpc_{0};
  std::atomic<bool> closed_{false};
  bool cropFailureLogged_ = false;
  std::string captionKey_;
  int64_t captionQpc_ = 0;
  LONG captionRows_ = 0;
  std::string lastGeometry_;
  int64_t lastGeometryQpc_ = 0;
};

// GPU video processor (BGRA -> NV12 or BGRA, scaled and letterboxed) with a CPU fallback.
class FrameConverter {
 public:
  // Produces a contiguous NV12 image (Y plane then interleaved UV) of dstW x dstH.
  bool ToNv12(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, UINT dstW, UINT dstH, std::vector<uint8_t>& out, std::string& error);
  // Produces a 24-bit BGR image that fits inside maxW x maxH.
  bool ToBgr(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, UINT maxW, UINT maxH, std::vector<uint8_t>& out, UINT& outW,
             UINT& outH, std::string& error);
  bool UsingCpu() const { return cpu_; }

 private:
  bool EnsureProcessor(Gpu& gpu, UINT inW, UINT inH, UINT outW, UINT outH, bool yuv);
  bool Blt(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, ID3D11Texture2D* dst, UINT dstW, UINT dstH, const RECT& dstRect, bool yuv);
  bool ReadSource(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, std::vector<uint8_t>& bgra);

  bool cpu_ = false;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  UINT inW_ = 0, inH_ = 0, outW_ = 0, outH_ = 0;
  bool yuv_ = false;
  ComPtr<ID3D11Texture2D> inputRef_;
  ComPtr<ID3D11VideoProcessorInputView> inputView_;
  ComPtr<ID3D11Texture2D> target_, staging_;
  ComPtr<ID3D11VideoProcessorOutputView> outputView_;
  UINT targetW_ = 0, targetH_ = 0;
  DXGI_FORMAT targetFormat_ = DXGI_FORMAT_UNKNOWN;
  ComPtr<ID3D11Texture2D> sourceStaging_;
  UINT sourceStagingW_ = 0, sourceStagingH_ = 0;
};

bool EncodeJpeg(const std::vector<uint8_t>& bgr, UINT w, UINT h, float quality, std::string& jpeg);
std::string Base64(const std::string& data);

// Window list for the source dialog.
struct SourceWindow {
  HWND hwnd = nullptr;
  DWORD pid = 0;
  std::wstring title;
  std::wstring exe;
  RECT rect{};
  bool minimized = false;
};
std::vector<SourceWindow> EnumerateSourceWindows(HWND self);
std::string SourceId(HWND hwnd, DWORD pid);
bool ParseSourceId(const std::string& id, HWND& hwnd, DWORD& pid);
// Refresh rate of the monitor that shows the window (0 when unknown).
int WindowMonitorRefreshRate(HWND hwnd);

// Monitors for the full-screen source tab.
struct SourceMonitor {
  HMONITOR handle = nullptr;
  std::wstring device;   // GDI device name, e.g. DISPLAY1 device
  std::string id;        // stable across reconnects: hash of the display's device interface path
  int number = 0;        // 1-based, left to right
  int width = 0, height = 0;  // physical pixels
  int scale = 100;       // effective DPI scaling in percent
  int refresh = 0;       // Hz
  bool primary = false;
};
std::vector<SourceMonitor> EnumerateMonitors();
bool FindMonitor(const std::string& id, SourceMonitor& monitor);
bool MonitorPresent(const std::wstring& device);

}  // namespace fc
