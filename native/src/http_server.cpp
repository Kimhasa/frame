#include "http_server.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <map>
#include <regex>
#include <sstream>

#include "chat.h"
#include "config.h"
#include "directory.h"
#include "http_client.h"
#include "streamer.h"

namespace fc {

namespace {

// Connection threads in total (each long-lived chat WebSocket keeps one) and concurrently handled ordinary requests
// (pages, info, WHEP, DVR chunks). Past either limit a request gets 503 with Retry-After instead of a dropped socket;
// the chat hub has its own limit. Threads use a small stack so a few thousand idle sockets stay cheap.
constexpr int kMaxThreads = 2600;
constexpr int kMaxRequests = 400;
constexpr SIZE_T kThreadStack = 256 * 1024;
constexpr size_t kMaxPath = 512;  // std::regex recursion depth grows with the input
constexpr size_t kMaxHeader = 16 * 1024;
constexpr size_t kMaxBody = 64 * 1024;

struct Request {
  std::string method, target, path, query;
  std::map<std::string, std::string> headers;
  std::string body;
};

bool RecvRequest(SOCKET s, Request& req) {
  std::string data;
  char buffer[4096];
  size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    int n = recv(s, buffer, sizeof(buffer), 0);
    if (n <= 0) return false;
    data.append(buffer, n);
    headerEnd = data.find("\r\n\r\n");
    if (headerEnd == std::string::npos && data.size() > kMaxHeader) return false;
  }
  std::istringstream head(data.substr(0, headerEnd));
  std::string line;
  std::getline(head, line);
  if (!line.empty() && line.back() == '\r') line.pop_back();
  std::istringstream first(line);
  std::string version;
  first >> req.method >> req.target >> version;
  if (req.method.empty() || req.target.empty() || req.target[0] != '/') return false;
  while (std::getline(head, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    std::string name = line.substr(0, colon);
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(tolower(c)); });
    std::string value = line.substr(colon + 1);
    value.erase(0, value.find_first_not_of(' '));
    req.headers[name] = value;
  }
  size_t length = 0;
  if (req.headers.count("content-length")) {
    length = static_cast<size_t>(strtoull(req.headers["content-length"].c_str(), nullptr, 10));
    if (length > kMaxBody) return false;
  }
  req.body = data.substr(headerEnd + 4);
  while (req.body.size() < length) {
    int n = recv(s, buffer, sizeof(buffer), 0);
    if (n <= 0) return false;
    req.body.append(buffer, n);
  }
  req.body.resize(length);
  size_t q = req.target.find('?');
  req.path = req.target.substr(0, q);
  req.query = q == std::string::npos ? "" : req.target.substr(q + 1);
  return true;
}

bool SendAll(SOCKET s, const char* data, size_t size) {
  size_t sent = 0;
  while (sent < size) {
    int n = send(s, data + sent, static_cast<int>(std::min<size_t>(size - sent, 1 << 20)), 0);
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

bool SendAll(SOCKET s, const std::string& data) { return SendAll(s, data.data(), data.size()); }

std::string QueryValue(const std::string& query, const std::string& name) {
  size_t pos = 0;
  while (pos <= query.size()) {
    size_t end = query.find('&', pos);
    if (end == std::string::npos) end = query.size();
    std::string pair = query.substr(pos, end - pos);
    size_t eq = pair.find('=');
    if (pair.substr(0, eq) == name) return eq == std::string::npos ? "" : pair.substr(eq + 1);
    pos = end + 1;
  }
  return "";
}

double QueryNumber(const std::string& query, const std::string& name) {
  std::string value = QueryValue(query, name);
  if (value.empty() || value.size() > 32 || value.find_first_not_of("0123456789.-") != std::string::npos) return NAN;
  return strtod(value.c_str(), nullptr);
}

const char* StatusText(int code) {
  switch (code) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 302: return "Found";
    case 101: return "Switching Protocols";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    default: return "OK";
  }
}

void Respond(SOCKET s, int code, const std::string& type, const std::string& body, const std::vector<std::pair<std::string, std::string>>& extra = {},
             bool headOnly = false) {
  std::ostringstream out;
  out << "HTTP/1.1 " << code << " " << StatusText(code) << "\r\n";
  if (!type.empty()) out << "Content-Type: " << type << "\r\n";
  out << "Content-Length: " << body.size() << "\r\n"
      << "Connection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
      << "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS\r\n"
      << "Access-Control-Allow-Headers: Content-Type, If-Match\r\nAccess-Control-Expose-Headers: Location, ETag, Link, Accept-Patch\r\n";
  for (const auto& [name, value] : extra) out << name << ": " << value << "\r\n";
  out << "\r\n";
  if (!headOnly) out << body;
  SendAll(s, out.str());
}

bool ReadFileBytes(const fs::path& path, std::string& out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  std::ostringstream ss;
  ss << in.rdbuf();
  out = ss.str();
  return true;
}

}  // namespace

