cmake_minimum_required(VERSION 3.21)
project(FrameConsole VERSION 0.5.0 LANGUAGES CXX RC)

# Built and tested with Visual Studio 2022 Build Tools 17.14 (MSVC 14.44), Windows SDK 10.0.26100.0, x64.
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "FRAME Console is built for x64 only")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the deployed exe does not need the Visual C++ Redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(FRAME_THIRD_PARTY "${CMAKE_CURRENT_SOURCE_DIR}/../build/third_party" CACHE PATH "Extracted pinned third-party packages (tools/fetch-deps.mjs)")
set(WEBVIEW2_DIR "${FRAME_THIRD_PARTY}/webview2/build/native")
if(NOT EXISTS "${WEBVIEW2_DIR}/include/WebView2.h")
  message(FATAL_ERROR "WebView2 SDK not found at ${WEBVIEW2_DIR}. Run: node tools/fetch-deps.mjs")
endif()

add_executable(FrameConsole WIN32
  src/main.cpp
  src/util.cpp
  src/config.cpp
  src/capture.cpp
  src/thumbnails.cpp
  src/window_icon.cpp
  src/audio.cpp
  src/child_process.cpp
  src/http_client.cpp
  src/http_server.cpp
  src/streamer.cpp
  src/directory.cpp
  src/chat.cpp
  src/recorder.cpp
  src/FrameConsole.rc
  src/FrameConsole.manifest)

target_include_directories(FrameConsole PRIVATE src third_party "${WEBVIEW2_DIR}/include")
target_compile_definitions(FrameConsole PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 WINVER=0x0A00)
target_compile_options(FrameConsole PRIVATE /utf-8 /W4 /permissive- /EHsc /bigobj /Zc:__cplusplus /MP)
target_link_options(FrameConsole PRIVATE /MANIFEST:NO)
target_link_libraries(FrameConsole PRIVATE
  "${WEBVIEW2_DIR}/x64/WebView2LoaderStatic.lib"
  d3d11 dxgi windowsapp ws2_32 iphlpapi winhttp mmdevapi avrt windowscodecs dwmapi shlwapi bcrypt shcore normaliz ole32 oleaut32 uuid advapi32 user32 gdi32 shell32 version)
