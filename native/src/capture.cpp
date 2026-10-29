#include "capture.h"

#include <dwmapi.h>
#include <psapi.h>
#include <shellscalingapi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <cmath>

namespace fc {

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wd3d = winrt::Windows::Graphics::DirectX::Direct3D11;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;

bool Gpu::Init(std::string& error) {
  D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  struct Attempt {
    D3D_DRIVER_TYPE type;
    UINT flags;
  } attempts[] = {
      {D3D_DRIVER_TYPE_HARDWARE, D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT},
      {D3D_DRIVER_TYPE_HARDWARE, D3D11_CREATE_DEVICE_BGRA_SUPPORT},
      {D3D_DRIVER_TYPE_WARP, D3D11_CREATE_DEVICE_BGRA_SUPPORT},
  };
  HRESULT hr = E_FAIL;
  for (const auto& a : attempts) {
    hr = D3D11CreateDevice(nullptr, a.type, nullptr, a.flags, levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &device_, nullptr, &context_);
    if (SUCCEEDED(hr)) break;
  }
  if (FAILED(hr)) {
    error = "Direct3D 11 장치를 만들 수 없습니다: " + HrMessage(hr);
    return false;
  }
  ComPtr<ID3D10Multithread> multithread;
  if (SUCCEEDED(context_.As(&multithread))) multithread->SetMultithreadProtected(TRUE);
  device_.As(&videoDevice_);
  context_.As(&videoContext_);
  ComPtr<IDXGIDevice> dxgi;
  device_.As(&dxgi);
  ComPtr<IDXGIAdapter> adapter;
  if (dxgi && SUCCEEDED(dxgi->GetAdapter(&adapter))) {
    DXGI_ADAPTER_DESC desc{};
    adapter->GetDesc(&desc);
    adapterName_ = Utf8(desc.Description);
  }
  winrt::com_ptr<::IInspectable> inspectable;
  hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), inspectable.put());
  if (FAILED(hr)) {
    error = "캡처용 Direct3D 장치를 만들 수 없습니다: " + HrMessage(hr);
    return false;
  }
  winrtDevice_ = inspectable.as<wd3d::IDirect3DDevice>();
  return true;
}

RECT FitRect(UINT srcW, UINT srcH, UINT boxW, UINT boxH) {
  double scale = std::min(static_cast<double>(boxW) / srcW, static_cast<double>(boxH) / srcH);
  LONG w = std::max<LONG>(2, static_cast<LONG>(std::lround(srcW * scale)) & ~1L);
  LONG h = std::max<LONG>(2, static_cast<LONG>(std::lround(srcH * scale)) & ~1L);
  // Even rounding alone (the output already has the source's aspect) would leave a 1-2 px black line at one edge:
  // fill the box instead; the stretch is below 0.2 % at 1080p. Real aspect differences keep their bars.
  if (static_cast<LONG>(boxW) - w <= 2) w = boxW;
  if (static_cast<LONG>(boxH) - h <= 2) h = boxH;
  w = std::min<LONG>(w, boxW);
  h = std::min<LONG>(h, boxH);
  LONG x = ((static_cast<LONG>(boxW) - w) / 2) & ~1L;
  LONG y = ((static_cast<LONG>(boxH) - h) / 2) & ~1L;
  return RECT{x, y, x + w, y + h};
}

// A window's capture surface covers its visible frame (DWMWA_EXTENDED_FRAME_BOUNDS: title bar and borders, without the
// invisible resize borders and the drop shadow). Only the client area is broadcast: these are the insets between the two
// rectangles, in physical pixels of the monitor the window is on (this process is per-monitor DPI aware, so both are
// physical). Insets rather than absolute positions keep the crop right while the captured surface catches up with a
// resize. Apps that draw their own title bar inside the client area keep it: for Windows it is their content.
struct ClientInsets {
  LONG left = 0, top = 0, right = 0, bottom = 0;
  RECT frame{}, client{};
  UINT dpi = 0;
  LONG drawnCaption = 0;  // title bar rows the window draws inside its client area (removed as well)
  bool scaled = false;    // the window is bitmap-scaled by Windows (one more blended edge pixel removed)
};

static bool MeasureClientInsets(HWND hwnd, ClientInsets& in) {
  RECT client{};
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &in.frame, sizeof(in.frame))) || !GetClientRect(hwnd, &client)) return false;
  POINT a{client.left, client.top}, b{client.right, client.bottom};
  if (!ClientToScreen(hwnd, &a) || !ClientToScreen(hwnd, &b)) return false;
  // Right-to-left windows mirror client coordinates.
  in.client = RECT{std::min(a.x, b.x), std::min(a.y, b.y), std::max(a.x, b.x), std::max(a.y, b.y)};
  in.left = std::max<LONG>(0, in.client.left - in.frame.left);
  in.top = std::max<LONG>(0, in.client.top - in.frame.top);
  in.right = std::max<LONG>(0, in.frame.right - in.client.right);
  in.bottom = std::max<LONG>(0, in.frame.bottom - in.client.bottom);
  in.dpi = GetDpiForWindow(hwnd);
  // A window that Windows scales (DPI unaware or system aware on another DPI) is stretched as a bitmap, so the row or
  // column on each client edge blends with the title bar or border: keep that one physical pixel out as well.
  HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  UINT mx = 0, my = 0;
  if (monitor && SUCCEEDED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mx, &my)) && mx != in.dpi) {
    if (in.left > 0) ++in.left;
    if (in.top > 0) ++in.top;
    if (in.right > 0) ++in.right;
    if (in.bottom > 0) ++in.bottom;
    in.scaled = true;
  }
  return true;
}

