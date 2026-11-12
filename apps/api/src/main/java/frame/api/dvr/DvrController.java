package frame.api.dvr;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.mediamtx.BodyCopy;
import frame.api.playback.BroadcastScope;
import frame.api.playback.LiveMedia;
import frame.api.web.ClientAddress;
import frame.api.web.Counter;
import frame.api.web.Gate;
import frame.api.web.LogOnce;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.apache.catalina.connector.ClientAbortException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;

/**
 * The broadcast's recording (relay.mjs dvrIndex, dvrPlaylist, dvrFile, dvrMedia):
 * <pre>
 *   GET /{path}/dvr                    /{path}/b/{id}/dvr                   JSON index (ranges, segments)
 *   GET /{path}/dvr.m3u8               /{path}/b/{id}/dvr.m3u8              the recording as an HLS EVENT playlist
 *   GET /{path}/dvr/file[.mp4]?id=&f=[&s=]   /{path}/b/{id}/dvr/file[.mp4]  a recorded file (Range) or one listed segment
 *   GET /{path}/dvr/media?id=&start=&duration=                              a bounded chunk from the playback server
 * </pre>
 * Under a broadcast prefix, the recording of a publisher session that is not the broadcast's own is not listed or served
 * (503 + Retry-After), and after every wait the broadcast must still be the one on the path.
 */
@RestController
public class DvrController {
    private static final Logger log = LoggerFactory.getLogger(DvrController.class);
    private static final Pattern DIGITS = Pattern.compile("^[0-9]+$");
    private static final Pattern NUMBER = Pattern.compile("^-?[0-9.]{1,32}$");
    private static final Pattern RANGE_DIGITS = Pattern.compile("^[0-9]{1,15}$");
    private static final long[] UNSATISFIABLE = {-1, -1};

    private final LiveMedia live;
    private final BroadcastScope scopes;
    private final Recordings recordings;
    private final ClientAddress client;
    private final RateLimit rate;
    private final Gate streams;
    private final Counter perIp = new Counter();
    private final int perIpLimit;

    public DvrController(LiveMedia live, BroadcastScope scopes, Recordings recordings, ClientAddress client, FrameProperties props) {
        this.live = live;
        this.scopes = scopes;
        this.recordings = recordings;
        this.client = client;
        this.rate = RateLimit.parse(props.rates().dvr());
        this.streams = new Gate(props.limits().dvrStreams());
        this.perIpLimit = props.limits().dvrPerIp();
    }

    private record Scope(String id, LiveMedia.State state) {}

    // ---- index ----------------------------------------------------------------------------------------------------------

    @GetMapping("/{path}/dvr")
    public ResponseEntity<Object> indexPath(@PathVariable String path) {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        return index(path, null);
    }

    @GetMapping("/{path}/b/{id}/dvr")
    public ResponseEntity<Object> indexScoped(@PathVariable String path, @PathVariable String id) {
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return index(path, new Scope(id, b.state()));
    }

    // The JSON index of the current broadcast's recording ({"running":false} when not running). Under a prefix it waits while
    // the path's publisher session is not the broadcast's own (its ranges would include that session's time).
    private ResponseEntity<Object> index(String path, Scope scope) {
        LiveMedia.State s = scope != null ? scope.state() : live.current(path);
        if (live.starting(s)) return Replies.busy(2, LiveMedia.STARTING);
        if (scope != null && !s.live()) return BroadcastScope.notRunning(true);
        if (scope != null && BroadcastScope.foreignFrom(s) < Long.MAX_VALUE) return Replies.busy(2, "Media is not ready yet");
        Map<String, Object> value = recordings.index(path, s.entry(), s.live());
        if (scope != null) { ResponseEntity<Object> changed = scopes.changed(path, scope.id()); if (changed != null) return changed; }
        return Replies.json(200, value);
    }

    // ---- dvr.m3u8 -------------------------------------------------------------------------------------------------------

    @GetMapping("/{path}/dvr.m3u8")
    public ResponseEntity<Object> playlistPath(@PathVariable String path, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        return playlist(path, req, res, null);
    }

