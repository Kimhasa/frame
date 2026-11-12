package frame.api.playback;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.broadcast.Broadcast;
import frame.api.mediamtx.BodyCopy;
import frame.api.mediamtx.MediaPath;
import frame.api.quality.Ladders;
import frame.api.quality.Renditions;
import frame.api.web.ClientAddress;
import frame.api.web.Counter;
import frame.api.web.Gate;
import frame.api.web.LogOnce;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.catalina.connector.ClientAbortException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Playback (relay.mjs): the broadcast's /info, its live HLS and the viewer sessions, on two kinds of routes:
 * <pre>
 *   GET    /{path}/info
 *   GET    /{path}/live.m3u8[?q=]                  /{path}/b/{id}/live.m3u8[?q=]
 *   GET    /{path}[/{variant}]/hls/{file}          /{path}/b/{id}[/{variant}]/hls/{file}      variant: 480p.., src, aac
 *   POST   /{path}/session                         /{path}/b/{id}/session
 *   PUT    /{path}/session/{sid}  (DELETE too)     /{path}/b/{id}/session/{sid}
 * </pre>
 * The path routes serve whatever broadcast is on the path (the existing /{path} page). The broadcast routes (the React
 * viewer, new share links) first check that broadcast {id} is still the one on the path (404 not-running, 409
 * broadcast-changed, JSON, no-store), that the media is that broadcast's own, and again after every wait, so a link never
 * gets the next broadcast's playlists, parts or sessions. Media requests are identical for everyone (CDN-safe: no cookie,
 * no viewer data) and never refused for the viewer cap; the session POST is where the cap applies.
 */
@RestController
public class PlaybackController {
    private static final Logger log = LoggerFactory.getLogger(PlaybackController.class);
    private static final Pattern FILE = Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\\.(?:m3u8|mp4|m4s|ts)$");
    private static final Pattern VARIANT = Pattern.compile("^((240|360|480|720|1080|1440)p|aac|src)$");
    private static final Pattern QUALITY = Pattern.compile("^(source|(240|360|480|720|1080|1440)p)$");
    private static final Pattern SID = Pattern.compile("^[0-9a-f]{32}$");
    // The routes a broadcast prefix carries (relay.mjs SCOPED_ROUTES): anything else under it is 404, these with another
    // method 405.
    private static final Pattern SCOPED_ROUTE = Pattern.compile("^(live\\.m3u8|(?:(?:240|360|480|720|1080|1440)p/|aac/|src/)?hls/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\\.(?:m3u8|mp4|m4s|ts)"
            + "|dvr|dvr\\.m3u8|dvr/file(?:\\.mp4)?|session(?:/[0-9a-f]{32})?)$");
    private static final int HEARTBEAT_MS = 15000;

    private final LiveMedia live;
    private final BroadcastScope scopes;
    private final HlsUpstream upstream;
    private final ViewerSessions sessions;
    private final Audience audience;
    private final Renditions renditions;
    private final Ladders ladders;
    private final ClientAddress client;
    private final FrameProperties props;
    private final RateLimit sessionRate;
    private final Gate hlsGate;
    private final Counter hlsPerIp = new Counter();
    private final JsonNode iceServers;

    public PlaybackController(LiveMedia live, BroadcastScope scopes, HlsUpstream upstream, ViewerSessions sessions, Audience audience,
                              Renditions renditions, Ladders ladders, ClientAddress client, FrameProperties props, JsonMapper json) {
        this.live = live;
        this.scopes = scopes;
        this.upstream = upstream;
        this.sessions = sessions;
        this.audience = audience;
        this.renditions = renditions;
        this.ladders = ladders;
        this.client = client;
        this.props = props;
        this.sessionRate = RateLimit.parse(props.rates().session());
        this.hlsGate = new Gate(props.limits().hlsInflight());
        JsonNode ice;
        try { ice = json.readTree(props.iceServers() == null || props.iceServers().isBlank() ? "[]" : props.iceServers()); }
        catch (RuntimeException e) { throw new IllegalArgumentException("RELAY_ICE_SERVERS must be a JSON array"); }
        if (ice == null || !ice.isArray()) throw new IllegalArgumentException("RELAY_ICE_SERVERS must be a JSON array");
        this.iceServers = ice;
    }

