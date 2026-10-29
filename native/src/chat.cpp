#include "chat.h"

#include "config.h"

#include <bcrypt.h>

#include <algorithm>

namespace fc {

std::string Base64(const std::string& data);  // capture.cpp

namespace {

constexpr size_t kMaxFrame = 16 * 1024;
constexpr size_t kHistory = 200;
constexpr size_t kHistoryOnJoin = 100;
constexpr int kMaxClients = 2000;  // each one holds a viewer-server connection thread (small stack) and a socket

std::string Sha1(const std::string& data) {
  unsigned char digest[20] = {};
  BCryptHash(BCRYPT_SHA1_ALG_HANDLE, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char*>(data.data())), static_cast<ULONG>(data.size()), digest,
             sizeof(digest));
  return std::string(reinterpret_cast<char*>(digest), sizeof(digest));
}

size_t CodePoints(const std::string& s) {
  return static_cast<size_t>(std::count_if(s.begin(), s.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; }));
}

std::wstring Nfc(const std::wstring& in) {
  int n = NormalizeString(NormalizationC, in.c_str(), static_cast<int>(in.size()), nullptr, 0);
  if (n <= 0) return in;
  std::wstring out(static_cast<size_t>(n), L'\0');
  n = NormalizeString(NormalizationC, in.c_str(), static_cast<int>(in.size()), out.data(), n);
  if (n <= 0) return in;
  out.resize(static_cast<size_t>(n));
  return out;
}

std::wstring Lower(const std::wstring& in) {
  std::wstring out(in);
  if (!out.empty()) LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, in.c_str(), static_cast<int>(in.size()), out.data(), static_cast<int>(out.size()), nullptr, nullptr, 0);
  return out;
}

bool SendAll(SOCKET s, const char* data, size_t size) {
  while (size > 0) {
    int n = send(s, data, static_cast<int>(std::min<size_t>(size, 1 << 20)), 0);
    if (n <= 0) return false;
    data += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

bool RecvAll(SOCKET s, char* data, size_t size) {
  while (size > 0) {
    int n = recv(s, data, static_cast<int>(size), 0);
    if (n <= 0) return false;
    data += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

std::string Frame(unsigned char opcode, const std::string& payload) {
  std::string out;
  out += static_cast<char>(0x80 | opcode);
  if (payload.size() < 126) {
    out += static_cast<char>(payload.size());
  } else if (payload.size() < 65536) {
    out += static_cast<char>(126);
    out += static_cast<char>((payload.size() >> 8) & 0xFF);
    out += static_cast<char>(payload.size() & 0xFF);
  } else {
    out += static_cast<char>(127);
    for (int i = 7; i >= 0; --i) out += static_cast<char>((static_cast<uint64_t>(payload.size()) >> (i * 8)) & 0xFF);
  }
  return out + payload;
}

}  // namespace

bool NormaliseChatName(const std::string& input, std::string& name, std::string& error) {
  std::wstring w = Nfc(Wide(input)), collapsed;
  for (wchar_t c : w) {
    if (c < 0x20 || c == 0x7F || (c >= 0x200B && c <= 0x200F) || c == 0x2028 || c == 0x2029 || c == 0xFEFF) {
      if (c == L'\t' || c == L'\n' || c == L'\r') c = L' ';
      else {
        error = "이름에 사용할 수 없는 문자가 있습니다.";
        return false;
      }
    }
    if (iswspace(c)) {
      if (!collapsed.empty() && collapsed.back() != L' ') collapsed += L' ';
    } else {
      collapsed += c;
    }
  }
  while (!collapsed.empty() && collapsed.back() == L' ') collapsed.pop_back();
  name = Utf8(collapsed);
  size_t length = CodePoints(name);
  if (length < 1 || length > 20) {
    error = "1~20자의 이름을 입력하십시오.";
    return false;
  }
  static const wchar_t* reserved[] = {L"시스템", L"관리자", L"system", L"admin", L"administrator"};
  std::wstring lower = Lower(collapsed);
  for (const wchar_t* r : reserved)
    if (lower == r) {
      error = "사용할 수 없는 이름입니다.";
      return false;
    }
  return true;
}

bool NormaliseChatText(const std::string& input, std::string& text, std::string& error) {
  std::wstring w = Nfc(Wide(input)), clean;
  for (wchar_t c : w) {
    if (c == L'\r') continue;
    if ((c < 0x20 && c != L'\n' && c != L'\t') || c == 0x7F) {
      error = "보낼 수 없는 문자가 있습니다.";
      return false;
    }
    clean += c;
  }
  size_t begin = clean.find_first_not_of(L" \t\n"), end = clean.find_last_not_of(L" \t\n");
  clean = begin == std::wstring::npos ? L"" : clean.substr(begin, end - begin + 1);
  text = Utf8(clean);
  size_t length = CodePoints(text);
  if (length < 1) {
    error = "메시지를 입력하십시오.";
    return false;
  }
  if (length > 1000) {
    error = "메시지는 1000자까지 보낼 수 있습니다.";
    return false;
  }
  return true;
}

struct ChatHub::Client {
  SOCKET socket = INVALID_SOCKET;
  std::string peer;
  std::string machine;  // "local" for this PC (loopback or any of its addresses), else the peer address
  std::mutex sendMutex;
  std::string name;
  bool joined = false;
  std::deque<int64_t> recent;  // send times for rate limiting
  std::atomic<bool> open{true};

  bool Send(unsigned char opcode, const std::string& payload) {
    if (!open) return false;
    std::string frame = Frame(opcode, payload);
    std::lock_guard<std::mutex> lock(sendMutex);
    if (!SendAll(socket, frame.data(), frame.size())) {
      open = false;
      return false;
    }
    return true;
  }
  bool SendJson(const json& value) { return Send(0x1, value.dump(-1, ' ', false, json::error_handler_t::replace)); }
  void Close() {
    if (!open.exchange(false)) return;
    std::string frame = Frame(0x8, std::string("\x03\xe8", 2));
    std::lock_guard<std::mutex> lock(sendMutex);
    SendAll(socket, frame.data(), frame.size());
    shutdown(socket, SD_BOTH);
  }
};

ChatHub::ChatHub() : pinger_([this] { PingLoop(); }) {}

ChatHub::~ChatHub() {
  stopping_ = true;
  CloseRoom("프로그램이 종료되었습니다.");
  if (pinger_.joinable()) pinger_.join();
}

void ChatHub::OpenRoom(const std::string& broadcastId) {
  CloseRoom("새 송출이 시작되었습니다.");
  std::lock_guard<std::mutex> lock(mutex_);
  roomId_ = broadcastId;
  history_.clear();
  nextMessage_ = 0;
}

void ChatHub::CloseRoom(const std::string& reason) {
  std::vector<std::shared_ptr<Client>> members;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (roomId_.empty() && clients_.empty()) return;
    members = clients_;
    roomId_.clear();
    history_.clear();
  }
  for (auto& c : members) {
    c->SendJson({{"type", "closed"}, {"reason", reason}});
    c->Close();
  }
}

std::string ChatHub::RoomId() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return roomId_;
}

int ChatHub::ConnectionCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return static_cast<int>(clients_.size());
}

