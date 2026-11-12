package frame.api.obs;

import frame.api.FrameProperties;
import frame.api.broadcast.PublisherTokens;
import frame.api.web.ClientAddress;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Publisher-only bootstrap/status. This is not a public creator-login or stream-key issuance service. */
@RestController
public class ObsController {
    private final ObsProperties props;
    private final ObsBroadcasts broadcasts;
    private final PublisherTokens tokens;
    private final ClientAddress client;
    private final JsonMapper json;
    private final RateLimit publishIp, authFail, requests;

    public ObsController(ObsProperties props, ObsBroadcasts broadcasts, PublisherTokens tokens, ClientAddress client, JsonMapper json, FrameProperties frame) {
        this.props = props; this.broadcasts = broadcasts; this.tokens = tokens; this.client = client; this.json = json;
        this.publishIp = RateLimit.parse(frame.rates().publishIp()); this.authFail = RateLimit.parse(frame.rates().authFail()); this.requests = RateLimit.parse(frame.rates().announce());
    }

    @GetMapping("/api/obs/{path}")
    public ResponseEntity<Object> status(@PathVariable String path, HttpServletRequest req) {
        ResponseEntity<Object> refusal = authorize(path, req);
        if (refusal != null) return refusal;
        ObsBroadcasts.State state = broadcasts.status(path);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", path); out.put("state", state.state()); out.put("broadcastId", state.broadcastId()); out.put("mediaReady", state.mediaReady());
        out.put("title", state.metadata().title()); out.put("publisher", state.metadata().publisher());
        out.putAll(broadcasts.metrics(path));
        out.put("serverUrl", props.serverUrl());
        // Return only the authenticated publisher's own credential, never a configured secret or another publisher's key.
        String token = req.getHeader(HttpHeaders.AUTHORIZATION).substring("Bearer ".length());
        out.put("streamKey", path + "?user=" + path + "&pass=" + URLEncoder.encode(token, StandardCharsets.UTF_8));
        return Replies.json(200, out);
    }

    @PutMapping("/api/obs/{path}")
    public ResponseEntity<Object> metadata(@PathVariable String path, HttpServletRequest req) throws IOException {
        ResponseEntity<Object> refusal = authorize(path, req);
        if (refusal != null) return refusal;
        if (req.getContentLengthLong() > 4096) return Replies.text(413, "Payload too large");
        byte[] body = req.getInputStream().readNBytes(4097);
        if (body.length > 4096) return Replies.text(413, "Payload too large");
        JsonNode value;
        try { value = json.readTree(body); } catch (Exception e) { return Replies.text(400, "Invalid JSON"); }
        String title = text(value, "title"), publisher = text(value, "publisher");
        if (title == null || title.isBlank() || title.getBytes(StandardCharsets.UTF_8).length > 200 || publisher == null || publisher.getBytes(StandardCharsets.UTF_8).length > 100)
            return Replies.text(400, "Title (1..200 UTF-8 bytes) and publisher (0..100 UTF-8 bytes) required");
        broadcasts.update(path, new ObsBroadcasts.Metadata(title.trim(), publisher.trim()));
        return Replies.noContent();
    }

    private ResponseEntity<Object> authorize(String path, HttpServletRequest req) {
        if (!props.enabled() || !ObsBroadcasts.PATH.matcher(path).matches()) return Replies.textNoStore(404, "Not found");
        String ip = client.ip(req);
        int wait = publishIp.take(ip);
        if (wait == 0) wait = authFail.peek(ip);
        if (wait > 0) return Replies.limited(wait);
        int owner = tokens.indexOf(req.getHeader(HttpHeaders.AUTHORIZATION));
        if (owner < 0) {
            authFail.take(ip);
            return ResponseEntity.status(401).contentType(Replies.TEXT).header(HttpHeaders.CACHE_CONTROL, "no-store")
                    .header(HttpHeaders.WWW_AUTHENTICATE, "Bearer realm=\"frame-relay\"").body("Publisher token required");
        }
        if (tokens.explicitOwner(path) != owner) return Replies.textNoStore(403, "Path not uniquely assigned to this publisher token");
        wait = requests.take("t" + owner);
        return wait > 0 ? Replies.limited(wait) : null;
    }

    private static String text(JsonNode node, String field) { return node != null && node.isObject() && node.path(field).isString() ? node.path(field).asString() : null; }
}
