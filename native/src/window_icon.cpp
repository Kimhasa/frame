#include "window_icon.h"

#include <shlobj.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <map>

#include "capture.h"  // Base64

namespace fc {
namespace {

using Microsoft::WRL::ComPtr;

std::mutex g_iconMutex;
std::map<std::string, std::string> g_icons;  // key -> base64 PNG ("" = could not convert)

// Width of an icon in pixels. GetIconInfo hands out copies of the bitmaps, which the caller deletes.
int IconWidth(HICON icon) {
  ICONINFO info{};
  if (!GetIconInfo(icon, &info)) return 0;
  BITMAP bitmap{};
  int width = 0;
  if (info.hbmColor && GetObjectW(info.hbmColor, sizeof(bitmap), &bitmap)) width = bitmap.bmWidth;
  else if (info.hbmMask && GetObjectW(info.hbmMask, sizeof(bitmap), &bitmap)) width = bitmap.bmWidth;
  if (info.hbmColor) DeleteObject(info.hbmColor);
  if (info.hbmMask) DeleteObject(info.hbmMask);
  return width;
}

HICON MessageIcon(HWND hwnd, WPARAM which) {
  DWORD_PTR result = 0;
  if (!SendMessageTimeoutW(hwnd, WM_GETICON, which, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 100, &result)) return nullptr;
  return reinterpret_cast<HICON>(result);
}

// PNG with straight alpha; WIC turns 32-bit, masked and legacy icons alike into BGRA and scales with a cubic filter.
std::string Png(HICON icon, int size) {
  ComPtr<IWICImagingFactory> factory;
  ComPtr<IWICBitmap> bitmap;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory))) ||
      FAILED(factory->CreateBitmapFromHICON(icon, &bitmap)))
    return "";
  UINT w = 0, h = 0;
  bitmap->GetSize(&w, &h);
  if (!w || !h) return "";
  ComPtr<IWICBitmapSource> source = bitmap;
  UINT tw = w >= h ? static_cast<UINT>(size) : std::max(1u, static_cast<UINT>(size) * w / h);
  UINT th = h >= w ? static_cast<UINT>(size) : std::max(1u, static_cast<UINT>(size) * h / w);
  if (tw != w || th != h) {
    ComPtr<IWICBitmapScaler> scaler;
    if (FAILED(factory->CreateBitmapScaler(&scaler)) || FAILED(scaler->Initialize(bitmap.Get(), tw, th, WICBitmapInterpolationModeHighQualityCubic))) return "";
    source = scaler;
  }
  ComPtr<IStream> stream;
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) || FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) ||
      FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache)) || FAILED(encoder->CreateNewFrame(&frame, nullptr)) || FAILED(frame->Initialize(nullptr)) ||
      FAILED(frame->SetSize(tw, th)) || FAILED(frame->SetPixelFormat(&format)) || FAILED(frame->WriteSource(source.Get(), nullptr)) || FAILED(frame->Commit()) ||
      FAILED(encoder->Commit()))
    return "";
  STATSTG stat{};
  stream->Stat(&stat, STATFLAG_NONAME);
  LARGE_INTEGER zero{};
  stream->Seek(zero, STREAM_SEEK_SET, nullptr);
  std::string png(static_cast<size_t>(stat.cbSize.QuadPart), '\0');
  ULONG read = 0;
  stream->Read(png.data(), static_cast<ULONG>(png.size()), &read);
  png.resize(read);
  return Base64(png);
}

std::string Cached(const std::string& key, HICON icon, int size) {
  {
    std::lock_guard<std::mutex> lock(g_iconMutex);
    auto it = g_icons.find(key);
    if (it != g_icons.end()) return it->second;
  }
  std::string png = Png(icon, size);
  std::lock_guard<std::mutex> lock(g_iconMutex);
  if (g_icons.size() > 512) g_icons.clear();
  g_icons[key] = png;
  return png;
}

}  // namespace

std::string WindowIconPng(HWND hwnd, DWORD pid, const std::wstring& exePath, int size, std::string& source) {
  // Borrowed: the window's and its class's icons belong to that app.
  HICON icon = MessageIcon(hwnd, ICON_BIG);
  source = "window";
  if (!icon) {
    icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICON));
    source = "class";
  }
  // A window icon much smaller than the shown size would be blurry; the program file holds larger sizes. Store apps run
  // in ApplicationFrameHost, whose own file icon is not the app's, so it is never used for them.
  const bool frameHost = _wcsicmp(fs::path(exePath).filename().c_str(), L"ApplicationFrameHost.exe") == 0;
  if ((!icon || IconWidth(icon) < size * 4 / 5) && !exePath.empty() && !frameHost) {
    std::string key = Printf("file|%s|%d", Utf8(exePath).c_str(), size);
    {
      std::lock_guard<std::mutex> lock(g_iconMutex);
      auto it = g_icons.find(key);
      if (it != g_icons.end() && !it->second.empty()) {
        source = "program";
        return it->second;
      }
    }
    HICON file = nullptr;  // owned: created for this call
    if (SUCCEEDED(SHDefExtractIconW(exePath.c_str(), 0, 0, &file, nullptr, static_cast<UINT>(MAKELONG(size, size)))) && file) {
      std::string png = Cached(key, file, size);
      DestroyIcon(file);
      if (!png.empty()) {
        source = "program";
        return png;
      }
    }
  }
  if (!icon) {
    icon = MessageIcon(hwnd, ICON_SMALL2);
    if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICONSM));
    source = "small";
  }
  if (!icon) {
    source = "none";
    return "";
  }
  return Cached(Printf("win|%p|%lu|%p|%d", static_cast<void*>(hwnd), pid, static_cast<void*>(icon), size), icon, size);
}

}  // namespace fc
