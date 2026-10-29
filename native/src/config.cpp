#include "config.h"

#include <iphlpapi.h>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <regex>
#include <sstream>

namespace fc {

const std::vector<Resolution>& Resolutions() {
  static const std::vector<Resolution> list = {
      {"426x240", "240p", 426, 240, 0.5},     {"640x360", "360p", 640, 360, 1},       {"854x480", "480p", 854, 480, 2},
      {"1280x720", "720p", 1280, 720, 4},     {"1920x1080", "1080p", 1920, 1080, 8}, {"2560x1440", "1440p", 2560, 1440, 16},
      {"3840x2160", "2160p", 3840, 2160, 35},
  };
  return list;
}

const Resolution* FindResolution(const std::string& value) {
  for (const auto& r : Resolutions())
    if (value == r.value) return &r;
  return nullptr;
}

fs::path ConfigPath() { return ExeDir() / L"config" / L"frame-console.json"; }

// Automatic bitrate (also used as the cap in VBR mode). Same formula as the UI's automatic value.
// 0.07 bit per pixel at 60 fps fits desktop content (text, UI, video areas) at good quality with NVENC/QSV/AMF; per-frame
// differences shrink as the frame rate rises, so the rate grows with fps^0.75 rather than linearly; x264 needs about 15 % less.
double AutoBitrateMbps(int width, int height, int fps, const std::string& encoder) {
  double f = fps >= 30 ? fps : 60;
  double factor = encoder == "libx264" ? 0.85 : 1.0;
  double mbps = 0.07 * width * height * 60.0 * std::pow(f / 60.0, 0.75) * factor / 1e6;
  return std::min(200.0, std::max(0.5, std::round(mbps * 2) / 2));
}

double AutoBitrateMbps(const std::string& resolution, int fps) {
  const Resolution* r = FindResolution(resolution);
  return AutoBitrateMbps(r ? r->width : 1920, r ? r->height : 1080, fps, "");
}

bool ValidHost(const std::string& host) {
  if (host.empty() || host.size() > 253) return false;
  static const std::regex ipv4(R"(^(\d+)\.(\d+)\.(\d+)\.(\d+)$)");
  std::smatch m;
  if (std::regex_match(host, m, ipv4)) {
    for (int i = 1; i <= 4; ++i)
      if (m[i].str().size() > 3 || std::stoi(m[i].str()) > 255) return false;
    return true;
  }
  static const std::regex name(R"(^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$)");
  return std::regex_match(host, name);
}

bool ValidStreamPath(const std::string& path) {
  static const std::regex re(R"(^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$)");
  return std::regex_match(path, re);
}

bool ValidPort(int port) { return port >= 1 && port <= 65535; }

json SettingsToJson(const Settings& s) {
  return {{"serverHost", s.serverHost}, {"streamPath", s.streamPath},     {"publishPort", s.publishPort},
          {"viewerPort", s.viewerPort}, {"iceUdpPort", s.iceUdpPort},     {"iceTcpPort", s.iceTcpPort},
          {"resolution", s.resolution}, {"fps", s.fps},                   {"bitrateAuto", s.bitrateAuto},
          {"bitrateMbps", s.bitrateMbps}, {"audio", s.audio},             {"systemVolume", s.systemVolume},
          {"micVolume", s.micVolume},   {"audioBitrateKbps", s.audioBitrateKbps}, {"encoder", s.encoder},
          {"renditions", s.renditions}, {"captureCursor", s.captureCursor}, {"iceServers", s.iceServers},
          {"broadcastTitle", s.broadcastTitle}, {"publisherName", s.publisherName}, {"discoveryPort", s.discoveryPort},
          {"directoryServers", s.directoryServers}, {"recordEnabled", s.recordEnabled}, {"recordDir", s.recordDir}, {"recordMaxGB", s.recordMaxGB},
          {"recordMinFreeGB", s.recordMinFreeGB}, {"recordKeepDays", s.recordKeepDays}, {"rateControl", s.rateControl},
          {"publicUrl", s.publicUrl}, {"iceHosts", s.iceHosts}, {"relayPublishUrl", s.relayPublishUrl}, {"relayApiUrl", s.relayApiUrl},
          {"relayCaFile", s.relayCaFile},
          {"windowPreview", {{"firstFrameMs", s.windowPreview.firstFrameMs}, {"attempts", s.windowPreview.attempts},
                             {"retryDelaysMs", s.windowPreview.retryDelaysMs}, {"deadlineMs", s.windowPreview.deadlineMs},
                             {"concurrency", s.windowPreview.concurrency}, {"cacheMs", s.windowPreview.cacheMs}}}};
}

template <typename T>
static void Read(const json& j, const char* key, T& out) {
  auto it = j.find(key);
  if (it == j.end()) return;
  try {
    out = it->get<T>();
  } catch (...) {
  }
}

Settings LoadSettings(std::string* warning) {
  Settings s;
  std::ifstream in(ConfigPath(), std::ios::binary);
  if (!in) {
    if (warning) *warning = "설정 파일이 없어 기본값을 사용합니다.";
    return s;
  }
  std::stringstream buffer;
  buffer << in.rdbuf();
  json j = json::parse(buffer.str(), nullptr, false, true);
  if (j.is_discarded() || !j.is_object()) {
    if (warning) *warning = "설정 파일을 읽을 수 없어 기본값을 사용합니다.";
    return s;
  }
  Settings d;
  Read(j, "serverHost", s.serverHost);
  Read(j, "streamPath", s.streamPath);
  Read(j, "publishPort", s.publishPort);
  Read(j, "viewerPort", s.viewerPort);
  Read(j, "iceUdpPort", s.iceUdpPort);
  Read(j, "iceTcpPort", s.iceTcpPort);
  Read(j, "resolution", s.resolution);
  Read(j, "fps", s.fps);
  Read(j, "bitrateAuto", s.bitrateAuto);
  Read(j, "bitrateMbps", s.bitrateMbps);
  Read(j, "audio", s.audio);
  Read(j, "systemVolume", s.systemVolume);
  Read(j, "micVolume", s.micVolume);
  Read(j, "audioBitrateKbps", s.audioBitrateKbps);
  Read(j, "encoder", s.encoder);
  Read(j, "renditions", s.renditions);
  Read(j, "captureCursor", s.captureCursor);
  Read(j, "broadcastTitle", s.broadcastTitle);
  Read(j, "publisherName", s.publisherName);
  Read(j, "discoveryPort", s.discoveryPort);
  if (j.contains("directoryServers") && j["directoryServers"].is_array()) s.directoryServers = j["directoryServers"];
  Read(j, "recordEnabled", s.recordEnabled);
  Read(j, "recordDir", s.recordDir);
  Read(j, "recordMaxGB", s.recordMaxGB);
  Read(j, "recordMinFreeGB", s.recordMinFreeGB);
  Read(j, "recordKeepDays", s.recordKeepDays);
  Read(j, "rateControl", s.rateControl);
  Read(j, "publicUrl", s.publicUrl);
  Read(j, "relayPublishUrl", s.relayPublishUrl);
  Read(j, "relayApiUrl", s.relayApiUrl);
  Read(j, "relayCaFile", s.relayCaFile);
  if (j.contains("windowPreview") && j["windowPreview"].is_object()) {
    const json& p = j["windowPreview"];
    WindowPreviewSettings& w = s.windowPreview;
    Read(p, "firstFrameMs", w.firstFrameMs);
    Read(p, "attempts", w.attempts);
    Read(p, "retryDelaysMs", w.retryDelaysMs);
    Read(p, "deadlineMs", w.deadlineMs);
    Read(p, "concurrency", w.concurrency);
    Read(p, "cacheMs", w.cacheMs);
    w.firstFrameMs = std::clamp(w.firstFrameMs, 100, 10000);
    w.attempts = std::clamp(w.attempts, 1, 5);
    if (w.retryDelaysMs.empty() || w.retryDelaysMs.size() > 4) w.retryDelaysMs = d.windowPreview.retryDelaysMs;
    for (int& delay : w.retryDelaysMs) delay = std::clamp(delay, 0, 5000);
    w.deadlineMs = std::clamp(w.deadlineMs, 500, 30000);
    w.concurrency = std::clamp(w.concurrency, 1, 4);
    w.cacheMs = std::clamp(w.cacheMs, 0, 600000);
  }
  if (j.contains("iceHosts") && j["iceHosts"].is_array()) s.iceHosts = j["iceHosts"];
  if (j.contains("iceServers") && j["iceServers"].is_array()) s.iceServers = j["iceServers"];
  // Invalid values in the file fall back to defaults instead of reaching the encoder or the server.
  if (s.serverHost != "auto" && !ValidHost(s.serverHost)) s.serverHost = d.serverHost;
  if (!ValidStreamPath(s.streamPath)) s.streamPath = d.streamPath;
  for (int* port : {&s.publishPort, &s.viewerPort, &s.iceUdpPort})
    if (!ValidPort(*port)) *port = 0;
  if (!s.publishPort) s.publishPort = d.publishPort;
  if (!s.viewerPort) s.viewerPort = d.viewerPort;
  if (!s.iceUdpPort) s.iceUdpPort = d.iceUdpPort;
  if (s.iceTcpPort != 0 && !ValidPort(s.iceTcpPort)) s.iceTcpPort = d.iceTcpPort;
  if (!FindResolution(s.resolution)) s.resolution = d.resolution;
  if (s.fps < 30 || s.fps > 165) s.fps = d.fps;
  if (!(s.bitrateMbps >= 0.5 && s.bitrateMbps <= 200)) s.bitrateMbps = d.bitrateMbps;
  if (s.audio != "none" && s.audio != "system" && s.audio != "mic" && s.audio != "mix") s.audio = d.audio;
  s.systemVolume = std::clamp(s.systemVolume, 0, 100);
  s.micVolume = std::clamp(s.micVolume, 0, 100);
  s.audioBitrateKbps = std::clamp(s.audioBitrateKbps, 32, 510);
  static const char* encoders[] = {"auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"};
  if (std::none_of(std::begin(encoders), std::end(encoders), [&](const char* e) { return s.encoder == e; })) s.encoder = d.encoder;
  if (s.broadcastTitle.size() > 120) s.broadcastTitle.resize(120);
  if (s.publisherName.size() > 60) s.publisherName.resize(60);
  if (s.discoveryPort != 0 && !ValidPort(s.discoveryPort)) s.discoveryPort = d.discoveryPort;
  json servers = json::array();
  static const std::regex server(R"(^[A-Za-z0-9.-]{1,253}:\d{1,5}$)");
  for (const auto& entry : s.directoryServers)
    if (entry.is_string() && std::regex_match(entry.get<std::string>(), server)) servers.push_back(entry);
  s.directoryServers = servers;
  if (!(s.recordMaxGB >= 1)) s.recordMaxGB = d.recordMaxGB;
  if (!(s.recordMinFreeGB >= 0.5)) s.recordMinFreeGB = d.recordMinFreeGB;
  if (s.recordKeepDays < 0) s.recordKeepDays = d.recordKeepDays;
  if (s.rateControl != "vbr" && s.rateControl != "cbr") s.rateControl = d.rateControl;
  static const std::regex web(R"(^https?://[A-Za-z0-9.-]{1,253}(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$)");
  static const std::regex relay(R"(^rtsps?://[A-Za-z0-9.-]{1,253}(:\d{1,5})?(/[A-Za-z0-9._~/-]{0,128})?$)");
  while (!s.publicUrl.empty() && s.publicUrl.back() == '/') s.publicUrl.pop_back();
  while (!s.relayApiUrl.empty() && s.relayApiUrl.back() == '/') s.relayApiUrl.pop_back();
  if (!s.publicUrl.empty() && !std::regex_match(s.publicUrl, web)) s.publicUrl.clear();
  if (!s.relayApiUrl.empty() && !std::regex_match(s.relayApiUrl, web)) s.relayApiUrl.clear();
  if (!s.relayPublishUrl.empty() && !std::regex_match(s.relayPublishUrl, relay)) s.relayPublishUrl.clear();
  while (!s.relayPublishUrl.empty() && s.relayPublishUrl.back() == '/') s.relayPublishUrl.pop_back();
  if (s.relayCaFile.size() > 260) s.relayCaFile.clear();
  json hosts = json::array();
  for (const auto& entry : s.iceHosts)
    if (entry.is_string() && ValidHost(entry.get<std::string>()) && hosts.size() < 8) hosts.push_back(entry);
  s.iceHosts = hosts;
  return s;
}

Secrets LoadSecrets() {
  Secrets out;
  std::ifstream in(ConfigPath().parent_path() / L"frame-console.secrets.json", std::ios::binary);
  if (!in) return out;
  json j = json::parse(in, nullptr, false);
  if (!j.is_object()) return out;
  Read(j, "relayUser", out.relayUser);
  Read(j, "relayPassword", out.relayPassword);
  Read(j, "relayToken", out.relayToken);
  return out;
}

bool SaveSettings(const Settings& s, std::string* error) {
  std::error_code ec;
  fs::create_directories(ConfigPath().parent_path(), ec);
  fs::path temp = ConfigPath();
  temp += L".tmp";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    if (!out) {
      if (error) *error = "설정 파일을 저장할 수 없습니다: " + Utf8(ConfigPath().wstring());
      return false;
    }
    out << SettingsToJson(s).dump(2) << "\n";
  }
  if (!MoveFileExW(temp.c_str(), ConfigPath().c_str(), MOVEFILE_REPLACE_EXISTING)) {
    if (error) *error = "설정 파일을 저장할 수 없습니다: " + LastErrorMessage();
    return false;
  }
  return true;
}

