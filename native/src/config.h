// Settings file (config/frame-console.json) and validation of values that arrive from the UI.
#pragma once

#include "common.h"

namespace fc {

struct Resolution {
  const char* value;
  const char* label;
  int width;
  int height;
  double baseMbps;
};

const std::vector<Resolution>& Resolutions();
const Resolution* FindResolution(const std::string& value);

struct Settings {
  std::string serverHost = "auto";  // "auto" picks the primary LAN IPv4 address at launch.
  std::string streamPath = "screen-01";
  int publishPort = 8554;   // RTSP port that FFmpeg publishes to (loopback only).
  int viewerPort = 8889;    // HTTP port that serves the viewer UI and WHEP to the LAN.
  int iceUdpPort = 8189;    // WebRTC media (UDP) reachable from the LAN.
  int iceTcpPort = 8189;    // WebRTC media fallback over TCP; 0 disables.
  std::string resolution = "1920x1080";
  int fps = 60;
  bool bitrateAuto = true;
  double bitrateMbps = 8;
  std::string audio = "none";
  int systemVolume = 80;
  int micVolume = 100;
  int audioBitrateKbps = 128;
  std::string encoder = "auto";  // auto | h264_nvenc | h264_qsv | h264_amf | libx264
  bool renditions = true;        // lower playback qualities encoded on demand
  bool captureCursor = true;
  json iceServers = json::array();  // optional internal STUN/TURN, e.g. [{"urls":"turn:10.0.0.5:3478","username":"u","credential":"p"}]
  // Broadcast list
  std::string broadcastTitle;       // empty: the shared window title or monitor name
  std::string publisherName;        // empty: this PC's computer name
  int discoveryPort = 8899;         // UDP multicast announcements in the same subnet; 0 disables
  json directoryServers = json::array();  // ["10.0.0.5:8889"]: central FRAME Console PCs that collect announcements across subnets
  // Full-broadcast recording (DVR); stored as received, without re-encoding
  bool recordEnabled = true;
  std::string recordDir;            // empty: the "recordings" folder in the data folder (next to the exe or under %LOCALAPPDATA%)
  double recordMaxGB = 200;         // total size of all recordings; the oldest finished broadcasts are removed first
  double recordMinFreeGB = 5;       // stop recording (live continues) when the disk has less free space than this
  int recordKeepDays = 7;           // finished broadcasts older than this are deleted at start-up; 0 keeps them
  std::string rateControl = "vbr"; // vbr: quality-capped variable bitrate (bitrate is the cap); cbr: constant bitrate
};

fs::path ConfigPath();
Settings LoadSettings(std::string* warning);
bool SaveSettings(const Settings& settings, std::string* error);
json SettingsToJson(const Settings& settings);

double AutoBitrateMbps(int width, int height, int fps, const std::string& encoder);
double AutoBitrateMbps(const std::string& resolution, int fps);  // full box size, before the source is known
bool ValidHost(const std::string& host);
bool ValidStreamPath(const std::string& path);
bool ValidPort(int port);

// Validates a "start" request from the UI and merges it into settings. Returns an error message for the UI on failure.
bool ApplyStartRequest(const json& request, Settings& settings, std::string& field, std::string& error);

struct LocalAddress {
  std::string ip;
  std::string adapter;
  bool hasGateway = false;
};
std::vector<LocalAddress> LocalIPv4Addresses();
std::string PreferredLanAddress();
// True when host is (or resolves to) an address that belongs to this PC.
bool HostIsLocal(const std::string& host, std::string& resolved);

}  // namespace fc
