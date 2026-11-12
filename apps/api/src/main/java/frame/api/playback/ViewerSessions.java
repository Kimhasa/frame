package frame.api.playback;

import frame.api.FrameProperties;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.function.IntSupplier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Viewer sessions (POST .../session, PUT .../session/{sid} heartbeat every 15 s, DELETE on leave), server/lib/hls.mjs
 * ViewerSessions: active while the last heartbeat is within RELAY_SESSION_ACTIVE_MS. Each remembers the address+browser key
 * of the page that opened it, so the fallback count of HLS clients without a session does not count that page twice.
 * Caps: RELAY_MAX_VIEWERS_PER_PATH (with the other viewers {@link Audience} counts) and RELAY_MAX_SESSIONS_PER_IP, both
 * checked under the lock that opens the session.
 */
@Component
public class ViewerSessions {
    /** The new session id, or why none was opened. */
    public record Opened(String sid, Refusal refusal) {}

    public enum Refusal { VIEWER_LIMIT, ADDRESS_LIMIT }

    private record Session(long at, String key, String ip) {}

    private final SecureRandom random = new SecureRandom();
    private final long activeMs;
    private final int perPath, perIp;
    private final Map<String, Map<String, Session>> byPath = new HashMap<>();
    /** path -> key -> active sessions with that key. */
    private final Map<String, Map<String, Integer>> keys = new HashMap<>();
    private final Map<String, Integer> ips = new HashMap<>();

    public ViewerSessions(FrameProperties props) {
        this.activeMs = props.sessionActiveMs();
        this.perPath = props.limits().viewersPerPath();
        this.perIp = props.limits().sessionsPerIp();
    }

    /** Opens a session unless the path (its sessions + {@code others}) or this address is at its cap. */
    public synchronized Opened open(String path, String key, String ip, IntSupplier others) {
        prune(path);
        Map<String, Session> m = byPath.get(path);
        if ((m == null ? 0 : m.size()) + others.getAsInt() >= perPath) return new Opened(null, Refusal.VIEWER_LIMIT);
        if (ips.getOrDefault(ip, 0) >= perIp) return new Opened(null, Refusal.ADDRESS_LIMIT);
        byte[] b = new byte[16];
        random.nextBytes(b);
        String sid = HexFormat.of().formatHex(b);
        byPath.computeIfAbsent(path, p -> new HashMap<>()).put(sid, new Session(System.currentTimeMillis(), key, ip));
        keys.computeIfAbsent(path, p -> new HashMap<>()).merge(key, 1, Integer::sum);
        ips.merge(ip, 1, Integer::sum);
        return new Opened(sid, null);
    }

    /** Heartbeat (close=false) or leave (close=true); false for an unknown or expired session (the page opens a new one). */
    public synchronized boolean touch(String path, String sid, String key, String ip, boolean close) {
        Map<String, Session> m = byPath.get(path);
        Session s = m == null ? null : m.get(sid);
        if (s == null) return false;
        boolean expired = System.currentTimeMillis() - s.at() >= activeMs;
        if (expired || close) {
            drop(path, sid, s);
            return !expired;
        }
        // The page may have changed address (Wi-Fi <-> mobile data): its key and its per-address count follow.
        if (!s.key().equals(key)) { decrement(keys.get(path), s.key()); keys.computeIfAbsent(path, p -> new HashMap<>()).merge(key, 1, Integer::sum); }
        if (!s.ip().equals(ip)) { decrement(ips, s.ip()); ips.merge(ip, 1, Integer::sum); }
        m.put(sid, new Session(System.currentTimeMillis(), key, ip));
        return true;
    }

    public synchronized int size(String path) {
        prune(path);
        Map<String, Session> m = byPath.get(path);
        return m == null ? 0 : m.size();
    }

    public synchronized boolean hasKey(String path, String key) {
        Map<String, Integer> k = keys.get(path);
        return k != null && k.getOrDefault(key, 0) > 0;
    }

    /** Read-only product eligibility check; never renews a media session or changes viewer admission. */
    public synchronized boolean valid(String path,String sid,String key,String ip){
        Map<String,Session> sessions=byPath.get(path);Session found=sessions==null?null:sessions.get(sid);
        return found!=null&&System.currentTimeMillis()-found.at()<activeMs&&found.key().equals(key)&&found.ip().equals(ip);
    }

    public synchronized int total() {
        return byPath.values().stream().mapToInt(Map::size).sum();
    }

    @Scheduled(fixedRate = 5000)
    public synchronized void pruneAll() {
        for (String path : new HashSet<>(byPath.keySet())) prune(path);
    }

    private void prune(String path) {
        Map<String, Session> m = byPath.get(path);
        if (m == null) return;
        long old = System.currentTimeMillis() - activeMs;
        for (Map.Entry<String, Session> e : Map.copyOf(m).entrySet()) if (e.getValue().at() < old) drop(path, e.getKey(), e.getValue());
    }

    private void drop(String path, String sid, Session s) {
        Map<String, Session> m = byPath.get(path);
        if (m != null) { m.remove(sid); if (m.isEmpty()) byPath.remove(path); }
        Map<String, Integer> k = keys.get(path);
        decrement(k, s.key());
        if (k != null && k.isEmpty()) keys.remove(path);
        decrement(ips, s.ip());
    }

    private static void decrement(Map<String, Integer> map, String key) {
        if (map != null) map.computeIfPresent(key, (k, v) -> v > 1 ? v - 1 : null);
    }
}
