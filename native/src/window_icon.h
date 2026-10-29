// App icons for the window picker's title rows.
#pragma once

#include "common.h"

namespace fc {

// The window's Windows icon as a base64 PNG of about size x size pixels with transparency: its own icon (WM_GETICON with
// a 100 ms limit, so a hung app cannot stall the list), then its class icon, then its program file's icon when the
// window's icon is missing or much smaller than size. Empty when none exists. source tells where it came from. Converted
// images are kept per window, icon handle and size (or per program file and size); borrowed icon handles are never freed.
std::string WindowIconPng(HWND hwnd, DWORD pid, const std::wstring& exePath, int size, std::string& source);

}  // namespace fc