// Height of a title bar that the window draws inside its own client area (Chromium app windows, for example): the rows
// at the top that the window itself reports as caption, system menu or caption buttons (WM_NCHITTEST) across its whole
// width. A row where any point is client area (tabs, menus, toolbars) ends the scan, so drawn content is never cut, and
// rows that are only resize border do not count as a title bar. Only per-monitor DPI aware windows read the physical
// coordinates sent here correctly; others get 0.
static LONG DrawnCaptionRows(HWND hwnd, const RECT& client) {
  DPI_AWARENESS_CONTEXT context = GetWindowDpiAwarenessContext(hwnd);
  if (!AreDpiAwarenessContextsEqual(context, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
      !AreDpiAwarenessContextsEqual(context, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE))
    return 0;
  const LONG width = client.right - client.left, limit = (client.bottom - client.top) / 4;
  if (width < 64 || limit < 4) return 0;
  constexpr int kSamples = 11;
  bool sawCaption = false;
  // 1: the whole row is title bar, 0: it holds client content, -1: the window did not answer.
  auto row = [&](LONG y) {
    bool caption = false;
    for (int i = 0; i < kSamples; ++i) {
      LONG x = client.left + static_cast<LONG>((i + 0.5) * width / kSamples);
      DWORD_PTR code = 0;
      if (!SendMessageTimeoutW(hwnd, WM_NCHITTEST, 0, MAKELPARAM(static_cast<WORD>(x), static_cast<WORD>(client.top + y)), SMTO_ABORTIFHUNG, 50, &code))
        return -1;
      switch (static_cast<LRESULT>(code)) {
        case HTCAPTION: case HTSYSMENU: case HTMINBUTTON: case HTMAXBUTTON: case HTCLOSE: case HTHELP:
          caption = true;
          break;
        case HTTOP: case HTTOPLEFT: case HTTOPRIGHT:
          break;
        default:
          return 0;
      }
    }
    if (caption) sawCaption = true;
    return 1;
  };
  LONG y = 0;
  int state = 1;
  while (y < limit && (state = row(y)) == 1) y += 4;  // coarse
  if (state < 0) return 0;
  LONG first = std::max<LONG>(0, y - 3);
  for (y = first; y < std::min(limit, first + 4) && (state = row(y)) == 1; ++y) {}  // the exact first content row
  if (state < 0 || !sawCaption || y >= limit) return 0;
  return y;
}

static ComPtr<ID3D11Texture2D> SurfaceTexture(const wd3d::IDirect3DSurface& surface) {
  auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  ComPtr<ID3D11Texture2D> texture;
  winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(&texture)));
  return texture;
}

bool WindowCapture::Start(HWND hwnd, bool cursor, std::string& error) {
  Stop();
  try {
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    wgc::GraphicsCaptureItem item{nullptr};
    winrt::check_hresult(interop->CreateForWindow(hwnd, winrt::guid_of<wgc::IGraphicsCaptureItem>(), winrt::put_abi(item)));
    return StartItem(item, hwnd, L"", cursor, error);
  } catch (const winrt::hresult_error& e) {
    error = "창을 캡처할 수 없습니다: " + Utf8(std::wstring(e.message())) + Printf(" (0x%08X)", static_cast<unsigned>(e.code()));
  }
  Stop();
  return false;
}

bool WindowCapture::StartMonitor(HMONITOR monitor, const std::wstring& device, bool cursor, std::string& error) {
  Stop();
  try {
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    wgc::GraphicsCaptureItem item{nullptr};
    winrt::check_hresult(interop->CreateForMonitor(monitor, winrt::guid_of<wgc::IGraphicsCaptureItem>(), winrt::put_abi(item)));
    return StartItem(item, nullptr, device, cursor, error);
  } catch (const winrt::hresult_error& e) {
    error = "모니터를 캡처할 수 없습니다: " + Utf8(std::wstring(e.message())) + Printf(" (0x%08X)", static_cast<unsigned>(e.code()));
  }
  Stop();
  return false;
}