    /** The broadcast prefix a request named and the state its binding was checked on (null for the path routes). */
    public record Scope(String id, LiveMedia.State state) {}

    // ---- /info ------------------------------------------------------------------------------------------------------

    @GetMapping("/{path}/info")
    public ResponseEntity<Object> info(@PathVariable String path) {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        LiveMedia.State s = live.current(path);
        if (live.starting(s)) return Replies.busy(2, LiveMedia.STARTING);  // not {"running":false}: the list is not rebuilt yet
        ResponseEntity<Object> r = Replies.json(200, viewerInfo(path, s));
        return s.waiting() ? ResponseEntity.status(200).headers(r.getHeaders()).header(HttpHeaders.RETRY_AFTER, "2").body(r.getBody()) : r;
    }

    private Map<String, Object> viewerInfo(String path, LiveMedia.State s) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!s.live()) {
            out.put("running", false);
            out.put("path", path);
            return out;
        }
        Broadcast e = s.entry();
        MediaPath seen = s.ready() ? s.p() : e.seen;
        List<String> tracks = seen == null ? List.of() : seen.tracks();
        String audio = e.audio != null ? e.audio : tracks.isEmpty() ? "none" : tracks.contains("Opus") || tracks.contains("MPEG-4 Audio") ? "system" : "none";
        out.put("running", true);
        out.put("mediaReady", s.ready());
        out.put("path", path);
        out.put("width", e.width > 0 ? e.width : seen == null ? 0 : seen.width());
        out.put("height", e.height > 0 ? e.height : seen == null ? 0 : seen.height());
        out.put("fps", number(e.fps));
        out.put("bitrate", number(LivePlaylist.sourceMbps(e, seen)));
        out.put("audio", audio);
        out.put("codec", tracks.contains("H265") ? "H.265" : "H.264");
        out.put("elapsedMs", Math.max(0, System.currentTimeMillis() - e.startedAtRelayMs));
        out.put("startedAtMs", e.startedAtRelayMs);
        out.put("broadcastId", e.id);
        out.put("dvr", props.dvr().enabled());
        out.put("title", e.title);
        out.put("publisher", e.publisher);
        List<Map<String, Object>> qualities = new ArrayList<>();
        for (Renditions.Quality q : renditions.of(e, s.p(), s.paths())) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", q.name());
            m.put("width", q.width());
            m.put("height", q.height());
            m.put("mbps", number(q.mbps()));
            m.put("fps", number(q.fps()));
            m.put("codec", q.codec());
            qualities.add(m);
        }
        out.put("renditions", qualities);
        // HLS for every browser viewer (relative to /{path}/): the multivariant live playlist, the recording as an HLS EVENT
        // playlist, and the prefix under which master, DVR and the sessions answer for this broadcast only.
        if (props.hls()) {
            Map<String, Object> hls = new LinkedHashMap<>();
            hls.put("master", "live.m3u8");
            hls.put("lowLatency", true);
            hls.put("audio", LivePlaylist.audio(s, props.hlsAac()).present() ? "aac" : "none");
            hls.put("dvr", props.dvr().enabled() && !blank(props.dvr().recordDir()) ? "dvr.m3u8" : null);
            hls.put("scope", "b/" + e.id + "/");
            out.put("hls", hls);
            Map<String, String> variants = new LinkedHashMap<>();
            variants.put("opus", "hls/index.m3u8");
            if (props.hlsAac()) variants.put("aac", "aac/hls/index.m3u8");
            out.put("hlsVariants", variants);
        } else {
            out.put("hlsVariants", Map.of());
        }
        out.put("iceServers", iceServers());
        return out;
    }

    // RELAY_ICE_SERVERS plus short-lived TURN credentials (coturn use-auth-secret: username "expiry:frame", HMAC-SHA1).
    private JsonNode iceServers() {
        List<String> urls = props.turn().urlList();
        String secret = props.turn().secret();
        if (urls.isEmpty() || blank(secret)) return iceServers;
        ArrayNode out = ((ArrayNode) iceServers).deepCopy();
        String username = (System.currentTimeMillis() / 1000 + props.turn().ttlS()) + ":frame";
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            ObjectNode turn = out.addObject();
            ArrayNode list = turn.putArray("urls");
            urls.forEach(list::add);
            turn.put("username", username);
            turn.put("credential", Base64.getEncoder().encodeToString(mac.doFinal(username.getBytes(StandardCharsets.UTF_8))));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return out;
    }

    // ---- live.m3u8 ------------------------------------------------------------------------------------------------------

    @GetMapping("/{path}/live.m3u8")
    public ResponseEntity<Object> livePath(@PathVariable String path, HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        return livePlaylist(path, req, res, null);
    }

    @GetMapping("/{path}/b/{id}/live.m3u8")
    public ResponseEntity<Object> liveScoped(@PathVariable String path, @PathVariable String id, HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return livePlaylist(path, req, res, new Scope(id, b.state()));
    }

    private ResponseEntity<Object> livePlaylist(String path, HttpServletRequest req, HttpServletResponse res, Scope scope) throws IOException, InterruptedException {
        if (!props.hls()) return Replies.textNoStore(404, "Not found");
        String q = req.getParameter("q") == null ? "" : req.getParameter("q");
        if (!q.isEmpty() && !QUALITY.matcher(q).matches()) return Replies.textNoStore(404, "Quality is not available");
        LiveMedia.State s = scope != null ? scope.state() : live.current(path);
        if (!s.ready() || (scope != null && !BroadcastScope.ownSource(s.entry(), s.p()))) return notReady(s, scope);
        List<Renditions.Quality> ladder = renditions.ladder(s.entry(), s.p(), s.paths());
        String body = LivePlaylist.master(s, q, renditions.of(s.entry(), s.p(), s.paths()), ladder, ladders.failing(path), props.hlsAac());
        if (body.isEmpty()) return Replies.textNoStore(404, "Quality is not available");
        // Start the ladder now (no wait): the player asks for a variant right after this.
        if (!ladder.isEmpty() && !LivePlaylist.audio(s, props.hlsAac()).kind().equals("transcode")) ladders.ensure(path, ladder, path + "/src", 0);
        Replies.playlist(req, res, "application/vnd.apple.mpegurl", "max-age=2", body);
        return null;
    }

    // ---- HLS playlists and media ------------------------------------------------------------------------------------

    @GetMapping("/{path}/hls/{file}")
    public ResponseEntity<Object> hlsPath(@PathVariable String path, @PathVariable String file, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!Announcement.PATH.matcher(path).matches() || !FILE.matcher(file).matches()) return Replies.text(404, "Not found");
        return hls(path, null, file, req, res, null);
    }

    @GetMapping("/{path}/{variant}/hls/{file}")
    public ResponseEntity<Object> hlsPathVariant(@PathVariable String path, @PathVariable String variant, @PathVariable String file,
                                                 HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!Announcement.PATH.matcher(path).matches() || !VARIANT.matcher(variant).matches() || !FILE.matcher(file).matches()) return Replies.text(404, "Not found");
        return hls(path, variant, file, req, res, null);
    }

    @GetMapping("/{path}/b/{id}/hls/{file}")
    public ResponseEntity<Object> hlsScoped(@PathVariable String path, @PathVariable String id, @PathVariable String file, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!FILE.matcher(file).matches()) return Replies.textNoStore(404, "Not found");
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return hls(path, null, file, req, res, new Scope(id, b.state()));
    }

    @GetMapping("/{path}/b/{id}/{variant}/hls/{file}")
    public ResponseEntity<Object> hlsScopedVariant(@PathVariable String path, @PathVariable String id, @PathVariable String variant, @PathVariable String file,
                                                   HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (!VARIANT.matcher(variant).matches() || !FILE.matcher(file).matches()) return Replies.textNoStore(404, "Not found");
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return hls(path, variant, file, req, res, new Scope(id, b.state()));
    }

    // LL-HLS of the broadcast (or one quality, or the AAC transcode) through one shared MediaMTX session per path and
    // quality. Playlists max-age=1 (blocking reloads keyed by _HLS_msn/_HLS_part/_HLS_skip, the only query passed on),
    // init/parts/segments public max-age=60 (their names are unique per MediaMTX muxer).
    private ResponseEntity<Object> hls(String path, String variant, String file, HttpServletRequest req, HttpServletResponse res, Scope scope) throws IOException {
        if (!props.hls()) return Replies.textNoStore(404, "Not found");
        String ip = client.ip(req);
        try {
            LiveMedia.State s = scope != null ? scope.state() : live.current(path);
            if (!s.ready() || (scope != null && !BroadcastScope.ownSource(s.entry(), s.p()))) return notReady(s, scope);
            List<Renditions.Quality> ladder = variant != null && !variant.equals("aac") ? renditions.ladder(s.entry(), s.p(), s.paths()) : List.of();
            boolean missing = variant != null && (variant.equals("aac") ? !props.hlsAac()
                    : variant.equals("src") ? ladder.isEmpty()
                    : renditions.of(s.entry(), s.p(), s.paths()).stream().noneMatch(r -> r.name().equals(variant)));
            if (missing) return Replies.textNoStore(404, "Not found");
            // A quality path still published from the previous broadcast's source (its encoder has not restarted yet).
            if (scope != null && variant != null && !BroadcastScope.ownMedia(s.entry(), s.paths().get(path + "/" + variant))) return Replies.busy(2, "Media is not ready yet");
            audience.touchHls(path, hlsKey(req, ip));
            if (hlsPerIp.get(ip) >= props.limits().hlsPerIp()) return Replies.busy(2, "Too many HLS requests from this address");
            // The source copy and the relay's qualities come from the ladder (started here if needed; cheap once published).
            if (variant != null && (variant.equals("src") || ladder.stream().anyMatch(r -> r.name().equals(variant)))) {
                boolean started = ladders.ensure(path, ladder, path + "/" + variant, 15_000);
                if (scope != null) { ResponseEntity<Object> moved = scopes.moved(path, scope.id()); if (moved != null) return moved; }
                if (!started) return Replies.busy(1, "Quality is starting");
            }
            if (!hlsGate.enter()) return Replies.busy(2, "Server busy");
            hlsPerIp.add(ip, 1);
            try {
                String mtxPath = variant != null ? path + "/" + variant : path;
                String params = HlsUpstream.params(req.getParameter("_HLS_msn"), req.getParameter("_HLS_part"), req.getParameter("_HLS_skip"));
                if (file.endsWith(".m3u8")) {
                    // Blocking reloads are held by MediaMTX until the requested part exists; identical ones share one request.
                    HlsUpstream.Playlist p = upstream.playlist(mtxPath, file, params);
                    if (scope != null) { ResponseEntity<Object> moved = scopes.moved(path, scope.id()); if (moved != null) return moved; }
                    if (p.status() != 200) return failure(p.status());
                    Replies.playlist(req, res, p.type() != null ? p.type() : "application/vnd.apple.mpegurl", "max-age=1", p.body());
                    return null;
                }
                HlsUpstream.Media m = upstream.media(mtxPath, file, params);
                if (scope != null) {
                    ResponseEntity<Object> moved = scopes.moved(path, scope.id());
                    if (moved != null) { if (m.response() != null) m.response().body().close(); return moved; }
                }
                if (m.status() != 200) return failure(m.status());
                stream(m, req, res);
                return null;
            } finally {
                hlsGate.leave();
                hlsPerIp.add(ip, -1);
            }
        } catch (BodyCopy.Broken e) {
            // MediaMTX broke off (or stalled) after the answer started: the connection is aborted (Replies.abort), so the
            // player sees a failed request, never a shorter but apparently complete part.
            if (LogOnce.allow("hls-cut")) log.warn("HLS upstream broke off during {}: {}", file, e.why());
            Replies.abort(req, res);
            return null;
        } catch (ClientAbortException | AsyncRequestNotUsableException e) {
            // The viewer went away mid-transfer (Spring's response wrapper reports a failed write as
            // AsyncRequestNotUsableException): nothing to answer, nothing to log, and not an upstream failure.
            return null;
        } catch (Exception e) {
            // MediaMTX unreachable or restarting before the answer started.
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            if (!res.isCommitted()) {
                if (LogOnce.allow("hls-up")) log.warn("HLS upstream failed: {}", e.toString());
                return Replies.busy(2, "Media server is restarting");
            }
            Replies.abort(req, res);
            return null;
        }
    }

    // Init, parts and segments: copied while MediaMTX produces them (a preload-hinted part arrives as it is made).
    private static void stream(HlsUpstream.Media m, HttpServletRequest req, HttpServletResponse res) throws IOException {
        try (InputStream in = m.response().body()) {
            res.setStatus(200);
            res.setHeader(HttpHeaders.CONTENT_TYPE, m.response().headers().firstValue("Content-Type").orElse("video/mp4"));
            res.setHeader(HttpHeaders.CACHE_CONTROL, "public, max-age=60");
            m.response().headers().firstValue("Content-Length").ifPresent(v -> res.setHeader(HttpHeaders.CONTENT_LENGTH, v));
            if ("HEAD".equals(req.getMethod())) return;
            BodyCopy.copy(in, res.getOutputStream(), 15_000);
        }
    }

    // Upstream status -> the viewer's answer (never MediaMTX's own body, cookie or redirect).
    private static ResponseEntity<Object> failure(int status) {
        if (status == 404) return Replies.textNoStore(404, "Not found");
        if (status == 0) return Replies.busy(2, "Media server is restarting");
        return Replies.textNoStore(502, "Upstream error");
    }

    // ---- viewer sessions ------------------------------------------------------------------------------------------------

    @PostMapping("/{path}/session")
    public ResponseEntity<Object> openPath(@PathVariable String path, HttpServletRequest req) {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(405, "Method not allowed");
        return openSession(path, req, null);
    }

    @PostMapping("/{path}/b/{id}/session")
    public ResponseEntity<Object> openScoped(@PathVariable String path, @PathVariable String id, HttpServletRequest req) {
        if (!BroadcastScope.wellFormed(path, id)) return Replies.text(405, "Method not allowed");
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) return b.refused();
        return openSession(path, req, new Scope(id, b.state()));
    }

    // 200 {"sid","heartbeatMs"} | 503 + Retry-After (viewer cap, or this address holds too many) | 404 not running.
    private ResponseEntity<Object> openSession(String path, HttpServletRequest req, Scope scope) {
        String ip = client.ip(req);
        int wait = sessionRate.take(ip);
        if (wait > 0) return Replies.limited(wait);
        LiveMedia.State s = scope != null ? scope.state() : live.current(path);
        if (!s.live()) return live.starting(s) ? Replies.busy(2, LiveMedia.STARTING) : Replies.json(404, Map.of("error", "not-running"));
        ViewerSessions.Opened opened = audience.openSession(path, hlsKey(req, ip), ip, s.paths());
        if (opened.refusal() == ViewerSessions.Refusal.VIEWER_LIMIT) {
            if (LogOnce.allow("cap " + path)) log.warn("viewer limit {} reached on /{}", audience.perPathLimit(), path);
            return Replies.busy(15, "Viewer limit reached");
        }
        if (opened.refusal() == ViewerSessions.Refusal.ADDRESS_LIMIT) {
            if (LogOnce.allow("sess-ip " + ip)) log.warn("viewer sessions per address reached for {}", ip);
            return Replies.busy(15, "Too many viewers from this address");
        }
        return Replies.json(200, Map.of("sid", opened.sid(), "heartbeatMs", HEARTBEAT_MS));
    }

    @PutMapping("/{path}/session/{sid}")
    public ResponseEntity<Object> heartbeatPath(@PathVariable String path, @PathVariable String sid, HttpServletRequest req) {
        return touch(path, sid, req, false);
    }

    @DeleteMapping("/{path}/session/{sid}")
    public ResponseEntity<Object> leavePath(@PathVariable String path, @PathVariable String sid, HttpServletRequest req) {
        return touch(path, sid, req, true);
    }

    @PutMapping("/{path}/b/{id}/session/{sid}")
    public ResponseEntity<Object> heartbeatScoped(@PathVariable String path, @PathVariable String id, @PathVariable String sid, HttpServletRequest req) {
        if (!BroadcastScope.wellFormed(path, id)) return Replies.text(405, "Method not allowed");
        if (!SID.matcher(sid).matches()) return Replies.textNoStore(404, "Not found");
        BroadcastScope.Bound b = scopes.bind(path, id);
        if (b.refused() != null) {
            // A heartbeat of a broadcast that is gone closes its session (it never counts for the next broadcast).
            if (b.state() != null) { String ip = client.ip(req); sessions.touch(path, sid, hlsKey(req, ip), ip, true); }
            return b.refused();
        }
        return touch(path, sid, req, false);
    }

    @DeleteMapping("/{path}/b/{id}/session/{sid}")
    public ResponseEntity<Object> leaveScoped(@PathVariable String path, @PathVariable String id, @PathVariable String sid, HttpServletRequest req) {
        // Leaving always works, whatever is on the path now.
        if (!BroadcastScope.wellFormed(path, id)) return Replies.text(405, "Method not allowed");
        if (!SID.matcher(sid).matches()) return Replies.textNoStore(404, "Not found");
        return touch(path, sid, req, true);
    }

    private ResponseEntity<Object> touch(String path, String sid, HttpServletRequest req, boolean close) {
        if (!Announcement.PATH.matcher(path).matches() || !SID.matcher(sid).matches()) return Replies.text(405, "Method not allowed");
        String ip = client.ip(req);
        boolean known = sessions.touch(path, sid, hlsKey(req, ip), ip, close);
        return ResponseEntity.status(known ? 204 : 404).header(HttpHeaders.CACHE_CONTROL, "no-store").build();
    }

    /** Any other route under a broadcast prefix: 405 for one it carries with another method, else 404. */
    @RequestMapping("/{path}/b/{id}/**")
    public ResponseEntity<Object> otherScoped(@PathVariable String path, @PathVariable String id, HttpServletRequest req) {
        // A malformed prefix is no route: 404 for GET, 405 for anything else (relay.mjs handle()).
        if (!BroadcastScope.wellFormed(path, id))
            return req.getMethod().equals("GET") || req.getMethod().equals("HEAD") ? Replies.text(404, "Not found") : Replies.text(405, "Method not allowed");
        String prefix = "/" + path + "/b/" + id + "/";
        String rest = req.getRequestURI().startsWith(prefix) ? req.getRequestURI().substring(prefix.length()) : "";
        if (SCOPED_ROUTE.matcher(rest).matches()) return Replies.text(405, "Method not allowed");
        return Replies.textNoStore(404, "Not found");
    }

    // Media briefly away (sender reconnecting, MediaMTX restarting, or still another publisher session) -> wait; else not
    // running: JSON under a broadcast prefix (so a player tells it from the plain 404 of a quality), text on the path routes.
    private ResponseEntity<Object> notReady(LiveMedia.State s, Scope scope) {
        if (s.live()) return Replies.busy(2, "Media is not ready yet");
        if (live.starting(s)) return Replies.busy(2, LiveMedia.STARTING);
        return BroadcastScope.notRunning(scope != null);
    }

    // The address + browser of a request (an older relay's MediaMTX hlsSession cookie when a browser still sends one): the
    // fallback identity of an HLS client without a viewer session, and the key a session remembers for its own page.
    public static String hlsKey(HttpServletRequest req, String ip) {
        if (req.getCookies() != null)
            for (Cookie c : req.getCookies()) if (c.getName().equals("hlsSession") && !c.getValue().isEmpty() && c.getValue().length() <= 200) return "s:" + c.getValue();
        try {
            String ua = req.getHeader(HttpHeaders.USER_AGENT);
            byte[] d = MessageDigest.getInstance("SHA-256").digest((ip + " " + (ua == null ? "" : ua)).getBytes(StandardCharsets.UTF_8));
            return "a:" + Base64.getEncoder().encodeToString(d).substring(0, 16);
        } catch (Exception e) {
            return "a:" + ip;
        }
    }

    private static boolean blank(String s) { return s == null || s.isBlank(); }

    static Object number(double v) { return v == Math.rint(v) && Math.abs(v) < 1e15 ? (Object) (long) v : (Object) v; }
}
