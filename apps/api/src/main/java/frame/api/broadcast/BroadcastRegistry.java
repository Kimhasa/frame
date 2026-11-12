package frame.api.broadcast;

import frame.api.FrameProperties;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * The public broadcast list and its rules (server/lib/registry.mjs). A sender announces itself every ~2 s with its
 * publisher token; an entry lives RELAY_ANNOUNCE_TTL_MS after its last announcement and ends at once on "bye". Each token
 * may only use the paths assigned to it, and which token announced an id is remembered, so one publisher cannot withdraw,
 * re-thumbnail or take over another's broadcast or path, not even while the owner reconnects (the path stays reserved
 * for it for RELAY_MEDIA_GRACE_MS after its entry expired). Starts and ends are published as {@link BroadcastEvents}.
 */
@Component
public class BroadcastRegistry {
    private static final Logger log = LoggerFactory.getLogger(BroadcastRegistry.class);
    static final String ENDED_BYE = "송출이 종료되었습니다.";
    static final String ENDED_RESTART = "새 송출이 시작되었습니다.";
    static final String ENDED_LOST = "송출이 종료되었습니다. 송출 PC의 연결이 끊어졌습니다.";

    /** Outcome of an announcement: 204 accepted, 400 invalid, 403 not this publisher's, 409 path taken, 503 full. */
    public record Result(int status, String reason, List<String> ignored, String path) {}

    private record Hold(int token, long until) {}

    private final PublisherTokens tokens;
    private final ApplicationEventPublisher events;
    private final long ttlMs, holdMs;
    private final int max;
    private final Map<String, Broadcast> entries = new LinkedHashMap<>();
    private final Map<String, Hold> holds = new HashMap<>();
    /** path -> when the last broadcast on it ended (playback reports may still arrive for 5 minutes). */
    private final Map<String, Long> ended = new HashMap<>();
    private final ReentrantLock publishing = new ReentrantLock();

    public BroadcastRegistry(FrameProperties props, PublisherTokens tokens, ApplicationEventPublisher events) {
        this.tokens = tokens;
        this.events = events;
        this.ttlMs = props.announceTtlMs();
        this.holdMs = props.mediaGraceMs();
        this.max = props.limits().broadcasts();
    }

    public synchronized Broadcast byPath(String path) {
        for (Broadcast e : entries.values()) if (e.path.equals(path)) return e;
        return null;
    }

    public synchronized Broadcast get(String id) { return entries.get(id); }

    /** Every entry, newest (sender start) first. */
    public synchronized List<Broadcast> all() {
        List<Broadcast> list = new ArrayList<>(entries.values());
        list.sort(Comparator.comparingLong((Broadcast b) -> b.senderStartedAtMs).reversed());
        return list;
    }

    public synchronized int size() { return entries.size(); }

    /** A path with a broadcast now or within the last 5 minutes. */
    public synchronized boolean known(String path) {
        Long at = ended.get(path);
        return byPath(path) != null || (at != null && System.currentTimeMillis() - at < 300_000);
    }

    /** {"v":1,"type":"announce","item":{...}} or {"v":1,"type":"bye","id":...} from publisher token {@code token}. */
    public Result announce(JsonNode message, int token) {
        List<Object> happened = new ArrayList<>();
        Result r;
        // Events leave in the order they happened (a room must never be bound to a broadcast that already ended), and
        // outside the registry's lock (a listener may read the registry).
        publishing.lock();
        try {
            synchronized (this) { r = announceLocked(message, token, happened); }
            happened.forEach(events::publishEvent);
        } finally {
            publishing.unlock();
        }
        return r;
    }

    private Result announceLocked(JsonNode message, int token, List<Object> happened) {
        if (message == null || !message.isObject() || !message.path("v").isNumber() || message.path("v").doubleValue() != 1) return refused(400, "unsupported message");
        String type = message.path("type").isString() ? message.path("type").asString() : "";
        if (type.equals("bye")) {
            String id = message.path("id").isString() ? message.path("id").asString() : "";
            Broadcast e = entries.get(id);
            if (e == null) return new Result(204, "", List.of(), null);
            if (e.token != token) return refused(403, "not your broadcast");
            remove(e, ENDED_BYE, happened);
            holds.remove(e.path);
            return new Result(204, "", List.of(), null);
        }
        if (!type.equals("announce")) return refused(400, "unsupported message");
        Announcement.Parsed parsed = Announcement.parse(message.get("item"));
        if (parsed.item() == null) return refused(400, parsed.error());
        Announcement item = parsed.item();
        if (!tokens.allows(token, item.path())) return refused(403, "path not assigned to this publisher token");
        long now = System.currentTimeMillis();
        Broadcast existing = entries.get(item.id());
        if (existing != null) {
            if (existing.token != token) return refused(403, "not your broadcast");
            if (!existing.path.equals(item.path())) return refused(409, "broadcast id already uses another path");
            existing.update(item);
            existing.expiresAt = now + ttlMs;
            existing.lastAnnounceMs = now;
            return new Result(204, "", parsed.ignored(), item.path());
        }
        Broadcast other = byPath(item.path());
        if (other != null) {
            if (other.token != token) return refused(409, "path is used by another broadcast");
            remove(other, ENDED_RESTART, happened);  // the same publisher restarted on the same path
        }
        Hold hold = holds.get(item.path());
        if (hold != null && hold.until() > now && hold.token() != token) return refused(409, "path is reserved for its broadcaster (reconnecting)");
        holds.remove(item.path());
        if (entries.size() >= max) return refused(503, "directory full");
        long skew = item.sentAtMs() != null ? now - item.sentAtMs() : 0;
        Broadcast entry = new Broadcast(item, token, now, skew);
        entry.lastAnnounceMs = now;
        entry.expiresAt = now + ttlMs;
        entries.put(entry.id, entry);
        log.info("broadcast {} on /{} announced", entry.id, entry.path);
        happened.add(new BroadcastEvents.Started(entry));
        return new Result(204, "", parsed.ignored(), item.path());
    }

    /** 204 stored, 404 unknown broadcast, 403 not this token's broadcast. */
    public synchronized int setThumbnail(String id, int token, byte[] jpeg) {
        Broadcast e = entries.get(id);
        if (e == null) return 404;
        if (e.token != token) return 403;
        e.thumbnail = jpeg;
        return 204;
    }

    @Scheduled(fixedRate = 1000)
    public void sweep() {
        List<Object> happened = new ArrayList<>();
        publishing.lock();
        try {
            sweepLocked(happened);
            happened.forEach(events::publishEvent);
        } finally {
            publishing.unlock();
        }
    }

    private void sweepLocked(List<Object> happened) {
        synchronized (this) {
            long now = System.currentTimeMillis();
            for (Broadcast e : new ArrayList<>(entries.values())) {
                if (e.expiresAt > now) continue;
                remove(e, ENDED_LOST, happened);
                if (holdMs > 0) holds.put(e.path, new Hold(e.token, now + holdMs));
            }
            holds.values().removeIf(h -> h.until() <= now);
            ended.values().removeIf(t -> now - t > 300_000);
        }
    }

    private void remove(Broadcast e, String reason, List<Object> happened) {
        if (entries.get(e.id) != e) return;
        entries.remove(e.id);
        ended.put(e.path, System.currentTimeMillis());
        log.info("broadcast {} on /{} ended: {}", e.id, e.path, reason);
        happened.add(new BroadcastEvents.Ended(e, reason));
    }

    private static Result refused(int status, String reason) { return new Result(status, reason, List.of(), null); }
}