bool WindowCapture::StartItem(const wgc::GraphicsCaptureItem& item, HWND hwnd, const std::wstring& monitorDevice, bool cursor, std::string& error) {
  try {
    auto size = item.Size();
    if (size.Width < 2 || size.Height < 2) {
      error = "대상 크기가 너무 작아 캡처할 수 없습니다.";
      return false;
    }
    auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(gpu_.WinrtDevice(), DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size);
    auto session = pool.CreateCaptureSession(item);
    try {
      session.IsCursorCaptureEnabled(cursor);
    } catch (...) {
    }
    try {
      session.IsBorderRequired(false);
    } catch (...) {
      LogFile("capture", "IsBorderRequired(false) is not available; Windows draws the capture border");
    }
    try {
      // Windows 11 24H2+: let frames arrive as fast as the window is composed instead of the default pacing.
      session.MinUpdateInterval(winrt::Windows::Foundation::TimeSpan{10000});
    } catch (...) {
      LogFile("capture", "MinUpdateInterval is not available on this Windows build");
    }
    {
      std::lock_guard<std::mutex> lock(frameMutex_);
      hwnd_ = hwnd;
      monitorDevice_ = monitorDevice;
      item_ = item;
      pool_ = pool;
      session_ = session;
      poolSize_ = size;
      running_ = true;
      closed_ = false;
      frames_ = 0;
      latestSeq_ = 0;
    }
    frameRevoker_ = pool.FrameArrived(winrt::auto_revoke, [this](const wgc::Direct3D11CaptureFramePool& sender, const winrt::Windows::Foundation::IInspectable&) {
      OnFrameArrived(sender);
    });
    closedRevoker_ = item.Closed(winrt::auto_revoke, [this](const wgc::GraphicsCaptureItem&, const winrt::Windows::Foundation::IInspectable&) {
      if (closed_.exchange(true)) return;
      SetEvent(frameEvent_.Get());
      if (onClosed) onClosed();
    });
    session.StartCapture();
    return true;
  } catch (const winrt::hresult_error& e) {
    error = "창을 캡처할 수 없습니다: " + Utf8(std::wstring(e.message())) + Printf(" (0x%08X)", static_cast<unsigned>(e.code()));
  } catch (const std::exception& e) {
    error = std::string("창을 캡처할 수 없습니다: ") + e.what();
  }
  Stop();
  return false;
}

void WindowCapture::Stop() {
  frameRevoker_.revoke();
  closedRevoker_.revoke();
  std::lock_guard<std::mutex> lock(frameMutex_);
  running_ = false;
  try {
    if (session_) session_.Close();
    if (pool_) pool_.Close();
  } catch (...) {
  }
  session_ = nullptr;
  pool_ = nullptr;
  item_ = nullptr;
  std::lock_guard<std::mutex> gpuLock(gpu_.Lock());
  latest_.Reset();
  latestW_ = latestH_ = 0;
}

void WindowCapture::PollClosed() {
  if (closed_ || !running_) return;
  bool gone = hwnd_ ? !IsWindow(hwnd_) : !monitorDevice_.empty() && !MonitorPresent(monitorDevice_);
  if (!gone || closed_.exchange(true)) return;
  SetEvent(frameEvent_.Get());
  if (onClosed) onClosed();
}

SIZE WindowCapture::ContentSize() const { return SIZE{static_cast<LONG>(latestW_), static_cast<LONG>(latestH_)}; }

void WindowCapture::OnFrameArrived(const wgc::Direct3D11CaptureFramePool& pool) {
  std::lock_guard<std::mutex> lock(frameMutex_);
  if (!running_) return;
  try {
    auto frame = pool.TryGetNextFrame();
    if (!frame) return;
    auto size = frame.ContentSize();
    auto texture = SurfaceTexture(frame.Surface());
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    UINT surfaceW = std::min<UINT>(static_cast<UINT>(size.Width), desc.Width), surfaceH = std::min<UINT>(static_cast<UINT>(size.Height), desc.Height);
    UINT x0 = 0, y0 = 0;
    if (hwnd_ && clientCrop_) {
      ClientInsets in;
      if (MeasureClientInsets(hwnd_, in)) {
        // Asking the window about its title bar takes a few hundred cross-process messages: do it again only when the
        // client area moved or changed size or DPI, and at most twice a second (a live resize changes it every frame).
        std::string key = Printf("%ld,%ld,%ld,%ld,%u", in.client.left, in.client.top, in.client.right, in.client.bottom, in.dpi);
        int64_t qpc = QpcNow();
        if (key != captionKey_ && QpcSeconds(qpc - captionQpc_) >= 0.5) {
          captionKey_ = key;
          captionQpc_ = qpc;
          captionRows_ = DrawnCaptionRows(hwnd_, in.client);
        }
        in.top += captionRows_;
        in.drawnCaption = captionRows_;
        LONG cw = static_cast<LONG>(surfaceW) - in.left - in.right, ch = static_cast<LONG>(surfaceH) - in.top - in.bottom;
        if (cw >= 16 && ch >= 16) {
          x0 = static_cast<UINT>(in.left);
          y0 = static_cast<UINT>(in.top);
          surfaceW = static_cast<UINT>(cw);
          surfaceH = static_cast<UINT>(ch);
        }
        LogGeometry(size.Width, size.Height, in, x0, y0, surfaceW, surfaceH);
      } else if (!cropFailureLogged_) {
        cropFailureLogged_ = true;
        LogFile("capture", "client area unavailable (" + LastErrorMessage() + "); the whole window frame is used");
        UiLog("소스", "창의 내용 영역을 확인할 수 없어 제목 표시줄을 포함한 창 전체를 송출합니다.");
      }
    }
    UINT w = surfaceW & ~1u;
    UINT h = surfaceH & ~1u;
    if (w >= 2 && h >= 2) {
      std::lock_guard<std::mutex> gpuLock(gpu_.Lock());
      if (!latest_ || latestW_ != w || latestH_ != h) {
        D3D11_TEXTURE2D_DESC td{};
        td.Width = w;
        td.Height = h;
        td.MipLevels = 1;
        td.ArraySize = 1;
        td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT;
        td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        latest_.Reset();
        if (SUCCEEDED(gpu_.Device()->CreateTexture2D(&td, nullptr, &latest_))) {
          latestW_ = w;
          latestH_ = h;
        }
      }
      if (latest_) {
        D3D11_BOX box{x0, y0, 0, x0 + w, y0 + h, 1};
        gpu_.Context()->CopySubresourceRegion(latest_.Get(), 0, 0, 0, 0, texture.Get(), 0, &box);
        ++latestSeq_;
      }
    }
    ++frames_;
    lastFrameQpc_ = QpcNow();
    SetEvent(frameEvent_.Get());
    frame.Close();
    if (size.Width != poolSize_.Width || size.Height != poolSize_.Height) {
      // The window was resized: re-create the buffers at the new size (handled on the next frame).
      poolSize_ = size;
      pool.Recreate(gpu_.WinrtDevice(), DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size);
    }
  } catch (const winrt::hresult_error& e) {
    LogFile("capture", "frame error " + Utf8(std::wstring(e.message())));
  }
}

