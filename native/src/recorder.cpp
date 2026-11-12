#include "recorder.h"

#include <shlobj.h>

#include <algorithm>
#include <array>
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

std::string FormatIso8601Ms(double epochMs) {
  int64_t ms = static_cast<int64_t>(std::llround(epochMs));
  int64_t secs = ms >= 0 ? ms / 1000 : (ms - 999) / 1000;
  __time64_t t = secs;
  tm g{};
  if (_gmtime64_s(&g, &t) != 0) return "";
  return Printf("%04d-%02d-%02dT%02d:%02d:%02d.%03lldZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec,
                static_cast<long long>(ms - secs * 1000));
}

// ---------------------------------------------------------------------------------------------
// fMP4 index and fragments for the HLS DVR playlist

namespace {

uint32_t Be32(const uint8_t* p) { return (uint32_t{p[0]} << 24) | (uint32_t{p[1]} << 16) | (uint32_t{p[2]} << 8) | p[3]; }
uint64_t Be64(const uint8_t* p) { return (uint64_t{Be32(p)} << 32) | Be32(p + 4); }

void Put32(std::string& s, uint32_t v) {
  for (int shift = 24; shift >= 0; shift -= 8) s += static_cast<char>((v >> shift) & 0xFF);
}
void Put64(std::string& s, uint64_t v) {
  Put32(s, static_cast<uint32_t>(v >> 32));
  Put32(s, static_cast<uint32_t>(v));
}

bool ReadAt(HANDLE file, uint64_t offset, void* buffer, size_t size) {
  OVERLAPPED ov{};
  ov.Offset = static_cast<DWORD>(offset);
  ov.OffsetHigh = static_cast<DWORD>(offset >> 32);
  DWORD read = 0;
  return ReadFile(file, buffer, static_cast<DWORD>(size), &read, &ov) && read == size;
}

ScopedHandle OpenShared(const fs::path& path) {
  // MediaMTX keeps the newest file open for writing; reading never blocks or changes it.
  return ScopedHandle(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL, nullptr));
}

// Box header at offset: type and total size. False when it cannot be read yet or the size is invalid (size < header);
// a size-0 box ("to the end of the file") is never complete while the file grows.
bool BoxHeader(HANDLE file, uint64_t offset, uint64_t fileSize, uint32_t& type, uint64_t& size, uint32_t& headerSize) {
  uint8_t h[16];
  if (offset + 8 > fileSize || !ReadAt(file, offset, h, 8)) return false;
  size = Be32(h);
  type = Be32(h + 4);
  headerSize = 8;
  if (size == 1) {
    if (offset + 16 > fileSize || !ReadAt(file, offset + 8, h + 8, 8)) return false;
    size = Be64(h + 8);
    headerSize = 16;
  }
  return size >= headerSize;
}

constexpr uint32_t Fourcc(const char (&s)[5]) {
  return (uint32_t{static_cast<uint8_t>(s[0])} << 24) | (uint32_t{static_cast<uint8_t>(s[1])} << 16) | (uint32_t{static_cast<uint8_t>(s[2])} << 8) |
         static_cast<uint8_t>(s[3]);
}

// Calls fn(type, payload, payloadSize) for each child box inside [p, p + size).
template <typename Fn>
void ForEachBox(const uint8_t* p, size_t size, Fn fn) {
  size_t off = 0;
  while (off + 8 <= size) {
    uint64_t boxSize = Be32(p + off);
    uint32_t type = Be32(p + off + 4);
    size_t header = 8;
    if (boxSize == 1) {
      if (off + 16 > size) return;
      boxSize = Be64(p + off + 8);
      header = 16;
    } else if (boxSize == 0) {
      boxSize = size - off;
    }
    if (boxSize < header || boxSize > size - off) return;
    fn(type, p + off + header, static_cast<size_t>(boxSize) - header);
    off += static_cast<size_t>(boxSize);
  }
}

