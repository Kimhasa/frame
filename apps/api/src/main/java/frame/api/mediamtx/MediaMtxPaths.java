package frame.api.mediamtx;

import frame.api.FrameProperties;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Read-only view of the relay MediaMTX through its loopback API, shared by every request: the path list is fetched at
 * most once per second however many viewers poll /info, and the inbound byte counters give a measured bitrate.
 * When the API fails, the last good list stays in use (marked stale) for RELAY_MEDIAMTX_STALE_MS, so one slow answer does
 * not make every broadcast look offline. The MediaMTX API itself is never reachable through this service.
 */
@Component
public class MediaMtxPaths {
    private static final Logger log = LoggerFactory.getLogger(MediaMtxPaths.class);
    private final ExecutorService exec = Executors.newVirtualThreadPerTaskExecutor();
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(3)).executor(exec).build();
    private final JsonMapper json;
    private final String api, auth;
    private final long staleMs;

    private record Rate(long bytes, long at, double mbps) {}

    private volatile Map<String, MediaPath> paths = Map.of();
    private final Map<String, Rate> rates = new HashMap<>();
    private volatile long at, goodAt;
    private volatile boolean ok, stale;
    private CompletableFuture<Void> pending;

    public MediaMtxPaths(FrameProperties props, JsonMapper json) {
        this.json = json;
        this.api = props.mediamtx().api();
        this.staleMs = props.mediamtx().staleMs();
        String user = props.mediamtx().apiUser();
        this.auth = user == null || user.isEmpty() ? null
                : "Basic " + Base64.getEncoder().encodeToString((user + ":" + props.mediamtx().apiPass()).getBytes(StandardCharsets.UTF_8));
    }

    /** The path list, refreshed when older than 1 s; once a list exists a slow API holds a caller at most 1.5 s. */
    public Map<String, MediaPath> list() {
        if (System.currentTimeMillis() - at < 1000) return paths;
        CompletableFuture<Void> job;
        synchronized (this) {
            if (pending == null) {
                // Stored before the work starts, and cleared only if it is still this job: a refresh that finishes at once
                // can never leave a completed future behind (which would stop all later refreshes).
                CompletableFuture<Void> mine = new CompletableFuture<>();
                pending = mine;
                exec.execute(() -> {
                    try { refresh(); } finally {
                        synchronized (this) { if (pending == mine) pending = null; }
                        mine.complete(null);
                    }
                });
            }
            job = pending;
        }
        try {
            if (at > 0) job.get(1500, TimeUnit.MILLISECONDS); else job.get();
        } catch (Exception ignored) {
            // The list callers would have had (timeouts and failures are handled in refresh()).
        }
        return paths;
    }

    /** The last list without refreshing (re-checks after a wait read this, never a new lookup). */
    public Map<String, MediaPath> last() { return paths; }

    public boolean ok() { return ok; }
    public boolean stale() { return stale; }
    /** When the last successful refresh finished (a WHEP reader shows in the list two refreshes after its answer). */
    public long goodAt() { return goodAt; }

    private void refresh() {
        long now = System.currentTimeMillis();
        try {
            List<JsonNode> items = new ArrayList<>();
            for (int page = 0, pages = 1; page < pages && page < 20; page++) {
                JsonNode r = get("/v3/paths/list?itemsPerPage=500&page=" + page);
                pages = Math.max(1, r.path("pageCount").asInt(1));
                for (JsonNode item : r.path("items")) items.add(item);
            }
            Map<String, MediaPath> next = new HashMap<>();
            synchronized (rates) {
                for (JsonNode p : items) {
                    String name = p.path("name").asString("");
                    JsonNode video = null;
                    List<String> tracks = new ArrayList<>();
                    for (JsonNode t : p.path("tracks2")) {
                        String codec = t.path("codec").asString("");
                        tracks.add(codec);
                        if (video == null && (codec.equals("H264") || codec.equals("H265") || codec.equals("AV1") || codec.equals("VP9"))) video = t;
                    }
                    if (tracks.isEmpty()) for (JsonNode t : p.path("tracks")) tracks.add(t.asString(""));
                    long bytesIn = p.has("inboundBytes") ? p.path("inboundBytes").asLong(0) : p.path("bytesReceived").asLong(0);
                    Rate prev = rates.get(name);
                    double mbps = prev == null ? 0 : prev.mbps();
                    if (prev != null && now > prev.at() && bytesIn >= prev.bytes()) {
                        double sample = (bytesIn - prev.bytes()) * 8 / ((now - prev.at()) / 1000.0) / 1e6;
                        mbps = prev.mbps() > 0 ? prev.mbps() * 0.8 + sample * 0.2 : sample;
                    }
                    rates.put(name, new Rate(bytesIn, now, mbps));
                    long readyMs = time(p.has("readyTime") ? p.path("readyTime") : p.path("availableTime"));
                    boolean ready = p.has("ready") ? p.path("ready").asBoolean(false) : p.path("available").asBoolean(false);
                    int readers = 0, webrtc = 0;
                    for (JsonNode r : p.path("readers")) {
                        readers++;
                        if (r.path("type").asString("").toLowerCase(Locale.ROOT).contains("webrtc")) webrtc++;
                    }
                    JsonNode props = video == null ? null : video.path("codecProps");
                    double avg = readyMs > 0 && now - readyMs >= 10000 && bytesIn > 0 ? bytesIn * 8 / ((now - readyMs) / 1000.0) / 1e6 : 0;
                    next.put(name, new MediaPath(ready, readyMs, List.copyOf(tracks),
                            props == null ? 0 : props.path("width").asInt(0), props == null ? 0 : props.path("height").asInt(0),
                            props == null || !props.path("profile").isString() ? null : props.path("profile").asString(),
                            props == null || !props.path("level").isString() ? null : props.path("level").asString(),
                            p.path("source").path("type").asString(""), readers, webrtc, bytesIn, mbps, avg, p.path("source").path("id").asString("")));
                }
                rates.keySet().retainAll(next.keySet());
            }
            if (!ok) log.info("MediaMTX API reachable");
            ok = true;
            stale = false;
            goodAt = System.currentTimeMillis();
            paths = Map.copyOf(next);
        } catch (Exception e) {
            if (ok || at == 0) log.warn("MediaMTX API unavailable: {}", e.toString());
            ok = false;
            if (!paths.isEmpty() && System.currentTimeMillis() - goodAt <= staleMs) stale = true;
            else { paths = Map.of(); stale = false; }
        }
        at = System.currentTimeMillis();
    }

    private JsonNode get(String path) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(api + path)).timeout(Duration.ofSeconds(3)).GET();
        if (auth != null) b.header("Authorization", auth);
        // A deadline for the whole exchange: the JDK client's request timeout ends with the headers.
        HttpResponse<String> res = Deadline.send(http, b.build(), HttpResponse.BodyHandlers.ofString(), Duration.ofSeconds(3));
        if (res.statusCode() != 200) throw new IllegalStateException("MediaMTX API " + res.statusCode());
        return json.readTree(res.body());
    }

    /** MediaMTX readyTime ("2026-11-09T16:33:44.5946245+09:00": local offset, 7 fraction digits) in epoch ms, 0 if unknown. */
    static long time(JsonNode v) {
        if (!v.isString()) return 0;
        try { return Instant.parse(v.asString()).toEpochMilli(); } catch (Exception e) { return 0; }
    }

    /** The first viewer or sender request must not wait for the first API refresh (the Node relay lists once at listen). */
    @EventListener(ApplicationReadyEvent.class)
    public void warmUp() {
        exec.execute(this::list);
    }
}
