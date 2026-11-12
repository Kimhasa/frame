// LAN-facing HTTP server on the viewer port: the approved UI (list and viewer) and its scripts, the broadcast list and
// announcements from other FRAME PCs, list thumbnails, read-only stream info, LL-HLS (the multivariant live.m3u8 and the
// forwarded MediaMTX playlists and parts), HLS viewer sessions (counting), WHEP (WebRTC playback) forwarding to the
// loopback-only MediaMTX, the recorded broadcast (dvr.m3u8, read-only recording files, the older DVR index and chunks)
// and the chat WebSocket. It exposes no sender controls and no MediaMTX management API.
#pragma once

#include "common.h"

#include <map>

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

  json Stats() const;  // connection threads, ordinary requests in progress, requests refused with 503

 private:
  struct Connection {
    HttpServer* server;
    SOCKET socket;
    std::string peer;
  };
  static DWORD WINAPI ConnectionThread(void* param);
  void AcceptLoop();
  void Handle(SOCKET client, std::string peer);
  void RecordViewerStats(const std::string& path, const std::string& body, const std::string& peer);
  // MediaMTX HLS session shared by all viewers of one stream/quality (made by requesting its index.m3u8); stale names a
  // session MediaMTX no longer knows, which is replaced. Empty when MediaMTX could not make one.
  std::string UpstreamHlsSession(int port, const std::string& stream, const std::string& stale);

  Streamer& streamer_;
  Directory& directory_;
  ChatHub& chat_;
  SOCKET listener_ = INVALID_SOCKET;
  int port_ = 0;
  std::thread acceptThread_;
  std::atomic<int> active_{0}, requests_{0}, refused_{0};
  std::mutex statsMutex_;
  std::map<std::string, int64_t> statsLast_;
  std::mutex hlsSessionMutex_;
  std::map<std::string, std::string> hlsSessions_;                   // "<port>|<stream>" -> MediaMTX HLS session id
  std::map<std::string, std::shared_ptr<std::mutex>> hlsRefresh_;   // one session request at a time per stream
  std::atomic<bool> stopping_{false};
};

}  // namespace fc