    @GetMapping("/{path}/b/{id}/dvr.m3u8")
    public ResponseEntity<Object> playlistScoped(@PathVariable String path, @PathVariable String id, HttpServletRequest req, HttpServletResponse res) throws IOException {
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return playlist(path, req, res, new Scope(id, b.state()));
    }

    // The current broadcast's recording as HLS (its URIs are relative: dvr/file.mp4?id=&f=&s=). Under a prefix it waits
    // while it would list a file of a publisher session that is not the broadcast's own.
    private ResponseEntity<Object> playlist(String path, HttpServletRequest req, HttpServletResponse res, Scope scope) throws IOException {
        LiveMedia.State s = scope != null ? scope.state() : live.current(path);
        if (live.starting(s)) return Replies.busy(2, LiveMedia.STARTING);
        if (s.entry() == null || !s.live()) return BroadcastScope.notRunning(scope != null);
        if (!recordings.hlsAvailable()) return Replies.textNoStore(404, "No recording");
        Recordings.HlsState st = recordings.hlsState(path, s.entry(), false);
        if (scope != null) { ResponseEntity<Object> changed = scopes.changed(path, scope.id()); if (changed != null) return changed; }
        long from = scope != null ? BroadcastScope.foreignFrom(s) : Long.MAX_VALUE;
        String body = st.body();
        if (st.files().stream().anyMatch(f -> !f.gone && f.segmentCount() > 0 && f.fileId >= from)) return Replies.busy(2, "Media is not ready yet");
        Replies.playlist(req, res, "application/vnd.apple.mpegurl", "no-cache", body);
        return null;
    }

    // ---- dvr/file -------------------------------------------------------------------------------------------------------

    @GetMapping({"/{path}/dvr/file", "/{path}/dvr/file.mp4"})
    public ResponseEntity<Object> filePath(@PathVariable String path, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        return file(path, req, res, null);
    }

    @GetMapping({"/{path}/b/{id}/dvr/file", "/{path}/b/{id}/dvr/file.mp4"})
    public ResponseEntity<Object> fileScoped(@PathVariable String path, @PathVariable String id, HttpServletRequest req, HttpServletResponse res) throws IOException {
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return file(path, req, res, new Scope(id, b.state()));
    }

