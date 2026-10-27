// LAN-facing HTTP server on the viewer port: the approved UI (list and viewer), the broadcast list and announcements from
// other FRAME PCs, list thumbnails, read-only stream info, WHEP (WebRTC playback) forwarding to the loopback-only MediaMTX,
// recorded-media (DVR) forwarding and the chat WebSocket. It exposes no sender controls and no MediaMTX management API.
#pragma once

#include "common.h"

namespace fc {

class Streamer;
class Directory;
class ChatHub;

class HttpServer {
 public:
  HttpServer(Streamer& streamer, Directory& directory, ChatHub& chat) : streamer_(streamer), directory_(directory), chat_(chat) {}
  ~HttpServer() { Stop(); }
  bool Start(int port, std::string& error);
  void Stop();
  int Port() const { return port_; }
  bool Listening() const { return listener_ != INVALID_SOCKET; }

 private:
  void AcceptLoop();
  void Handle(SOCKET client, std::string peer);

  Streamer& streamer_;
  Directory& directory_;
  ChatHub& chat_;
  SOCKET listener_ = INVALID_SOCKET;
  int port_ = 0;
  std::thread acceptThread_;
  std::atomic<int> active_{0};
  std::atomic<bool> stopping_{false};
};

}  // namespace fc
