package frame.api.dvr;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;

/**
 * One fMP4 file MediaMTX records for the HLS DVR (server/lib/fmp4.mjs; native/src/recorder.cpp ScanRecordFile,
 * GroupRecordFile, BuildRecordFragment), so the relay's dvr.m3u8 means exactly what the app's does.
 * MediaMTX closes a recorded part (moof+mdat) every recordPartDuration regardless of keyframes, so a part's first video
 * sample is normally not a sync sample and whole parts cannot form HLS segments that start with a keyframe. Segments are
 * therefore cut at the video sync samples and served as new fragments whose samples are copied byte for byte from the
 * recorded parts (no re-encode); the init is the file's own ftyp+moov (a byte range of the file).
 * <p>The scan state is guarded by a ReentrantLock (on Java 21 a virtual thread waiting on a monitor pins its carrier). A
 * fragment is built outside it from a snapshot: parts and tracks never change once added.
 */
final class RecordFile {
    private static final int MAX_META = 8 * 1024 * 1024;  // a moov or moof larger than this is not something MediaMTX writes

    record Track(long id, long timescale, String handler, long trexDuration, long trexSize, long trexFlags) {}

    /** A complete moof+mdat: its file range and the decode-time span of its video samples. */
    record Part(long offset, long size, long videoStart, long videoEnd) {}

    /** A listed HLS segment: video decode times [start, end), the parts it is cut from. Never changes once listed. */
    record Segment(long start, long end, int firstPart, int lastPart, boolean openStart, boolean openEnd) {}

    /** One segment as a new fragment: moof box + mdat header, then the sample bytes at {@code runs} ([offset, length]). */
    record Fragment(byte[] moof, List<long[]> runs, long payload) {}

    private record Sample(long dts, long offset, long duration, long size, long flags, int cto) {}

    private record Box(String type, long size, int header) {}

    private record Child(String type, int start, int end) {}

    final Path path;
    final String name;
    /** Recording start in epoch ms (from the file name). */
    final double startMs;
    /** The file's id in URLs: its start in whole ms, the same for the file's life whatever restarts or retention remove. */
    final long fileId;

    private final ReentrantLock lock = new ReentrantLock();
    private long size, next, initSize, grewAtMs;
    private List<Track> tracks = List.of();
    private int video = -1;
    private boolean broken;
    volatile boolean complete, gone;
    private final List<Part> parts = new ArrayList<>();
    private final List<Long> keyframes = new ArrayList<>();
    private final List<Segment> segments = new ArrayList<>();
    private int nextKeyframe;

    RecordFile(Path path, String name, double startMs) {
        this.path = path;
        this.name = name;
        this.startMs = startMs;
        this.fileId = (long) Math.floor(startMs);
    }

    long initSize() { lock.lock(); try { return initSize; } finally { lock.unlock(); } }
    boolean broken() { lock.lock(); try { return broken; } finally { lock.unlock(); } }
    long grewAtMs() { lock.lock(); try { return grewAtMs; } finally { lock.unlock(); } }
    int segmentCount() { lock.lock(); try { return segments.size(); } finally { lock.unlock(); } }
    Segment segment(int i) { lock.lock(); try { return i >= 0 && i < segments.size() ? segments.get(i) : null; } finally { lock.unlock(); } }
    List<Segment> segments() { lock.lock(); try { return List.copyOf(segments); } finally { lock.unlock(); } }
    long videoTimescale() { lock.lock(); try { return timescale(); } finally { lock.unlock(); } }

    private long timescale() { return video >= 0 && video < tracks.size() ? tracks.get(video).timescale() : 0; }

    /** Bytes of the file a client may read directly: the init and the parts the listed segments are made of. */
    long listedBytes() {
        lock.lock();
        try {
            if (segments.isEmpty()) return initSize;
            Segment last = segments.getLast();
            if (last.lastPart() >= parts.size()) return initSize;
            Part p = parts.get(last.lastPart());
            return p.offset() + p.size();
        } finally {
            lock.unlock();
        }
    }

    // ---- scanning -------------------------------------------------------------------------------------------------------

    /** Reads the boxes MediaMTX appended since the last scan (complete moof+mdat pairs only). */
    void scan() {
        lock.lock();
        try {
            if (!broken) scanLocked();
        } finally {
            lock.unlock();
        }
    }

