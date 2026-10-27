// Minimal WinHTTP client: loopback requests (MediaMTX API, WHEP and playback forwarding) and directory announcements.
#pragma once

#include "common.h"

#include <map>

namespace fc {

struct HttpResponse {
  int status = 0;
  std::string body;
  std::map<std::string, std::string> headers;  // lower-case names
};

using HttpHeaders = std::vector<std::pair<std::string, std::string>>;

// Request to 127.0.0.1:port.
bool HttpRequest(const std::string& method, int port, const std::string& path, const std::string& body, const HttpHeaders& headers,
                 HttpResponse& response, DWORD timeoutMs, std::string* error = nullptr);
// Request to another host (directory announcements to a central FRAME Console).
bool HttpRequestHost(const std::string& host, int port, const std::string& method, const std::string& path, const std::string& body,
                     const HttpHeaders& headers, HttpResponse& response, DWORD timeoutMs, std::string* error = nullptr);
// Streams the response body of a loopback GET: onHead gets status and headers (body empty), onData each chunk.
// Either callback returning false stops the transfer. Used for recorded media, which can be large.
bool HttpStream(int port, const std::string& path, const HttpHeaders& headers, const std::function<bool(const HttpResponse&)>& onHead,
                const std::function<bool(const char*, size_t)>& onData, DWORD timeoutMs, std::string* error = nullptr);

}  // namespace fc