void ParseMoov(RecordFile& f, const uint8_t* p, size_t size) {
  std::vector<RecordTrack> tracks, defaults;
  ForEachBox(p, size, [&](uint32_t type, const uint8_t* b, size_t n) {
    if (type == Fourcc("trak")) {
      RecordTrack t;
      ForEachBox(b, n, [&](uint32_t type2, const uint8_t* c, size_t m) {
        if (type2 == Fourcc("tkhd") && m >= 24) t.id = c[0] == 1 ? Be32(c + 20) : Be32(c + 12);
        if (type2 != Fourcc("mdia")) return;
        ForEachBox(c, m, [&](uint32_t type3, const uint8_t* d, size_t k) {
          if (type3 == Fourcc("mdhd") && k >= 24) t.timescale = d[0] == 1 ? Be32(d + 20) : Be32(d + 12);
          if (type3 == Fourcc("hdlr") && k >= 12) t.handler = Be32(d + 8);
        });
      });
      if (t.id && t.timescale) tracks.push_back(t);
    } else if (type == Fourcc("mvex")) {
      ForEachBox(b, n, [&](uint32_t type2, const uint8_t* c, size_t m) {
        if (type2 != Fourcc("trex") || m < 24) return;
        RecordTrack d;
        d.id = Be32(c + 4);
        d.trexDuration = Be32(c + 12);
        d.trexSize = Be32(c + 16);
        d.trexFlags = Be32(c + 20);
        defaults.push_back(d);
      });
    }
  });
  for (auto& t : tracks)
    for (const auto& d : defaults)
      if (d.id == t.id) t.trexDuration = d.trexDuration, t.trexSize = d.trexSize, t.trexFlags = d.trexFlags;
  f.tracks = tracks;
  f.video = SIZE_MAX;
  for (size_t i = 0; i < tracks.size() && f.video == SIZE_MAX; ++i)
    if (tracks[i].handler == Fourcc("vide")) f.video = i;
}

struct Sample {
  uint64_t dts = 0, offset = 0;  // decode time (track timescale), absolute file offset of the data
  uint32_t duration = 0, size = 0, flags = 0;
  int32_t cto = 0;
};

bool IsSync(uint32_t flags) { return (flags & 0x00010000) == 0; }  // sample_is_non_sync_sample clear

// The samples of every traf of a known track in one moof (bytes p, size) that starts at file offset moofOffset.
// Sample flags follow the chain trun first-sample flags > sample flags > tfhd default > trex default.
bool ParseMoofSamples(const RecordFile& f, const uint8_t* p, size_t size, uint64_t moofOffset, std::vector<std::vector<Sample>>& out) {
  out.assign(f.tracks.size(), {});
  bool ok = true;
  uint64_t previousEnd = moofOffset;
  ForEachBox(p, size, [&](uint32_t type, const uint8_t* b, size_t n) {
    if (type != Fourcc("traf")) return;
    size_t track = SIZE_MAX;
    uint64_t base = moofOffset, dts = 0, dataPos = 0;
    uint32_t defDuration = 0, defSize = 0, defFlags = 0;
    ForEachBox(b, n, [&](uint32_t type2, const uint8_t* c, size_t m) {
      if (type2 == Fourcc("tfhd") && m >= 8) {
        uint32_t flags = Be32(c) & 0xFFFFFF, id = Be32(c + 4);
        for (size_t i = 0; i < f.tracks.size(); ++i)
          if (f.tracks[i].id == id) track = i;
        if (track == SIZE_MAX) return;
        defDuration = f.tracks[track].trexDuration, defSize = f.tracks[track].trexSize, defFlags = f.tracks[track].trexFlags;
        size_t o = 8;
        bool haveBase = false;
        if (flags & 0x1) {
          if (o + 8 <= m) base = Be64(c + o), haveBase = true;
          o += 8;
        }
        if (flags & 0x2) o += 4;
        if (flags & 0x8) {
          if (o + 4 <= m) defDuration = Be32(c + o);
          o += 4;
        }
        if (flags & 0x10) {
          if (o + 4 <= m) defSize = Be32(c + o);
          o += 4;
        }
        if ((flags & 0x20) && o + 4 <= m) defFlags = Be32(c + o);
        if (!haveBase) base = (flags & 0x20000) ? moofOffset : previousEnd;  // default-base-is-moof
        dataPos = base;
      } else if (type2 == Fourcc("tfdt") && m >= 8) {
        dts = c[0] == 1 && m >= 12 ? Be64(c + 4) : Be32(c + 4);
      } else if (type2 == Fourcc("trun") && m >= 8 && track != SIZE_MAX) {
        uint32_t version = c[0], flags = Be32(c) & 0xFFFFFF, count = Be32(c + 4);
        size_t o = 8;
        if (flags & 0x1) {
          if (o + 4 > m) {
            ok = false;
            return;
          }
          dataPos = base + static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(Be32(c + o))));
          o += 4;
        }
        bool firstPresent = (flags & 0x4) != 0;
        uint32_t first = 0;
        if (firstPresent) {
          if (o + 4 > m) {
            ok = false;
            return;
          }
          first = Be32(c + o);
          o += 4;
        }
        size_t entry = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
        if (o > m || count > 1000000 || (entry && (m - o) / entry < count)) {
          ok = false;  // truncated or implausible trun
          return;
        }
        auto& samples = out[track];
        for (uint32_t i = 0; i < count; ++i) {
          size_t x = o + static_cast<size_t>(i) * entry;
          Sample s;
          s.duration = defDuration, s.size = defSize, s.flags = defFlags;
          if (flags & 0x100) s.duration = Be32(c + x), x += 4;
          if (flags & 0x200) s.size = Be32(c + x), x += 4;
          if (flags & 0x400) s.flags = Be32(c + x), x += 4;
          if (flags & 0x800) {
            uint32_t v = Be32(c + x);
            s.cto = version == 0 ? static_cast<int32_t>(std::min<uint32_t>(v, 0x7FFFFFFF)) : static_cast<int32_t>(v);
          }
          if (i == 0 && firstPresent) s.flags = first;
          s.dts = dts;
          s.offset = dataPos;
          dts += s.duration;
          dataPos += s.size;
          samples.push_back(s);
        }
      }
    });
    if (track != SIZE_MAX) previousEnd = dataPos;
  });
  return ok;
}

