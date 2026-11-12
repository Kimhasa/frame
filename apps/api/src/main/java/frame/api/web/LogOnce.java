package frame.api.web;

import java.util.concurrent.ConcurrentHashMap;

/**
 * One log line per key per minute, as the Node relay's log(level, message, key): a MediaMTX restart or a sender stuck on a
 * refusal must not flood the journal (and push other lines out of journald's rate limit).
 */
public final class LogOnce {
    private static final ConcurrentHashMap<String, Long> LAST = new ConcurrentHashMap<>();

    private LogOnce() {}

    /** true when {@code key} was not logged within the last 60 s (and records it). */
    public static boolean allow(String key) {
        long now = System.currentTimeMillis();
        if (LAST.size() > 5000) LAST.clear();
        Long before = LAST.get(key);
        if (before != null && now - before < 60_000) return false;
        LAST.put(key, now);
        return true;
    }
}