    /**
     * ?id={broadcast}&f={file}[&s={segment}]: the recording file of dvr.m3u8 with Range (the init is its ftyp+moov range;
     * never bytes past what the playlist lists), or one listed media segment built from its parts. f is the file's recording
     * start (epoch ms, from its name), not its place in the list, so a URL cached for an hour names the same bytes after a
     * relay restart or after the retention removed older files. Under a prefix the id must be the prefix's broadcast.
     */
    private ResponseEntity<Object> file(String path, HttpServletRequest req, HttpServletResponse res, Scope scope) throws IOException {
        String id = req.getParameter("id") == null ? "" : req.getParameter("id");
        long fileId = digits(req.getParameter("f"), 15);
        String sText = req.getParameter("s");
        long segment = sText == null ? -1 : digits(sText, 6);
        if (!Announcement.ID.matcher(id).matches() || fileId < 0 || (sText != null && segment < 0)) return Replies.json(400, Map.of("error", "bad-request"));
        if (scope != null && !id.equals(scope.id())) return Replies.json(409, Map.of("error", "broadcast-changed"));
        String ip = client.ip(req);
        int wait = rate.take(ip);
        if (wait > 0) return Replies.limited(wait);
        if (perIp.get(ip) >= perIpLimit) return Replies.busy(2, "Too many recording downloads from this address");
        LiveMedia.State s = scope != null ? scope.state() : live.current(path);
        if (live.starting(s)) return Replies.busy(2, LiveMedia.STARTING);
        if (scope != null && fileId >= BroadcastScope.foreignFrom(s)) return Replies.busy(2, "Media is not ready yet");
        Recordings.Found found = recordings.hlsFile(path, s.entry(), s.live(), id, fileId);
        if (scope != null) { ResponseEntity<Object> changed = scopes.changed(path, scope.id()); if (changed != null) return changed; }
        if (found.status() != 0) return Replies.json(found.status(), Map.of("error", found.error()));
        RecordFile f = found.file();
        if (!streams.enter()) return Replies.busy(2, "Server busy");
        perIp.add(ip, 1);
        try {
            boolean head = "HEAD".equals(req.getMethod());
            if (segment >= 0) {
                RecordFile.Segment seg = f.segment((int) segment);
                RecordFile.Fragment frag = seg == null ? null : f.fragment(seg, (int) segment + 1);
                if (frag == null) {
                    if (seg != null && LogOnce.allow("dvr-seg")) log.warn("DVR segment {} of file {} on /{} could not be built", segment, f.name, path);
                    return Replies.json(404, Map.of("error", "no-data"));
                }
                // A listed segment never changes (it is cut from complete parts), so it is cached like a finished file.
                res.setStatus(200);
                res.setHeader(HttpHeaders.CONTENT_TYPE, "video/mp4");
                res.setHeader(HttpHeaders.CONTENT_LENGTH, Long.toString(frag.moof().length + frag.payload()));
                res.setHeader(HttpHeaders.ACCEPT_RANGES, "none");
                res.setHeader(HttpHeaders.CACHE_CONTROL, "public, max-age=3600");
                if (head) return null;
                res.getOutputStream().write(frag.moof());
                sendRuns(req, res, f, frag.runs());
                return null;
            }
            // complete before the listed bytes: a file seen complete has its final listing (set after its last cut), so a
            // publicly cached answer never carries a shorter total.
            boolean complete = f.complete;
            long limit = f.listedBytes();
            long[] range = range(req.getHeader(HttpHeaders.RANGE), limit);
            if (range == UNSATISFIABLE || limit == 0)
                return ResponseEntity.status(416).contentType(Replies.TEXT).header(HttpHeaders.CACHE_CONTROL, "no-store")
                        .header(HttpHeaders.CONTENT_RANGE, "bytes */" + limit).body("Range not satisfiable");
            long first = range != null ? range[0] : 0, last = range != null ? range[1] : limit - 1;
            res.setStatus(range != null ? 206 : 200);
            res.setHeader(HttpHeaders.CONTENT_TYPE, "video/mp4");
            res.setHeader(HttpHeaders.CONTENT_LENGTH, Long.toString(last - first + 1));
            res.setHeader(HttpHeaders.ACCEPT_RANGES, "bytes");
            res.setHeader(HttpHeaders.CACHE_CONTROL, complete ? "public, max-age=3600" : "no-cache");
            if (range != null) res.setHeader(HttpHeaders.CONTENT_RANGE, "bytes " + first + "-" + last + "/" + (complete ? Long.toString(limit) : "*"));
            if (head) return null;
            sendRuns(req, res, f, List.of(new long[] {first, last - first + 1}));
            return null;
        } finally {
            streams.leave();
            perIp.add(ip, -1);
        }
    }

    // Byte runs of a recording file; a read error aborts the connection so the player sees a failed request, never a
    // shorter body.
    private static void sendRuns(HttpServletRequest req, HttpServletResponse res, RecordFile f, List<long[]> runs) throws IOException {
        OutputStream out = res.getOutputStream();
        try (FileChannel ch = FileChannel.open(f.path, StandardOpenOption.READ)) {
            ByteBuffer chunk = ByteBuffer.allocate(256 * 1024);
            for (long[] run : runs) {
                long offset = run[0], length = run[1];
                while (length > 0) {
                    int n = (int) Math.min(length, chunk.capacity());
                    chunk.clear().limit(n);
                    while (chunk.hasRemaining()) {
                        int got = ch.read(chunk, offset + chunk.position());
                        if (got <= 0) throw new IOException("short read");
                    }
                    out.write(chunk.array(), 0, n);
                    offset += n;
                    length -= n;
                }
            }
        } catch (ClientAbortException | AsyncRequestNotUsableException e) {
            // The viewer went away (Spring's response wrapper reports a failed write as AsyncRequestNotUsableException):
            // not a recording failure, nothing to log.
        } catch (IOException | RuntimeException e) {
            if (LogOnce.allow("dvr-read")) log.warn("recording read failed: {}", e.toString());
            Replies.abort(req, res);
        }
    }

    // ---- dvr/media ------------------------------------------------------------------------------------------------------