    private void scanLocked() {
        try (FileChannel ch = FileChannel.open(path, StandardOpenOption.READ)) {
            // The open handle reports the real size; directory listings of a file another process writes can lag behind.
            long fileSize = ch.size();
            if (fileSize != size || grewAtMs == 0) grewAtMs = System.currentTimeMillis();
            size = fileSize;
            long off = next;
            for (;;) {
                Box h = boxHeader(ch, off, fileSize);
                if (h == null) return;
                if (h.size() < h.header()) { if (h.size() != 0) broken = true; return; }  // a size smaller than its header: not MP4
                long boxSize = h.size();
                // Sizes are compared as "larger than what is left" (a 64-bit size near 2^63 must not wrap around).
                if (h.type().equals("moov")) {
                    if (boxSize > MAX_META) { broken = true; return; }
                    if (boxSize > fileSize - off) return;
                    ByteBuffer buf = readAt(ch, off + h.header(), (int) (boxSize - h.header()));
                    if (buf == null) return;
                    parseMoov(buf);
                    if (video < 0) { broken = true; return; }  // the recording always carries video; without it nothing is listed
                } else if (h.type().equals("moof")) {
                    if (video < 0 || boxSize > MAX_META) { broken = true; return; }
                    if (boxSize > fileSize - off) return;
                    Box mdat = boxHeader(ch, off + boxSize, fileSize);
                    if (mdat == null) return;
                    if (!mdat.type().equals("mdat") || mdat.size() < mdat.header()) { broken = true; return; }
                    if (mdat.size() > fileSize - off - boxSize) return;  // the part is still being written
                    List<List<Sample>> samples = readMoofSamples(ch, tracks, off, fileSize);
                    if (samples == null) { broken = true; return; }
                    if (initSize == 0) initSize = off;
                    long prevEnd = parts.isEmpty() ? 0 : parts.getLast().videoEnd();
                    long videoStart = prevEnd, videoEnd = prevEnd;
                    List<Sample> v = samples.get(video);
                    if (!v.isEmpty()) {
                        videoStart = v.getFirst().dts();
                        videoEnd = v.getLast().dts() + v.getLast().duration();
                        for (Sample s : v) if (isSync(s.flags()) && (keyframes.isEmpty() || s.dts() > keyframes.getLast())) keyframes.add(s.dts());
                    }
                    parts.add(new Part(off, boxSize + mdat.size(), videoStart, videoEnd));
                    boxSize += mdat.size();
                } else if (boxSize > fileSize - off) {
                    return;
                }
                off += boxSize;
                next = off;
            }
        } catch (IOException | RuntimeException e) {
            // A read that fails now (file being replaced or removed) is retried on the next scan.
        }
    }

    /**
     * Cuts new segments of about {@code targetSeconds} at video keyframes. A segment is listed once the keyframe that ends it
     * and one more second of media are on disk (so every track's samples of its span are complete), or when the file is
     * final. Once listed a segment never changes (EVENT playlist).
     */
    void group(boolean fin, double targetSeconds) {
        lock.lock();
        try {
            groupLocked(fin, targetSeconds);
        } finally {
            lock.unlock();
        }
    }

    private void groupLocked(boolean fin, double targetSeconds) {
        long ts = timescale();
        if (ts == 0 || initSize == 0 || parts.isEmpty() || broken) return;
        long target = (long) Math.floor(targetSeconds * ts), margin = ts;  // 1 s
        long videoEnd = parts.getLast().videoEnd();
        int n = parts.size();
        for (;;) {
            // A segment starts at the first keyframe at or after the end of the previous one.
            long from = segments.isEmpty() ? 0 : segments.getLast().end();
            while (nextKeyframe < keyframes.size() && keyframes.get(nextKeyframe) < from) nextKeyframe++;
            if (nextKeyframe >= keyframes.size()) return;
            long start = keyframes.get(nextKeyframe), end;
            boolean openStart = segments.isEmpty(), openEnd = false;
            int k = nextKeyframe + 1;
            // 0.1 s of tolerance: keyframes one GOP apart carry timestamp jitter, and 3.997 s should not make a 5 s segment.
            while (k < keyframes.size() && keyframes.get(k) - start + ts / 10 < target) k++;
            if (k < keyframes.size() && (fin || videoEnd >= keyframes.get(k) + margin)) end = keyframes.get(k);
            else if (fin && videoEnd > start) { end = videoEnd; openEnd = true; }
            else return;  // the open end of a growing file
            // The parts whose video overlaps the span, one second wider for the other tracks (their part boundaries differ).
            int firstPart = 0;
            if (!openStart) while (firstPart + 1 < n && parts.get(firstPart).videoEnd() + margin <= start) firstPart++;
            int lastPart = n - 1;
            if (!openEnd) while (lastPart > firstPart && parts.get(lastPart).videoStart() >= end + margin) lastPart--;
            segments.add(new Segment(start, end, firstPart, lastPart, openStart, openEnd));
            nextKeyframe = k;
        }
    }

