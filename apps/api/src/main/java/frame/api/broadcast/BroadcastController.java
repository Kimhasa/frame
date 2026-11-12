package frame.api.broadcast;

import frame.api.FrameProperties;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.web.ClientAddress;
import frame.api.web.LogOnce;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Broadcast registration (the Windows sender app) and the public list (the React viewer):
 * <pre>
 *   POST /api/broadcasts/announce            publisher token; {"v":1,"type":"announce"|"bye",...} -> 204 + X-Frame-Media-Ready
 *   PUT  /api/broadcasts/{id}/thumbnail      publisher token; image/jpeg up to 256 KB
 *   GET  /api/broadcasts                     {"items":[...]}: announced broadcasts whose media reaches the relay
 *   GET  /thumbnails/{id}.jpg
 * </pre>
 * Publisher requests are rate limited per address before the token is compared, so while an address is limited a correct
 * token is refused exactly like a wrong one and guessing gains nothing.
 */
@RestController
public class BroadcastController {
    private static final Logger log = LoggerFactory.getLogger(BroadcastController.class);
    private final BroadcastRegistry registry;
    private final PublisherTokens tokens;
    private final MediaMtxPaths mediamtx;
    private final ClientAddress client;
    private final JsonMapper json;
    private final RateLimit publishIp, authFail, announceRate;

    public BroadcastController(BroadcastRegistry registry, PublisherTokens tokens, MediaMtxPaths mediamtx, ClientAddress client, JsonMapper json, FrameProperties props) {
        this.registry = registry;
        this.tokens = tokens;
        this.mediamtx = mediamtx;
        this.client = client;
        this.json = json;
        this.publishIp = RateLimit.parse(props.rates().publishIp());
        this.authFail = RateLimit.parse(props.rates().authFail());
        this.announceRate = RateLimit.parse(props.rates().announce());
    }

    @PostMapping("/api/broadcasts/announce")
    public ResponseEntity<Object> announce(HttpServletRequest req) throws IOException {
        String ip = client.ip(req);
        Object token = publisher(req, ip, "announce");
        if (token instanceof ResponseEntity<?> refused) return cast(refused);
        byte[] body = readLimited(req, 4096);
        if (body == null) return Replies.text(413, "Payload too large");
        JsonNode message;
        try { message = json.readTree(body); } catch (Exception e) { return Replies.text(400, "Bad request"); }
        BroadcastRegistry.Result r = registry.announce(message, (Integer) token);
        if (r.status() != 204) {
            if (LogOnce.allow("ann " + ip + " " + r.reason())) log.info("announce refused ({} {}) from {}", r.status(), r.reason(), ip);
            ResponseEntity.BodyBuilder b = ResponseEntity.status(r.status()).contentType(Replies.TEXT);
            if (r.status() == 503) b.header(HttpHeaders.RETRY_AFTER, "30");
            return b.body(r.reason());
        }
        // The sender tells "listed" from "announced but no media reaches the relay" without another endpoint, and sees which
        // optional fields were dropped as invalid.
        boolean ready = false;
        if (r.path() != null) { MediaPath p = mediamtx.list().get(r.path()); ready = p != null && p.ready(); }
        ResponseEntity.HeadersBuilder<?> ok = ResponseEntity.noContent().header("X-Frame-Media-Ready", ready ? "1" : "0");
        if (!r.ignored().isEmpty()) ok.header("X-Frame-Ignored", String.join(",", r.ignored()));
        return cast(ok.build());
    }

    @RequestMapping(path = "/api/broadcasts/{id}/thumbnail", method = {RequestMethod.PUT, RequestMethod.POST})
    public ResponseEntity<Object> thumbnail(@PathVariable String id, HttpServletRequest req) throws IOException {
        if (!Announcement.ID.matcher(id).matches()) return Replies.text(404, "Not found");
        String ip = client.ip(req);
        Object token = publisher(req, ip, "thumbnail");
        if (token instanceof ResponseEntity<?> refused) return cast(refused);
        String type = req.getContentType();
        if (type == null || !type.toLowerCase(Locale.ROOT).matches("^image/jpeg\\b.*")) return Replies.text(415, "image/jpeg required");
        byte[] body = readLimited(req, 256 * 1024);
        if (body == null) return Replies.text(413, "Thumbnail larger than 256 KB");
        if (body.length < 4 || (body[0] & 0xff) != 0xff || (body[1] & 0xff) != 0xd8 || (body[2] & 0xff) != 0xff) return Replies.text(400, "Not a JPEG image");
        int status = registry.setThumbnail(id, (Integer) token, body);
        return status == 204 ? cast(ResponseEntity.noContent().build()) : Replies.text(status, status == 404 ? "Unknown broadcast" : "Not your broadcast");
    }

