package frame.api.playback;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.mediamtx.Deadline;
import frame.api.quality.Ladders;
import frame.api.quality.Renditions;
import frame.api.web.ClientAddress;
import frame.api.web.Gate;
import frame.api.web.LogOnce;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * WebRTC playback (relay.mjs whep): POST|PATCH|DELETE /{path}[/{quality}]/whep[/{session}] proxied to the loopback MediaMTX
 * WebRTC server. WHEP gets the same rules as HLS, so neither the viewer cap nor a broadcast binding can be bypassed with it:
 * an offer counts for the cap (RELAY_MAX_VIEWERS_PER_PATH) from the moment it is admitted until MediaMTX lists its reader,
 * and a page that names its broadcast (?b={id}, the React viewer's WebRTC fallback) is bound like the /{path}/b/{id}/ routes.
 */
@RestController
public class WhepController {
    private static final Logger log = LoggerFactory.getLogger(WhepController.class);
    private static final Pattern QUALITY = Pattern.compile("^(240|360|480|720|1080|1440)p$");
    private static final Pattern SESSION = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
    private static final int MAX_OFFER = 64 * 1024, MAX_ANSWER = 256 * 1024;

    private final LiveMedia live;
    private final Audience audience;
    private final Renditions renditions;
    private final Ladders ladders;
    private final ClientAddress client;
    private final RateLimit rate;
    private final Gate inflight;
    private final String webrtc;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5))
            .executor(Executors.newVirtualThreadPerTaskExecutor()).build();

    public WhepController(LiveMedia live, Audience audience, Renditions renditions, Ladders ladders, ClientAddress client, FrameProperties props) {
        this.live = live;
        this.audience = audience;
        this.renditions = renditions;
        this.ladders = ladders;
        this.client = client;
        this.rate = RateLimit.parse(props.rates().whep());
        this.inflight = new Gate(props.limits().whepInflight());
        this.webrtc = props.mediamtx().webrtc();
    }

    @RequestMapping(value = "/{path}/whep", method = {RequestMethod.POST, RequestMethod.PATCH, RequestMethod.DELETE})
    public ResponseEntity<Object> source(@PathVariable String path, HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        return whep(path, null, null, req, res);
    }

    @RequestMapping(value = "/{path}/{quality}/whep", method = {RequestMethod.POST, RequestMethod.PATCH, RequestMethod.DELETE})
    public ResponseEntity<Object> quality(@PathVariable String path, @PathVariable String quality, HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        return whep(path, quality, null, req, res);
    }

    @RequestMapping(value = "/{path}/whep/{session}", method = {RequestMethod.POST, RequestMethod.PATCH, RequestMethod.DELETE})
    public ResponseEntity<Object> sourceSession(@PathVariable String path, @PathVariable String session, HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        return whep(path, null, session, req, res);
    }

    @RequestMapping(value = "/{path}/{quality}/whep/{session}", method = {RequestMethod.POST, RequestMethod.PATCH, RequestMethod.DELETE})
    public ResponseEntity<Object> qualitySession(@PathVariable String path, @PathVariable String quality, @PathVariable String session,
                                                 HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        return whep(path, quality, session, req, res);
    }

    private ResponseEntity<Object> whep(String path, String quality, String session, HttpServletRequest req, HttpServletResponse res) throws IOException, InterruptedException {
        // Not a WHEP route of the Node relay: its answer to any other non-GET request.
        if (!Announcement.PATH.matcher(path).matches() || (quality != null && !QUALITY.matcher(quality).matches()) || (session != null && !SESSION.matcher(session).matches()))
            return Replies.text(405, "Method not allowed");
        boolean post = req.getMethod().equals("POST");
        if (post && session != null) return Replies.text(405, "Method not allowed");
        String ip = client.ip(req);
        String named = post ? req.getParameter("b") : null;
        if (named != null && !Announcement.ID.matcher(named).matches()) return Replies.textNoStore(400, "Bad broadcast id");
        boolean reserved = false;
        try {
            if (post) {
                LiveMedia.State s = live.current(path);
                BroadcastScope.Unbound unbound = named != null ? BroadcastScope.binding(s.entry(), named) : null;
                // (Right after a start the named broadcast may just not have announced again yet: wait, as under a broadcast prefix.)
                if (unbound != null) return unbound.status() == 404 && live.starting(s) ? Replies.busy(2, LiveMedia.STARTING)
                        : Replies.json(unbound.status(), Map.of("error", unbound.error()));
                // Media briefly away (sender reconnecting): 503 + Retry-After, which the UI waits out, instead of "not running".
                if (!s.ready()) return s.waiting() ? Replies.busy(2, "Media is not ready yet")
                        : live.starting(s) ? Replies.busy(2, LiveMedia.STARTING) : Replies.textNoStore(404, "Stream is not running");
                if (named != null && !BroadcastScope.ownSource(s.entry(), s.p())) return Replies.busy(2, "Media is not ready yet");
                if (quality != null && renditions.of(s.entry(), s.p(), s.paths()).stream().noneMatch(r -> r.name().equals(quality)))
                    return Replies.textNoStore(404, "Quality is not available");
                // The cap, the rate and the reservation in one step; counted from here until MediaMTX lists the reader.
                int admitted = audience.admitWhep(path, s.paths(), () -> rate.take(ip));
                if (admitted < 0) {
                    if (LogOnce.allow("cap " + path)) log.warn("viewer limit {} reached on /{}", audience.perPathLimit(), path);
                    return Replies.busy(15, "Viewer limit reached");
                }
                if (admitted > 0) return Replies.limited(admitted);
                reserved = true;
                // A relay quality is published by the broadcast's ladder: start it if needed and wait for the path.
                List<Renditions.Quality> ladder = quality != null ? renditions.ladder(s.entry(), s.p(), s.paths()) : List.of();
                if (ladder.stream().anyMatch(r -> r.name().equals(quality)) && !ladders.ensure(path, ladder, path + "/" + quality, 15_000))
                    return Replies.busy(2, "Quality is starting");
            }
            byte[] body = readLimited(req, MAX_OFFER);
            if (body == null) return Replies.text(413, "Payload too large");
            if (!inflight.enter()) return Replies.busy(2, "Server busy");
            try {
                // The validated route, never the raw request-target (one like "//host:port/..." would name another origin).
                String route = "/" + path + (quality != null ? "/" + quality : "") + "/whep" + (session != null ? "/" + session : "");
                HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(webrtc + route)).timeout(Duration.ofSeconds(20))
                        .method(req.getMethod(), HttpRequest.BodyPublishers.ofByteArray(body)).header("X-Forwarded-For", ip);
                for (String h : List.of("Content-Type", "If-Match")) if (req.getHeader(h) != null) b.header(h, req.getHeader(h));
                // Relay qualities wait until their encoder delivers a keyframe, hence the long timeout (answer body included).
                HttpResponse<byte[]> up = Deadline.send(http, b.build(), HttpResponse.BodyHandlers.ofByteArray(), Duration.ofSeconds(20));
                if (reserved && up.statusCode() == 201) { reserved = false; audience.releaseWhepWhenListed(path); }  // a session exists from here
                byte[] data = up.body();
                if (data.length > MAX_ANSWER) throw new IOException("upstream body too large");
                res.setStatus(up.statusCode());
                up.headers().firstValue("Content-Type").ifPresent(v -> res.setHeader(HttpHeaders.CONTENT_TYPE, v));
                res.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
                up.headers().firstValue("Location").ifPresent(v -> res.setHeader(HttpHeaders.LOCATION, location(v, route)));  // stay on the relay
                // Repeated headers (a Link per ICE server) joined as Node does.
                for (String h : List.of("ETag", "Link", "Accept-Patch")) {
                    List<String> values = up.headers().allValues(h);
                    if (!values.isEmpty()) res.setHeader(h, String.join(", ", values));
                }
                res.setContentLength(data.length);
                res.getOutputStream().write(data);
                if (post) log.info("WHEP /{}{} from {} -> {}", path, quality != null ? "/" + quality : "", ip, up.statusCode());
                return null;
            } catch (Exception e) {
                if (e instanceof InterruptedException) Thread.currentThread().interrupt();
                if (LogOnce.allow("whep-up")) log.warn("WHEP upstream failed: {}", e.toString());
                // Relay MediaMTX restarting (refused/timed out): a short wait the UI honours, not a hard failure.
                // (Nothing of the answer is set before the upstream answer was read whole.)
                return res.isCommitted() ? null : Replies.busy(2, "Media server is restarting");
            } finally {
                inflight.leave();
            }
        } finally {
            if (reserved) audience.releaseWhep(path);
        }
    }

    // MediaMTX's session URL, kept on this origin: an absolute path as it is, a relative one resolved against the route.
    static String location(String value, String route) {
        if (value.startsWith("/")) return value;
        try {
            return URI.create("http://x" + route).resolve(value).getRawPath();
        } catch (IllegalArgumentException e) {
            return route;
        }
    }

    private static byte[] readLimited(HttpServletRequest req, int limit) throws IOException {
        if (req.getContentLengthLong() > limit) return null;
        byte[] data = req.getInputStream().readNBytes(limit + 1);
        return data.length > limit ? null : data;
    }
}