// Reads the moof at offset (complete box of moofSize bytes) and parses its samples.
bool ReadMoofSamples(HANDLE file, const RecordFile& f, uint64_t offset, uint64_t fileSize, std::vector<std::vector<Sample>>& out) {
  uint32_t type = 0, header = 0;
  uint64_t size = 0;
  if (!BoxHeader(file, offset, fileSize, type, size, header) || type != Fourcc("moof") || size > 8ull * 1024 * 1024 || offset + size > fileSize)
    return false;
  std::vector<uint8_t> buffer(static_cast<size_t>(size - header));
  if (!ReadAt(file, offset + header, buffer.data(), buffer.size())) return false;
  return ParseMoofSamples(f, buffer.data(), buffer.size(), offset, out);
}

}  // namespace

uint64_t RecordFile::ListedBytes() const {
  if (segments.empty() || segments.back().lastPart >= parts.size()) return initSize;
  const RecordPart& last = parts[segments.back().lastPart];
  return last.offset + last.size;
}

void ScanRecordFile(RecordFile& f) {
  if (f.broken) return;
  ScopedHandle file = OpenShared(f.path);
  if (!file.Valid()) return;
  LARGE_INTEGER sizeValue{};
  if (!GetFileSizeEx(file.Get(), &sizeValue)) return;
  // The open handle reports the real size; directory listings of a file another process writes can lag behind.
  uint64_t fileSize = static_cast<uint64_t>(sizeValue.QuadPart);
  if (fileSize != f.size || !f.grewAtMs) f.grewAtMs = EpochMillis();
  f.size = fileSize;
  constexpr uint64_t kMaxMeta = 8ull * 1024 * 1024;  // a moov or moof larger than this is not something MediaMTX writes
  std::vector<uint8_t> buffer;
  std::vector<std::vector<Sample>> samples;
  uint64_t off = f.next;
  for (;;) {
    uint32_t type = 0, header = 0;
    uint64_t size = 0;
    if (!BoxHeader(file.Get(), off, fileSize, type, size, header)) {
      if (off + 8 <= fileSize && size != 0 && size < header) f.broken = true;  // a size smaller than its header: not MP4
      return;
    }
    if (type == Fourcc("moov")) {
      if (size > kMaxMeta) {
        f.broken = true;
        return;
      }
      if (off + size > fileSize) return;
      buffer.resize(static_cast<size_t>(size - header));
      if (!ReadAt(file.Get(), off + header, buffer.data(), buffer.size())) return;
      ParseMoov(f, buffer.data(), buffer.size());
      if (f.video == SIZE_MAX) {
        f.broken = true;  // the recording always carries video; without it there is nothing to list
        return;
      }
    } else if (type == Fourcc("moof")) {
      if (f.video == SIZE_MAX || size > kMaxMeta) {
        f.broken = true;
        return;
      }
      uint32_t mdatType = 0, mdatHeader = 0;
      uint64_t mdatSize = 0;
      if (off + size > fileSize || !BoxHeader(file.Get(), off + size, fileSize, mdatType, mdatSize, mdatHeader)) return;
      if (mdatType != Fourcc("mdat")) {
        f.broken = true;
        return;
      }
      if (off + size + mdatSize > fileSize) return;  // the part is still being written
      if (!ReadMoofSamples(file.Get(), f, off, fileSize, samples)) {
        f.broken = true;
        return;
      }
      if (!f.initSize) f.initSize = off;
      RecordPart part;
      part.offset = off;
      part.size = size + mdatSize;
      part.videoStart = part.videoEnd = f.parts.empty() ? 0 : f.parts.back().videoEnd;
      const auto& video = samples[f.video];
      if (!video.empty()) {
        part.videoStart = video.front().dts;
        part.videoEnd = video.back().dts + video.back().duration;
        for (const auto& s : video)
          if (IsSync(s.flags) && (f.keyframes.empty() || s.dts > f.keyframes.back())) f.keyframes.push_back(s.dts);
      }
      f.parts.push_back(part);
      size += mdatSize;
    } else if (off + size > fileSize) {
      return;
    }
    off += size;
    f.next = off;
  }
}