bool HttpServer::Start(int port, std::string& error) {
  if (Listening() && port_ == port) return true;
  Stop();
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) {
    error = "시청 서버 소켓을 만들 수 없습니다.";
    return false;
  }
  BOOL exclusive = TRUE;
  setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 || listen(s, SOMAXCONN) != 0) {
    int code = WSAGetLastError();
    closesocket(s);
    error = code == WSAEADDRINUSE || code == WSAEACCES ? Printf("시청 포트 %d을(를) 다른 프로그램이 사용 중입니다.", port)
                                                       : Printf("시청 포트 %d을(를) 열 수 없습니다 (%d).", port, code);
    return false;
  }
  listener_ = s;
  port_ = port;
  stopping_ = false;
  acceptThread_ = std::thread([this] { AcceptLoop(); });
  LogFile("http", Printf("viewer server listening on 0.0.0.0:%d", port));
  return true;
}

void HttpServer::Stop() {
  stopping_ = true;
  if (listener_ != INVALID_SOCKET) {
    closesocket(listener_);
    listener_ = INVALID_SOCKET;
  }
  if (acceptThread_.joinable()) acceptThread_.join();
  for (int i = 0; i < 100 && active_ > 0; ++i) Sleep(20);
  port_ = 0;
}

void HttpServer::AcceptLoop() {
  while (!stopping_) {
    sockaddr_in peer{};
    int len = sizeof(peer);
    SOCKET client = accept(listener_, reinterpret_cast<sockaddr*>(&peer), &len);
    if (client == INVALID_SOCKET) {
      if (stopping_) break;
      Sleep(10);
      continue;
    }
    DWORD timeout = 20000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    if (active_ >= kMaxThreads) {
      ++refused_;
      Respond(client, 503, "text/plain; charset=utf-8", "Busy", {{"Retry-After", "2"}, {"Cache-Control", "no-store"}});
      shutdown(client, SD_BOTH);
      closesocket(client);
      continue;
    }
    char ip[INET_ADDRSTRLEN] = {};
    inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip));
    ++active_;
    auto* job = new Connection{this, client, ip};
    HANDLE thread = CreateThread(nullptr, kThreadStack, &HttpServer::ConnectionThread, job, STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr);
    if (thread) {
      CloseHandle(thread);
    } else {
      delete job;
      --active_;
      Respond(client, 503, "text/plain; charset=utf-8", "Busy", {{"Retry-After", "2"}, {"Cache-Control", "no-store"}});
      shutdown(client, SD_BOTH);
      closesocket(client);
    }
  }
}

DWORD WINAPI HttpServer::ConnectionThread(void* param) {
  std::unique_ptr<Connection> job(static_cast<Connection*>(param));
  try {
    job->server->Handle(job->socket, job->peer);
  } catch (...) {
  }
  shutdown(job->socket, SD_BOTH);
  closesocket(job->socket);
  --job->server->active_;
  return 0;
}

json HttpServer::Stats() const {
  return {{"threads", active_.load()}, {"requests", requests_.load()}, {"refused", refused_.load()}};
}

