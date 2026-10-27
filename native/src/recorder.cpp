#include "recorder.h"

#include <shlobj.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <sstream>

namespace fc {

namespace {

constexpr double kGiB = 1024.0 * 1024.0 * 1024.0;

// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
int64_t DaysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

double CivilToEpochMs(int y, int mo, int d, int h, int mi, int s, double fracSeconds) {
  int64_t days = DaysFromCivil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d));
  return (static_cast<double>(days) * 86400.0 + h * 3600.0 + mi * 60.0 + s + fracSeconds) * 1000.0;
}

bool IsBroadcastId(const std::wstring& name) {
  return name.size() == 32 && std::all_of(name.begin(), name.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}

uint64_t FolderBytes(const fs::path& dir) {
  uint64_t total = 0;
  std::error_code ec;
  for (fs::recursive_directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec), end; !ec && it != end; it.increment(ec)) {
    std::error_code fileEc;
    if (it->is_regular_file(fileEc)) total += it->file_size(fileEc);
  }
  return total;
}

json ReadMeta(const fs::path& dir) {
  std::ifstream in(dir / L"broadcast.json", std::ios::binary);
  if (!in) return json();
  json j = json::parse(in, nullptr, false);
  return j.is_object() ? j : json();
}

void WriteMeta(const fs::path& dir, const json& meta) {
  fs::path tmp = dir / L"broadcast.json.tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    out << meta.dump(2, ' ', false, json::error_handler_t::replace);
    if (!out) return;
  }
  std::error_code ec;
  fs::rename(tmp, dir / L"broadcast.json", ec);
}

std::string SizeText(uint64_t bytes) {
  if (bytes >= static_cast<uint64_t>(kGiB)) return Printf("%.2f GB", bytes / kGiB);
  return Printf("%.1f MB", bytes / (1024.0 * 1024.0));
}

std::string DurationText(int64_t ms) {
  int64_t s = std::max<int64_t>(0, ms / 1000);
  return Printf("%lld:%02lld:%02lld", static_cast<long long>(s / 3600), static_cast<long long>(s / 60 % 60), static_cast<long long>(s % 60));
}

}  // namespace

bool ParseRfc3339(const std::string& text, double& epochMs) {
  int y, mo, d, h, mi, s, n = 0;
  if (sscanf_s(text.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &s, &n) != 6 || n != 19) return false;
  size_t i = 19;
  double frac = 0;
  if (i < text.size() && text[i] == '.') {
    double scale = 0.1;
    for (++i; i < text.size() && isdigit(static_cast<unsigned char>(text[i])); ++i, scale /= 10) frac += (text[i] - '0') * scale;
  }
  int offsetMinutes = 0;
  if (i < text.size() && (text[i] == 'Z' || text[i] == 'z')) {
    ++i;
  } else if (i + 6 <= text.size() && (text[i] == '+' || text[i] == '-') && text[i + 3] == ':') {
    int oh = atoi(text.substr(i + 1, 2).c_str()), om = atoi(text.substr(i + 4, 2).c_str());
    offsetMinutes = (text[i] == '-' ? -1 : 1) * (oh * 60 + om);
    i += 6;
  } else {
    return false;
  }
  if (i != text.size()) return false;
  epochMs = CivilToEpochMs(y, mo, d, h, mi, s, frac) - offsetMinutes * 60000.0;
  return true;
}

