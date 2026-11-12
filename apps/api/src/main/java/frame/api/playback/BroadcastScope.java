package frame.api.playback;

import frame.api.broadcast.Announcement;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.web.Replies;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

/**
 * Rules of the broadcast-scoped viewer routes /{path}/b/{id}/... (server/lib/scope.mjs), used by the live, HLS, session and
 * DVR routes. A link that names its broadcast must never play, record or count for the next broadcast on the same path, so
 * every scoped answer first checks that the broadcast on the path is still the one in the prefix ({@link #bind}), that the
 * media on the path is that broadcast's own, and again after every wait ({@link #changed}, {@link #moved}).
 */
@Component
public class BroadcastScope {
    /** Media up to this long before the broadcast's start counts as its own (the announced start's clock skew). */
    static final long OWN_MEDIA_SLACK_MS = 10_000;

    /** The JSON error of a scoped answer: 404 not-running (nothing on the path), 409 broadcast-changed. */
    public record Unbound(int status, String error) {}

    /** The state the binding was checked on, or the refusal (state null when the prefix itself is malformed). */
    public record Bound(LiveMedia.State state, ResponseEntity<Object> refused) {}

    private final LiveMedia live;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths mediamtx;

    public BroadcastScope(LiveMedia live, BroadcastRegistry registry, MediaMtxPaths mediamtx) {
        this.live = live;
        this.registry = registry;
        this.mediamtx = mediamtx;
    }

    /** A path and a broadcast id that form a broadcast prefix at all (else the Node relay treats the URL as no route). */
    public static boolean wellFormed(String path, String id) {
        return Announcement.PATH.matcher(path).matches() && Announcement.ID.matcher(id).matches();
    }

    /**
     * The broadcast on {@code path} must be {@code id}: the state it was checked on, else 404 or 409 (JSON, no-store). A
     * malformed prefix is no route: 404 "Not found" (the routes other than GET answer 405 before binding).
     */
    public Bound bind(String path, String id) {
        if (!wellFormed(path, id)) return new Bound(null, Replies.text(404, "Not found"));
        // current() reads the registry before it waits for the path list: the broadcast must also still be on the path after it.
        LiveMedia.State s = live.current(path);
        Unbound bad = binding(s.entry(), id);
        if (bad == null) bad = binding(registry.byPath(path), id);
        // Right after a start the broadcast of the prefix may just not have announced again yet: wait, not "not running".
        if (bad != null && bad.status() == 404 && live.starting(s)) return new Bound(s, Replies.busy(2, LiveMedia.STARTING));
        return new Bound(s, bad == null ? null : refusal(bad));
    }

    /** After a wait (a recording scan, an upstream answer): 404/409 when {@code id} is no longer on the path, else null. */
    public ResponseEntity<Object> changed(String path, String id) {
        Unbound bad = binding(registry.byPath(path), id);
        return bad == null ? null : refusal(bad);
    }

    /**
     * After waiting for live media: also 503 + Retry-After when the source path now carries a publisher session that is not
     * the broadcast's own (one that began during the wait and has not been announced yet). Reads the last path list
     * (refreshed by every viewer request), never a new lookup that would hold an answer already received.
     */
    public ResponseEntity<Object> moved(String path, String id) {
        ResponseEntity<Object> bad = changed(path, id);
        if (bad != null) return bad;
        return ownSource(registry.byPath(path), mediamtx.last().get(path)) ? null : Replies.busy(2, "Media is not ready yet");
    }

    /** Not running: JSON under a broadcast prefix (a player tells it from the plain 404 of a quality), text on the path routes. */
    public static ResponseEntity<Object> notRunning(boolean scoped) {
        return scoped ? Replies.json(404, Map.of("error", "not-running")) : Replies.textNoStore(404, "Stream is not running");
    }

    // ---- the rules ------------------------------------------------------------------------------------------------------

    /** null while {@code entry} (the registry entry on the path, or null) is broadcast {@code id}. */
    public static Unbound binding(Broadcast entry, String id) {
        if (entry == null) return new Unbound(404, "not-running");
        return entry.id.equals(id) ? null : new Unbound(409, "broadcast-changed");
    }

    /** The path does not carry a publisher session older than the broadcast (the previous broadcast still publishing). */
    public static boolean ownMedia(Broadcast entry, MediaPath p) {
        if (p == null || !p.ready() || p.readyMs() == 0 || entry == null || entry.startedAtRelayMs == 0) return true;
        return p.readyMs() >= entry.startedAtRelayMs - OWN_MEDIA_SLACK_MS;
    }

    /**
     * The publisher session began before the broadcast's last announcement. A sender announces every 2 s while it sends, so
     * its own new session is confirmed by its next announcement; until then it may be the next broadcast's sender that took
     * the path before its first announcement (FRAME_DESIGN.md 5.3), and an old link must not get its media.
     */
    public static boolean announced(Broadcast entry, MediaPath p) {
        if (p == null || !p.ready() || p.readyMs() == 0 || entry == null || entry.lastAnnounceMs() == 0) return true;
        return p.readyMs() <= entry.lastAnnounceMs();
    }

    public static boolean ownSource(Broadcast entry, MediaPath p) {
        return ownMedia(entry, p) && announced(entry, p);
    }

    /**
     * For a scoped recording request: while the source path's publisher session is not the broadcast's own, the recording
     * files that session may have written (named by their start, which comes after the session became ready; 2 s of slack)
     * belong to someone else. Files from this time on are not listed or served under the prefix; MAX_VALUE when the session
     * is the broadcast's own (or no media arrives).
     */
    public static long foreignFrom(LiveMedia.State s) {
        return s.entry() != null && s.p() != null && s.p().ready() && !ownSource(s.entry(), s.p()) ? s.p().readyMs() - 2000 : Long.MAX_VALUE;
    }

    private static ResponseEntity<Object> refusal(Unbound bad) {
        return Replies.json(bad.status(), Map.of("error", bad.error()));
    }
}