bool ApplyStartRequest(const json& r, Settings& s, std::string& field, std::string& error) {
  auto str = [&](const char* key) -> std::string { return r.contains(key) && r[key].is_string() ? r[key].get<std::string>() : std::string(); };
  auto num = [&](const char* key, double fallback) -> double { return r.contains(key) && r[key].is_number() ? r[key].get<double>() : fallback; };
  auto Fail = [&](const char* f, const std::string& e) {
    field = f;
    error = e;
    return false;
  };
  Settings next = s;
  next.serverHost = str("host");
  next.streamPath = str("path");
  next.resolution = str("resolution");
  double fps = num("fps", -1);
  double bitrate = num("bitrate", -1);
  next.bitrateAuto = r.contains("bitrateAuto") && r["bitrateAuto"].is_boolean() ? r["bitrateAuto"].get<bool>() : true;
  next.audio = str("audio");
  double publishPort = num("publishPort", -1), viewerPort = num("viewerPort", -1);
  next.systemVolume = std::clamp(static_cast<int>(num("systemVolume", s.systemVolume)), 0, 100);
  next.micVolume = std::clamp(static_cast<int>(num("micVolume", s.micVolume)), 0, 100);

  if (!ValidHost(next.serverHost)) return Fail("server-host", "올바른 IP 주소나 호스트 이름을 입력하세요.");
  if (!ValidStreamPath(next.streamPath)) return Fail("stream-path", "영문, 숫자, 하이픈, 밑줄로 1~64자 입력하세요.");
  if (!FindResolution(next.resolution)) return Fail("resolution", "지원하지 않는 화질입니다.");
  if (fps != std::floor(fps) || fps < 30 || fps > 165) return Fail("custom-fps", "30~165 사이의 정수로 입력하세요.");
  next.fps = static_cast<int>(fps);
  if (next.bitrateAuto) bitrate = AutoBitrateMbps(next.resolution, next.fps);
  if (!(bitrate >= 0.5 && bitrate <= 200)) return Fail("quality", "0.5~200 Mbps 사이로 입력하세요.");
  next.bitrateMbps = bitrate;
  if (next.audio != "none" && next.audio != "system" && next.audio != "mic" && next.audio != "mix")
    return Fail("audio-source", "지원하지 않는 오디오 설정입니다.");
  if (publishPort != std::floor(publishPort) || viewerPort != std::floor(viewerPort) || !ValidPort(static_cast<int>(publishPort)) ||
      !ValidPort(static_cast<int>(viewerPort)))
    return Fail("publish-port", "포트는 1~65535 사이의 정수로 입력하세요.");
  next.publishPort = static_cast<int>(publishPort);
  next.viewerPort = static_cast<int>(viewerPort);
  if (next.publishPort == next.viewerPort) return Fail("publish-port", "송출 포트와 시청 포트는 서로 달라야 합니다.");
  if (next.iceTcpPort && (next.iceTcpPort == next.viewerPort || next.iceTcpPort == next.publishPort))
    return Fail("publish-port", Printf("포트 %d은(는) WebRTC 연결에 사용 중입니다. 다른 포트를 입력하세요.", next.iceTcpPort));
  s = next;
  return true;
}

