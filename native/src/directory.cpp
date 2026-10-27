#include "directory.h"

#include <algorithm>
#include <map>
#include <regex>

#include "config.h"
#include "http_client.h"

namespace fc {

namespace {
constexpr const char* kGroup = "239.255.42.99";  // administratively scoped (organisation-local) multicast
constexpr int64_t kTtlMs = 7000;
constexpr size_t kMaxRemote = 256;
}  // namespace

bool ValidBroadcastId(const std::string& id) {
  static const std::regex re(R"(^[0-9a-f]{32}$)");
  return std::regex_match(id, re);
}

json BroadcastItem::ToJson() const {
  std::string base = "http://" + host + ":" + std::to_string(port);
  return {{"id", id}, {"title", title}, {"publisher", publisher}, {"baseUrl", base}, {"path", path}, {"thumbnailUrl", base + "/thumbnails/" + id + ".jpg"},
          {"width", width}, {"height", height}, {"fps", fps}, {"running", true}, {"startedAtMs", startedAtMs}};
}

Directory::Directory() {
  announcer_ = std::thread([this] { AnnounceLoop(); });
  listener_ = std::thread([this] { ListenLoop(); });
}

Directory::~Directory() {
  SetLocal(nullptr);
  stopping_ = true;
  if (announcer_.joinable()) announcer_.join();
  if (listener_.joinable()) listener_.join();
  CloseSockets();
}

void Directory::Configure(int multicastPort, const std::vector<std::string>& servers) {
  std::lock_guard<std::mutex> lock(mutex_);
  multicastPort_ = multicastPort;
  servers_ = servers;
  ++generation_;  // the listener reopens its socket
}

void Directory::SetLocal(const BroadcastItem* item) {
  std::string byeId;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!item && local_) byeId = local_->id;
    local_ = item ? std::make_unique<BroadcastItem>(*item) : nullptr;
  }
  if (byeId.empty()) return;
  json bye = {{"v", 1}, {"type", "bye"}, {"id", byeId}};
  SendMulticast(bye.dump());
  std::vector<std::string> servers;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    servers = servers_;
  }
  for (const auto& s : servers) {
    size_t colon = s.rfind(':');
    if (colon == std::string::npos) continue;
    HttpResponse r;
    HttpRequestHost(s.substr(0, colon), atoi(s.substr(colon + 1).c_str()), "POST", "/api/broadcasts/announce", bye.dump(),
                    {{"Content-Type", "application/json"}}, r, 1500);
  }
}

json Directory::List() const {
  std::lock_guard<std::mutex> lock(mutex_);
  json items = json::array();
  if (local_) items.push_back(local_->ToJson());
  int64_t now = EpochMillis();
  for (const auto& [id, r] : remote_)
    if (r.expiresAt > now && (!local_ || id != local_->id)) items.push_back(r.item);
  return {{"items", items}};
}

int Directory::RemoteCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  int64_t now = EpochMillis();
  return static_cast<int>(std::count_if(remote_.begin(), remote_.end(), [&](const auto& e) { return e.second.expiresAt > now; }));
}

bool Directory::Accept(const json& message, const std::string& peerIp, std::string& error) { return Store(message, peerIp, error); }

bool Directory::Store(const json& message, const std::string& peerIp, std::string& error) {
  if (!message.is_object() || message.value("v", 0) != 1) return error = "unsupported message", false;
  std::string type = message.value("type", "");
  if (type == "bye") {
    std::string id = message.value("id", "");
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = remote_.find(id);
    // Only the PC that announced a broadcast may withdraw it.
    if (it != remote_.end() && it->second.item.value("baseUrl", "").find("//" + peerIp + ":") != std::string::npos) remote_.erase(it);
    return true;
  }
  if (type != "announce" || !message.contains("item") || !message["item"].is_object()) return error = "unsupported message", false;
  const json& in = message["item"];
  BroadcastItem item;
  item.id = in.value("id", "");
  item.title = in.value("title", "");
  item.publisher = in.value("publisher", "");
  item.host = in.value("host", "");
  item.port = in.value("port", 0);
  item.path = in.value("path", "");
  item.width = in.value("width", 0);
  item.height = in.value("height", 0);
  item.fps = in.value("fps", 0);
  item.startedAtMs = in.value("startedAtMs", static_cast<int64_t>(0));
  if (!ValidBroadcastId(item.id) || !ValidStreamPath(item.path) || !ValidHost(item.host) || !ValidPort(item.port)) return error = "invalid broadcast", false;
  if (item.title.empty() || item.title.size() > 200 || item.publisher.size() > 100) return error = "invalid title", false;
  if (item.width < 0 || item.width > 8192 || item.height < 0 || item.height > 8192 || item.fps < 0 || item.fps > 240) return error = "invalid format", false;
  {
    // This PC's own announcement, looped back on another interface (VPN, second adapter): nothing to store.
    std::lock_guard<std::mutex> lock(mutex_);
    if (local_ && local_->id == item.id) return true;
  }
  // The advertised host must be the sender itself, so a PC cannot list streams on behalf of another address.
  bool sameHost = item.host == peerIp;
  if (!sameHost) {
    addrinfo hints{};
    hints.ai_family = AF_INET;
    addrinfo* result = nullptr;
    if (getaddrinfo(item.host.c_str(), nullptr, &hints, &result) == 0) {
      for (auto* p = result; p && !sameHost; p = p->ai_next) {
        char text[INET_ADDRSTRLEN] = {};
        inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(p->ai_addr)->sin_addr, text, sizeof(text));
        sameHost = peerIp == text;
      }
      freeaddrinfo(result);
    }
  }
  if (!sameHost) return error = "announcement does not come from the advertised host", false;
  std::lock_guard<std::mutex> lock(mutex_);
  if (local_ && local_->id == item.id) return true;
  int64_t now = EpochMillis();
  for (auto it = remote_.begin(); it != remote_.end();) it = it->second.expiresAt <= now ? remote_.erase(it) : std::next(it);
  if (!remote_.count(item.id) && remote_.size() >= kMaxRemote) return error = "directory full", false;
  remote_[item.id] = {item.ToJson(), now + kTtlMs};
  return true;
}

