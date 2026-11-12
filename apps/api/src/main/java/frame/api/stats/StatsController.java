package frame.api.stats;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.web.ClientAddress;
import frame.api.web.LogOnce;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * POST /{path}/stats (relay.mjs statsReport): a playback report from a viewer page (navigator.sendBeacon: text/plain; or
 * fetch with application/json), at most 2 KB, one per page every 4 s. Anonymous: no address is stored (see StatsLog).
 */
@RestController
public class StatsController {
    private static final Logger log = LoggerFactory.getLogger(StatsController.class);
    private static final Pattern TYPE = Pattern.compile("^(application/json|text/plain)\\b.*", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private final BroadcastRegistry registry;
    private final StatsLog stats;
    private final ClientAddress client;
    private final JsonMapper json;
    private final RateLimit rate;
    /** One report per page every 4 s (a burst of 1). */
    private final RateLimit perPage = new RateLimit(1, 0.25);

    public StatsController(BroadcastRegistry registry, StatsLog stats, ClientAddress client, JsonMapper json, FrameProperties props) {
        this.registry = registry;
        this.stats = stats;
        this.client = client;
        this.json = json;
        this.rate = RateLimit.parse(props.rates().stats());
    }

    @PostMapping("/{path}/stats")
    public ResponseEntity<Object> report(@PathVariable String path, HttpServletRequest req) throws IOException {
        if (!Announcement.PATH.matcher(path).matches()) return Replies.text(405, "Method not allowed");  // no route: Node's answer to a POST
        String ip = client.ip(req);
        int wait = rate.take(ip);
        if (wait > 0) return Replies.limited(wait);
        if (req.getContentType() == null || !TYPE.matcher(req.getContentType()).matches()) return Replies.text(415, "application/json or text/plain required");
        if (req.getContentLengthLong() > 2048) return Replies.text(413, "Report larger than 2 KB");
        byte[] body = req.getInputStream().readNBytes(2049);
        if (body.length > 2048) return Replies.text(413, "Report larger than 2 KB");
        if (!registry.known(path)) return Replies.textNoStore(404, "Stream is not running");
        JsonNode value;
        try { value = json.readTree(new String(body, StandardCharsets.UTF_8)); } catch (RuntimeException e) { return Replies.text(400, "Bad request"); }
        if (value == null || value.isMissingNode()) return Replies.text(400, "Bad request");
        StatsLog.Row row = StatsLog.row(path, value, System.currentTimeMillis());
        if (row.fields() == null) return Replies.text(400, row.error());
        wait = perPage.take(ip + " " + row.session());
        if (wait > 0) return Replies.limited(wait);
        if (stats.enabled()) {
            try { stats.append(row.fields()); }
            catch (IOException | RuntimeException e) { if (LogOnce.allow("stats-write")) log.warn("playback stats not written: {}", e.toString()); }
        }
        return Replies.noContent();
    }
}