std::vector<LocalAddress> LocalIPv4Addresses() {
  std::vector<LocalAddress> out;
  ULONG size = 16 * 1024;
  std::vector<unsigned char> buffer(size);
  ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_INCLUDE_GATEWAYS;
  ULONG rc = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
  if (rc == ERROR_BUFFER_OVERFLOW) {
    buffer.resize(size);
    rc = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
  }
  if (rc != NO_ERROR) return out;
  for (auto* a = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()); a; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
    for (auto* u = a->FirstUnicastAddress; u; u = u->Next) {
      auto* sin = reinterpret_cast<sockaddr_in*>(u->Address.lpSockaddr);
      char text[INET_ADDRSTRLEN] = {};
      inet_ntop(AF_INET, &sin->sin_addr, text, sizeof(text));
      out.push_back({text, Utf8(a->FriendlyName ? a->FriendlyName : L""), a->FirstGatewayAddress != nullptr});
    }
  }
  return out;
}

static int AddressRank(const LocalAddress& a) {
  unsigned b1 = 0, b2 = 0;
  sscanf_s(a.ip.c_str(), "%u.%u", &b1, &b2);
  if (b1 == 169 && b2 == 254) return 0;           // link-local, never reachable through a router
  if (b1 == 100 && b2 >= 64 && b2 <= 127) return 1;  // carrier-grade NAT / overlay VPN
  bool privateRange = b1 == 10 || (b1 == 172 && b2 >= 16 && b2 <= 31) || (b1 == 192 && b2 == 168);
  return (privateRange ? 4 : 2) + (a.hasGateway ? 2 : 0);
}

std::string PreferredLanAddress() {
  auto list = LocalIPv4Addresses();
  std::stable_sort(list.begin(), list.end(), [](const LocalAddress& x, const LocalAddress& y) { return AddressRank(x) > AddressRank(y); });
  return list.empty() ? "127.0.0.1" : list.front().ip;
}

bool HostIsLocal(const std::string& host, std::string& resolved) {
  addrinfo hints{};
  hints.ai_family = AF_INET;
  addrinfo* result = nullptr;
  if (getaddrinfo(host.c_str(), nullptr, &hints, &result) != 0) return false;
  auto locals = LocalIPv4Addresses();
  bool found = false;
  for (auto* p = result; p && !found; p = p->ai_next) {
    char text[INET_ADDRSTRLEN] = {};
    inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(p->ai_addr)->sin_addr, text, sizeof(text));
    std::string ip = text;
    if (ip.rfind("127.", 0) == 0) found = true;
    for (const auto& l : locals)
      if (l.ip == ip) found = true;
    if (found) resolved = ip;
  }
  freeaddrinfo(result);
  return found;
}

}  // namespace fc