void WindowCapture::LogGeometry(int surfaceW, int surfaceH, const ClientInsets& in, UINT x, UINT y, UINT w, UINT h) {
  // Evidence for the crop: what the capture surface covers against the window's frame and client rectangles.
  std::string text = Printf("surface %dx%d, frame bounds %ldx%ld at (%ld,%ld), client %ldx%ld at (%ld,%ld), drawn title bar %ld, scaled %d, insets l%ld t%ld r%ld b%ld, dpi %u -> content %ux%u at (%u,%u)",
                            surfaceW, surfaceH, in.frame.right - in.frame.left, in.frame.bottom - in.frame.top, in.frame.left, in.frame.top,
                            in.client.right - in.client.left, in.client.bottom - in.client.top, in.client.left, in.client.top, in.drawnCaption, in.scaled ? 1 : 0, in.left, in.top,
                            in.right, in.bottom, in.dpi, w, h, x, y);
  int64_t now = QpcNow();
  if (text == lastGeometry_ || QpcSeconds(now - lastGeometryQpc_) < 1.0) return;
  lastGeometry_ = text;
  lastGeometryQpc_ = now;
  LogFile("capture", "window geometry: " + text);
}

bool WindowCapture::WithLatest(const std::function<void(ID3D11Texture2D*, UINT, UINT, uint64_t)>& fn) {
  std::lock_guard<std::mutex> gpuLock(gpu_.Lock());
  if (!latest_) return false;
  fn(latest_.Get(), latestW_, latestH_, latestSeq_);
  return true;
}

// ---------------------------------------------------------------------------------------------
// FrameConverter

