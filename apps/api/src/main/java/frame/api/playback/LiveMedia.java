package frame.api.playback;

import frame.api.FrameProperties;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.quality.Ladders;
import frame.api.quality.Renditions;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The broadcast on a path together with the MediaMTX state of its source path (relay.mjs current()):
 * <ul>
 *   <li>ready: announced and the relay receives its media;</li>
 *   <li>waiting: announced, media not arriving right now but seen (or announced) within RELAY_MEDIA_GRACE_MS (a sender
 *       reconnecting, a relay MediaMTX restart): viewers are told {"running":true,"mediaReady":false} and wait.</li>
 * </ul>
 * Every 2 s it also keeps each broadcast's media observation current, starts a broadcast's quality ladder once its media
 * arrived, and lets the ladders stop when nobody reads them.
 * <p>Start-up grace: the broadcast list lives in memory and is rebuilt from the senders' next announcements (every 2 s).
 * For {@link #STARTUP_GRACE_MS} after this service starts, a path without a broadcast is therefore not yet known to be
 * off: viewer routes answer 503 + Retry-After ({@link #STARTING}) instead of "not running", so a page that was playing
 * when the service restarted waits and continues, instead of showing the broadcast as ended.
 */
@Component
public class LiveMedia {
    /** entry and p may be null; paths is the whole list the state was computed from. */
    public record State(Broadcast entry, MediaPath p, Map<String, MediaPath> paths, boolean ready, boolean waiting) {
        public boolean live() { return ready || waiting; }
    }

    private final BroadcastRegistry registry;
    private final MediaMtxPaths mediamtx;
    private final Renditions renditions;
    private final Ladders ladders;
    private final long graceMs;
    private final boolean hls, hlsAac;
    /** Two announcement intervals and a margin. */
    public static final long STARTUP_GRACE_MS = 5000;
    /** The answer during the start-up grace. "not ready" is what viewers wait on (the same wording as media briefly away). */
    public static final String STARTING = "Relay has just started: media is not ready yet";
    private volatile long readyNanos;
    private volatile boolean ready;

    public LiveMedia(BroadcastRegistry registry, MediaMtxPaths mediamtx, Renditions renditions, Ladders ladders, FrameProperties props) {
        this.registry = registry;
        this.mediamtx = mediamtx;
        this.renditions = renditions;
        this.ladders = ladders;
        this.graceMs = props.mediaGraceMs();
        this.hls = props.hls();
        this.hlsAac = props.hlsAac();
    }

    /** The service accepts requests from now on: the start-up grace begins. */
    @EventListener(ApplicationReadyEvent.class)
    public void started() {
        readyNanos = System.nanoTime();  // the monotonic clock: a clock step (NTP right after a boot) must not stretch or cut the grace
        ready = true;
    }

    /** Nothing is announced on the path, but the service has only just started (its senders may not have announced again). */
    public boolean starting(State s) {
        return s.entry() == null && (!ready || System.nanoTime() - readyNanos < STARTUP_GRACE_MS * 1_000_000L);
    }

    public State current(String path) {
        Broadcast entry = registry.byPath(path);
        Map<String, MediaPath> paths = mediamtx.list();
        MediaPath p = paths.get(path);
        boolean ready = entry != null && p != null && p.ready();
        if (ready) entry.observe(p, mediamtx.stale());
        boolean waiting = entry != null && !ready && System.currentTimeMillis() - Math.max(entry.lastReadyMs, entry.firstSeenMs) <= graceMs;
        return new State(entry, p, paths, ready, waiting);
    }

    @Scheduled(fixedDelay = 2000)
    public void observeAll() throws InterruptedException {
        if (registry.size() == 0 && !ladders.any()) return;
        Map<String, MediaPath> paths = mediamtx.list();
        ladders.sweep(paths, mediamtx.stale());
        for (Broadcast e : registry.all()) {
            MediaPath p = paths.get(e.path);
            if (p == null || !p.ready()) continue;
            e.observe(p, mediamtx.stale());
            // Once per broadcast, as soon as its media arrives: start its ladder (a start on a viewer's request would make
            // that viewer wait for the new paths' first frames, about 8 s).
            if (hls && !e.ladderStarted) {
                State s = new State(e, p, paths, true, false);
                List<Renditions.Quality> list = renditions.ladder(e, p, paths);
                if (!list.isEmpty() && !LivePlaylist.audio(s, hlsAac).kind().equals("transcode")) {
                    e.ladderStarted = true;
                    ladders.ensure(e.path, list, e.path + "/src", 0);
                }
            }
        }
    }
}