void Directory::SendMulticast(const std::string& payload) {
  int port;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    port = multicastPort_;
  }
  if (!port) return;
  sockaddr_in to{};
  to.sin_family = AF_INET;
  to.sin_port = htons(static_cast<u_short>(port));
  inet_pton(AF_INET, kGroup, &to.sin_addr);
  // Send on every LAN interface so each subnet the PC is attached to hears it.
  for (const auto& a : LocalIPv4Addresses()) {
    if (a.ip.rfind("169.254.", 0) == 0) continue;
    SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) continue;
    in_addr iface{};
    inet_pton(AF_INET, a.ip.c_str(), &iface);
    DWORD ttl = 1;
    setsockopt(s, IPPROTO_IP, IP_MULTICAST_IF, reinterpret_cast<const char*>(&iface), sizeof(iface));
    setsockopt(s, IPPROTO_IP, IP_MULTICAST_TTL, reinterpret_cast<const char*>(&ttl), sizeof(ttl));
    sendto(s, payload.data(), static_cast<int>(payload.size()), 0, reinterpret_cast<sockaddr*>(&to), sizeof(to));
    closesocket(s);
  }
}

void Directory::AnnounceLoop() {
  while (!stopping_) {
    json message;
    std::vector<std::string> servers;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (local_) {
        const auto& l = *local_;
        message = {{"v", 1},
                   {"type", "announce"},
                   {"item", {{"id", l.id}, {"title", l.title}, {"publisher", l.publisher}, {"host", l.host}, {"port", l.port}, {"path", l.path},
                             {"width", l.width}, {"height", l.height}, {"fps", l.fps}, {"startedAtMs", l.startedAtMs}}}};
        servers = servers_;
      }
    }
    if (!message.is_null()) {
      std::string payload = message.dump();
      SendMulticast(payload);
      for (const auto& s : servers) {
        size_t colon = s.rfind(':');
        if (colon == std::string::npos) continue;
        HttpResponse r;
        std::string error;
        if (!HttpRequestHost(s.substr(0, colon), atoi(s.substr(colon + 1).c_str()), "POST", "/api/broadcasts/announce", payload,
                             {{"Content-Type", "application/json"}}, r, 1500, &error) || r.status != 204)
          LogFile("directory", "announce to " + s + " failed: " + (error.empty() ? std::to_string(r.status) + " " + r.body.substr(0, 120) : error));
      }
    }
    for (int i = 0; i < 20 && !stopping_; ++i) Sleep(100);
  }
}

void Directory::CloseSockets() {
  if (listen_ != INVALID_SOCKET) closesocket(listen_);
  listen_ = INVALID_SOCKET;
}

void Directory::OpenSockets() {
  CloseSockets();
  int port;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    port = multicastPort_;
  }
  if (!port) return;
  SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == INVALID_SOCKET) return;
  BOOL reuse = TRUE;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    LogFile("directory", Printf("cannot bind UDP %d for broadcast discovery (%d)", port, WSAGetLastError()));
    closesocket(s);
    return;
  }
  for (const auto& a : LocalIPv4Addresses()) {
    if (a.ip.rfind("169.254.", 0) == 0) continue;
    ip_mreq m{};
    inet_pton(AF_INET, kGroup, &m.imr_multiaddr);
    inet_pton(AF_INET, a.ip.c_str(), &m.imr_interface);
    setsockopt(s, IPPROTO_IP, IP_ADD_MEMBERSHIP, reinterpret_cast<const char*>(&m), sizeof(m));
  }
  listen_ = s;
  LogFile("directory", Printf("listening for broadcast announcements on %s:%d", kGroup, port));
}

void Directory::ListenLoop() {
  int seen = -1;
  char buffer[4096];
  while (!stopping_) {
    if (seen != generation_) {
      seen = generation_;
      OpenSockets();
    }
    if (listen_ == INVALID_SOCKET) {
      Sleep(200);
      continue;
    }
    fd_set set;
    FD_ZERO(&set);
    FD_SET(listen_, &set);
    timeval tv{0, 300000};
    if (select(0, &set, nullptr, nullptr, &tv) <= 0) continue;
    sockaddr_in from{};
    int len = sizeof(from);
    int n = recvfrom(listen_, buffer, sizeof(buffer), 0, reinterpret_cast<sockaddr*>(&from), &len);
    if (n <= 0) continue;
    char ip[INET_ADDRSTRLEN] = {};
    inet_ntop(AF_INET, &from.sin_addr, ip, sizeof(ip));
    json message = json::parse(std::string(buffer, static_cast<size_t>(n)), nullptr, false);
    std::string error;
    if (!message.is_discarded() && !Store(message, ip, error) && !error.empty()) {
      // Announcements repeat every 2 s; log each sender's rejection reason once a minute.
      static std::map<std::string, int64_t> lastLogged;
      int64_t now = EpochMillis();
      int64_t& last = lastLogged[std::string(ip) + " " + error];
      if (now - last > 60000) {
        last = now;
        LogFile("directory", std::string("ignored announcement from ") + ip + ": " + error);
      }
      if (lastLogged.size() > 256) lastLogged.clear();
    }
  }
}

}  // namespace fc
