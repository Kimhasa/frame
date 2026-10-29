#include "http_client.h"

#include <winhttp.h>

#include <algorithm>
#include <sstream>

namespace fc {

namespace {

struct InternetHandle {
  HINTERNET h = nullptr;
  ~InternetHandle() {
    if (h) WinHttpCloseHandle(h);
  }
};

void ReadHeaders(HINTERNET request, HttpResponse& response) {
  DWORD status = 0, size = sizeof(status);
  WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX);
  response.status = static_cast<int>(status);
  DWORD rawSize = 0;
  WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &rawSize, WINHTTP_NO_HEADER_INDEX);
  if (!rawSize) return;
  std::wstring raw(rawSize / sizeof(wchar_t), L'\0');
  if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, raw.data(), &rawSize, WINHTTP_NO_HEADER_INDEX)) return;
  std::istringstream lines(Utf8(raw));
  std::string line;
  while (std::getline(lines, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    std::string name = line.substr(0, colon);
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(tolower(c)); });
    std::string value = line.substr(colon + 1);
    value.erase(0, value.find_first_not_of(' '));
    auto& slot = response.headers[name];
    slot = slot.empty() ? value : slot + ", " + value;
  }
}

// Sends one request and calls onHead/onData; the buffered helpers collect the body themselves.
bool Perform(const std::string& host, int port, const std::string& method, const std::string& path, const std::string& body, const HttpHeaders& headers,
             DWORD timeoutMs, const std::function<bool(const HttpResponse&)>& onHead, const std::function<bool(const char*, size_t)>& onData,
             HttpResponse& response, std::string* error, bool secure = false) {
  response = HttpResponse{};
  InternetHandle session{WinHttpOpen(L"FrameConsole", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
  if (!session.h) {
    if (error) *error = LastErrorMessage();
    return false;
  }
  int t = static_cast<int>(timeoutMs);
  WinHttpSetTimeouts(session.h, t, t, t, t);
  InternetHandle connection{WinHttpConnect(session.h, Wide(host).c_str(), static_cast<INTERNET_PORT>(port), 0)};
  if (!connection.h) {
    if (error) *error = LastErrorMessage();
    return false;
  }
  InternetHandle request{WinHttpOpenRequest(connection.h, Wide(method).c_str(), Wide(path).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                            secure ? WINHTTP_FLAG_SECURE : 0)};
  if (!request.h) {
    if (error) *error = LastErrorMessage();
    return false;
  }
  DWORD disable = WINHTTP_DISABLE_REDIRECTS;
  WinHttpSetOption(request.h, WINHTTP_OPTION_DISABLE_FEATURE, &disable, sizeof(disable));
  std::wstring headerText;
  for (const auto& [name, value] : headers) headerText += Wide(name) + L": " + Wide(value) + L"\r\n";
  BOOL ok = WinHttpSendRequest(request.h, headerText.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headerText.c_str(), static_cast<DWORD>(-1L),
                               body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                               static_cast<DWORD>(body.size()), 0);
  if (!ok || !WinHttpReceiveResponse(request.h, nullptr)) {
    if (error) *error = LastErrorMessage();
    return false;
  }
  ReadHeaders(request.h, response);
  if (onHead && !onHead(response)) return true;
  std::vector<char> chunk(256 * 1024);
  for (;;) {
    DWORD read = 0;
    if (!WinHttpReadData(request.h, chunk.data(), static_cast<DWORD>(chunk.size()), &read)) {
      if (error) *error = LastErrorMessage();
      return false;
    }
    if (read == 0) break;
    if (!onData(chunk.data(), read)) break;
  }
  return true;
}

}  // namespace

bool HttpRequestHost(const std::string& host, int port, const std::string& method, const std::string& path, const std::string& body,
                     const HttpHeaders& headers, HttpResponse& response, DWORD timeoutMs, std::string* error) {
  std::string collected;
  bool ok = Perform(host, port, method, path, body, headers, timeoutMs, nullptr,
                    [&](const char* data, size_t size) {
                      collected.append(data, size);
                      return collected.size() <= 4 * 1024 * 1024;
                    },
                    response, error);
  response.body = std::move(collected);
  return ok;
}

bool HttpRequestUrl(const std::string& url, const std::string& method, const std::string& body, const HttpHeaders& headers, HttpResponse& response,
                    DWORD timeoutMs, std::string* error) {
  std::wstring wide = Wide(url);
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  wchar_t host[256] = {}, path[2048] = {};
  parts.lpszHostName = host;
  parts.dwHostNameLength = 256;
  parts.lpszUrlPath = path;
  parts.dwUrlPathLength = 2048;
  if (!WinHttpCrackUrl(wide.c_str(), 0, 0, &parts) || (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS)) {
    if (error) *error = "invalid URL";
    return false;
  }
  std::string collected;
  bool ok = Perform(Utf8(host), parts.nPort, method, path[0] ? Utf8(path) : "/", body, headers, timeoutMs, nullptr,
                    [&](const char* data, size_t size) {
                      collected.append(data, size);
                      return collected.size() <= 4 * 1024 * 1024;
                    },
                    response, error, parts.nScheme == INTERNET_SCHEME_HTTPS);
  response.body = std::move(collected);
  return ok;
}

bool HttpRequest(const std::string& method, int port, const std::string& path, const std::string& body, const HttpHeaders& headers,
                 HttpResponse& response, DWORD timeoutMs, std::string* error) {
  return HttpRequestHost("127.0.0.1", port, method, path, body, headers, response, timeoutMs, error);
}

bool HttpStream(int port, const std::string& path, const HttpHeaders& headers, const std::function<bool(const HttpResponse&)>& onHead,
                const std::function<bool(const char*, size_t)>& onData, DWORD timeoutMs, std::string* error) {
  HttpResponse response;
  return Perform("127.0.0.1", port, "GET", path, "", headers, timeoutMs, onHead, onData, response, error);
}

}  // namespace fc
