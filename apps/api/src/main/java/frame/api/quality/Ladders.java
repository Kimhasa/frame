package frame.api.quality;

import frame.api.FrameProperties;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.web.LogOnce;
import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * The quality ladder of each broadcast (server/lib/ladder.mjs; the app's Streamer::EnsureLadder): one FFmpeg per broadcast
 * decodes the source once and publishes a copy of it (<path>/src) and every relay-side lower quality (<path>/<h>p), all with
 * one -start_time_realtime, so MediaMTX gives every variant the same timestamps and players switch without gaps. Started
 * when the broadcast's media is ready (a new ladder path only takes frames from FFmpeg's second RTCP sender report, about
 * 5 s in), again on a request after an idle stop; stopped when none of its paths had a reader for RELAY_LADDER_IDLE_MS.
 * Failure policy: a ladder that exits before any of its paths was published starts a streak; each further such exit
 * doubles the wait before the next start (3 s up to 60 s), and while the streak lasts live.m3u8 plays the source path itself.
 */
@Component
public class Ladders {
    private static final Logger log = LoggerFactory.getLogger(Ladders.class);
    private static final long RETRY_MS = 3000, RETRY_MAX_MS = 60_000;

    /** Published when a ladder starts, with the MediaMTX paths it will publish (their old shared HLS sessions are useless). */
    public record Started(String path, List<String> names) {}

    private static final class Ladder {
        final String key;
        final List<Renditions.Quality> list;
        final long startedAt;
        volatile long usedAt;
        final Set<String> ready = new HashSet<>();
        volatile boolean published, exited, stopped;
        volatile long retryAt;
        final ArrayDeque<String> tail = new ArrayDeque<>();
        Process child;

        Ladder(String key, List<Renditions.Quality> list) {
            this.key = key;
            this.list = list;
            this.startedAt = this.usedAt = System.currentTimeMillis();
        }
    }

    private final String ffmpeg, rtsp;
    private final long idleMs;
    private final MediaMtxPaths mediamtx;
    private final ApplicationEventPublisher events;
    private final Map<String, Ladder> ladders = new HashMap<>();
    /** path -> consecutive exits before any path was published; kept across restarts. */
    private final Map<String, Integer> streaks = new HashMap<>();
    /** The service is stopping: no ladder is started any more, and an encoder that ends now is not a failure. */
    private volatile boolean closing;

    public Ladders(FrameProperties props, MediaMtxPaths mediamtx, ApplicationEventPublisher events) {
        this.ffmpeg = props.quality().ffmpeg();
        this.rtsp = props.quality().rtsp();
        this.idleMs = props.quality().idleMs();
        this.mediamtx = mediamtx;
        this.events = events;
    }

    /** The ladder keeps failing before it publishes anything: list the source path itself, not src/ or qualities. */
    public synchronized boolean failing(String path) { return streaks.containsKey(path); }

    // A ladder path published by this ladder: ready since it started (the path list may still show the previous ladder's
    // publisher for a moment after a restart; its muxer is gone, so treating it as ready would answer 404s).
    private static boolean mine(MediaPath p, Ladder l) {
        return p != null && p.ready() && (p.readyMs() == 0 || p.readyMs() >= l.startedAt - 1000);
    }

    private void published(String path, Ladder l, String name) {
        l.ready.add(name);
        if (l.published) return;
        l.published = true;
        if (streaks.remove(path) != null) log.info("quality encoder for /{} publishes again", path);
    }

    /**
     * Makes sure the ladder of {@code path} (qualities {@code list}) runs; with waitMs, waits until the MediaMTX path
     * {@code want} (<path>/src or <path>/<h>p) is published. false: not ready in time, or waiting to restart after an exit.
     */
    public boolean ensure(String path, List<Renditions.Quality> list, String want, long waitMs) throws InterruptedException {
        if (list.isEmpty() || closing) return false;
        String key = list.stream().map(r -> r.name() + ":" + r.mbps()).collect(Collectors.joining(","));
        Ladder l;
        Started started = null;
        boolean readyNow;
        synchronized (this) {
            l = ladders.get(path);
            if (l != null && !l.exited && !l.key.equals(key)) { stopLocked(path, "qualities changed"); l = null; }
            if (l != null && l.exited) {
                if (System.currentTimeMillis() < l.retryAt) return false;
                ladders.remove(path);
                l = null;
            }
            if (l == null) {
                l = startLocked(path, list, key);
                List<String> names = new ArrayList<>(List.of(path + "/src"));
                for (Renditions.Quality q : list) names.add(path + "/" + q.name());
                started = new Started(path, names);
            }
            l.usedAt = System.currentTimeMillis();
            readyNow = l.ready.contains(want);
        }
        if (started != null) events.publishEvent(started);
        if (readyNow || waitMs <= 0) return true;
        for (long until = System.currentTimeMillis() + waitMs; System.currentTimeMillis() < until && !l.exited; ) {
            if (mine(mediamtx.list().get(want), l)) {
                synchronized (this) { published(path, l, want); }
                return true;
            }
            Thread.sleep(200);
        }
        return false;
    }

