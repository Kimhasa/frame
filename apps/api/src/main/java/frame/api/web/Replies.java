package frame.api.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/**
 * The relay's answer shapes, kept byte-compatible with the Node relay: plain text for errors of the path routes, JSON
 * {"error": ...} under a broadcast prefix, 503/429 always with Retry-After so players and senders back off.
 */
public final class Replies {
    public static final MediaType TEXT = new MediaType("text", "plain", StandardCharsets.UTF_8);
    public static final MediaType JSON = new MediaType("application", "json", StandardCharsets.UTF_8);
    public static final MediaType M3U8 = MediaType.parseMediaType("application/vnd.apple.mpegurl");

    private Replies() {}

    public static ResponseEntity<Object> text(int status, String message) {
        return ResponseEntity.status(status).contentType(TEXT).body(message);
    }

    public static ResponseEntity<Object> textNoStore(int status, String message) {
        return ResponseEntity.status(status).contentType(TEXT).header(HttpHeaders.CACHE_CONTROL, "no-store").body(message);
    }

    public static ResponseEntity<Object> json(int status, Object value) {
        return ResponseEntity.status(status).contentType(JSON).header(HttpHeaders.CACHE_CONTROL, "no-store").body(value);
    }

    /** 503 + Retry-After: the client waits and asks again (media briefly away, a cap, a restart). */
    public static ResponseEntity<Object> busy(int seconds, String message) {
        return ResponseEntity.status(503).contentType(TEXT).header(HttpHeaders.CACHE_CONTROL, "no-store")
                .header(HttpHeaders.RETRY_AFTER, Integer.toString(seconds)).body(message);
    }

    public static ResponseEntity<Object> limited(int seconds) {
        return ResponseEntity.status(429).contentType(TEXT).header(HttpHeaders.CACHE_CONTROL, "no-store")
                .header(HttpHeaders.RETRY_AFTER, Integer.toString(seconds)).body("Too many requests");
    }

    public static ResponseEntity<Object> noContent() {
        return ResponseEntity.noContent().header(HttpHeaders.CACHE_CONTROL, "no-store").build();
    }

    /**
     * A playlist (or another fixed body) written as it is: no message converter, which would add a charset, or
     * Content-Disposition for the .m3u8 extension as reflected-file-download protection. The same bytes for every viewer.
     */
    public static void write(HttpServletRequest req, HttpServletResponse res, int status, String type, String cache, byte[] body) throws IOException {
        res.setStatus(status);
        res.setHeader(HttpHeaders.CONTENT_TYPE, type);
        if (cache != null) res.setHeader(HttpHeaders.CACHE_CONTROL, cache);
        res.setContentLength(body.length);
        if (!"HEAD".equals(req.getMethod())) res.getOutputStream().write(body);
    }

    /** Request attribute set by {@link #abort}: WebDefaults (the outermost filter) then aborts the connection. */
    public static final String ABORT = "frame.abort";

    /**
     * Ends an answer whose media headers are set when its body cannot be completed (MediaMTX broke off, a recording could
     * not be read): the client must see a failed transfer, never a shorter but apparently complete body (Node's destroy()).
     * What is set is committed first (otherwise Tomcat would send a 500 page under those headers) and the request is
     * marked; the caller returns without writing more. The connection is then closed by WebDefaults, outside Spring MVC:
     * an exception thrown from a controller would be resolved by Spring's own handlers (they treat a ClientAbortException
     * as a client that went away, and match a RuntimeException cause to the 500 handler), the answer would be completed
     * with its terminating chunk and the cut body would look whole.
     */
    public static void abort(HttpServletRequest req, HttpServletResponse res) {
        try { if (!res.isCommitted()) res.flushBuffer(); } catch (IOException ignored) { }
        req.setAttribute(ABORT, Boolean.TRUE);
    }

    public static void playlist(HttpServletRequest req, HttpServletResponse res, String type, String cache, String body) throws IOException {
        write(req, res, 200, type, cache, body.getBytes(StandardCharsets.UTF_8));
    }
}