    /**
     * Segment {@code segment} built from the file on disk, or null. moof: mfhd, then per track with samples traf { tfhd
     * (default-base-is-moof), tfdt v1, trun v1 with data offset, duration, size, flags and composition offset for every
     * sample }; mdat: the tracks' sample bytes in the same order.
     */
    Fragment fragment(Segment segment, int sequence) {
        long vts;
        int vid;
        List<Track> tr;
        List<Part> span;
        lock.lock();
        try {
            vts = timescale();
            if (vts == 0 || segment.lastPart() >= parts.size() || segment.firstPart() > segment.lastPart()) return null;
            vid = video;
            tr = tracks;
            span = List.copyOf(parts.subList(segment.firstPart(), segment.lastPart() + 1));
        } finally {
            lock.unlock();
        }
        try (FileChannel ch = FileChannel.open(path, StandardOpenOption.READ)) {
            long fileSize = ch.size();
            // Every track's samples of [start, end): video by its own decode time, the others by the same instant in their
            // timescale. Consecutive segments share their boundaries, so each sample belongs to exactly one segment.
            List<List<Sample>> picked = new ArrayList<>();
            for (int i = 0; i < tr.size(); i++) picked.add(new ArrayList<>());
            for (Part part : span) {
                List<List<Sample>> samples = readMoofSamples(ch, tr, part.offset(), fileSize);
                if (samples == null) return null;
                for (int i = 0; i < tr.size(); i++) {
                    long tts = tr.get(i).timescale();
                    for (Sample s : samples.get(i)) {
                        boolean afterStart = i == vid ? s.dts() >= segment.start() : segment.openStart() || s.dts() * vts >= segment.start() * tts;
                        boolean beforeEnd = segment.openEnd() || (i == vid ? s.dts() < segment.end() : s.dts() * vts < segment.end() * tts);
                        if (afterStart && beforeEnd) picked.get(i).add(s);
                    }
                }
            }
            if (picked.get(vid).isEmpty() || !isSync(picked.get(vid).getFirst().flags())) return null;
            long moofSize = 8 + 16;
            for (List<Sample> v : picked) if (!v.isEmpty()) moofSize += 8 + 16 + 20 + 20 + 16L * v.size();
            if (moofSize > Integer.MAX_VALUE - 8) return null;
            ByteBuffer m = ByteBuffer.allocate((int) moofSize + 8);
            m.putInt((int) moofSize).put(tag("moof")).putInt(16).put(tag("mfhd")).putInt(0).putInt(sequence);
            List<long[]> runs = new ArrayList<>();
            long dataOffset = moofSize + 8, payload = 0;
            boolean outside = false;
            for (int i = 0; i < picked.size(); i++) {
                List<Sample> v = picked.get(i);
                if (v.isEmpty()) continue;
                m.putInt((int) (8 + 16 + 20 + 20 + 16L * v.size())).put(tag("traf"));
                m.putInt(16).put(tag("tfhd")).putInt(0x020000).putInt((int) tr.get(i).id());
                m.putInt(20).put(tag("tfdt")).putInt(0x01000000).putLong(v.getFirst().dts());
                m.putInt((int) (20 + 16L * v.size())).put(tag("trun")).putInt(0x01000f01).putInt(v.size()).putInt((int) dataOffset);
                for (Sample s : v) {
                    m.putInt((int) s.duration()).putInt((int) s.size()).putInt((int) s.flags()).putInt(s.cto());
                    long[] last = runs.isEmpty() ? null : runs.getLast();
                    if (last != null && last[0] + last[1] == s.offset()) last[1] += s.size(); else runs.add(new long[] {s.offset(), s.size()});
                    payload += s.size();
                    dataOffset += s.size();
                    if (s.offset() < 0 || s.size() > fileSize - s.offset()) outside = true;
                }
            }
            if (outside || payload + 8 > 0xffffffffL || dataOffset > 0xffffffffL) return null;
            m.putInt((int) (payload + 8)).put(tag("mdat"));
            return new Fragment(m.array(), runs, payload);
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    // ---- boxes ----------------------------------------------------------------------------------------------------------

    private static boolean isSync(long flags) { return (flags & 0x00010000L) == 0; }  // sample_is_non_sync_sample clear

    private static byte[] tag(String s) { return s.getBytes(StandardCharsets.ISO_8859_1); }

    private static long u32(ByteBuffer b, int at) { return b.getInt(at) & 0xffffffffL; }

    private static String type(ByteBuffer b, int at) {
        byte[] t = new byte[4];
        b.get(at, t);
        return new String(t, StandardCharsets.ISO_8859_1);
    }

    private static ByteBuffer readAt(FileChannel ch, long offset, int length) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(length);
        while (b.hasRemaining()) {
            int n = ch.read(b, offset + b.position());
            if (n <= 0) return null;
        }
        return b.flip();
    }

    // The box header at offset, or null when it cannot be read yet. Size 0 ("to the end of the file") is never complete
    // while the file grows; a size smaller than its header marks a broken file (checked by the caller).
    private static Box boxHeader(FileChannel ch, long offset, long fileSize) throws IOException {
        if (offset < 0 || 8 > fileSize - offset) return null;
        ByteBuffer h = readAt(ch, offset, 8);
        if (h == null) return null;
        long size = u32(h, 0);
        int header = 8;
        String type = type(h, 4);
        if (size == 1) {
            if (16 > fileSize - offset) return null;
            ByteBuffer e = readAt(ch, offset + 8, 8);
            if (e == null) return null;
            size = e.getLong(0);
            if (size < 0) size = 2;  // larger than any file: broken (smaller than its header)
            header = 16;
        }
        return new Box(type, size, header);
    }

    // The child boxes inside buf[start, end).
    private static List<Child> children(ByteBuffer buf, int start, int end) {
        List<Child> out = new ArrayList<>();
        int off = start;
        while (off + 8 <= end) {
            long size = u32(buf, off);
            int header = 8;
            String type = type(buf, off + 4);
            if (size == 1) {
                if (off + 16 > end) break;
                size = buf.getLong(off + 8);
                header = 16;
            } else if (size == 0) {
                size = end - off;
            }
            if (size < header || size > end - off) break;
            out.add(new Child(type, off + header, (int) (off + size)));
            off += (int) size;
        }
        return out;
    }

    private void parseMoov(ByteBuffer buf) {
        List<Track> found = new ArrayList<>();
        List<long[]> defaults = new ArrayList<>();  // [id, duration, size, flags]
        for (Child box : children(buf, 0, buf.limit())) {
            if (box.type().equals("trak")) {
                long id = 0, timescale = 0;
                String handler = "";
                for (Child c : children(buf, box.start(), box.end())) {
                    if (c.type().equals("tkhd") && c.end() - c.start() >= 24) id = buf.get(c.start()) == 1 ? u32(buf, c.start() + 20) : u32(buf, c.start() + 12);
                    if (!c.type().equals("mdia")) continue;
                    for (Child d : children(buf, c.start(), c.end())) {
                        if (d.type().equals("mdhd") && d.end() - d.start() >= 24) timescale = buf.get(d.start()) == 1 ? u32(buf, d.start() + 20) : u32(buf, d.start() + 12);
                        if (d.type().equals("hdlr") && d.end() - d.start() >= 12) handler = type(buf, d.start() + 8);
                    }
                }
                if (id != 0 && timescale != 0) found.add(new Track(id, timescale, handler, 0, 0, 0));
            } else if (box.type().equals("mvex")) {
                for (Child c : children(buf, box.start(), box.end())) {
                    if (!c.type().equals("trex") || c.end() - c.start() < 24) continue;
                    defaults.add(new long[] {u32(buf, c.start() + 4), u32(buf, c.start() + 12), u32(buf, c.start() + 16), u32(buf, c.start() + 20)});
                }
            }
        }
        List<Track> list = new ArrayList<>();
        for (Track t : found) {
            Track withDefaults = t;
            for (long[] d : defaults) if (d[0] == t.id()) withDefaults = new Track(t.id(), t.timescale(), t.handler(), d[1], d[2], d[3]);
            list.add(withDefaults);
        }
        tracks = List.copyOf(list);
        video = -1;
        for (int i = 0; i < tracks.size(); i++) if (tracks.get(i).handler().equals("vide")) { video = i; break; }
    }

    private static int trackIndex(List<Track> tracks, long id) {
        for (int i = 0; i < tracks.size(); i++) if (tracks.get(i).id() == id) return i;
        return -1;
    }

    private static List<List<Sample>> readMoofSamples(FileChannel ch, List<Track> tracks, long offset, long fileSize) throws IOException {
        Box h = boxHeader(ch, offset, fileSize);
        if (h == null || !h.type().equals("moof") || h.size() < h.header() || h.size() > MAX_META || h.size() > fileSize - offset) return null;
        ByteBuffer buf = readAt(ch, offset + h.header(), (int) (h.size() - h.header()));
        return buf == null ? null : parseMoofSamples(tracks, buf, offset);
    }

    // The samples of every traf of a known track in one moof (payload buf) that starts at file offset moofOffset, or null
    // for a truncated or implausible trun. Sample flags: trun first-sample flags > sample flags > tfhd default > trex default.
    private static List<List<Sample>> parseMoofSamples(List<Track> tracks, ByteBuffer buf, long moofOffset) {
        List<List<Sample>> out = new ArrayList<>();
        for (int i = 0; i < tracks.size(); i++) out.add(new ArrayList<>());
        long previousEnd = moofOffset;
        for (Child traf : children(buf, 0, buf.limit())) {
            if (!traf.type().equals("traf")) continue;
            int track = -1;
            long base = moofOffset, dts = 0, dataPos = 0, defDuration = 0, defSize = 0, defFlags = 0;
            for (Child c : children(buf, traf.start(), traf.end())) {
                int at = c.start(), m = c.end() - c.start();
                if (c.type().equals("tfhd") && m >= 8) {
                    long flags = u32(buf, at) & 0xffffff;
                    track = trackIndex(tracks, u32(buf, at + 4));
                    if (track < 0) continue;
                    Track t = tracks.get(track);
                    defDuration = t.trexDuration();
                    defSize = t.trexSize();
                    defFlags = t.trexFlags();
                    int o = 8;
                    boolean haveBase = false;
                    if ((flags & 0x1) != 0) { if (o + 8 <= m) { base = buf.getLong(at + o); haveBase = true; } o += 8; }
                    if ((flags & 0x2) != 0) o += 4;
                    if ((flags & 0x8) != 0) { if (o + 4 <= m) defDuration = u32(buf, at + o); o += 4; }
                    if ((flags & 0x10) != 0) { if (o + 4 <= m) defSize = u32(buf, at + o); o += 4; }
                    if ((flags & 0x20) != 0 && o + 4 <= m) defFlags = u32(buf, at + o);
                    if (!haveBase) base = (flags & 0x20000) != 0 ? moofOffset : previousEnd;  // default-base-is-moof
                    dataPos = base;
                } else if (c.type().equals("tfdt") && m >= 8) {
                    dts = buf.get(at) == 1 && m >= 12 ? buf.getLong(at + 4) : u32(buf, at + 4);
                } else if (c.type().equals("trun") && m >= 8 && track >= 0) {
                    int version = buf.get(at);
                    long flags = u32(buf, at) & 0xffffff, count = u32(buf, at + 4);
                    int o = 8;
                    if ((flags & 0x1) != 0) { if (o + 4 > m) return null; dataPos = base + buf.getInt(at + o); o += 4; }
                    boolean firstPresent = (flags & 0x4) != 0;
                    long first = 0;
                    if (firstPresent) { if (o + 4 > m) return null; first = u32(buf, at + o); o += 4; }
                    int entry = ((flags & 0x100) != 0 ? 4 : 0) + ((flags & 0x200) != 0 ? 4 : 0) + ((flags & 0x400) != 0 ? 4 : 0) + ((flags & 0x800) != 0 ? 4 : 0);
                    if (o > m || count > 1_000_000 || (entry != 0 && (m - o) / entry < count)) return null;
                    List<Sample> samples = out.get(track);
                    for (int i = 0; i < count; i++) {
                        int x = at + o + i * entry;
                        long duration = defDuration, size = defSize, sampleFlags = defFlags;
                        int cto = 0;
                        if ((flags & 0x100) != 0) { duration = u32(buf, x); x += 4; }
                        if ((flags & 0x200) != 0) { size = u32(buf, x); x += 4; }
                        if ((flags & 0x400) != 0) { sampleFlags = u32(buf, x); x += 4; }
                        if ((flags & 0x800) != 0) cto = version == 0 ? (int) Math.min(u32(buf, x), 0x7fffffffL) : buf.getInt(x);
                        if (i == 0 && firstPresent) sampleFlags = first;
                        samples.add(new Sample(dts, dataPos, duration, size, sampleFlags, cto));
                        dts += duration;
                        dataPos += size;
                    }
                }
            }
            if (track >= 0) previousEnd = dataPos;
        }
        return out;
    }
}
