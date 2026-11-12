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
constexpr ULONGLONG kRequestDeadlineMs = 10000;  // the whole request (headers and body) must arrive within this

struct Request {
  std::string method, target, path, query;
  std::map<std::string, std::string> headers;
  std::string body;
  bool received = false;  // any byte arrived
};

bool RecvRequest(SOCKET s, Request& req) {
  // One deadline for the whole request, not only per receive: a client trickling bytes would otherwise hold its request
  // slot (counted while the request arrives) for as long as it likes. Each receive waits at most the time left.
  const ULONGLONG deadline = GetTickCount64() + kRequestDeadlineMs;
  auto receive = [&](char* into, int size) {
    ULONGLONG now = GetTickCount64();
    if (now >= deadline) return 0;
    DWORD left = static_cast<DWORD>(deadline - now);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&left), sizeof(left));
    return recv(s, into, size, 0);
  };
  std::string data;
  char buffer[4096];
  size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    int n = receive(buffer, sizeof(buffer));
    if (n <= 0) return false;
    req.received = true;
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
    int n = receive(buffer, sizeof(buffer));
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
    case 206: return "Partial Content";
    case 302: return "Found";
    case 101: return "Switching Protocols";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 416: return "Range Not Satisfiable";
    case 500: return "Internal Server Error";
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
      << "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
      << "Access-Control-Allow-Headers: Content-Type, If-Match, Range\r\n"
      << "Access-Control-Expose-Headers: Location, ETag, Link, Accept-Patch, Content-Range, Content-Length, Accept-Ranges\r\n";
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

// MediaMTX writes its session id (and the request's query) into every URI of the playlists it serves. The viewer server
// strips them: players get the same playlist whatever session served it and request plain file names, which the proxy
// forwards with its own shared session.
std::string StripPlaylistQueries(const std::string& body) {
  std::string out;
  out.reserve(body.size());
  size_t pos = 0;
  while (pos < body.size()) {
    size_t end = body.find('\n', pos);
    if (end == std::string::npos) end = body.size();
    std::string line = body.substr(pos, end - pos);
    bool cr = !line.empty() && line.back() == '\r';
    if (cr) line.pop_back();
    if (!line.empty() && line[0] == '#') {
      for (size_t u = line.find("URI=\""); u != std::string::npos; u = line.find("URI=\"", u)) {
        size_t start = u + 5, close = line.find('"', start);
        if (close == std::string::npos) break;
        size_t q = line.find('?', start);
        if (q != std::string::npos && q < close) line.erase(q, close - q), close = q;
        u = close + 1;
      }
    } else {
      size_t q = line.find('?');
      if (q != std::string::npos) line.erase(q);
    }
    out += line;
    if (cr) out += '\r';
    if (end < body.size()) out += '\n';
    pos = end + 1;
  }
  return out;
}

// A single "bytes=" range against a resource of size bytes: 1 with [first, last], 0 when absent or not understood (the
// whole resource is sent), -1 when it lies outside the resource.
int ParseRange(const std::string& value, uint64_t size, uint64_t& first, uint64_t& last) {
  if (value.compare(0, 6, "bytes=") != 0 || value.find(',') != std::string::npos) return 0;
  std::string spec = value.substr(6);
  spec.erase(std::remove(spec.begin(), spec.end(), ' '), spec.end());
  size_t dash = spec.find('-');
  if (dash == std::string::npos) return 0;
  std::string a = spec.substr(0, dash), b = spec.substr(dash + 1);
  auto digits = [](const std::string& s) { return !s.empty() && s.size() <= 18 && s.find_first_not_of("0123456789") == std::string::npos; };
  if (a.empty()) {  // the last b bytes
    if (!digits(b)) return 0;
    uint64_t n = strtoull(b.c_str(), nullptr, 10);
    if (!n || !size) return -1;
    first = n >= size ? 0 : size - n;
    last = size - 1;
    return 1;
  }
  if (!digits(a) || (!b.empty() && !digits(b))) return 0;
  first = strtoull(a.c_str(), nullptr, 10);
  last = b.empty() ? (size ? size - 1 : 0) : strtoull(b.c_str(), nullptr, 10);
  if (!b.empty() && last < first) return 0;
  if (first >= size) return -1;
  last = std::min(last, size - 1);
  return 1;
}