    @GetMapping("/api/broadcasts")
    public ResponseEntity<Object> list(HttpServletRequest req) {
        Map<String, MediaPath> paths = mediamtx.list();
        String origin = client.publicBase(req);
        List<Map<String, Object>> items = new ArrayList<>();
        for (Broadcast e : registry.all()) {
            MediaPath p = paths.get(e.path);
            if (p == null || !p.ready()) continue;
            e.observe(p, mediamtx.stale());
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", e.id);
            item.put("title", e.title);
            item.put("publisher", e.publisher);
            item.put("baseUrl", origin);
            item.put("path", e.path);
            item.put("thumbnailUrl", origin + "/thumbnails/" + e.id + ".jpg");
            item.put("width", e.width > 0 ? e.width : p.width());
            item.put("height", e.height > 0 ? e.height : p.height());
            item.put("fps", number(e.fps));
            item.put("running", true);
            item.put("startedAtMs", e.startedAtRelayMs);
            items.add(item);
        }
        return Replies.json(200, Map.of("items", items));
    }

    // Only "<32 hex>.jpg" (Node: ^/thumbnails/([0-9a-f]{32})\.jpg$): any other name, such as a stream path called
    // "thumbnails" asking for /thumbnails/info, goes on to the other routes.
    @GetMapping("/thumbnails/{id:[0-9a-f]+}.jpg")
    public ResponseEntity<Object> thumbnailImage(@PathVariable String id) {
        if (!Announcement.ID.matcher(id).matches()) return Replies.text(404, "Not found");
        Broadcast e = registry.get(id);
        byte[] jpeg = e == null ? null : e.thumbnail();
        if (jpeg == null) return Replies.textNoStore(404, "Not found");
        return ResponseEntity.ok().contentType(MediaType.IMAGE_JPEG).header(HttpHeaders.CACHE_CONTROL, "max-age=4").body(jpeg);
    }

    // The token's index, or the refusal: 429 while this address (or this token) is limited, 401 for a missing or wrong token.
    private Object publisher(HttpServletRequest req, String ip, String what) {
        int wait = publishIp.take(ip);
        if (wait == 0) wait = authFail.peek(ip);
        if (wait > 0) return Replies.limited(wait);
        int token = tokens.indexOf(req.getHeader(HttpHeaders.AUTHORIZATION));
        if (token < 0) {
            authFail.take(ip);
            if (LogOnce.allow("auth " + ip)) log.warn("{} with a missing or wrong token from {}", what, ip);
            return ResponseEntity.status(401).contentType(Replies.TEXT).header(HttpHeaders.WWW_AUTHENTICATE, "Bearer realm=\"frame-relay\"").body("Publisher token required");
        }
        wait = announceRate.take("t" + token);
        if (wait > 0) return Replies.limited(wait);
        return token;
    }

    // The body up to `limit` bytes, or null when it is larger.
    static byte[] readLimited(HttpServletRequest req, int limit) throws IOException {
        if (req.getContentLengthLong() > limit) return null;
        try (InputStream in = req.getInputStream()) {
            byte[] data = in.readNBytes(limit + 1);
            return data.length > limit ? null : data;
        }
    }

    // A JSON number as JavaScript writes it: 30, not 30.0.
    static Object number(double v) { return v == Math.rint(v) && Math.abs(v) < 1e15 ? (Object) (long) v : (Object) v; }

    @SuppressWarnings("unchecked")
    private static ResponseEntity<Object> cast(ResponseEntity<?> r) { return (ResponseEntity<Object>) r; }
}