bool FrameConverter::EnsureProcessor(Gpu& gpu, UINT inW, UINT inH, UINT outW, UINT outH, bool yuv) {
  if (processor_ && inW == inW_ && inH == inH_ && outW == outW_ && outH == outH_ && yuv == yuv_) return true;
  processor_.Reset();
  enumerator_.Reset();
  inputRef_.Reset();
  inputView_.Reset();
  outputView_.Reset();  // views belong to the enumerator; the target texture itself is kept
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC desc{};
  desc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  desc.InputFrameRate = {60, 1};
  desc.InputWidth = inW;
  desc.InputHeight = inH;
  desc.OutputFrameRate = {60, 1};
  desc.OutputWidth = outW;
  desc.OutputHeight = outH;
  desc.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
  if (FAILED(gpu.VideoDevice()->CreateVideoProcessorEnumerator(&desc, &enumerator_))) return false;
  UINT support = 0;
  if (FAILED(enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &support)) || !(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT))
    return false;
  DXGI_FORMAT outFormat = yuv ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM;
  if (FAILED(enumerator_->CheckVideoProcessorFormat(outFormat, &support)) || !(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) return false;
  if (FAILED(gpu.VideoDevice()->CreateVideoProcessor(enumerator_.Get(), 0, &processor_))) return false;
  auto* vc = gpu.VideoContext();
  ComPtr<ID3D11VideoContext1> vc1;
  if (SUCCEEDED(vc->QueryInterface(IID_PPV_ARGS(&vc1)))) {
    vc1->VideoProcessorSetStreamColorSpace1(processor_.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    vc1->VideoProcessorSetOutputColorSpace1(processor_.Get(), yuv ? DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709 : DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
  } else {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE in{};
    in.RGB_Range = 0;
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE out{};
    out.YCbCr_Matrix = 1;
    out.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    vc->VideoProcessorSetStreamColorSpace(processor_.Get(), 0, &in);
    vc->VideoProcessorSetOutputColorSpace(processor_.Get(), &out);
  }
  vc->VideoProcessorSetStreamAutoProcessingMode(processor_.Get(), 0, FALSE);
  vc->VideoProcessorSetStreamFrameFormat(processor_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
  D3D11_VIDEO_COLOR background{};
  if (yuv) {
    background.YCbCr = {0.0625f, 0.5f, 0.5f, 1.0f};
  } else {
    background.RGBA = {0.0f, 0.0f, 0.0f, 1.0f};
  }
  vc->VideoProcessorSetOutputBackgroundColor(processor_.Get(), yuv ? TRUE : FALSE, &background);
  inW_ = inW;
  inH_ = inH;
  outW_ = outW;
  outH_ = outH;
  yuv_ = yuv;
  return true;
}

bool FrameConverter::Blt(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, ID3D11Texture2D* dst, UINT dstW, UINT dstH, const RECT& dstRect,
                         bool yuv) {
  if (!gpu.VideoDevice() || !EnsureProcessor(gpu, srcW, srcH, dstW, dstH, yuv)) return false;
  if (inputRef_.Get() != src) {
    inputView_.Reset();
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC iv{};
    iv.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    if (FAILED(gpu.VideoDevice()->CreateVideoProcessorInputView(src, enumerator_.Get(), &iv, &inputView_))) return false;
    inputRef_ = src;
  }
  if (!outputView_) {
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ov{};
    ov.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    if (FAILED(gpu.VideoDevice()->CreateVideoProcessorOutputView(dst, enumerator_.Get(), &ov, &outputView_))) return false;
  }
  auto* vc = gpu.VideoContext();
  RECT source{0, 0, static_cast<LONG>(srcW), static_cast<LONG>(srcH)};
  RECT full{0, 0, static_cast<LONG>(dstW), static_cast<LONG>(dstH)};
  vc->VideoProcessorSetStreamSourceRect(processor_.Get(), 0, TRUE, &source);
  vc->VideoProcessorSetStreamDestRect(processor_.Get(), 0, TRUE, &dstRect);
  vc->VideoProcessorSetOutputTargetRect(processor_.Get(), TRUE, &full);
  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = inputView_.Get();
  return SUCCEEDED(vc->VideoProcessorBlt(processor_.Get(), outputView_.Get(), 0, 1, &stream));
}

static bool CreateTargets(Gpu& gpu, UINT w, UINT h, DXGI_FORMAT format, ComPtr<ID3D11Texture2D>& target, ComPtr<ID3D11Texture2D>& staging) {
  D3D11_TEXTURE2D_DESC td{};
  td.Width = w;
  td.Height = h;
  td.MipLevels = 1;
  td.ArraySize = 1;
  td.Format = format;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DEFAULT;
  td.BindFlags = D3D11_BIND_RENDER_TARGET;
  if (FAILED(gpu.Device()->CreateTexture2D(&td, nullptr, &target))) return false;
  td.Usage = D3D11_USAGE_STAGING;
  td.BindFlags = 0;
  td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  return SUCCEEDED(gpu.Device()->CreateTexture2D(&td, nullptr, &staging));
}

bool FrameConverter::ReadSource(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, std::vector<uint8_t>& bgra) {
  if (!sourceStaging_ || sourceStagingW_ != srcW || sourceStagingH_ != srcH) {
    sourceStaging_.Reset();
    D3D11_TEXTURE2D_DESC td{};
    td.Width = srcW;
    td.Height = srcH;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_STAGING;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(gpu.Device()->CreateTexture2D(&td, nullptr, &sourceStaging_))) return false;
    sourceStagingW_ = srcW;
    sourceStagingH_ = srcH;
  }
  gpu.Context()->CopyResource(sourceStaging_.Get(), src);
  D3D11_MAPPED_SUBRESOURCE map{};
  if (FAILED(gpu.Context()->Map(sourceStaging_.Get(), 0, D3D11_MAP_READ, 0, &map))) return false;
  bgra.resize(static_cast<size_t>(srcW) * srcH * 4);
  for (UINT y = 0; y < srcH; ++y) memcpy(bgra.data() + static_cast<size_t>(y) * srcW * 4, static_cast<uint8_t*>(map.pData) + static_cast<size_t>(y) * map.RowPitch, srcW * 4);
  gpu.Context()->Unmap(sourceStaging_.Get(), 0);
  return true;
}

bool FrameConverter::ToNv12(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, UINT dstW, UINT dstH, std::vector<uint8_t>& out, std::string& error) {
  RECT fit = FitRect(srcW, srcH, dstW, dstH);
  size_t ySize = static_cast<size_t>(dstW) * dstH;
  out.resize(ySize * 3 / 2);
  if (!cpu_) {
    if (!target_ || targetW_ != dstW || targetH_ != dstH || targetFormat_ != DXGI_FORMAT_NV12) {
      outputView_.Reset();
      target_.Reset();
      staging_.Reset();
      if (!CreateTargets(gpu, dstW, dstH, DXGI_FORMAT_NV12, target_, staging_)) {
        cpu_ = true;
        LogFile("capture", "NV12 render target is not supported; using CPU colour conversion");
      } else {
        targetW_ = dstW;
        targetH_ = dstH;
        targetFormat_ = DXGI_FORMAT_NV12;
      }
    }
    if (!cpu_ && !Blt(gpu, src, srcW, srcH, target_.Get(), dstW, dstH, fit, true)) {
      cpu_ = true;
      LogFile("capture", "GPU video processor is not available; using CPU colour conversion");
    }
    if (!cpu_) {
      gpu.Context()->CopyResource(staging_.Get(), target_.Get());
      D3D11_MAPPED_SUBRESOURCE map{};
      HRESULT hr = gpu.Context()->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &map);
      if (FAILED(hr)) {
        error = "프레임을 읽을 수 없습니다: " + HrMessage(hr);
        return false;
      }
      const uint8_t* base = static_cast<const uint8_t*>(map.pData);
      for (UINT y = 0; y < dstH; ++y) memcpy(out.data() + static_cast<size_t>(y) * dstW, base + static_cast<size_t>(y) * map.RowPitch, dstW);
      const uint8_t* uv = base + static_cast<size_t>(map.RowPitch) * dstH;
      for (UINT y = 0; y < dstH / 2; ++y) memcpy(out.data() + ySize + static_cast<size_t>(y) * dstW, uv + static_cast<size_t>(y) * map.RowPitch, dstW);
      gpu.Context()->Unmap(staging_.Get(), 0);
      return true;
    }
  }
  // CPU path (no usable video processor, e.g. basic display adapters): nearest sampling + BT.709 limited range.
  std::vector<uint8_t> bgra;
  if (!ReadSource(gpu, src, srcW, srcH, bgra)) {
    error = "프레임을 읽을 수 없습니다.";
    return false;
  }
  uint8_t* yPlane = out.data();
  uint8_t* uvPlane = out.data() + ySize;
  memset(yPlane, 16, ySize);
  for (size_t i = 0; i < ySize / 2; i += 2) uvPlane[i] = uvPlane[i + 1] = 128;
  LONG fw = fit.right - fit.left, fh = fit.bottom - fit.top;
  for (LONG y = 0; y < fh; y += 2) {
    for (LONG x = 0; x < fw; x += 2) {
      int sumU = 0, sumV = 0;
      for (int dy = 0; dy < 2; ++dy) {
        for (int dx = 0; dx < 2; ++dx) {
          UINT sx = std::min<UINT>(srcW - 1, static_cast<UINT>((x + dx) * static_cast<int64_t>(srcW) / fw));
          UINT sy = std::min<UINT>(srcH - 1, static_cast<UINT>((y + dy) * static_cast<int64_t>(srcH) / fh));
          const uint8_t* p = bgra.data() + (static_cast<size_t>(sy) * srcW + sx) * 4;
          int b = p[0], g = p[1], r = p[2];
          int Y = (47 * r + 157 * g + 16 * b + 4096 + 128) >> 8;
          yPlane[static_cast<size_t>(fit.top + y + dy) * dstW + fit.left + x + dx] = static_cast<uint8_t>(std::clamp(Y, 16, 235));
          sumU += (-26 * r - 87 * g + 112 * b);
          sumV += (112 * r - 102 * g - 10 * b);
        }
      }
      size_t uvIndex = static_cast<size_t>((fit.top + y) / 2) * dstW + fit.left + x;
      uvPlane[uvIndex] = static_cast<uint8_t>(std::clamp(((sumU / 4 + 128) >> 8) + 128, 16, 240));
      uvPlane[uvIndex + 1] = static_cast<uint8_t>(std::clamp(((sumV / 4 + 128) >> 8) + 128, 16, 240));
    }
  }
  return true;
}

bool FrameConverter::ToBgr(Gpu& gpu, ID3D11Texture2D* src, UINT srcW, UINT srcH, UINT maxW, UINT maxH, std::vector<uint8_t>& out, UINT& outW, UINT& outH,
                           std::string& error) {
  RECT fit = FitRect(srcW, srcH, std::min(maxW, srcW), std::min(maxH, srcH));
  outW = static_cast<UINT>(fit.right - fit.left);
  outH = static_cast<UINT>(fit.bottom - fit.top);
  out.resize(static_cast<size_t>(outW) * outH * 3);
  RECT dst{0, 0, static_cast<LONG>(outW), static_cast<LONG>(outH)};
  if (!cpu_) {
    if (!target_ || targetW_ != outW || targetH_ != outH || targetFormat_ != DXGI_FORMAT_B8G8R8A8_UNORM) {
      outputView_.Reset();
      target_.Reset();
      staging_.Reset();
      if (!CreateTargets(gpu, outW, outH, DXGI_FORMAT_B8G8R8A8_UNORM, target_, staging_)) {
        cpu_ = true;
      } else {
        targetW_ = outW;
        targetH_ = outH;
        targetFormat_ = DXGI_FORMAT_B8G8R8A8_UNORM;
      }
    }
    if (!cpu_ && !Blt(gpu, src, srcW, srcH, target_.Get(), outW, outH, dst, false)) cpu_ = true;
    if (!cpu_) {
      gpu.Context()->CopyResource(staging_.Get(), target_.Get());
      D3D11_MAPPED_SUBRESOURCE map{};
      HRESULT hr = gpu.Context()->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &map);
      if (FAILED(hr)) {
        error = "미리보기를 읽을 수 없습니다: " + HrMessage(hr);
        return false;
      }
      for (UINT y = 0; y < outH; ++y) {
        const uint8_t* s = static_cast<const uint8_t*>(map.pData) + static_cast<size_t>(y) * map.RowPitch;
        uint8_t* d = out.data() + static_cast<size_t>(y) * outW * 3;
        for (UINT x = 0; x < outW; ++x, s += 4, d += 3) {
          d[0] = s[0];
          d[1] = s[1];
          d[2] = s[2];
        }
      }
      gpu.Context()->Unmap(staging_.Get(), 0);
      return true;
    }
  }
  std::vector<uint8_t> bgra;
  if (!ReadSource(gpu, src, srcW, srcH, bgra)) {
    error = "미리보기를 읽을 수 없습니다.";
    return false;
  }
  for (UINT y = 0; y < outH; ++y) {
    UINT sy = std::min<UINT>(srcH - 1, static_cast<UINT>(static_cast<uint64_t>(y) * srcH / outH));
    for (UINT x = 0; x < outW; ++x) {
      UINT sx = std::min<UINT>(srcW - 1, static_cast<UINT>(static_cast<uint64_t>(x) * srcW / outW));
      const uint8_t* s = bgra.data() + (static_cast<size_t>(sy) * srcW + sx) * 4;
      uint8_t* d = out.data() + (static_cast<size_t>(y) * outW + x) * 3;
      d[0] = s[0];
      d[1] = s[1];
      d[2] = s[2];
    }
  }
  return true;
}

