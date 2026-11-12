package frame.api;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.chat.ChatHub;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.playback.Audience;
import frame.api.playback.ViewerSessions;
import frame.api.quality.Ladders;
import frame.api.stats.StatsLog;
import frame.api.web.Connections;
import frame.api.web.Replies;
import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** GET /healthz: 200 while the relay MediaMTX API answers (503 otherwise), with the counts the Node relay reports. */
@RestController
public class HealthController {
    static final String VERSION = "0.3.0-spring";
    private final MediaMtxPaths mediamtx;
    private final BroadcastRegistry registry;
    private final ViewerSessions sessions;
    private final Audience audience;
    private final ChatHub chat;
    private final Connections connections;
    private final StatsLog stats;
    private final Ladders ladders;

    public HealthController(MediaMtxPaths mediamtx, BroadcastRegistry registry, ViewerSessions sessions, Audience audience, ChatHub chat,
                            Connections connections, StatsLog stats, Ladders ladders) {
        this.mediamtx = mediamtx;
        this.registry = registry;
        this.sessions = sessions;
        this.audience = audience;
        this.chat = chat;
        this.connections = connections;
        this.stats = stats;
        this.ladders = ladders;
    }

    @GetMapping("/healthz")
    public ResponseEntity<Object> health() {
        Map<String, MediaPath> paths = mediamtx.list();
        List<Broadcast> all = registry.all();
        int receiving = 0, hlsViewers = 0;
        for (Broadcast e : all) {
            MediaPath p = paths.get(e.path);
            if (p != null && p.ready()) receiving++;
            hlsViewers += audience.hls(e.path);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", mediamtx.ok());
        out.put("version", VERSION);
        out.put("backend", "spring");
        out.put("mediamtx", mediamtx.ok());
        out.put("mediamtxListStale", mediamtx.stale());
        out.put("broadcasts", all.size());
        out.put("receiving", receiving);
        out.put("hlsViewers", hlsViewers);
        out.put("hlsSessions", sessions.total());
        out.put("chatClients", chat.count());
        out.put("sockets", connections.open());
        out.put("statsRows", stats.written());
        out.put("qualityEncoders", ladders.running());
        out.put("uptimeS", Math.round(ManagementFactory.getRuntimeMXBean().getUptime() / 1000.0));
        return Replies.json(mediamtx.ok() ? 200 : 503, out);
    }
}
