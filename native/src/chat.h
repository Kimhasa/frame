// Real-time chat for the running broadcast: WebSocket (RFC 6455) on the viewer port, one room per broadcast ID.
// The server owns message IDs, timestamps and display names; client-sent names and IDs are never treated as identity.
#pragma once

#include "common.h"

#include <deque>
#include <map>

namespace fc {

class ChatHub {
 public:
  ChatHub();
  ~ChatHub();
  // Opens the room for a new broadcast (closing any previous one).
  void OpenRoom(const std::string& broadcastId);
  // Closes the room: members are told the broadcast ended and are disconnected; history is discarded.
  void CloseRoom(const std::string& reason);
  std::string RoomId() const;
  // Completes the HTTP upgrade on socket and serves the connection until it closes (runs on the connection thread).
  // key is the Sec-WebSocket-Key header; peer is the client address used for rate limits and logs.
  void Serve(SOCKET socket, const std::string& key, const std::string& peer);
  int ConnectionCount() const;

 private:
  struct Client;
  struct Message {
    std::string id, author, text;
    int64_t ts = 0;
  };
  void Broadcast(const json& event);
  void HandleText(const std::shared_ptr<Client>& client, const std::string& text);
  bool NameTaken(const std::string& name, const Client* except) const;
  void PingLoop();

  mutable std::mutex mutex_;
  std::string roomId_;
  std::deque<Message> history_;
  uint64_t nextMessage_ = 0;
  std::vector<std::shared_ptr<Client>> clients_;
  std::atomic<bool> stopping_{false};
  std::thread pinger_;
};

// Validation shared with tests: returns the normalised name or an error message.
bool NormaliseChatName(const std::string& input, std::string& name, std::string& error);
bool NormaliseChatText(const std::string& input, std::string& text, std::string& error);

}  // namespace fc