std::string MediaHeaders(int code, uint64_t length, const std::string& cache, const std::string& contentRange, bool ranges) {
  std::ostringstream out;
  out << "HTTP/1.1 " << code << " " << StatusText(code) << "\r\nContent-Type: video/mp4\r\nContent-Length: " << length
      << "\r\nAccept-Ranges: " << (ranges ? "bytes" : "none") << "\r\n";
  if (!contentRange.empty()) out << "Content-Range: " << contentRange << "\r\n";
  out << "Cache-Control: " << cache << "\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
      << "Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\r\n";
  return out.str();
}

ScopedHandle OpenRecording(const fs::path& path) {
  return ScopedHandle(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL, nullptr));
}

// Sends byte runs of a recording file; on a read error the connection is reset so the player sees a failed request,
// never a shorter body.
void SendFileRuns(SOCKET s, HANDLE file, const std::vector<std::pair<uint64_t, uint64_t>>& runs) {
  std::vector<char> buffer(256 * 1024);
  for (auto [offset, length] : runs) {
    while (length) {
      DWORD want = static_cast<DWORD>(std::min<uint64_t>(length, buffer.size()));
      OVERLAPPED ov{};
      ov.Offset = static_cast<DWORD>(offset);
      ov.OffsetHigh = static_cast<DWORD>(offset >> 32);
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), want, &read, &ov) || read != want) {
        LogFile("dvr", "recording read failed: " + LastErrorMessage());
        linger abort{1, 0};
        setsockopt(s, SOL_SOCKET, SO_LINGER, reinterpret_cast<const char*>(&abort), sizeof(abort));
        return;
      }
      if (!SendAll(s, buffer.data(), read)) return;
      offset += read;
      length -= read;
    }
  }
}

}  // namespace

