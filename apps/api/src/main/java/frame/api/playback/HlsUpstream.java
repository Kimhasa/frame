package frame.api.playback;

import frame.api.FrameProperties;
import frame.api.mediamtx.Deadline;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.quality.Ladders;
import frame.api.web.LogOnce;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * LL-HLS from the loopback MediaMTX (server/lib/hls.mjs UpstreamHls). MediaMTX 1.21 serves media playlists and parts only
 * inside an HLS session its index.m3u8 created, so one session per MediaMTX path is shared by every viewer and its ids are
 * removed from the playlists: every viewer gets the same bytes, and no MediaMTX cookie or cookie check reaches a browser
 * or a CDN. Identical playlist requests (the same blocking _HLS_msn/_HLS_part) share one upstream request.
 */
@Component
public class HlsUpstream {
    private static final Logger log = LoggerFactory.getLogger(HlsUpstream.class);
    private static final Pattern SESSION = Pattern.compile("[?&]session=([0-9a-fA-F-]{1,64})");

    /** A playlist answer (session ids stripped); status 0 = MediaMTX unreachable. */
    record Playlist(int status, String type, String body) {}

    /** A media answer: the upstream stream when status is 200 (the caller closes it). */
    record Media(int status, HttpResponse<InputStream> response) {}

    private record Made(String id, int status) {}

    private static final class Flight {
        final CompletableFuture<Playlist> answer;
        volatile long doneAt;
        Flight(CompletableFuture<Playlist> answer) { this.answer = answer; }
    }