std::string FormatRfc3339Utc(double epochMs) {
  int64_t us = static_cast<int64_t>(std::llround(epochMs * 1000.0));
  int64_t secs = us >= 0 ? us / 1000000 : (us - 999999) / 1000000;
  int64_t micro = us - secs * 1000000;
  __time64_t t = secs;
  tm g{};
  if (_gmtime64_s(&g, &t) != 0) return "";
  return Printf("%04d-%02d-%02dT%02d:%02d:%02d.%06lldZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, static_cast<long long>(micro));
}


namespace {

// Removes finished broadcasts under root: those older than keepDays, then the oldest while the total (finished ones plus
// currentBytes) exceeds maxBytes. Only folders this program created (broadcast id name + broadcast.json) are counted or
// removed, never currentId and never other files in a shared folder. Returns the bytes of the finished broadcasts kept.
uint64_t PruneRecordings(const fs::path& root, const std::string& currentId, uint64_t currentBytes, double maxBytes, int keepDays) {
  struct Entry {
    fs::path dir;
    int64_t endedAt = 0;
    uint64_t bytes = 0;
  };
  std::vector<Entry> finished;
  uint64_t total = currentBytes;
  int64_t now = EpochMillis();
  std::error_code ec;
  for (fs::directory_iterator it(root, ec), end; !ec && it != end; it.increment(ec)) {
    std::error_code e;
    if (!it->is_directory(e)) continue;
    std::wstring name = it->path().filename().wstring();
    if (!IsBroadcastId(name) || Utf8(name) == currentId || !fs::exists(it->path() / L"broadcast.json", e)) continue;
    uint64_t bytes = FolderBytes(it->path());
    total += bytes;
    json meta = ReadMeta(it->path());
    int64_t endedAt = meta.is_object() ? meta.value("endedAtMs", meta.value("startedAtMs", static_cast<int64_t>(0))) : 0;
    if (!endedAt) {
      auto written = fs::last_write_time(it->path(), e);
      endedAt = e ? now : now - std::chrono::duration_cast<std::chrono::milliseconds>(fs::file_time_type::clock::now() - written).count();
    }
    finished.push_back({it->path(), endedAt, bytes});
  }
  std::sort(finished.begin(), finished.end(), [](const Entry& a, const Entry& b) { return a.endedAt < b.endedAt; });
  for (const auto& entry : finished) {
    bool expired = keepDays > 0 && now - entry.endedAt > static_cast<int64_t>(keepDays) * 86400000;
    bool overCap = static_cast<double>(total) > maxBytes;
    if (!expired && !overCap) continue;
    // Media first and broadcast.json last: a segment held open by another program leaves a folder that is still ours
    // to retry on the next start, instead of an unknown folder that only counts against the cap.
    std::error_code e;
    for (fs::directory_iterator media(entry.dir, e), end; !e && media != end; media.increment(e)) {
      std::error_code me;
      if (media->is_directory(me)) fs::remove_all(media->path(), me);
      if (me) e = me;
      if (e) break;
    }
    if (!e) fs::remove_all(entry.dir, e);
    if (e) {
      LogFile("record", "could not remove " + Utf8(entry.dir.wstring()) + ": " + e.message());
      continue;
    }
    total -= std::min(total, entry.bytes);
    LogFile("record", std::string(expired ? "expired" : "over cap") + ", removed " + Utf8(entry.dir.wstring()) + " (" + SizeText(entry.bytes) + ")");
    UiLog("녹화", std::string(expired ? "보관 기간이 지난" : "용량 상한을 넘은") + " 이전 방송 녹화를 삭제했습니다: " + Utf8(entry.dir.filename().wstring()) + " (" +
                      SizeText(entry.bytes) + ")");
  }
  return total - std::min(total, currentBytes);
}

double FreeGiB(const fs::path& dir) {
  ULARGE_INTEGER available{};
  if (dir.empty() || !GetDiskFreeSpaceExW(dir.c_str(), &available, nullptr, nullptr)) return -1;
  return available.QuadPart / kGiB;
}

}  // namespace

fs::path RecordStore::Root(const Settings& settings) {
  if (!settings.recordDir.empty()) {
    fs::path p = Wide(settings.recordDir);
    return p.is_absolute() ? p : ExeDir() / p;
  }
  PWSTR appData = nullptr;
  fs::path root = DataDir() / L"recordings";
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &appData))) root = fs::path(appData) / L"FrameConsole" / L"recordings";
  CoTaskMemFree(appData);
  return root;
}

