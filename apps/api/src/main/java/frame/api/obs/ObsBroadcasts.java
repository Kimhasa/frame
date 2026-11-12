package frame.api.obs;

import frame.api.FrameProperties;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** OBS publishes media only. The backend maintains its registration instead of requiring a sender heartbeat helper. */
@Component
public class ObsBroadcasts {
    public static final Pattern PATH = Pattern.compile("^obs-[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$");
    public record Metadata(String title, String publisher) {}
    public record State(String state, String broadcastId, boolean mediaReady, Metadata metadata) {}
    private static final class Active {
        final String id = UUID.randomUUID().toString().replace("-", "");
        final int owner;
        final long started;
        long lastMedia;
        MediaPath media;
        Active(int owner, long now) { this.owner = owner; this.started = now; this.lastMedia = now; }
    }

    private final ObsProperties props;
    private final PublisherTokens tokens;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths mediamtx;
    private final JsonMapper json;
    private final long graceMs;
    private final Map<String, Active> active = new HashMap<>();
    private final Map<String, Metadata> metadata = new HashMap<>();
    private Map<String, MediaPath> paths = Map.of();
    private boolean unavailable;

    public ObsBroadcasts(ObsProperties props, FrameProperties frame, PublisherTokens tokens, BroadcastRegistry registry, MediaMtxPaths mediamtx, JsonMapper json) {
        this.props = props; this.tokens = tokens; this.registry = registry; this.mediamtx = mediamtx; this.json = json;
        this.graceMs = frame.mediaGraceMs();
    }

    @Scheduled(fixedDelay = 1000)
    public void sync() {
        if (!props.enabled()) return;
        Map<String, MediaPath> found = mediamtx.list();
        reconcile(found, mediamtx.stale() || !mediamtx.ok(), System.currentTimeMillis());
    }

    // Also used by focused tests: stale API data cannot keep a stopped broadcast alive indefinitely.
    synchronized void reconcile(Map<String, MediaPath> found, boolean stale, long now) {
        paths = found;
        unavailable = stale;
        if (!stale) for (var entry : found.entrySet()) {
            String path = entry.getKey();
            MediaPath media = entry.getValue();
            int owner = tokens.explicitOwner(path);
            if (!PATH.matcher(path).matches() || owner < 0 || !media.ready() || !media.sourceType().toLowerCase().contains("rtmp")) continue;
            Active item = active.get(path);
            // A new publisher after a long scheduler/API gap is a new broadcast, even if no intermediate empty poll ran.
            // A continuous publisher with the same readyTime merely outlived a delayed poll and keeps its identity.
            if (item != null && now - item.lastMedia > graceMs && item.media != null && media.readyMs() != item.media.readyMs()) {
                registry.announce(json.valueToTree(Map.of("v", 1, "type", "bye", "id", item.id)), item.owner);
                active.remove(path);
                item = null;
            }
            if (item == null) {
                // OBS must not replace an existing native or differently owned broadcast, even on an assigned path.
                if (registry.byPath(path) != null) continue;
                item = new Active(owner, now);
                active.put(path, item);
            }
            item.lastMedia = now;
            item.media = media;
        }
        for (var entry : new ArrayList<>(active.entrySet())) {
            String path = entry.getKey();
            Active item = entry.getValue();
            Broadcast current = registry.byPath(path);
            MediaPath currentMedia = found.get(path);
            boolean differentProtocol = !stale && currentMedia != null && currentMedia.ready() && !currentMedia.sourceType().toLowerCase().contains("rtmp");
            if (differentProtocol || (current != null && !current.id.equals(item.id)) || now - item.lastMedia > graceMs) {
                if (current != null && current.id.equals(item.id)) registry.announce(json.valueToTree(Map.of("v", 1, "type", "bye", "id", item.id)), item.owner);
                active.remove(path);
                continue;
            }
            Metadata details = metadata(path);
            MediaPath media = item.media;
            Map<String, Object> fields = new HashMap<>();
            fields.put("id", item.id); fields.put("path", path); fields.put("title", details.title()); fields.put("publisher", details.publisher());
            fields.put("width", media.width()); fields.put("height", media.height()); fields.put("fps", 0); fields.put("startedAtMs", item.started);
            BroadcastRegistry.Result result = registry.announce(json.valueToTree(Map.of("v", 1, "type", "announce", "item", fields)), item.owner);
            if (result.status() != 204) { active.remove(path); continue; }
            Broadcast registered = registry.get(item.id);
            if (!stale && registered != null && found.get(path) != null && found.get(path).ready()) registered.observe(media, false);
        }
    }

    public synchronized Metadata metadata(String path) {
        return metadata.getOrDefault(path, new Metadata(path.substring(4) + "의 라이브 방송", path.substring(4)));
    }

    public synchronized void update(String path, Metadata details) { metadata.put(path, details); }

    public synchronized State status(String path) {
        Active item = active.get(path);
        MediaPath media = paths.get(path);
        boolean ready = !unavailable && media != null && media.ready() && media.sourceType().toLowerCase().contains("rtmp");
        return new State(item == null ? unavailable ? "unavailable" : "waiting" : ready ? "live" : "reconnecting", item == null ? null : item.id, ready, metadata(path));
    }

    /** Observed values only: MediaMTX does not report the source FPS here, so it stays null. */
    public synchronized Map<String, Object> metrics(String path) {
        Active item = active.get(path);
        MediaPath media = paths.get(path);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("startedAtMs", item == null ? null : item.started);
        out.put("width", media == null || media.width() <= 0 ? null : media.width());
        out.put("height", media == null || media.height() <= 0 ? null : media.height());
        out.put("fps", null);
        out.put("bitrateMbps", media == null || media.mbps() <= 0 ? null : media.mbps());
        out.put("audioCodec", media != null && media.tracks().contains("MPEG-4 Audio") ? "AAC" : media != null && media.tracks().contains("Opus") ? "Opus" : null);
        return out;
    }
}
