package frame.api.playback;

import frame.api.FrameProperties;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.web.Counter;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.IntSupplier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Viewers of a broadcast for the per-path cap (RELAY_MAX_VIEWERS_PER_PATH), relay.mjs viewerCount/hlsCount:
 * WebRTC readers of the path and its qualities (MediaMTX readers, plus WHEP offers admitted but not listed yet), active
 * viewer sessions, and (RELAY_HLS_COUNT_WITHOUT_SESSION) HLS clients that fetched media within RELAY_HLS_ACTIVE_MS without a
 * session, by address + browser (a session's own page is not counted twice). Media requests are never refused for the cap.
 */
@Component
public class Audience {
    private final ViewerSessions sessions;
    private final MediaMtxPaths mediamtx;
    private final boolean countWithoutSession;
    private final long activeMs;
    private final int perPath;
    /** path -> (address+browser key -> last media request). */
    private final ConcurrentHashMap<String, ConcurrentHashMap<String, Long>> hlsClients = new ConcurrentHashMap<>();
    private final Counter whepPending = new Counter();

    public Audience(ViewerSessions sessions, MediaMtxPaths mediamtx, FrameProperties props) {
        this.sessions = sessions;
        this.mediamtx = mediamtx;
        this.countWithoutSession = props.hlsCountWithoutSession();
        this.activeMs = props.hlsActiveMs();
        this.perPath = props.limits().viewersPerPath();
    }

    public int perPathLimit() { return perPath; }

    /** An HLS media request of {@code key} on {@code path} (the fallback count). */
    public void touchHls(String path, String key) {
        if (countWithoutSession) hlsClients.computeIfAbsent(path, p -> new ConcurrentHashMap<>()).put(key, System.currentTimeMillis());
    }

    /** HLS viewers of a path: active sessions, plus clients without one. */
    public int hls(String path) {
        int n = sessions.size(path);
        if (!countWithoutSession) return n;
        Map<String, Long> m = hlsClients.get(path);
        if (m == null) return n;
        long old = System.currentTimeMillis() - activeMs;
        for (Map.Entry<String, Long> e : m.entrySet()) if (e.getValue() >= old && !sessions.hasKey(path, e.getKey())) n++;
        return n;
    }

    /** Everything but the sessions: WebRTC readers, pending WHEP offers, HLS clients without a session. */
    public int others(String path, Map<String, MediaPath> paths) {
        int webrtc = whepPending.get(path);
        for (Map.Entry<String, MediaPath> e : paths.entrySet())
            if (e.getKey().equals(path) || e.getKey().startsWith(path + "/")) webrtc += e.getValue().webrtcReaders();
        return webrtc + hls(path) - sessions.size(path);
    }

    /** The cap is reached (for a new WHEP offer). */
    public boolean full(String path, Map<String, MediaPath> paths) {
        return others(path, paths) + sessions.size(path) >= perPath;
    }

    /** A viewer session, under the same lock that counts the sessions (a burst of POSTs cannot pass the cap together). */
    public ViewerSessions.Opened openSession(String path, String key, String ip, Map<String, MediaPath> paths) {
        return sessions.open(path, key, ip, () -> others(path, paths));
    }

    /**
     * Admits a WHEP offer on the path: the cap check, the address's rate ({@code rate}: seconds to wait, 0 = allowed) and
     * the reservation in one step, under the lock that opens viewer sessions, so a burst of offers (or offers racing session
     * POSTs) cannot all pass the same count. -1 at the cap, the seconds to wait when rate limited, 0 when reserved (counted
     * until MediaMTX lists its reader, or released when no session results).
     */
    public int admitWhep(String path, Map<String, MediaPath> paths, IntSupplier rate) {
        synchronized (sessions) {
            if (full(path, paths)) return -1;
            int wait = rate.getAsInt();
            if (wait > 0) return wait;
            whepPending.add(path, 1);
            return 0;
        }
    }

    public void releaseWhep(String path) { whepPending.add(path, -1); }

    /**
     * After a WHEP answer: MediaMTX adds the reader before it answers, so a path-list refresh begun after the answer shows
     * it. The reservation is released after the second successful refresh from now (or after 30 s).
     */
    public void releaseWhepWhenListed(String path) {
        Thread.ofVirtual().start(() -> {
            try {
                long at = mediamtx.goodAt();
                int refreshes = 0;
                for (long until = System.currentTimeMillis() + 30_000; refreshes < 2 && System.currentTimeMillis() < until; ) {
                    Thread.sleep(250);
                    mediamtx.list();
                    if (mediamtx.goodAt() != at) { at = mediamtx.goodAt(); refreshes++; }
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } finally {
                releaseWhep(path);
            }
        });
    }

    @Scheduled(fixedRate = 2000)
    public void prune() {
        long old = System.currentTimeMillis() - activeMs;
        hlsClients.values().forEach(m -> m.values().removeIf(t -> t < old));
        hlsClients.values().removeIf(Map::isEmpty);
    }
}