bool EncodeJpeg(const std::vector<uint8_t>& bgr, UINT w, UINT h, float quality, std::string& jpeg) {
  ComPtr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)))) return false;
  ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) return false;
  ComPtr<IWICBitmapEncoder> encoder;
  if (FAILED(factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder)) || FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache)))
    return false;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> props;
  if (FAILED(encoder->CreateNewFrame(&frame, &props))) return false;
  PROPBAG2 option{};
  option.pstrName = const_cast<wchar_t*>(L"ImageQuality");
  VARIANT value;
  VariantInit(&value);
  value.vt = VT_R4;
  value.fltVal = quality;
  props->Write(1, &option, &value);
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  if (FAILED(frame->Initialize(props.Get())) || FAILED(frame->SetSize(w, h)) || FAILED(frame->SetPixelFormat(&format))) return false;
  if (FAILED(frame->WritePixels(h, w * 3, static_cast<UINT>(bgr.size()), const_cast<BYTE*>(bgr.data()))) || FAILED(frame->Commit()) ||
      FAILED(encoder->Commit()))
    return false;
  STATSTG stat{};
  stream->Stat(&stat, STATFLAG_NONAME);
  LARGE_INTEGER zero{};
  stream->Seek(zero, STREAM_SEEK_SET, nullptr);
  jpeg.resize(static_cast<size_t>(stat.cbSize.QuadPart));
  ULONG read = 0;
  stream->Read(jpeg.data(), static_cast<ULONG>(jpeg.size()), &read);
  jpeg.resize(read);
  return true;
}