    // FFmpeg arguments: the source copy, then each quality (scale=-2:H, libx264 at the configured rate, the source frame
    // rate, keyframes where the source has them, both audio tracks copied in the source's order).
    private List<String> args(String path, List<Renditions.Quality> list, long startUs) {
        StringBuilder graph = new StringBuilder("[0:v:0]split=" + list.size());
        for (int i = 0; i < list.size(); i++) graph.append("[s").append(i).append(']');
        for (int i = 0; i < list.size(); i++) graph.append(";[s").append(i).append("]scale=-2:").append(list.get(i).height()).append(":flags=bilinear[v").append(i).append(']');
        List<String> a = new ArrayList<>(List.of(ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "warning", "-threads", "1", "-rtsp_transport", "tcp",
                "-i", rtsp + "/" + path, "-filter_complex", graph.toString(), "-map", "0:v:0", "-map", "0:a?", "-c", "copy"));
        a.addAll(out(path, "src", startUs));
        for (int i = 0; i < list.size(); i++) {
            String kbps = Math.round(list.get(i).mbps() * 1000) + "k";
            a.addAll(List.of("-map", "[v" + i + "]", "-map", "0:a?", "-fps_mode", "passthrough", "-enc_time_base:v", "filter",
                    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high", "-bf", "0", "-pix_fmt", "yuv420p",
                    "-force_key_frames", "source", "-sc_threshold", "0", "-b:v", kbps, "-maxrate", kbps, "-bufsize", kbps, "-c:a", "copy"));
            a.addAll(out(path, list.get(i).name(), startUs));
        }
        return a;
    }

    private List<String> out(String path, String name, long startUs) {
        return List.of("-start_time_realtime", Long.toString(startUs), "-f", "rtsp", "-rtsp_transport", "tcp", "-pkt_size", "1190", rtsp + "/" + path + "/" + name);
    }

    private Ladder startLocked(String path, List<Renditions.Quality> list, String key) {
        Ladder l = new Ladder(key, list);
        long startUs = System.currentTimeMillis() * 1000;
        ladders.put(path, l);
        try {
            ProcessBuilder pb = new ProcessBuilder(args(path, list, startUs)).redirectOutput(ProcessBuilder.Redirect.DISCARD);
            l.child = pb.start();
            Thread.ofVirtual().start(() -> {
                try (BufferedReader err = new BufferedReader(new InputStreamReader(l.child.getErrorStream(), StandardCharsets.UTF_8))) {
                    for (String line; (line = err.readLine()) != null; ) {
                        if (line.isBlank()) continue;
                        synchronized (l.tail) { l.tail.add(line.length() > 300 ? line.substring(0, 300) : line); if (l.tail.size() > 4) l.tail.poll(); }
                    }
                } catch (Exception ignored) { }
            });
            l.child.onExit().thenAccept(p -> ended(path, l, "exit " + p.exitValue()));
            log.info("quality encoder for /{} started (pid {}): source copy + {}", path, l.child.pid(), list.stream().map(Renditions.Quality::name).collect(Collectors.joining(",")));
        } catch (Exception e) {
            ended(path, l, e.getMessage());
        }
        return l;
    }