std::string HttpServer::UpstreamHlsSession(int port, const std::string& stream, const std::string& stale) {
  // MediaMTX 1.21 serves media playlists, parts and segments only within an HLS session that its index.m3u8 creates
  // ("session not found" otherwise). One session per stream or quality is shared by every viewer of this server, so
  // players may load video1_stream.m3u8 / audio3_stream.m3u8 directly and all of them get identical responses.
  const std::string key = std::to_string(port) + "|" + stream;
  std::shared_ptr<std::mutex> refresh;
  {
    std::lock_guard<std::mutex> lock(hlsSessionMutex_);
    auto it = hlsSessions_.find(key);
    if (it != hlsSessions_.end() && it->second != stale) return it->second;
    auto& r = hlsRefresh_[key];
    if (!r) r = std::make_shared<std::mutex>();
    refresh = r;
  }
  // One request per stream makes the session (for an on-demand quality it first waits for that quality's encoder);
  // viewers arriving meanwhile wait for it instead of starting more.
  std::lock_guard<std::mutex> one(*refresh);
  {
    std::lock_guard<std::mutex> lock(hlsSessionMutex_);
    auto it = hlsSessions_.find(key);
    if (it != hlsSessions_.end() && it->second != stale) return it->second;
  }
  HttpResponse r;
  std::string error;
  if (!HttpRequest("GET", port, "/" + stream + "/index.m3u8?cookieCheck=1", "", {}, r, 30000, &error) || r.status != 200) {
    LogFile("http", "HLS session for " + stream + " failed: " + (error.empty() ? Printf("%d ", r.status) + r.body.substr(0, 120) : error));
    return "";
  }
  size_t at = r.body.find("session=");
  if (at == std::string::npos) return "";
  at += 8;
  size_t end = r.body.find_first_not_of("0123456789abcdefABCDEF-", at);
  std::string id = r.body.substr(at, (end == std::string::npos ? r.body.size() : end) - at);
  if (id.empty() || id.size() > 64) return "";
  std::lock_guard<std::mutex> lock(hlsSessionMutex_);
  // Sessions of an earlier broadcast (another loopback port) are of no use any more.
  const std::string prefix = std::to_string(port) + "|";
  for (auto it = hlsSessions_.begin(); it != hlsSessions_.end();) it = it->first.rfind(prefix, 0) != 0 ? hlsSessions_.erase(it) : std::next(it);
  for (auto it = hlsRefresh_.begin(); it != hlsRefresh_.end();) it = it->first.rfind(prefix, 0) != 0 ? hlsRefresh_.erase(it) : std::next(it);
  hlsSessions_[key] = id;
  return id;
}

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
    // A connection that never sent a byte (a browser's preconnected spare socket reaching the deadline) is just closed.
    if (req.received) Respond(client, 400, "text/plain; charset=utf-8", "Bad request");
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
    // A quality is published by the shared quality encoder (the ladder): start it when needed and wait for the path.
    if (req.method == "POST" && m[2].matched && !streamer_.EnsureLadder(stream, 15000)) {
      Respond(client, 503, "text/plain; charset=utf-8", "Quality is starting", {{"Retry-After", "2"}, {"Cache-Control", "no-store"}});
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
  // HLS viewer sessions, for counting only (no cap on this server): POST opens one, PUT is the heartbeat (active for
  // 30 s), DELETE leaves. Media requests never depend on them.
  static const std::regex sessionNew(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/session$)");
  static const std::regex sessionOne(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/session/([0-9a-f]{32})$)");
  if (std::regex_match(req.path, m, sessionNew)) {
    if (req.method != "POST") {
      Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    int status = 0;
    std::string sid = streamer_.HlsSessionOpen(m[1].str(), status);
    if (sid.empty())
      Respond(client, status, "application/json; charset=utf-8", json{{"error", status == 404 ? "not-running" : "busy"}}.dump(),
              status == 503 ? std::vector<std::pair<std::string, std::string>>{{"Retry-After", "5"}, {"Cache-Control", "no-store"}} : noStore);
    else
      Respond(client, 200, "application/json; charset=utf-8", json{{"sid", sid}, {"heartbeatMs", Streamer::kHlsHeartbeatMs}}.dump(), noStore);
    return;
  }
  if (std::regex_match(req.path, m, sessionOne)) {
    if (req.method != "PUT" && req.method != "DELETE") {
      Respond(client, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    bool known = streamer_.HlsSessionTouch(m[1].str(), m[2].str(), req.method == "DELETE");
    Respond(client, known ? 204 : 404, "", "", noStore);
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
  // Player scripts shipped with the UI (ui\assets\js, e.g. hls-1.5.20.min.js). Their names carry the version, so they are
  // cached long; nothing outside that folder is reachable (one file name, no separators).
  static const std::regex script(R"(^(?:/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?/assets/js/([A-Za-z0-9][A-Za-z0-9_.-]{0,79}\.(?:js|txt))$)");
  if (std::regex_match(req.path, m, script)) {
    std::string body, name = m[1].str();
    bool js = name.size() > 3 && name.compare(name.size() - 3, 3, ".js") == 0;
    if (!ReadFileBytes(ui / L"assets" / L"js" / Wide(name), body)) {
      Respond(client, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    Respond(client, 200, js ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8", body,
            {{"Cache-Control", js ? "public, max-age=31536000, immutable" : "max-age=86400"}}, head);
    return;
  }
  if (std::regex_match(req.path, m, info)) {
    Respond(client, 200, "application/json; charset=utf-8", streamer_.ViewerInfo(m[1].str()).dump(), noStore, head);
    return;
  }
  // HLS multivariant playlist of the running stream (all viewers get the same bytes; ?q= limits it to one quality).
  static const std::regex live(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/live\.m3u8$)");
  if (std::regex_match(req.path, m, live)) {
    static const std::regex qualityName(R"(^(?:source|(?:240|360|480|720|1080|1440)p)$)");
    std::string quality = QueryValue(req.query, "q"), body;
    int status = 404;
    if ((quality.empty() || std::regex_match(quality, qualityName)) && streamer_.HlsMultivariant(m[1].str(), quality, body, status)) {
      // Start the quality encoder now (no wait): the player asks for a variant right after this. While the ladder keeps
      // failing (the playlist then offers the stream's own path), this is its backed-off retry.
      streamer_.EnsureLadder(m[1].str() + "/src", 0);
      Respond(client, 200, "application/vnd.apple.mpegurl", body, {{"Cache-Control", "max-age=1"}}, head);
    }
    else
      Respond(client, status, "text/plain; charset=utf-8", "Stream is not running", noStore, head);
    return;
  }
  // The current broadcast's recording as an HLS EVENT playlist, and its files: the init as a byte range of the file
  // (Range, bounded to the listed bytes) and each media segment (&s=) built from the file's parts at a keyframe.
  static const std::regex dvrPlaylist(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/dvr\.m3u8$)");
  static const std::regex dvrFile(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/dvr/file(?:\.mp4)?$)");
  if (std::regex_match(req.path, m, dvrPlaylist)) {
    std::string body;
    int status = 404;
    if (streamer_.DvrPlaylist(m[1].str(), body, status))
      Respond(client, 200, "application/vnd.apple.mpegurl", body, {{"Cache-Control", "no-cache"}}, head);
    else
      Respond(client, status, "text/plain; charset=utf-8", "No recording", noStore, head);
    return;
  }
  if (std::regex_match(req.path, m, dvrFile)) {
    auto number = [](const std::string& v) {
      return !v.empty() && v.size() <= 6 && v.find_first_not_of("0123456789") == std::string::npos ? atoi(v.c_str()) : -1;
    };
    std::string id = QueryValue(req.query, "id"), segmentText = QueryValue(req.query, "s");
    int index = number(QueryValue(req.query, "f")), segment = segmentText.empty() ? -1 : number(segmentText);
    if (id.size() != 32 || id.find_first_not_of("0123456789abcdef") != std::string::npos || index < 0 || (!segmentText.empty() && segment < 0)) {
      Respond(client, 400, "application/json; charset=utf-8", json{{"error", "bad-request"}}.dump(), noStore, head);
      return;
    }
    RecordFile file;
    int status = 404;
    if (!streamer_.DvrFile(m[1].str(), id, index, file, status)) {
      Respond(client, status, "application/json; charset=utf-8", json{{"error", status == 409 ? "broadcast-changed" : "no-data"}}.dump(), noStore, head);
      return;
    }
    ScopedHandle handle = OpenRecording(file.path);
    if (!handle.Valid()) {
      Respond(client, 404, "application/json; charset=utf-8", json{{"error", "no-data"}}.dump(), noStore, head);
      return;
    }
    if (segment >= 0) {
      RecordFragment fragment;
      if (static_cast<size_t>(segment) >= file.segments.size() ||
          !BuildRecordFragment(file, file.segments[static_cast<size_t>(segment)], static_cast<uint32_t>(segment) + 1, fragment)) {
        if (static_cast<size_t>(segment) < file.segments.size()) LogFile("dvr", Printf("segment %d of file %d could not be built", segment, index));
        Respond(client, 404, "application/json; charset=utf-8", json{{"error", "no-data"}}.dump(), noStore, head);
        return;
      }
      // A listed segment never changes (it is cut from complete parts), so it may be cached like a finished file.
      if (!SendAll(client, MediaHeaders(200, fragment.moof.size() + fragment.payload, "public, max-age=3600", "", false)) || head) return;
      if (SendAll(client, fragment.moof)) SendFileRuns(client, handle.Get(), fragment.runs);
      return;
    }
    // The file itself: only the init and the parts of listed segments, never bytes past them.
    uint64_t limit = file.ListedBytes(), first = 0, last = limit ? limit - 1 : 0;
    auto range = req.headers.find("range");
    int ranged = range == req.headers.end() ? 0 : ParseRange(range->second, limit, first, last);
    if (ranged < 0 || !limit) {
      Respond(client, 416, "text/plain; charset=utf-8", "Range not satisfiable", {{"Content-Range", Printf("bytes */%llu", static_cast<unsigned long long>(limit))}, {"Cache-Control", "no-store"}},
              head);
      return;
    }
    std::string cache = file.complete ? "public, max-age=3600" : "no-cache";
    std::string contentRange = ranged ? Printf("bytes %llu-%llu/", static_cast<unsigned long long>(first), static_cast<unsigned long long>(last)) +
                                            (file.complete ? std::to_string(limit) : std::string("*"))
                                      : std::string();
    if (!SendAll(client, MediaHeaders(ranged ? 206 : 200, last - first + 1, cache, contentRange, true)) || head) return;
    SendFileRuns(client, handle.Get(), {{first, last - first + 1}});
    return;
  }
  // DVR: the time index of the running broadcast, and one bounded fMP4 chunk of it (read only, loopback upstream).
  static const std::regex dvrIndex(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/dvr$)");
  static const std::regex dvrMedia(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/dvr/media$)");
  if (std::regex_match(req.path, m, dvrIndex)) {
    Respond(client, 200, "application/json; charset=utf-8", streamer_.DvrIndex(m[1].str()).dump(), noStore, head);
    return;
  }
  // Low-latency HLS of the running stream (or one of its qualities) from the loopback MediaMTX: what every browser viewer
  // plays (live.m3u8 points here). Playlists and fMP4 init/parts/segments only; blocking playlist reloads pass through.
  // No viewer-specific data: MediaMTX's session and cookie check are answered here, its session ids are removed from
  // the playlists, so every viewer gets the same bytes (playlists max-age=1, keyed by the _HLS_ query; media names are
  // unique per MediaMTX muxer and cached 60 s).
  static const std::regex hls(R"(^/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(/(?:src|(?:240|360|480|720|1080|1440)p))?/hls/([A-Za-z0-9_][A-Za-z0-9_.-]{0,79})$)");
  if (std::regex_match(req.path, m, hls)) {
    std::string stream = m[1].str() + m[2].str(), file = m[3].str();
    int port = streamer_.HlsPort();
    if (!port || !streamer_.KnownStreamPath(stream)) {
      Respond(client, 404, "text/plain; charset=utf-8", "Stream is not running", noStore, head);
      return;
    }
    // The source copy and the qualities come from the ladder (started here if needed, then cheap once published).
    if (m[2].matched && !streamer_.EnsureLadder(stream, 15000)) {
      Respond(client, 503, "text/plain; charset=utf-8", "Quality is starting", {{"Retry-After", "1"}, {"Cache-Control", "no-store"}}, head);
      return;
    }
    std::string params;
    for (const char* name : {"_HLS_msn", "_HLS_part", "_HLS_skip"}) {
      std::string value = QueryValue(req.query, name);
      if (!value.empty() && value.size() < 16 && value.find_first_not_of("0123456789YESvy") == std::string::npos) params += "&" + std::string(name) + "=" + value;
    }
    std::string session = UpstreamHlsSession(port, stream, "");
    if (session.empty()) {
      Respond(client, 502, "text/plain; charset=utf-8", "Upstream error", noStore, head);
      return;
    }
    auto target = [&] { return "/" + stream + "/" + file + "?cookieCheck=1&session=" + session + params; };
    bool playlist = file.size() > 5 && file.compare(file.size() - 5, 5, ".m3u8") == 0;
    if (playlist) {
      HttpResponse upstream;
      std::string error;
      bool ok = false;
      for (int attempt = 0; attempt < 2; ++attempt) {
        ok = HttpRequest("GET", port, target(), "", {}, upstream, 30000, &error);
        // 401: MediaMTX ended the shared session. 404: its muxer is gone (the path's publisher restarted: the quality
        // ladder after an idle stop or a failure) and a request with the old session does not create the new muxer, only
        // index.m3u8 does. Either way a new session is made once (that index.m3u8 answers 404 when the path has nothing).
        if (!ok || (upstream.status != 401 && upstream.status != 404) || attempt) break;
        session = UpstreamHlsSession(port, stream, session);
        if (session.empty()) break;
      }
      if (!ok || upstream.status != 200) {
        bool missing = ok && upstream.status == 404;
        if (!missing) LogFile("http", "HLS playlist " + stream + "/" + file + " failed: " + (ok ? Printf("%d", upstream.status) : error));
        Respond(client, missing ? 404 : 502, "text/plain; charset=utf-8", missing ? "Not found" : "Upstream error", noStore, head);
        return;
      }
      auto type = upstream.headers.find("content-type");
      Respond(client, 200, type == upstream.headers.end() ? "application/vnd.apple.mpegurl" : type->second, StripPlaylistQueries(upstream.body),
              {{"Cache-Control", "max-age=1"}}, head);
      return;
    }
    bool started = false, clientGone = false, ok = false;
    int upstreamStatus = 0;
    std::string upstreamError;
    for (int attempt = 0; attempt < 2; ++attempt) {
      // Parts are streamed as MediaMTX sends them (a preload-hinted part arrives while it is being produced).
      ok = HttpStream(
          port, target(), {},
          [&](const HttpResponse& r) {
            upstreamStatus = r.status;
            if (r.status != 200) return false;
            auto type = r.headers.find("content-type");
            std::ostringstream out;
            out << "HTTP/1.1 200 OK\r\nContent-Type: " << (type == r.headers.end() ? "application/octet-stream" : type->second)
                << "\r\nCache-Control: public, max-age=60\r\nConnection: close\r\n" << (head ? "" : "Transfer-Encoding: chunked\r\n")
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
      if (started || upstreamStatus != 401 || attempt) break;
      session = UpstreamHlsSession(port, stream, session);
      if (session.empty()) break;
    }
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