json ChatHub::Stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  int joined = 0;
  for (const auto& c : clients_) joined += c->joined ? 1 : 0;
  return {{"clients", clients_.size()}, {"joined", joined}, {"refused", refused_.load()}};
}

void ChatHub::Broadcast(const json& event) {
  std::vector<std::shared_ptr<Client>> members;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& c : clients_)
      if (c->joined) members.push_back(c);
  }
  for (auto& c : members) c->SendJson(event);
}

bool ChatHub::NameTaken(const std::string& name, const Client* except) const {
  std::wstring wanted = Lower(Wide(name));
  for (const auto& c : clients_)
    // The same PC may hold one name in several panels (the sender's chat and its own viewer) or across a reconnect.
    if (c.get() != except && c->joined && !c->name.empty() && (!except || c->machine != except->machine) && Lower(Wide(c->name)) == wanted) return true;
  return false;
}

void ChatHub::Serve(SOCKET socket, const std::string& key, const std::string& peer) {
  auto client = std::make_shared<Client>();
  client->socket = socket;
  client->peer = peer;
  std::string resolved;
  client->machine = peer.rfind("127.", 0) == 0 || HostIsLocal(peer, resolved) ? "local" : peer;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (static_cast<int>(clients_.size()) >= kMaxClients) {
      std::string busy = "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      SendAll(socket, busy.data(), busy.size());
      ++refused_;
      return;
    }
    clients_.push_back(client);
  }
  std::string accept = Base64(Sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
  std::string response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
  bool ok = SendAll(socket, response.data(), response.size());
  DWORD timeout = 75000;  // pings go out every 25 s; a silent peer is dropped
  setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
  std::string message;
  while (ok && client->open) {
    unsigned char head[2];
    if (!RecvAll(socket, reinterpret_cast<char*>(head), 2)) break;
    bool fin = (head[0] & 0x80) != 0, masked = (head[1] & 0x80) != 0;
    unsigned char opcode = head[0] & 0x0F;
    uint64_t length = head[1] & 0x7F;
    if (length == 126 || length == 127) {
      unsigned char ext[8];
      size_t n = length == 126 ? 2 : 8;
      if (!RecvAll(socket, reinterpret_cast<char*>(ext), n)) break;
      length = 0;
      for (size_t i = 0; i < n; ++i) length = (length << 8) | ext[i];
    }
    if (!masked || length > kMaxFrame || message.size() + length > kMaxFrame) break;  // clients must mask; frames are small
    unsigned char mask[4];
    if (!RecvAll(socket, reinterpret_cast<char*>(mask), 4)) break;
    std::string payload(static_cast<size_t>(length), '\0');
    if (length && !RecvAll(socket, payload.data(), payload.size())) break;
    for (size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(payload[i] ^ mask[i % 4]);
    if (opcode == 0x8) break;
    if (opcode == 0x9) {
      client->Send(0xA, payload);
      continue;
    }
    if (opcode == 0xA) continue;
    if (opcode == 0x1 || opcode == 0x0) {
      message += payload;
      if (fin) {
        HandleText(client, message);
        message.clear();
      }
      continue;
    }
    break;  // binary or unknown opcodes are not part of this protocol
  }
  client->Close();
  std::lock_guard<std::mutex> lock(mutex_);
  clients_.erase(std::remove(clients_.begin(), clients_.end(), client), clients_.end());
}

void ChatHub::HandleText(const std::shared_ptr<Client>& client, const std::string& text) {
  json msg = json::parse(text, nullptr, false);
  if (msg.is_discarded() || !msg.is_object() || !msg.contains("type") || !msg["type"].is_string()) return;
  const std::string type = msg["type"];
  if (type == "join") {
    std::string wanted = msg.value("broadcastId", std::string());
    std::string requestedName = msg.contains("name") && msg["name"].is_string() ? msg["name"].get<std::string>() : std::string();
    json state, history = json::array();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (roomId_.empty() || wanted != roomId_) {
        state = {{"type", "state"}, {"connected", false}, {"canSend", false}, {"broadcastId", wanted}, {"error", "방송이 종료되었거나 다른 방송으로 바뀌었습니다."}};
      } else {
        client->joined = true;
        std::string name, nameError;
        if (!requestedName.empty() && NormaliseChatName(requestedName, name, nameError)) {
          if (NameTaken(name, client.get())) nameError = "이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.";
          else client->name = name;
        }
        state = {{"type", "state"}, {"connected", true}, {"canSend", true}, {"broadcastId", roomId_}, {"displayName", client->name}, {"error", nameError}};
        size_t from = history_.size() > kHistoryOnJoin ? history_.size() - kHistoryOnJoin : 0;
        for (size_t i = from; i < history_.size(); ++i)
          history.push_back({{"id", history_[i].id}, {"broadcastId", roomId_}, {"author", history_[i].author}, {"text", history_[i].text}, {"ts", history_[i].ts}});
      }
    }
    client->SendJson(state);
    if (client->joined) client->SendJson({{"type", "history"}, {"messages", history}});
    else client->Close();
    return;
  }
  if (!client->joined) return;
  if (type == "name") {
    std::string name, error;
    json reply;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!msg.contains("name") || !msg["name"].is_string() || !NormaliseChatName(msg["name"], name, error)) {
        reply = {{"type", "name"}, {"ok", false}, {"displayName", client->name}, {"error", error.empty() ? "이름을 확인하십시오." : error}};
      } else if (NameTaken(name, client.get())) {
        reply = {{"type", "name"}, {"ok", false}, {"displayName", client->name}, {"error", "이미 사용 중인 이름입니다. 다른 이름을 설정하십시오."}};
      } else {
        client->name = name;
        reply = {{"type", "name"}, {"ok", true}, {"displayName", name}};
      }
    }
    client->SendJson(reply);
    return;
  }
  if (type == "send") {
    std::string clientId = msg.contains("clientId") && msg["clientId"].is_string() ? msg["clientId"].get<std::string>().substr(0, 64) : std::string();
    auto nack = [&](const std::string& error) { client->SendJson({{"type", "ack"}, {"clientId", clientId}, {"ok", false}, {"error", error}}); };
    if (client->name.empty()) return nack("이름을 먼저 설정하십시오.");
    std::string body, error;
    if (!msg.contains("text") || !msg["text"].is_string() || !NormaliseChatText(msg["text"], body, error)) return nack(error.empty() ? "메시지를 확인하십시오." : error);
    int64_t now = EpochMillis();
    while (!client->recent.empty() && now - client->recent.front() > 10000) client->recent.pop_front();
    if (client->recent.size() >= 8) return nack("메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내십시오.");
    client->recent.push_back(now);
    json event;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      Message m{roomId_.substr(0, 8) + "-" + std::to_string(++nextMessage_), client->name, body, now};
      history_.push_back(m);
      if (history_.size() > kHistory) history_.pop_front();
      event = {{"type", "message"}, {"id", m.id}, {"broadcastId", roomId_}, {"author", m.author}, {"text", m.text}, {"ts", m.ts}};
    }
    Broadcast(event);
    client->SendJson({{"type", "ack"}, {"clientId", clientId}, {"ok", true}, {"id", event["id"]}});
  }
}

void ChatHub::PingLoop() {
  int ticks = 0;
  while (!stopping_) {
    Sleep(500);
    if (++ticks < 50) continue;
    ticks = 0;
    std::vector<std::shared_ptr<Client>> members;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      members = clients_;
    }
    for (auto& c : members) c->Send(0x9, "");
  }
}

}  // namespace fc