bool RecordStore::Prepare(const Settings& settings, const std::string& broadcastId, const json& meta, std::string& reason) {
  fs::path root = Root(settings);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    settings_ = settings;
    root_ = root;
    id_.clear();
    pausedForSpace_ = pausedForCap_ = false;
  }
  if (!settings.recordEnabled) {
    reason = "설정 파일에서 녹화(recordEnabled)가 꺼져 있어 되감기 없이 송출합니다.";
    return false;
  }
  std::error_code ec;
  fs::create_directories(root, ec);
  if (!fs::is_directory(root, ec)) {
    reason = "녹화 폴더를 만들 수 없어 되감기 없이 송출합니다: " + Utf8(root.wstring());
    return false;
  }
  uint64_t others = PruneRecordings(root, broadcastId, 0, settings.recordMaxGB * kGiB, settings.recordKeepDays);
  double free = FreeGiB(root);
  if (free >= 0 && free < settings.recordMinFreeGB) {
    reason = Printf("녹화 디스크 여유 공간이 %.1f GB로 최소 %.1f GB보다 적어 되감기 없이 송출합니다. 녹화 폴더: ", free, settings.recordMinFreeGB) +
             Utf8(root.wstring());
    return false;
  }
  fs::path dir = root / Wide(broadcastId);
  fs::create_directories(dir, ec);
  json m = meta;
  m["id"] = broadcastId;
  WriteMeta(dir, m);
  if (!fs::exists(dir / L"broadcast.json", ec)) {
    reason = "녹화 폴더에 쓸 수 없어 되감기 없이 송출합니다: " + Utf8(dir.wstring());
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  id_ = broadcastId;
  startedAtMs_ = m.value("startedAtMs", EpochMillis());
  othersBytes_ = others;
  return true;
}

void RecordStore::UpdateMeta(const json& patch) {
  fs::path dir = CurrentDir();
  if (dir.empty()) return;
  json meta = ReadMeta(dir);
  if (!meta.is_object()) meta = json::object();
  meta.update(patch);
  WriteMeta(dir, meta);
  std::lock_guard<std::mutex> lock(mutex_);
  if (patch.contains("startedAtMs") && patch["startedAtMs"].is_number_integer()) startedAtMs_ = patch["startedAtMs"].get<int64_t>();
}

bool RecordStore::Active() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return !id_.empty();
}

fs::path RecordStore::RootDir() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return root_;
}

fs::path RecordStore::CurrentDir() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return id_.empty() ? fs::path() : root_ / Wide(id_);
}

void RecordStore::ClearCurrent() {
  fs::path dir = CurrentDir();
  if (dir.empty()) return;
  std::error_code ec;
  for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
    std::error_code e;
    if (it->is_directory(e)) fs::remove_all(it->path(), e);
  }
}

void RecordStore::Discard() {
  fs::path dir = CurrentDir();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    id_.clear();
  }
  std::error_code ec;
  if (!dir.empty()) fs::remove_all(dir, ec);
}

std::string RecordStore::Finish(int64_t endedAtMs) {
  fs::path dir = CurrentDir();
  if (dir.empty()) return "";
  uint64_t bytes = FolderBytes(dir);
  json meta = ReadMeta(dir);
  if (!meta.is_object()) meta = json::object();
  int64_t started;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    started = startedAtMs_;
    id_.clear();
  }
  int64_t duration = std::max<int64_t>(1, endedAtMs - meta.value("startedAtMs", started));
  double mbps = bytes * 8.0 / (duration / 1000.0) / 1e6;
  meta["endedAtMs"] = endedAtMs;
  meta["bytes"] = bytes;
  meta["averageMbps"] = std::round(mbps * 100) / 100;
  WriteMeta(dir, meta);
  return "녹화 저장: " + SizeText(bytes) + ", " + DurationText(duration) + Printf(", 평균 %.2f Mbps", mbps) + " (" + Utf8(dir.wstring()) + ")";
}

std::string RecordStore::RecordPathPattern() const {
  std::lock_guard<std::mutex> lock(mutex_);
  // Relative to MediaMTX's working directory (the recordings root); MediaMTX appends ".mp4".
  // %z keeps segment times correct across daylight-saving changes.
  return "./" + id_ + "/%path/%Y-%m-%d_%H-%M-%S-%f%z";
}

