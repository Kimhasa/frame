package frame.api.broadcast;

import frame.api.mediamtx.MediaPath;
import java.util.List;
import java.util.UUID;

/**
 * One announced broadcast: what the sender announced (contract v1) plus what the relay measured. Owned by
 * {@link BroadcastRegistry}; the announced fields change only through it, the measured ones through {@link #observe}.
 * Times are on the relay's clock unless named otherwise.
 */
public final class Broadcast {
    /** Server instance identity: an ended sender ID can be reused, but its old history must stay ended. */
    public final UUID instanceId = UUID.randomUUID();
    public final String id;
    public final String path;
    /** Index of the publisher token that announced it: only that token may update, end or re-thumbnail it. */
    final int token;
    /** The sender's own startedAtMs (its clock): the list is sorted by it, newest first. */
    public final long senderStartedAtMs;
    /** The broadcast's start on the relay clock (sender start corrected by the measured clock skew). */
    public final long startedAtRelayMs;
    public final long firstSeenMs;

    public volatile String title, publisher;
    public volatile int width, height;
    public volatile double fps;
    /** Announced optional extras: null when the sender did not send them. */
    public volatile Double bitrate;
    public volatile String audio;
    public volatile List<Announcement.Rendition> renditions;

    volatile long lastAnnounceMs, expiresAt;
    volatile byte[] thumbnail;

    /** Last time its media was seen arriving (0 = never): the start of the waiting grace period. */
    public volatile long lastReadyMs;
    /** The start of this broadcast's DVR window on this relay (0 until its media first arrived). */
    public volatile long dvrFromMs;
    /** The quality ladder was started for this broadcast once (as soon as its media arrived). */
    public volatile boolean ladderStarted;
    /** What the relay last measured on its source path, so /info stays complete while media is briefly away. */
    public volatile MediaPath seen;

    Broadcast(Announcement a, int token, long now, long skew) {
        this.id = a.id();
        this.path = a.path();
        this.token = token;
        this.senderStartedAtMs = a.startedAtMs();
        // The sender's clock may differ: with sentAtMs the offset is measured once, so the start never jumps later.
        this.startedAtRelayMs = Math.min(now, Math.max(now - 7 * 86_400_000L, (a.startedAtMs() > 0 ? a.startedAtMs() : now) + skew));
        this.firstSeenMs = now;
        update(a);
    }

    void update(Announcement a) {
        title = a.title();
        publisher = a.publisher();
        width = a.width();
        height = a.height();
        fps = a.fps();
        if (a.bitrate() != null) bitrate = a.bitrate();
        if (a.audio() != null) audio = a.audio();
        if (a.renditions() != null) renditions = a.renditions();
    }

    public long lastAnnounceMs() { return lastAnnounceMs; }

    public byte[] thumbnail() { return thumbnail; }

    /**
     * The relay sees media on the source path {@code p} (ready), relay.mjs observe(). A publisher session older than the
     * broadcast (the previous broadcast still publishing) must not open the DVR window early, and a later one of the same
     * broadcast (a reconnect, a relay restart re-creating the entry) must not move it: the window opens at the broadcast's
     * start, or at its first media when that came up to 10 s before the start (the announced start's clock skew).
     * A stale path list (MediaMTX API slow) is not proof the media still arrives: it does not extend the grace period.
     */
    public synchronized void observe(MediaPath p, boolean staleList) {
        long start = startedAtRelayMs;
        long ready = p.readyMs() > 0 && p.readyMs() >= start - 10_000 ? Math.min(p.readyMs(), start) : start;
        dvrFromMs = dvrFromMs > 0 ? Math.min(dvrFromMs, ready) : ready;
        if (!staleList) lastReadyMs = System.currentTimeMillis();
        seen = p;
    }
}