    /** ?id=&start=&duration=: a chunk (200..30000 ms) of the recording from the playback server, chunked. */
    @GetMapping("/{path}/dvr/media")
    public ResponseEntity<Object> media(@PathVariable String path, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        String ip = client.ip(req);
        int wait = rate.take(ip);
        if (wait > 0) return Replies.limited(wait);
        if (perIp.get(ip) >= perIpLimit) return Replies.busy(2, "Too many recording downloads from this address");
        LiveMedia.State s = live.current(path);
        if (live.starting(s)) return Replies.busy(2, LiveMedia.STARTING);
        String id = req.getParameter("id") == null ? "" : req.getParameter("id");
        Recordings.Target t = recordings.target(path, s.entry(), s.live(), id, number(req.getParameter("start")), number(req.getParameter("duration")));
        if (t.status() != 0) return Replies.json(t.status(), Map.of("error", t.error()));
        if (!streams.enter()) return Replies.busy(2, "Server busy");
        perIp.add(ip, 1);
        try {
            HttpResponse<InputStream> up = recordings.chunk(t.url());
            try (InputStream in = up.body()) {
                if (up.statusCode() != 200) {
                    // 404: nothing recorded at that time yet (past the live edge) or a gap where the publisher was away.
                    int code = up.statusCode() == 404 ? 404 : 502;
                    if (code == 502 && LogOnce.allow("dvr-up")) log.warn("DVR chunk failed ({})", up.statusCode());
                    return Replies.json(code, Map.of("error", code == 404 ? "no-data" : "upstream"));
                }
                // Chunked: a transfer that breaks off upstream reaches the browser as an error (no final chunk), never as a
                // shorter but apparently complete file, exactly as the native server does.
                res.setStatus(200);
                res.setHeader(HttpHeaders.CONTENT_TYPE, "video/mp4");
                res.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
                if ("HEAD".equals(req.getMethod())) return null;
                BodyCopy.copy(in, res.getOutputStream(), 20_000);
                return null;
            }
        } catch (BodyCopy.Broken e) {
            if (LogOnce.allow("dvr-cut")) log.warn("DVR chunk interrupted: {}", e.why());
            Replies.abort(req, res);
            return null;
        } catch (ClientAbortException | AsyncRequestNotUsableException e) {
            return null;  // the viewer went away
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            if (LogOnce.allow("dvr-up")) log.warn("DVR upstream failed: {}", e.toString());
            if (!res.isCommitted()) return Replies.json(502, Map.of("error", "upstream"));
            Replies.abort(req, res);
            return null;
        } finally {
            streams.leave();
            perIp.add(ip, -1);
        }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------

    private static long digits(String v, int max) {
        return v != null && v.length() <= max && DIGITS.matcher(v).matches() ? Long.parseLong(v) : -1;
    }

    private static double number(String v) {
        if (v == null || !NUMBER.matcher(v).matches()) return Double.NaN;
        try { return Double.parseDouble(v); } catch (NumberFormatException e) { return Double.NaN; }
    }

    /** A single "bytes=" range of a body of {@code size}: null to send it whole, UNSATISFIABLE for 416, else [first, last]. */
    static long[] range(String value, long size) {
        if (value == null || !value.startsWith("bytes=") || value.contains(",")) return null;
        String spec = value.substring(6).replace(" ", "");
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        String a = spec.substring(0, dash), b = spec.substring(dash + 1);
        if (a.isEmpty()) {
            if (!RANGE_DIGITS.matcher(b).matches()) return null;
            long n = Long.parseLong(b);
            if (n == 0 || size == 0) return UNSATISFIABLE;
            return new long[] {n >= size ? 0 : size - n, size - 1};
        }
        if (!RANGE_DIGITS.matcher(a).matches() || (!b.isEmpty() && !RANGE_DIGITS.matcher(b).matches())) return null;
        long first = Long.parseLong(a), last = b.isEmpty() ? size - 1 : Long.parseLong(b);
        if (!b.isEmpty() && last < first) return null;
        if (first >= size) return UNSATISFIABLE;
        return new long[] {first, Math.min(last, size - 1)};
    }
}