void GroupRecordFile(RecordFile& f, bool final, double targetSeconds) {
  const uint64_t ts = f.VideoTimescale();
  if (!ts || !f.initSize || f.parts.empty() || f.broken) return;
  const uint64_t target = static_cast<uint64_t>(targetSeconds * static_cast<double>(ts)), margin = ts;  // 1 s
  const uint64_t videoEnd = f.parts.back().videoEnd;
  const size_t n = f.parts.size();
  for (;;) {
    // A segment starts at the first keyframe at or after the end of the previous one.
    uint64_t from = f.segments.empty() ? 0 : f.segments.back().end;
    while (f.nextKeyframe < f.keyframes.size() && f.keyframes[f.nextKeyframe] < from) ++f.nextKeyframe;
    if (f.nextKeyframe >= f.keyframes.size()) return;
    RecordSegment s;
    s.start = f.keyframes[f.nextKeyframe];
    s.openStart = f.segments.empty();
    size_t k = f.nextKeyframe + 1;
    // 0.1 s of tolerance: keyframes one GOP apart carry timestamp jitter, and 3.997 s should not make a 5 s segment.
    while (k < f.keyframes.size() && f.keyframes[k] - s.start + ts / 10 < target) ++k;
    if (k < f.keyframes.size() && (final || videoEnd >= f.keyframes[k] + margin)) {
      s.end = f.keyframes[k];
    } else if (final && videoEnd > s.start) {
      s.end = videoEnd;
      s.openEnd = true;
    } else {
      return;  // the open end of a growing file
    }
    // The parts whose video overlaps the span, one second wider for the other tracks (their part boundaries differ).
    s.firstPart = 0;
    if (!s.openStart)
      while (s.firstPart + 1 < n && f.parts[s.firstPart].videoEnd + margin <= s.start) ++s.firstPart;
    s.lastPart = n - 1;
    if (!s.openEnd)
      while (s.lastPart > s.firstPart && f.parts[s.lastPart].videoStart >= s.end + margin) --s.lastPart;
    f.segments.push_back(s);
    f.nextKeyframe = k;
  }
}