std::string Base64(const std::string& data) {
  static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((data.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < data.size(); i += 3) {
    uint32_t v = (static_cast<uint8_t>(data[i]) << 16) | (static_cast<uint8_t>(data[i + 1]) << 8) | static_cast<uint8_t>(data[i + 2]);
    out += table[v >> 18];
    out += table[(v >> 12) & 63];
    out += table[(v >> 6) & 63];
    out += table[v & 63];
  }
  if (i < data.size()) {
    uint32_t v = static_cast<uint8_t>(data[i]) << 16;
    if (i + 1 < data.size()) v |= static_cast<uint8_t>(data[i + 1]) << 8;
    out += table[v >> 18];
    out += table[(v >> 12) & 63];
    out += i + 1 < data.size() ? table[(v >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Window list

static bool IsCloaked(HWND hwnd) {
  DWORD cloaked = 0;
  return SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0;
}

static std::wstring ProcessPath(DWORD pid) {
  ScopedHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.Valid()) return L"";
  std::wstring path(MAX_PATH * 2, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process.Get(), 0, path.data(), &size)) return L"";
  path.resize(size);
  return path;
}

std::vector<SourceWindow> EnumerateSourceWindows(HWND self) {
  struct Context {
    HWND self;
    std::vector<SourceWindow> list;
  } context{self, {}};
  EnumWindows(
      [](HWND hwnd, LPARAM param) -> BOOL {
        auto* ctx = reinterpret_cast<Context*>(param);
        if (hwnd == ctx->self || !IsWindowVisible(hwnd) || GetAncestor(hwnd, GA_ROOT) != hwnd) return TRUE;
        LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) && !(ex & WS_EX_APPWINDOW)) return TRUE;
        if (GetWindow(hwnd, GW_OWNER) && !(ex & WS_EX_APPWINDOW)) return TRUE;
        if (IsCloaked(hwnd)) return TRUE;
        wchar_t cls[128] = {};
        GetClassNameW(hwnd, cls, 128);
        std::wstring className = cls;
        if (className == L"Progman" || className == L"WorkerW" || className == L"Shell_TrayWnd" || className == L"Shell_SecondaryTrayWnd")
          return TRUE;
        int length = GetWindowTextLengthW(hwnd);
        if (length <= 0) return TRUE;
        std::wstring title(static_cast<size_t>(length) + 1, L'\0');
        title.resize(static_cast<size_t>(GetWindowTextW(hwnd, title.data(), length + 1)));
        if (title.empty()) return TRUE;
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (pid == GetCurrentProcessId()) return TRUE;
        SourceWindow w;
        w.hwnd = hwnd;
        w.pid = pid;
        w.title = title;
        w.exePath = ProcessPath(pid);
        w.exe = fs::path(w.exePath).filename().wstring();
        w.minimized = IsIconic(hwnd) != FALSE;
        if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &w.rect, sizeof(w.rect)))) GetWindowRect(hwnd, &w.rect);
        if (!w.minimized && (w.rect.right - w.rect.left < 2 || w.rect.bottom - w.rect.top < 2)) return TRUE;
        ctx->list.push_back(std::move(w));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&context));
  return context.list;
}