    private final ExecutorService exec = Executors.newVirtualThreadPerTaskExecutor();
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).executor(exec).build();
    private final String base;
    private final ConcurrentHashMap<String, String> sessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CompletableFuture<Made>> making = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Flight> flights = new ConcurrentHashMap<>();

    private final MediaMtxPaths mediamtx;

    public HlsUpstream(FrameProperties props, MediaMtxPaths mediamtx) {
        this.base = props.mediamtx().hls();
        this.mediamtx = mediamtx;
    }

    /**
     * A ladder (re)started: its paths get new MediaMTX muxers, so their old shared sessions are useless. Once each path is
     * published its session is opened here (its index.m3u8 takes about a segment), so a player's first switch finds it.
     */
    @EventListener
    public void ladderStarted(Ladders.Started started) {
        for (String name : started.names()) {
            sessions.remove(name);
            exec.execute(() -> {
                try {
                    for (int i = 0; i < 75; i++) {
                        MediaPath p = mediamtx.list().get(name);
                        if (p != null && p.ready()) { session(name, ""); return; }
                        Thread.sleep(200);
                    }
                } catch (Exception ignored) { }
            });
        }
    }

    /** The LL-HLS query keys a player may send; everything else is dropped (a CDN keys playlists by exactly these). */
    static String params(String msn, String part, String skip) {
        StringBuilder out = new StringBuilder();
        String[][] all = {{"_HLS_msn", msn}, {"_HLS_part", part}, {"_HLS_skip", skip}};
        for (String[] kv : all) if (kv[1] != null && !kv[1].isEmpty() && kv[1].length() < 16 && kv[1].matches("[0-9YESvy]+")) out.append('&').append(kv[0]).append('=').append(kv[1]);
        return out.toString();
    }

    /** MediaMTX writes its session id (and the request's query) into every URI of the playlists: removed. */
    static String stripPlaylistQueries(String body) {
        String[] lines = body.split("\n", -1);
        StringBuilder out = new StringBuilder(body.length());
        for (int i = 0; i < lines.length; i++) {
            String raw = lines[i];
            boolean cr = raw.endsWith("\r");
            String line = cr ? raw.substring(0, raw.length() - 1) : raw;
            String fixed = line.startsWith("#") ? line.replaceAll("URI=\"([^\"?]*)\\?[^\"]*\"", "URI=\"$1\"") : line.split("\\?", 2)[0];
            if (i > 0) out.append('\n');
            out.append(fixed);
            if (cr) out.append('\r');
        }
        return out.toString();
    }

    /** A playlist of MediaMTX path {@code mtxPath} ("screen-01"). */
    Playlist playlist(String mtxPath, String file, String params) throws Exception {
        Made s = session(mtxPath, "");
        if (s.id() == null) return new Playlist(s.status() == 0 ? 502 : s.status(), null, "");
        for (int attempt = 0; ; attempt++) {
            Playlist r = shared(target(mtxPath, file, s.id(), params));
            // 401: MediaMTX ended the shared session (idle). 404: its muxer is gone (the publisher restarted) and a request
            // with the old session does not create the new one; only index.m3u8 does. Either way a new session, once.
            if ((r.status() != 401 && r.status() != 404) || attempt > 0) return r;
            s = session(mtxPath, s.id());
            if (s.id() == null) return new Playlist(s.status() == 0 ? 502 : s.status(), null, "");
        }
    }

    /** An init, part or segment; a preload-hinted part arrives while MediaMTX produces it, so it is streamed. */
    Media media(String mtxPath, String file, String params) throws Exception {
        Made s = session(mtxPath, "");
        if (s.id() == null) return new Media(s.status() == 0 ? 502 : s.status(), null);
        for (int attempt = 0; ; attempt++) {
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + target(mtxPath, file, s.id(), params))).timeout(Duration.ofSeconds(15)).GET().build();
            HttpResponse<InputStream> res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
            if (res.statusCode() == 200) return new Media(200, res);
            res.body().close();
            if (res.statusCode() != 401 || attempt > 0) return new Media(res.statusCode(), null);
            s = session(mtxPath, s.id());
            if (s.id() == null) return new Media(s.status() == 0 ? 502 : s.status(), null);
        }
    }

    // The shared session of a MediaMTX path, made once by its index.m3u8; `stale` is a session MediaMTX refused.
    private Made session(String mtxPath, String stale) throws Exception {
        String id = sessions.get(mtxPath);
        if (id != null && !id.equals(stale)) return new Made(id, 200);
        CompletableFuture<Made> mine = new CompletableFuture<>();
        CompletableFuture<Made> job = making.putIfAbsent(mtxPath, mine);
        if (job == null) {
            job = mine;
            // Removed before it completes: a later caller finds the session in `sessions` or starts a new job.
            exec.execute(() -> { Made made = makeSession(mtxPath); making.remove(mtxPath, mine); mine.complete(made); });
        }
        return job.get();
    }

    private Made makeSession(String mtxPath) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/" + mtxPath + "/index.m3u8?cookieCheck=1")).timeout(Duration.ofSeconds(30)).GET().build();
            HttpResponse<byte[]> res = Deadline.send(http, req, HttpResponse.BodyHandlers.ofByteArray(), Duration.ofSeconds(30));
            if (res.statusCode() != 200) {
                if (res.statusCode() != 404 && LogOnce.allow("hls-session " + res.statusCode())) log.warn("HLS session for {} -> {}", mtxPath, res.statusCode());
                return new Made(null, res.statusCode());
            }
            Matcher m = SESSION.matcher(new String(res.body(), StandardCharsets.UTF_8));
            if (!m.find()) { if (LogOnce.allow("hls-session-none")) log.warn("HLS session for {}: no session in index.m3u8", mtxPath); return new Made(null, 502); }
            if (sessions.size() > 4096) sessions.clear();
            sessions.put(mtxPath, m.group(1));
            return new Made(m.group(1), 200);
        } catch (Exception e) {
            if (LogOnce.allow("hls-session-err")) log.warn("HLS session for {} failed: {}", mtxPath, e.toString());
            return new Made(null, 0);
        }
    }

    private static String target(String mtxPath, String file, String sid, String params) {
        return "/" + mtxPath + "/" + file + "?cookieCheck=1&session=" + sid + params;
    }

    // Requests for the same upstream URL share one upstream request and its successful answer for 1 s.
    private Playlist shared(String url) throws Exception {
        long now = System.currentTimeMillis();
        Flight[] created = new Flight[1];
        Flight flight = flights.compute(url, (k, cur) -> {
            if (cur != null && (cur.doneAt == 0 || now - cur.doneAt < 1000)) return cur;
            return created[0] = new Flight(new CompletableFuture<>());
        });
        if (created[0] != flight) return flight.answer.get();
        exec.execute(() -> {
            try {
                HttpRequest req = HttpRequest.newBuilder(URI.create(base + url)).timeout(Duration.ofSeconds(15)).GET().build();
                HttpResponse<byte[]> res = Deadline.send(http, req, HttpResponse.BodyHandlers.ofByteArray(), Duration.ofSeconds(15));
                if (res.body().length > 4 << 20) throw new IOException("upstream playlist too large");
                String type = res.headers().firstValue("Content-Type").orElse(null);
                Playlist p = new Playlist(res.statusCode(), type, res.statusCode() == 200 ? stripPlaylistQueries(new String(res.body(), StandardCharsets.UTF_8)) : "");
                if (p.status() == 200) flight.doneAt = System.currentTimeMillis(); else flights.remove(url, flight);
                flight.answer.complete(p);
            } catch (Exception e) {
                flights.remove(url, flight);
                flight.answer.completeExceptionally(e);
            }
        });
        return flight.answer.get();
    }

    @Scheduled(fixedRate = 5000)
    public void dropOldFlights() {
        long old = System.currentTimeMillis() - 5000;
        flights.values().removeIf(f -> f.doneAt != 0 && f.doneAt < old);
    }
}
