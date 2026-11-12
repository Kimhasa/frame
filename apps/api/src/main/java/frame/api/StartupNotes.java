package frame.api;

import frame.api.broadcast.PublisherTokens;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * What an operator must know at startup (the Node relay's listen-time lines): the publisher tokens, what is on (renditions,
 * DVR, HLS, stats), and RELAY_* variables that no setting reads (a typo in relay.env would otherwise go unnoticed).
 */
@Component
public class StartupNotes {
    private static final Logger log = LoggerFactory.getLogger(StartupNotes.class);
    /** The RELAY_* variables application.yml reads: the same set as the Node relay's server/lib/config.mjs. */
    static final Set<String> USED = Set.of("RELAY_ANNOUNCE_TTL_MS", "RELAY_DVR", "RELAY_FFMPEG", "RELAY_FONTS_DIR", "RELAY_HLS", "RELAY_HLS_AAC",
            "RELAY_HLS_ACTIVE_MS", "RELAY_HLS_COUNT_WITHOUT_SESSION", "RELAY_ICE_SERVERS", "RELAY_JS_DIR", "RELAY_LADDER_IDLE_MS", "RELAY_LISTEN_HOST",
            "RELAY_LOG_LEVEL", "RELAY_MAX_BROADCASTS", "RELAY_MAX_CHAT", "RELAY_MAX_CHAT_PER_IP", "RELAY_MAX_DVR_PER_IP", "RELAY_MAX_DVR_STREAMS",
            "RELAY_MAX_HLS_INFLIGHT", "RELAY_MAX_HLS_PER_IP", "RELAY_MAX_SESSIONS_PER_IP", "RELAY_MAX_SOCKETS", "RELAY_MAX_VIEWERS_PER_PATH",
            "RELAY_MAX_WHEP_INFLIGHT", "RELAY_MEDIAMTX_API", "RELAY_MEDIAMTX_API_PASS", "RELAY_MEDIAMTX_API_USER", "RELAY_MEDIAMTX_HLS",
            "RELAY_MEDIAMTX_PLAYBACK", "RELAY_MEDIAMTX_RTSP", "RELAY_MEDIAMTX_STALE_MS", "RELAY_MEDIAMTX_WEBRTC", "RELAY_MEDIA_GRACE_MS", "RELAY_PORT",
            "RELAY_PUBLIC_BASE_URL", "RELAY_PUBLISHER_TOKENS", "RELAY_PUBLISHER_TOKENS_FILE", "RELAY_OBS_ENABLED", "RELAY_OBS_SERVER_URL", "RELAY_RATE_ANNOUNCE", "RELAY_RATE_AUTH_FAIL",
            "RELAY_RATE_CHAT_CONNECT", "RELAY_RATE_CHAT_SEND", "RELAY_RATE_DVR", "RELAY_RATE_PUBLISH_IP", "RELAY_RATE_SESSION", "RELAY_RATE_STATS",
            "RELAY_RATE_WHEP", "RELAY_RECORD_DIR", "RELAY_RENDITIONS", "RELAY_SESSION_ACTIVE_MS", "RELAY_STATS_DIR", "RELAY_STATS_KEEP_DAYS",
            "RELAY_STATS_MAX_MB", "RELAY_TRUSTED_PROXIES", "RELAY_TURN_SECRET", "RELAY_TURN_TTL_S", "RELAY_TURN_URLS", "RELAY_UI_FILE");

    private final PublisherTokens tokens;
    private final FrameProperties props;

    public StartupNotes(PublisherTokens tokens, FrameProperties props) {
        this.tokens = tokens;
        this.props = props;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void report() {
        String stats = props.stats().dir() == null || props.stats().dir().isBlank() ? "not stored (RELAY_STATS_DIR unset)" : props.stats().dir();
        String ui = props.legacyUi().file() == null || props.legacyUi().file().isBlank() ? "none (RELAY_UI_FILE unset)" : props.legacyUi().file();
        log.info("FRAME API {}: {} publisher token(s); renditions [{}]; DVR {}; HLS {}{}; media grace {} ms; playback stats {}; legacy page {}",
                HealthController.VERSION, tokens.size(), props.quality().list().stream().map(FrameProperties.Quality.Rendition::name).collect(Collectors.joining(",")),
                props.dvr().enabled() ? "on" : "off", props.hls() ? "on" : "off", props.hlsAac() ? " (+AAC)" : "", props.mediaGraceMs(), stats, ui);
        if (tokens.size() == 0) log.warn("no publisher token configured: every announcement will be refused");
        if (tokens.anyPath() > 0) log.warn("{} publisher token(s) may announce any path (\"*\"): give each sender its own path(s) in production", tokens.anyPath());
        Set<String> unknown = new TreeSet<>();
        for (var e : System.getenv().entrySet())
            if (e.getKey().startsWith("RELAY_") && !e.getValue().isBlank() && !USED.contains(e.getKey())) unknown.add(e.getKey());
        if (!unknown.isEmpty()) log.warn("set but not read by any setting (a typo?): {}", String.join(", ", unknown));
    }
}