std::string SourceId(HWND hwnd, DWORD pid) { return Printf("w%llx-%lu", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(hwnd)), pid); }

bool ParseSourceId(const std::string& id, HWND& hwnd, DWORD& pid) {
  unsigned long long h = 0;
  unsigned long p = 0;
  if (id.size() > 40 || sscanf_s(id.c_str(), "w%llx-%lu", &h, &p) != 2) return false;
  hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(h));
  pid = p;
  DWORD actual = 0;
  // An HWND value can be reused by another process after the original window closes.
  return IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, &actual) && actual == pid;
}

int WindowMonitorRefreshRate(HWND hwnd) {
  HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return 0;
  DEVMODEW mode{};
  mode.dmSize = sizeof(mode);
  if (!EnumDisplaySettingsW(info.szDevice, ENUM_CURRENT_SETTINGS, &mode)) return 0;
  return mode.dmDisplayFrequency > 1 ? static_cast<int>(mode.dmDisplayFrequency) : 0;
}

// ---------------------------------------------------------------------------------------------
// Monitors

static std::string Fnv64(const std::wstring& text) {
  uint64_t h = 1469598103934665603ull;
  for (wchar_t ch : text) {
    h ^= static_cast<uint64_t>(towlower(ch));
    h *= 1099511628211ull;
  }
  return Printf("m%016llx", static_cast<unsigned long long>(h));
}

std::vector<SourceMonitor> EnumerateMonitors() {
  std::vector<SourceMonitor> list;
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM param) -> BOOL {
        auto* out = reinterpret_cast<std::vector<SourceMonitor>*>(param);
        MONITORINFOEXW info{};
        info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(monitor, &info)) return TRUE;
        SourceMonitor m;
        m.handle = monitor;
        m.device = info.szDevice;
        m.width = info.rcMonitor.right - info.rcMonitor.left;
        m.height = info.rcMonitor.bottom - info.rcMonitor.top;
        m.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
        UINT dpiX = 96, dpiY = 96;
        if (SUCCEEDED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpiX, &dpiY))) m.scale = static_cast<int>(dpiX * 100 / 96);
        DEVMODEW mode{};
        mode.dmSize = sizeof(mode);
        if (EnumDisplaySettingsW(info.szDevice, ENUM_CURRENT_SETTINGS, &mode) && mode.dmDisplayFrequency > 1) m.refresh = static_cast<int>(mode.dmDisplayFrequency);
        // The device interface path identifies the physical display connection and survives reboots and rearranging.
        DISPLAY_DEVICEW dd{};
        dd.cb = sizeof(dd);
        std::wstring key = info.szDevice;
        if (EnumDisplayDevicesW(info.szDevice, 0, &dd, EDD_GET_DEVICE_INTERFACE_NAME) && dd.DeviceID[0]) key = dd.DeviceID;
        m.id = Fnv64(key);
        m.number = static_cast<int>(info.rcMonitor.left);  // replaced by the left-to-right order below
        out->push_back(m);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&list));
  std::vector<std::pair<std::pair<int, int>, size_t>> order;
  for (size_t i = 0; i < list.size(); ++i) {
    MONITORINFO info{sizeof(info)};
    GetMonitorInfoW(list[i].handle, &info);
    order.push_back({{info.rcMonitor.left, info.rcMonitor.top}, i});
  }
  std::sort(order.begin(), order.end());
  for (size_t n = 0; n < order.size(); ++n) list[order[n].second].number = static_cast<int>(n + 1);
  std::sort(list.begin(), list.end(), [](const SourceMonitor& a, const SourceMonitor& b) { return a.number < b.number; });
  return list;
}

bool FindMonitor(const std::string& id, SourceMonitor& monitor) {
  for (const auto& m : EnumerateMonitors())
    if (m.id == id) {
      monitor = m;
      return true;
    }
  return false;
}

bool MonitorPresent(const std::wstring& device) {
  for (const auto& m : EnumerateMonitors())
    if (m.device == device) return true;
  return false;
}

}  // namespace fc