    private void ended(String path, Ladder l, String why) {
        synchronized (this) {
            if (l.exited) return;
            l.exited = true;
            l.ready.clear();
            // Stopped by this service, or by the service manager together with it (systemd signals the whole control group).
            if (l.stopped || closing) return;
            // An exit after publishing (source gone, sender reconnecting) retries after 3 s; one before publishing anything
            // (FFmpeg missing, a bad argument, the source not readable) backs off 3, 6, 12 ... 60 s.
            int streak = l.published ? 0 : streaks.getOrDefault(path, 0) + 1;
            if (streak > 0) streaks.put(path, streak);
            long wait = streak > 0 ? Math.min(RETRY_MAX_MS, RETRY_MS << Math.min(streak - 1, 5)) : RETRY_MS;
            l.retryAt = System.currentTimeMillis() + wait;
            String tail;
            synchronized (l.tail) { tail = l.tail.isEmpty() ? "no output" : String.join(" | ", l.tail); }
            // Logged a moment later: when the service manager stops the whole control group, FFmpeg can end before this
            // service has learnt that it is closing, and that exit is no failure worth a warning.
            String streakNote = streak > 0 ? ", " + streak + " failed start(s) in a row" : "";
            CompletableFuture.delayedExecutor(500, TimeUnit.MILLISECONDS).execute(() -> {
                if (!closing && LogOnce.allow("ladder " + path))
                    log.warn("quality encoder for /{} ended ({}{}; retry after {} s): {}", path, why, streakNote, wait / 1000, tail);
            });
        }
    }

    public synchronized void stop(String path, String why) { stopLocked(path, why); }

    private void stopLocked(String path, String why) {
        Ladder l = ladders.remove(path);
        if (l == null) return;
        streaks.remove(path);  // an idle stop, the source ended or new qualities: the next start begins afresh
        l.stopped = true;
        if (!l.exited && l.child != null) {
            // destroy() asks (SIGTERM on Linux; on Windows it ends the process at once). An FFmpeg that does not leave within
            // 5 s is killed, so a stuck encoder never keeps its paths published or its CPU.
            Process child = l.child;
            child.destroy();
            child.onExit().orTimeout(5, TimeUnit.SECONDS).exceptionally(e -> { child.destroyForcibly(); return null; });
            log.info("quality encoder for /{} stopped ({})", path, why);
        }
    }

    /**
     * With the MediaMTX path list (every 2 s): a ladder with a reader on any of its paths stays; one without readers for
     * RELAY_LADDER_IDLE_MS, or whose source ended, stops. A path of the ladder seen published ends a failure streak.
     */
    public synchronized void sweep(Map<String, MediaPath> paths, boolean staleList) {
        long now = System.currentTimeMillis();
        streaks.keySet().removeIf(path -> !ladders.containsKey(path) && !(paths.get(path) != null && paths.get(path).ready()));
        for (Map.Entry<String, Ladder> e : new ArrayList<>(ladders.entrySet())) {
            String path = e.getKey();
            Ladder l = e.getValue();
            if (l.exited) { if (now > l.retryAt + 60_000) ladders.remove(path); continue; }
            List<String> names = new ArrayList<>(List.of(path + "/src"));
            for (Renditions.Quality q : l.list) names.add(path + "/" + q.name());
            // Not from a stale list (MediaMTX API slow or down): it may still show the previous ladder's paths.
            if (!staleList) for (String n : names) if (mine(paths.get(n), l)) published(path, l, n);
            if (names.stream().anyMatch(n -> paths.get(n) != null && paths.get(n).readers() > 0)) l.usedAt = now;
            MediaPath source = paths.get(path);
            if (now - l.usedAt > idleMs) stopLocked(path, "no reader for " + idleMs / 1000 + " s");
            else if ((source == null || !source.ready()) && now - l.usedAt > 5000) stopLocked(path, "source ended");
        }
    }

    public synchronized int running() {
        return (int) ladders.values().stream().filter(l -> !l.exited).count();
    }

    public synchronized boolean any() { return !ladders.isEmpty(); }

    /** The application context starts closing (SIGTERM): before the web server's graceful stop and the bean teardown. */
    @EventListener(ContextClosedEvent.class)
    public void closing() { closing = true; }

    @PreDestroy
    public void stopAll() {
        List<Process> children = new ArrayList<>();
        synchronized (this) {
            for (Ladder l : ladders.values()) if (!l.exited && l.child != null) children.add(l.child);
            for (String path : new ArrayList<>(ladders.keySet())) stopLocked(path, "shutdown");
        }
        // The JVM exits right after this, so the 5 s escalation above would never run: an encoder still alive after 2 s
        // (in total) is killed here. Normally FFmpeg leaves at once and this does not wait.
        long until = System.currentTimeMillis() + 2000;
        for (Process child : children) {
            try { child.waitFor(Math.max(0, until - System.currentTimeMillis()), TimeUnit.MILLISECONDS); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            if (child.isAlive()) child.destroyForcibly();
        }
    }
}
