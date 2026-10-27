// Broadcast list shared by all FRAME Console PCs on the internal network (GET /api/broadcasts).
// Each running sender announces itself every 2 s by UDP multicast (same subnet, no setup) and, if configured, by HTTP POST
// to central directory PCs (across subnets). Entries expire 7 s after the last announcement, so a crashed or disconnected
// sender drops out by itself. An entry is accepted only from the IP address its own URLs point to.
#pragma once

#include "common.h"

#include <map>

namespace fc {

struct BroadcastItem {
  std::string id;         // 32 hex characters, new for every broadcast
  std::string title;      // what is being shared (window title or monitor name, or the configured title)
  std::string publisher;  // PC name
  std::string host;       // address viewers use (serverHost)
  int port = 0;           // viewer port
  std::string path;       // stream ID
  int width = 0, height = 0, fps = 0;
  int64_t startedAtMs = 0;
  json ToJson() const;
};

class Directory {
 public:
  Directory();
  ~Directory();
  // multicastPort: UDP port for announcements (0 disables multicast); servers: "host:port" of central directory PCs.
  void Configure(int multicastPort, const std::vector<std::string>& servers);
  void SetLocal(const BroadcastItem* item);  // nullptr when not broadcasting
  json List() const;                          // {"items":[...]} local first, then live remote entries
  // HTTP announcement from another PC (POST /api/broadcasts/announce). Returns false with a reason when rejected.
  bool Accept(const json& message, const std::string& peerIp, std::string& error);
  int RemoteCount() const;

 private:
  bool Store(const json& message, const std::string& peerIp, std::string& error);
  void AnnounceLoop();
  void ListenLoop();
  void SendMulticast(const std::string& payload);
  void OpenSockets();
  void CloseSockets();

  mutable std::mutex mutex_;
  std::unique_ptr<BroadcastItem> local_;
  struct Remote {
    json item;
    int64_t expiresAt = 0;
  };
  std::map<std::string, Remote> remote_;  // by broadcast id
  int multicastPort_ = 0;
  std::vector<std::string> servers_;
  SOCKET listen_ = INVALID_SOCKET;
  std::atomic<bool> stopping_{false};
  std::thread announcer_, listener_;
  std::atomic<int> generation_{0};
};

bool ValidBroadcastId(const std::string& id);

}  // namespace fc
