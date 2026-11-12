package frame.api.dvr;

import frame.api.FrameProperties;
import frame.api.broadcast.Broadcast;
import frame.api.mediamtx.Deadline;
import frame.api.web.JsNumbers;
import frame.api.web.LogOnce;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The relay's DVR (server/lib/dvr.mjs; the app's DvrIndex, DvrMediaTarget, DvrPlaylist, DvrFile), backed by the relay
 * MediaMTX recording of the copy path "{path}/rec" (video + AAC, fMP4, 1 s parts; written by the runOnAvailable FFmpeg of
 * mediamtx-relay.yml) and its loopback playback server. Unlike the sender PC, one relay path is reused by successive
 * broadcasts, so everything before the current broadcast's start on this relay (Broadcast.dvrFromMs, relay clock) is
 * hidden from the index, the chunk requests and dvr.m3u8.
 */
@Component
public class Recordings {
    private static final Logger log = LoggerFactory.getLogger(Recordings.class);
    static final long SLACK_MS = 2000;  // a segment opens on the first keyframe after the publisher became ready
    /** HLS DVR media segments: cut at video keyframes, about this long (the app's kDvrSegmentSeconds). */
    static final double SEGMENT_S = 4;
    private static final Pattern NAME = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})-(\\d{6})(Z|[+-]\\d{4})?\\.mp4$");
    private static final DateTimeFormatter ISO_MS = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);

    /** A refusal (status, error) or the playback server target of a chunk request. */
    public record Target(int status, String error, String url) {}

    /** A refusal (status, error) or the recorded file of a dvr/file request. */
    public record Found(int status, String error, RecordFile file) {}

    /** The HLS DVR state of the current broadcast on a path: its files in recording order and the playlist text. */
    public static final class HlsState {
        final String id;
        final List<RecordFile> files = new CopyOnWriteArrayList<>();
        final ReentrantLock lock = new ReentrantLock();
        volatile long at;
        volatile String body = "";
        HlsState(String id) { this.id = id; }
        public String body() { return body; }
        public List<RecordFile> files() { return files; }
    }

    private record Cached(String id, long at, Map<String, Object> value) {}

    private final boolean enabled;
    private final String recordDir, playback;
    private final JsonMapper json;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(3))
            .executor(Executors.newVirtualThreadPerTaskExecutor()).build();
    private final ConcurrentHashMap<String, Cached> cache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, HlsState> hls = new ConcurrentHashMap<>();

    public Recordings(FrameProperties props, JsonMapper json) {
        this.enabled = props.dvr().enabled();
        this.recordDir = props.dvr().recordDir() == null ? "" : props.dvr().recordDir().trim();
        this.playback = props.mediamtx().playback();
        this.json = json;
    }

    public boolean enabled() { return enabled; }

    /** dvr.m3u8 needs the recording files themselves (RELAY_RECORD_DIR). */
    public boolean hlsAvailable() { return enabled && !recordDir.isEmpty(); }

    /** The MediaMTX path that records a broadcast path. */
    static String recordPath(String path) { return path + "/rec"; }

    /** 2026-10-28_11-27-35-354294+0900.mp4 (recordPath %Y-%m-%d_%H-%M-%S-%f%z) -> epoch ms, or null. */
    static Double segmentStart(String name) {
        Matcher m = NAME.matcher(name);
        if (!m.matches()) return null;
        LocalDateTime t;
        try {
            t = LocalDateTime.of(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)),
                    Integer.parseInt(m.group(4)), Integer.parseInt(m.group(5)), Integer.parseInt(m.group(6)));
        } catch (RuntimeException e) {
            return null;
        }
        double fraction = Integer.parseInt(m.group(7)) / 1000.0;
        String zone = m.group(8);
        long ms;
        if (zone == null) ms = t.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();  // local time without an offset
        else {
            // The offset by arithmetic, as Node computes it: any +HHMM, never an exception for an odd name.
            ms = t.toInstant(ZoneOffset.UTC).toEpochMilli();
            if (!zone.equals("Z")) ms -= (zone.charAt(0) == '-' ? -1L : 1L) * (Integer.parseInt(zone.substring(1, 3)) * 60L + Integer.parseInt(zone.substring(3, 5))) * 60_000L;
        }
        return ms + fraction;
    }

    private Path dir(String path) { return Path.of(recordDir, path, "rec"); }

    private List<String> names(String path) {
        try (Stream<Path> list = Files.list(dir(path))) {
            return list.map(p -> p.getFileName().toString()).toList();
        } catch (Exception e) {
            return List.of();
        }
    }

    // ---- the JSON index and the chunks of the playback server ------------------------------------------------------------

    /**
     * GET /{path}/dvr. entry: the broadcast on the path (or null); live: receiving media, or within the media grace period
     * (the recording made so far stays available).
     */
    public Map<String, Object> index(String path, Broadcast entry, boolean live) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (entry == null || !live) {
            out.put("running", false);
            out.put("path", path);
            return out;
        }
        out.put("running", true);
        out.put("id", entry.id);
        out.put("dvr", enabled);
        if (!enabled) return out;
        // Not yet seen receiving on this relay: nothing of this broadcast is recorded (older files on the path are earlier broadcasts).
        if (entry.dvrFromMs == 0) {
            out.put("recording", false);
            out.put("ranges", List.of());
            out.put("segments", List.of());
            out.put("gopMs", 1000);
            out.put("nowMs", System.currentTimeMillis());
            return out;
        }
        Cached hit = cache.get(path);
        if (hit != null && hit.id().equals(entry.id) && System.currentTimeMillis() - hit.at() < 1000) return hit.value();
        double from = entry.dvrFromMs - SLACK_MS;
        JsonNode list = null;
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(playback + "/list?path=" + enc(recordPath(path)))).timeout(Duration.ofSeconds(3)).GET().build();
            HttpResponse<String> res = Deadline.send(http, req, HttpResponse.BodyHandlers.ofString(), Duration.ofSeconds(3));
            if (res.statusCode() == 200) list = json.readTree(res.body());
            else if (res.statusCode() != 400 && res.statusCode() != 404 && LogOnce.allow("dvr-list " + res.statusCode()))
                log.warn("playback list {} -> {}", path, res.statusCode());  // 400/404: nothing written yet
        } catch (Exception e) {
            if (LogOnce.allow("dvr-list")) log.warn("playback list failed: {}", e.toString());
        }
        List<Double> segments = null;
        if (!recordDir.isEmpty()) {
            segments = new ArrayList<>();
            for (String name : names(path)) { Double t = segmentStart(name); if (t != null && t >= from) segments.add(t); }
            segments.sort(Comparator.naturalOrder());
        }
        List<Map<String, Object>> ranges = new ArrayList<>();
        List<Object> rangeStarts = new ArrayList<>();
        if (list != null && list.isArray()) for (JsonNode e : list) {
            double start = time(e.path("start"));
            double duration = e.path("duration").isNumber() ? e.path("duration").doubleValue() : 0;
            if (Double.isNaN(start) || !(duration > 0)) continue;
            double end = start + duration * 1000;
            if (end <= from) continue;  // an earlier broadcast on this path
            if (start < from) {  // merged with an earlier broadcast's tail
                Double first = segments == null ? null : segments.stream().filter(t -> t >= from).findFirst().orElse(null);
                start = first != null ? first : entry.dvrFromMs;
            }
            if (end > start) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("startMs", number(start));
                r.put("endMs", number(end));
                ranges.add(r);
                rangeStarts.add(number(start));
            }
        }
        out.put("recording", true);
        out.put("ranges", ranges);
        out.put("segments", segments != null ? segments.stream().map(Recordings::number).toList() : rangeStarts);
        out.put("gopMs", 1000);
        out.put("nowMs", System.currentTimeMillis());
        cache.put(path, new Cached(entry.id, System.currentTimeMillis(), out));
        return out;
    }

    /** GET /{path}/dvr/media?id=&start=&duration=: one bounded chunk, never a whole broadcast, never before it began here. */
    public Target target(String path, Broadcast entry, boolean live, String id, double startMs, double durationMs) {
        if (entry == null || !live) return new Target(404, "not-running", null);
        if (!id.equals(entry.id)) return new Target(409, "broadcast-changed", null);  // a new broadcast on the same path: reload the index
        if (!enabled) return new Target(404, "no-dvr", null);
        long now = System.currentTimeMillis();
        if (!Double.isFinite(startMs) || !Double.isFinite(durationMs) || durationMs < 200 || durationMs > 30000 || startMs < now - 8 * 86_400_000L || startMs > now + 10000)
            return new Target(400, "bad-range", null);
        if (entry.dvrFromMs == 0 || startMs < entry.dvrFromMs - SLACK_MS) return new Target(404, "no-data", null);
        String start = ISO_MS.format(Instant.ofEpochMilli((long) startMs));
        return new Target(0, null, "/get?path=" + enc(recordPath(path)) + "&start=" + enc(start) + "&duration="
                + JsNumbers.toFixed(durationMs / 1000, 3) + "&format=fmp4");
    }

    /** The chunk from the playback server (the caller closes the body). Below the front proxy's 45 s header timeout. */
    public HttpResponse<InputStream> chunk(String target) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(playback + target)).timeout(Duration.ofSeconds(20)).GET().build();
        return Deadline.send(http, req, HttpResponse.BodyHandlers.ofInputStream(), Duration.ofSeconds(20));
    }

    // ---- HLS DVR (dvr.m3u8 and dvr/file) -----------------------------------------------------------------------------

    /**
     * State of the current broadcast on {@code path}: its recorded files in order (a file removed by the retention stays as
     * gone), each scanned and cut into segments, and the playlist text. Refreshed at most once a second. A file is named in
     * URLs by its id, its recording start in whole ms, which stays the same for the file's life.
     */
    public HlsState hlsState(String path, Broadcast entry, boolean force) {
        HlsState st = hls.compute(path, (k, cur) -> cur != null && cur.id.equals(entry.id) ? cur : new HlsState(entry.id));
        long asked = System.currentTimeMillis();
        if (!force && st.at != 0 && asked - st.at < 1000) return st;
        // A ReentrantLock, not a monitor: on Java 21 a virtual thread waiting on a monitor pins its carrier thread.
        st.lock.lock();
        try {
            // Concurrent callers share one refresh: a forced one is satisfied by a refresh that finished after it asked.
            if (st.at != 0 && (force ? st.at >= asked : asked - st.at < 1000)) return st;
            refresh(path, entry, st);
        } finally {
            st.lock.unlock();
        }
        return st;
    }

    private void refresh(String path, Broadcast entry, HlsState st) {
        double from = entry.dvrFromMs > 0 ? entry.dvrFromMs - SLACK_MS : Double.POSITIVE_INFINITY;
        Map<String, Double> onDisk = new LinkedHashMap<>();
        for (String name : names(path)) { Double t = segmentStart(name); if (t != null && t >= from) onDisk.put(name, t); }
        // Never claim what is not on disk any more: a file the retention removed is not listed again.
        for (RecordFile f : st.files) if (!onDisk.containsKey(f.name)) f.gone = true;
        Set<String> known = new HashSet<>();
        for (RecordFile f : st.files) known.add(f.name);
        double lastStart = st.files.isEmpty() ? Double.NEGATIVE_INFINITY : st.files.getLast().startMs;
        Path dir = dir(path);
        onDisk.entrySet().stream().filter(e -> !known.contains(e.getKey())).sorted(Map.Entry.comparingByValue())
                .filter(e -> e.getValue() > lastStart).forEach(e -> st.files.add(new RecordFile(dir.resolve(e.getKey()), e.getKey(), e.getValue())));
        long now = System.currentTimeMillis();
        for (int i = 0; i < st.files.size(); i++) {
            RecordFile f = st.files.get(i);
            if (f.complete || f.gone) continue;
            f.scan();
            // MediaMTX writes one file at a time: every file but the newest is finished. The newest is final once it has not
            // grown for 5 s (the sender away); until then its open last group is not listed.
            boolean newer = i + 1 < st.files.size();
            f.group(newer || now - f.grewAtMs() >= 5000, SEGMENT_S);
            if (newer || f.broken()) f.complete = true;
        }
        st.body = playlistText(st);
        st.at = System.currentTimeMillis();
    }

    /** GET /{path}/dvr/file?id=&f={file id}: the recorded file, or why not. */
    public Found hlsFile(String path, Broadcast entry, boolean live, String id, long fileId) {
        if (entry == null || !live) return new Found(404, "not-running", null);
        if (!id.equals(entry.id)) return new Found(409, "broadcast-changed", null);  // a new broadcast on the same path: reload the playlist
        if (!hlsAvailable()) return new Found(404, "no-dvr", null);
        HlsState st = hls.get(path);
        // Not known: rescan, unless the id is older than the newest known file (only newer files are ever added).
        boolean known = st != null && st.id.equals(id) && (find(st, fileId) != null || (!st.files.isEmpty() && fileId < st.files.getLast().fileId));
        if (!known) st = hlsState(path, entry, true);
        RecordFile f = find(st, fileId);
        if (f == null || f.gone || f.segmentCount() == 0) return new Found(404, "no-data", null);
        return new Found(0, null, f);
    }

    private static RecordFile find(HlsState st, long fileId) {
        for (RecordFile f : st.files) if (f.fileId == fileId) return f;
        return null;
    }

    /**
     * EVENT playlist (segments only appended). Each recorded file has its own init (EXT-X-MAP: its ftyp+moov as a byte
     * range) and its own timeline, so a discontinuity separates files (and with them every gap where the sender was away).
     * Decode time 0 is the file's first sample, the time in its name. When the retention removed the oldest files the
     * playlist is no longer an EVENT one: it continues with MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE counting what was removed.
     */
    static String playlistText(HlsState st) {
        List<String> lines = new ArrayList<>();
        long target = 1;
        int removedSegments = 0, removedTags = 0;
        boolean leading = true, first = true;
        for (RecordFile f : st.files) {
            long ts = f.videoTimescale();
            List<RecordFile.Segment> segs = f.segments();
            if (segs.isEmpty() || ts <= 0) continue;
            for (RecordFile.Segment seg : segs) target = Math.max(target, Math.round((seg.end() - seg.start()) / (double) ts));
            if (f.gone) {
                if (leading) { removedSegments += segs.size(); removedTags++; }
                continue;
            }
            leading = false;
            // ".mp4" in the path: players that check segment extensions (FFmpeg's HLS demuxer) accept it; dvr/file is the same.
            String uri = "dvr/file.mp4?id=" + st.id + "&f=" + f.fileId;
            if (!first) lines.add("#EXT-X-DISCONTINUITY");
            first = false;
            lines.add("#EXT-X-MAP:URI=\"" + uri + "\",BYTERANGE=\"" + f.initSize() + "@0\"");
            for (int s = 0; s < segs.size(); s++) {
                RecordFile.Segment seg = segs.get(s);
                double seconds = (seg.end() - seg.start()) / (double) ts;  // the video samples' durations
                lines.add("#EXT-X-PROGRAM-DATE-TIME:" + ISO_MS.format(Instant.ofEpochMilli((long) (f.startMs + seg.start() * 1000.0 / ts))));
                lines.add("#EXTINF:" + JsNumbers.toFixed(seconds, 5) + ",");
                lines.add(uri + "&s=" + s);
            }
        }
        List<String> out = new ArrayList<>(List.of("#EXTM3U", "#EXT-X-VERSION:7"));
        if (removedSegments == 0) out.add("#EXT-X-PLAYLIST-TYPE:EVENT");
        out.add("#EXT-X-TARGETDURATION:" + Math.max(target, (long) Math.ceil(SEGMENT_S)));
        out.add("#EXT-X-MEDIA-SEQUENCE:" + removedSegments);
        if (removedTags > 0) out.add("#EXT-X-DISCONTINUITY-SEQUENCE:" + removedTags);
        out.add("#EXT-X-INDEPENDENT-SEGMENTS");
        out.addAll(lines);
        out.add("");
        return String.join("\n", out);
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20"); }

    // An ISO time of the playback list ("2026-11-10T01:02:03.456789+09:00") in epoch ms, NaN if unknown.
    private static double time(JsonNode v) {
        if (!v.isString()) return Double.NaN;
        try { return Instant.parse(v.asString()).toEpochMilli(); } catch (Exception e) { return Double.NaN; }
    }

    /** A whole number as an integer, else plain digits (the index's times keep the file names' fractions, as the Node relay). */
    static Object number(double v) { return JsNumbers.json(v); }
}