// Playback quality reported by viewers (operations: which transport and quality they really get, frame rate, loss,
// freezes, automatic quality switches and errors). One CSV line per report in data\logs\viewer-stats-<date>.csv; no IP
// address or identity is stored (the session id is random per page load). At most one line per address every 4 s and
// 50 MB per file, so a misbehaving client cannot fill the disk.
void HttpServer::RecordViewerStats(const std::string& path, const std::string& body, const std::string& peer) {
  json j = json::parse(body, nullptr, false);
  if (!j.is_object()) return;
  int64_t now = EpochMillis();
  std::lock_guard<std::mutex> lock(statsMutex_);
  int64_t& last = statsLast_[peer];
  if (now - last < 4000) return;
  last = now;
  if (statsLast_.size() > 5000) statsLast_.clear();
  auto text = [&](const char* key, size_t max) {
    std::string v = j.contains(key) && j[key].is_string() ? j[key].get<std::string>() : std::string();
    v.erase(std::remove_if(v.begin(), v.end(), [](char c) { return c == ',' || c == '\n' || c == '\r' || c == '"'; }), v.end());
    return v.substr(0, max);
  };
  auto number = [&](const char* key) { return j.contains(key) && j[key].is_number() ? Printf("%.3f", j[key].get<double>()) : std::string(); };
  SYSTEMTIME t;
  GetLocalTime(&t);
  fs::path file = LogDir() / Wide(Printf("viewer-stats-%04u%02u%02u.csv", t.wYear, t.wMonth, t.wDay));
  std::error_code ec;
  bool fresh = !fs::exists(file, ec);
  if (!fresh && fs::file_size(file, ec) > 50ull * 1024 * 1024) return;
  std::ofstream out(file, std::ios::binary | std::ios::app);
  if (fresh) out << "time,path,session,broadcast,transport,mode,quality,height,fps,loss_pct,jitter_ms,freezes,mbps,abr_switches,last_switch,event,device\n";
  out << ClockText() << "," << path << "," << text("sid", 16) << "," << text("broadcast", 32) << "," << text("transport", 8) << "," << text("mode", 8) << ","
      << text("quality", 12) << "," << number("height") << "," << number("fps") << "," << number("lossPct") << "," << number("jitterMs") << ","
      << number("freezes") << "," << number("mbps") << "," << number("abrSwitches") << "," << text("lastSwitch", 80) << "," << text("event", 80) << ","
      << text("device", 8) << "\n";
}