std::vector<double> RecordStore::SegmentStarts(const std::string& streamPath) const {
  std::vector<double> starts;
  fs::path dir = CurrentDir();
  if (dir.empty()) return starts;
  std::error_code ec;
  for (fs::directory_iterator it(dir / Wide(streamPath), ec), end; !ec && it != end; it.increment(ec)) {
    std::string name = Utf8(it->path().filename().wstring());
    int y, mo, d, h, mi, s, n = 0;
    char micro[7] = {};
    if (sscanf_s(name.c_str(), "%4d-%2d-%2d_%2d-%2d-%2d-%6[0-9]%n", &y, &mo, &d, &h, &mi, &s, micro, static_cast<unsigned>(sizeof(micro)), &n) != 7) continue;
    std::string rest = name.substr(static_cast<size_t>(n));
    if (rest.size() < 4 || rest.compare(rest.size() - 4, 4, ".mp4") != 0) continue;
    rest.resize(rest.size() - 4);
    double ms = CivilToEpochMs(y, mo, d, h, mi, s, atoi(micro) / 1e6);
    if (rest.size() == 5 && (rest[0] == '+' || rest[0] == '-')) {
      int offset = atoi(rest.substr(1, 2).c_str()) * 60 + atoi(rest.substr(3, 2).c_str());
      ms -= (rest[0] == '-' ? -1 : 1) * offset * 60000.0;
    } else if (rest.empty()) {  // local time without an offset: use the current zone
      TIME_ZONE_INFORMATION tz{};
      DWORD mode = GetTimeZoneInformation(&tz);
      ms += (tz.Bias + (mode == TIME_ZONE_ID_DAYLIGHT ? tz.DaylightBias : 0)) * 60000.0;
    } else if (rest != "Z") {
      continue;
    }
    starts.push_back(ms);
  }
  std::sort(starts.begin(), starts.end());
  return starts;
}

uint64_t RecordStore::CurrentBytes() const {
  fs::path dir = CurrentDir();
  return dir.empty() ? 0 : FolderBytes(dir);
}

uint64_t RecordStore::TotalBytes() const {
  uint64_t others;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    others = othersBytes_;
  }
  return others + CurrentBytes();
}

double RecordStore::FreeGB() const { return FreeGiB(RootDir()); }

RecordStore::Check RecordStore::Monitor(bool recordingNow) {
  Check c;
  std::string id;
  fs::path root;
  Settings settings;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    id = id_, root = root_, settings = settings_;
  }
  if (id.empty()) {
    c.record = false;
    return c;
  }
  double maxBytes = settings.recordMaxGB * kGiB;
  bool capReached = false;
  uint64_t current = FolderBytes(root / Wide(id)), others;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    others = othersBytes_;
  }
  if (static_cast<double>(others + current) > maxBytes) {
    others = PruneRecordings(root, id, current, maxBytes, 0);
    capReached = static_cast<double>(others + current) > maxBytes;
    std::lock_guard<std::mutex> lock(mutex_);
    othersBytes_ = others;
  }
  double free = FreeGiB(root);
  std::lock_guard<std::mutex> lock(mutex_);
  if (capReached && !pausedForCap_) {
    pausedForCap_ = true;
    c.message = Printf("녹화 용량 상한(recordMaxGB %.0f GB)에 도달해 녹화를 멈췄습니다. 라이브 송출은 계속되며, 되감기는 저장된 구간까지만 가능합니다.",
                       settings.recordMaxGB);
  }
  if (free >= 0 && free < settings.recordMinFreeGB && !pausedForSpace_) {
    pausedForSpace_ = true;
    c.message = Printf("녹화 디스크 여유 공간이 %.1f GB 남아 녹화를 멈췄습니다 (최소 %.1f GB). 라이브 송출은 계속되며, 되감기는 저장된 구간까지만 가능합니다.", free,
                       settings.recordMinFreeGB);
  } else if (pausedForSpace_ && free >= settings.recordMinFreeGB + 2) {
    pausedForSpace_ = false;
    if (!pausedForCap_) c.message = Printf("녹화 디스크 여유 공간이 %.1f GB로 회복되어 녹화를 다시 시작합니다. 멈춘 동안의 구간은 되감을 수 없습니다.", free);
  }
  c.record = !pausedForSpace_ && !pausedForCap_;
  c.changed = c.record != recordingNow;
  if (!c.changed) c.message.clear();
  return c;
}

}  // namespace fc