bool BuildRecordFragment(const RecordFile& f, const RecordSegment& segment, uint32_t sequence, RecordFragment& out) {
  const uint64_t vts = f.VideoTimescale();
  if (!vts || segment.lastPart >= f.parts.size() || segment.firstPart > segment.lastPart) return false;
  ScopedHandle file = OpenShared(f.path);
  if (!file.Valid()) return false;
  LARGE_INTEGER sizeValue{};
  if (!GetFileSizeEx(file.Get(), &sizeValue)) return false;
  uint64_t fileSize = static_cast<uint64_t>(sizeValue.QuadPart);
  // Every track's samples of [start, end): video by its own decode time, the others by the same instant in their
  // timescale. Consecutive segments share their boundaries, so each sample belongs to exactly one segment.
  std::vector<std::vector<Sample>> picked(f.tracks.size()), samples;
  for (size_t p = segment.firstPart; p <= segment.lastPart; ++p) {
    if (!ReadMoofSamples(file.Get(), f, f.parts[p].offset, fileSize, samples)) return false;
    for (size_t t = 0; t < f.tracks.size(); ++t) {
      const uint64_t ts = f.tracks[t].timescale;
      for (const auto& s : samples[t]) {
        bool afterStart = t == f.video ? s.dts >= segment.start : (segment.openStart || s.dts * vts >= segment.start * ts);
        bool beforeEnd = segment.openEnd || (t == f.video ? s.dts < segment.end : s.dts * vts < segment.end * ts);
        if (afterStart && beforeEnd) picked[t].push_back(s);
      }
    }
  }
  if (picked[f.video].empty() || !IsSync(picked[f.video].front().flags)) return false;
  // moof: mfhd, then per track with samples: traf { tfhd (default-base-is-moof), tfdt v1, trun v1 with data offset,
  // duration, size, flags and composition offset for every sample }. mdat: the tracks' sample bytes in the same order.
  uint64_t moofSize = 8 + 16;
  for (const auto& v : picked)
    if (!v.empty()) moofSize += 8 + 16 + 20 + 20 + 16 * static_cast<uint64_t>(v.size());
  out = RecordFragment();
  std::string& m = out.moof;
  m.reserve(static_cast<size_t>(moofSize + 8));
  Put32(m, static_cast<uint32_t>(moofSize));
  m += "moof";
  Put32(m, 16);
  m += "mfhd";
  Put32(m, 0);
  Put32(m, sequence);
  uint64_t dataOffset = moofSize + 8;
  for (size_t t = 0; t < picked.size(); ++t) {
    const auto& v = picked[t];
    if (v.empty()) continue;
    Put32(m, static_cast<uint32_t>(8 + 16 + 20 + 20 + 16 * v.size()));
    m += "traf";
    Put32(m, 16);
    m += "tfhd";
    Put32(m, 0x020000);
    Put32(m, f.tracks[t].id);
    Put32(m, 20);
    m += "tfdt";
    Put32(m, 0x01000000);
    Put64(m, v.front().dts);
    Put32(m, static_cast<uint32_t>(20 + 16 * v.size()));
    m += "trun";
    Put32(m, 0x01000F01);
    Put32(m, static_cast<uint32_t>(v.size()));
    Put32(m, static_cast<uint32_t>(dataOffset));
    for (const auto& s : v) {
      Put32(m, s.duration);
      Put32(m, s.size);
      Put32(m, s.flags);
      Put32(m, static_cast<uint32_t>(s.cto));
      if (s.offset + s.size > fileSize) return false;
      if (!out.runs.empty() && out.runs.back().first + out.runs.back().second == s.offset) out.runs.back().second += s.size;
      else out.runs.push_back({s.offset, s.size});
      out.payload += s.size;
      dataOffset += s.size;
    }
  }
  if (out.payload + 8 > 0xFFFFFFFFull || dataOffset > 0xFFFFFFFFull) return false;
  Put32(m, static_cast<uint32_t>(out.payload + 8));
  m += "mdat";
  return true;
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

std::vector<double> RecordStore::SegmentStarts(const std::string& recordPath) const {
  std::vector<double> starts;
  for (const auto& file : Files(recordPath)) starts.push_back(file.second);
  return starts;
}

std::vector<std::pair<fs::path, double>> RecordStore::Files(const std::string& recordPath) const {
  std::vector<std::pair<fs::path, double>> files;
  fs::path dir = CurrentDir();
  if (dir.empty()) return files;
  std::error_code ec;
  // recordPath is a MediaMTX path name ("<stream>/rec"); MediaMTX creates one folder per path segment.
  fs::path folder = dir;
  for (size_t start = 0; start <= recordPath.size();) {
    size_t slash = recordPath.find('/', start);
    if (slash == std::string::npos) slash = recordPath.size();
    if (slash > start) folder /= Wide(recordPath.substr(start, slash - start));
    start = slash + 1;
  }
  for (fs::directory_iterator it(folder, ec), end; !ec && it != end; it.increment(ec)) {
    std::error_code fileEc;
    if (!it->is_regular_file(fileEc)) continue;
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
    files.push_back({it->path(), ms});
  }
  std::sort(files.begin(), files.end(), [](const auto& a, const auto& b) { return a.second < b.second; });
  return files;
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