void HttpServer::Handle(SOCKET client, std::string peer) {
  // Ordinary requests are counted while they are handled; a chat WebSocket leaves this count when it upgrades.
  struct RequestSlot {
    std::atomic<int>& count;
    bool held = true;
    explicit RequestSlot(std::atomic<int>& c) : count(c) { ++count; }
    void Release() { if (held) --count, held = false; }
    ~RequestSlot() { Release(); }
  } slot(requests_);
  Request req;
  if (!RecvRequest(client, req)) {
    Respond(client, 400, "text/plain; charset=utf-8", "Bad request");
    return;
  }
  if (req.path.size() > kMaxPath) {
    Respond(client, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }
  bool websocket = req.headers.count("upgrade") != 0;
  if (!websocket && requests_ > kMaxRequests) {
    ++refused_;
    Respond(client, 503, "text/plain; charset=utf-8", "Busy", {{"Retry-After", "1"}, {"Cache-Control", "no-store"}});
    return;
  }
  // /<stream>[/<quality>]/whep[/<session>] and /<stream>[/<quality>]/info; nothing else reaches MediaMTX.
  static const std::regex whep(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(/(?:240|360|480|720|1080|1440)p)?/whep(/[A-Za-z0-9_-]{1,128})?$)");
  static const std::regex page(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/?$)");
  static const std::regex font(R"(^(?:/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?/assets/fonts/(PretendardVariable\.woff2|OFL\.txt)$)");
  static const std::regex info(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/info$)");
  std::smatch m;
  bool head = req.method == "HEAD";
  const std::vector<std::pair<std::string, std::string>> noStore = {{"Cache-Control", "no-store"}};

  if (std::regex_match(req.path, m, whep)) {
    std::string stream = m[1].str() + m[2].str();
    if (req.method == "OPTIONS") {
      Respond(client, 204, "", "", {{"Access-Control-Max-Age", "600"}});
      return;
    }
    if (req.method != "POST" && req.method != "PATCH" && req.method != "DELETE") {
      Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    if (req.method == "POST" && m[3].matched) {
      Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    int port = streamer_.WebrtcHttpPort();
    if (!port || !streamer_.KnownStreamPath(stream)) {
      Respond(client, 404, "text/plain; charset=utf-8", "Stream is not running", noStore);
      return;
    }
    std::vector<std::pair<std::string, std::string>> headers = {{"X-Forwarded-For", peer}};
    if (req.headers.count("content-type")) headers.push_back({"Content-Type", req.headers["content-type"]});
    if (req.headers.count("if-match")) headers.push_back({"If-Match", req.headers["if-match"]});
    HttpResponse upstream;
    std::string error;
    // On-demand qualities wait until MediaMTX has started their encoder, so allow a longer upstream timeout.
    if (!HttpRequest(req.method, port, req.path, req.body, headers, upstream, 20000, &error)) {
      LogFile("http", "WHEP upstream failed: " + error);
      Respond(client, 502, "text/plain; charset=utf-8", "Upstream error", noStore);
      return;
    }
    std::vector<std::pair<std::string, std::string>> extra = noStore;
    for (const char* name : {"location", "etag", "link", "accept-patch"}) {
      auto it = upstream.headers.find(name);
      if (it == upstream.headers.end()) continue;
      std::string value = it->second;
      if (std::string(name) == "location" && value.rfind("http", 0) == 0) {
        size_t slash = value.find('/', value.find("//") + 2);  // keep the client on this server
        value = slash == std::string::npos ? "/" : value.substr(slash);
      }
      std::string header = name;
      header[0] = static_cast<char>(toupper(header[0]));
      if (header == "Accept-patch") header = "Accept-Patch";
      if (header == "Etag") header = "ETag";
      extra.push_back({header, value});
    }
    auto type = upstream.headers.find("content-type");
    Respond(client, upstream.status, type == upstream.headers.end() ? "" : type->second, upstream.body, extra);
    if (req.method == "POST") LogFile("http", Printf("WHEP %s from %s -> %d", stream.c_str(), peer.c_str(), upstream.status));
    return;
  }

  if (req.method == "OPTIONS") {
    Respond(client, 204, "", "");
    return;
  }
  if (req.path == "/api/broadcasts/announce") {
    // Registration from another FRAME PC (central directory across subnets). Only its own address can be announced.
    if (req.method != "POST" || req.body.size() > 4096) {
      Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    std::string error;
    json message = json::parse(req.body, nullptr, false);
    if (message.is_discarded() || !directory_.Accept(message, peer, error)) Respond(client, 400, "text/plain; charset=utf-8", error.empty() ? "Bad request" : error);
    else Respond(client, 204, "", "");
    return;
  }
  if (req.path == "/api/stats" && (req.method == "GET" || head)) {
    // Read-only load counters for operations and load tests: media server paths/readers/bytes, viewer-server threads and
    // refusals, chat connections. Aggregates only; nothing here identifies a viewer or changes anything.
    json out = streamer_.ServerStats();
    out["http"] = Stats();
    out["chat"] = chat_.Stats();
    Respond(client, 200, "application/json; charset=utf-8", out.dump(), noStore, head);
    return;
  }
  static const std::regex stats(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/stats$)");
  if (std::regex_match(req.path, m, stats)) {
    if (req.method != "POST" || req.body.size() > 2048) {
      Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    RecordViewerStats(m[1].str(), req.body, peer);
    Respond(client, 204, "", "");
    return;
  }
  if (req.method != "GET" && !head) {
    Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }
  fs::path ui = ExeDir() / L"ui";
  static const std::regex thumb(R"(^/thumbnails/([0-9a-f]{32})\.jpg$)");
  static const std::regex chat(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/chat$)");
  if (req.path == "/api/broadcasts") {
    Respond(client, 200, "application/json; charset=utf-8", directory_.List().dump(-1, ' ', false, json::error_handler_t::replace), noStore, head);
    return;
  }
  if (std::regex_match(req.path, m, thumb)) {
    std::string jpeg = streamer_.Thumbnail(m[1].str());
    if (jpeg.empty()) Respond(client, 404, "text/plain; charset=utf-8", "Not found", noStore, head);
    else Respond(client, 200, "image/jpeg", jpeg, {{"Cache-Control", "max-age=4"}}, head);
    return;
  }
  if (std::regex_match(req.path, m, chat)) {
    auto upgrade = req.headers.find("upgrade");
    auto key = req.headers.find("sec-websocket-key");
    if (upgrade == req.headers.end() || _stricmp(upgrade->second.c_str(), "websocket") != 0 || key == req.headers.end() || key->second.size() > 64) {
      Respond(client, 400, "text/plain; charset=utf-8", "WebSocket upgrade required");
      return;
    }
    if (m[1].str() != streamer_.StreamPath() || streamer_.BroadcastId().empty()) {
      Respond(client, 404, "text/plain; charset=utf-8", "Stream is not running", noStore);
      return;
    }
    slot.Release();
    chat_.Serve(client, key->second, peer);
    return;
  }
  if (req.path == "/") {
    std::string body;
    if (!ReadFileBytes(ui / L"index.html", body)) {
      Respond(client, 404, "text/plain; charset=utf-8", "UI files are missing");
      return;
    }
    Respond(client, 200, "text/html; charset=utf-8", body, {{"Cache-Control", "no-store"}, {"X-Frame-Options", "DENY"}}, head);
    return;
  }
  if (std::regex_match(req.path, m, font)) {
    std::string body;
    std::string name = m[1].str();
    if (!ReadFileBytes(ui / L"assets" / L"fonts" / Wide(name), body)) {
      Respond(client, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    Respond(client, 200, name == "OFL.txt" ? "text/plain; charset=utf-8" : "font/woff2", body, {{"Cache-Control", "max-age=86400"}}, head);
    return;
  }
  if (std::regex_match(req.path, m, info)) {
    Respond(client, 200, "application/json; charset=utf-8", streamer_.ViewerInfo(m[1].str()).dump(), noStore, head);
    return;
  }
  // DVR: the time index of the running broadcast, and one bounded fMP4 chunk of it (read only, loopback upstream).
  static const std::regex dvrIndex(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/dvr$)");
  static const std::regex dvrMedia(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/dvr/media$)");
  if (std::regex_match(req.path, m, dvrIndex)) {
    Respond(client, 200, "application/json; charset=utf-8", streamer_.DvrIndex(m[1].str()).dump(), noStore, head);
    return;
  }
  // Low-latency HLS of the running stream (or one of its qualities) from the loopback MediaMTX: the fallback for viewers
  // whose browser or network cannot use WebRTC. Playlists and fMP4 parts only; blocking playlist reloads pass through.
  static const std::regex hls(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(/(?:240|360|480|720|1080|1440)p)?/hls/([A-Za-z0-9_][A-Za-z0-9_.-]{0,79})$)");
  if (std::regex_match(req.path, m, hls)) {
    std::string stream = m[1].str() + m[2].str(), file = m[3].str();
    int port = streamer_.HlsPort();
    if (!port || !streamer_.KnownStreamPath(stream)) {
      Respond(client, 404, "text/plain; charset=utf-8", "Stream is not running", noStore, head);
      return;
    }
    // MediaMTX first redirects to ?cookieCheck=1 (a browser cookie test); the forwarded request carries that answer.
    std::string query = "?cookieCheck=1";
    for (const char* name : {"_HLS_msn", "_HLS_part", "_HLS_skip"}) {
      std::string value = QueryValue(req.query, name);
      if (!value.empty() && value.size() < 16 && value.find_first_not_of("0123456789YESvy") == std::string::npos) query += "&" + std::string(name) + "=" + value;
    }
    std::string session = QueryValue(req.query, "session");  // MediaMTX ties a reader to its HLS session id
    if (!session.empty() && session.size() <= 64 && session.find_first_not_of("0123456789abcdefABCDEF-") == std::string::npos) query += "&session=" + session;
    bool started = false, clientGone = false;
    int upstreamStatus = 0;
    std::string upstreamError;
    bool ok = HttpStream(
        port, "/" + stream + "/" + file + query, {},
        [&](const HttpResponse& r) {
          upstreamStatus = r.status;
          if (r.status != 200) return false;
          auto type = r.headers.find("content-type");
          std::ostringstream out;
          out << "HTTP/1.1 200 OK\r\nContent-Type: " << (type == r.headers.end() ? "application/octet-stream" : type->second)
              << "\r\nCache-Control: no-store\r\nConnection: close\r\n" << (head ? "" : "Transfer-Encoding: chunked\r\n")
              << "X-Content-Type-Options: nosniff\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
          started = true;
          clientGone = !SendAll(client, out.str());
          return !head && !clientGone;
        },
        [&](const char* data, size_t size) {
          clientGone = !SendAll(client, Printf("%zx\r\n", size)) || !SendAll(client, data, size) || !SendAll(client, "\r\n", 2);
          return !clientGone;
        },
        30000, &upstreamError);
    if (started && !head && ok) {
      SendAll(client, "0\r\n\r\n", 5);
    } else if (started && !head) {
      linger abort{1, 0};
      setsockopt(client, SOL_SOCKET, SO_LINGER, reinterpret_cast<const char*>(&abort), sizeof(abort));
    } else if (!started) {
      Respond(client, upstreamStatus == 404 ? 404 : 502, "text/plain; charset=utf-8", upstreamStatus == 404 ? "Not found" : "Upstream error", noStore, head);
    }
    return;
  }
  if (std::regex_match(req.path, m, dvrMedia)) {
    int port = 0, status = 0;
    std::string target, error;
    if (!streamer_.DvrMediaTarget(m[1].str(), QueryValue(req.query, "id"), QueryNumber(req.query, "start"), QueryNumber(req.query, "duration"), port, target,
                                  status, error)) {
      Respond(client, status, "application/json; charset=utf-8", json{{"error", error}}.dump(), noStore, head);
      return;
    }
    bool started = false, clientGone = false;
    int upstreamStatus = 0;
    std::string upstreamError;
    bool ok = HttpStream(
        port, target, {},
        [&](const HttpResponse& r) {
          upstreamStatus = r.status;
          if (r.status != 200) return false;
          std::ostringstream out;
          // Chunked: MediaMTX streams the media as it reads the segments, and a transfer that breaks off upstream must
          // reach the browser as an error (no final chunk), never as a shorter but apparently complete file.
          out << "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nCache-Control: no-store\r\nConnection: close\r\n"
              << (head ? "" : "Transfer-Encoding: chunked\r\n")
              << "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
          started = true;
          clientGone = !SendAll(client, out.str());
          return !head && !clientGone;
        },
        [&](const char* data, size_t size) {
          clientGone = !SendAll(client, Printf("%zx\r\n", size)) || !SendAll(client, data, size) || !SendAll(client, "\r\n", 2);
          return !clientGone;
        },
        30000, &upstreamError);
    if (started && !head && ok) {
      SendAll(client, "0\r\n\r\n", 5);
    } else if (started && !head) {
      // Abortive close (no final chunk): the browser's fetch fails and the player retries the chunk.
      linger abort{1, 0};
      setsockopt(client, SOL_SOCKET, SO_LINGER, reinterpret_cast<const char*>(&abort), sizeof(abort));
      if (!clientGone) LogFile("dvr", "chunk interrupted: " + upstreamError);
    } else if (!started) {
      // 404: nothing recorded at that time yet (past the live edge) or a gap where recording was paused.
      int code = upstreamStatus == 404 ? 404 : 502;
      Respond(client, code, "application/json; charset=utf-8", json{{"error", code == 404 ? "no-data" : "upstream"}}.dump(), noStore, head);
      if (code == 502) LogFile("dvr", Printf("chunk failed (%d): ", upstreamStatus) + upstreamError);
    }
    return;
  }
  if (std::regex_match(req.path, m, page)) {
    std::string body;
    if (!ReadFileBytes(ui / L"index.html", body)) {
      Respond(client, 404, "text/plain; charset=utf-8", "UI files are missing");
      return;
    }
    Respond(client, 200, "text/html; charset=utf-8", body, {{"Cache-Control", "no-store"}, {"X-Frame-Options", "DENY"}}, head);
    return;
  }
  Respond(client, 404, "text/plain; charset=utf-8", "Not found");
}

}  // namespace fc
