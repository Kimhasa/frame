package frame.api;

import frame.api.web.RateLimit;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Settings of the backend ({@code frame.*} in application.yml, each fed by the Node relay's RELAY_* variable of the same
 * meaning, with the same defaults and ranges: server/lib/config.mjs). Secrets (publisher tokens, TURN secret) only come
 * from the environment or a token file.
 */
@ConfigurationProperties("frame")
public record FrameProperties(
        String publicBaseUrl,
        String trustedProxies,
        String publisherTokens,
        String publisherTokensFile,
        boolean hls,
        boolean hlsAac,
        String iceServers,
        long announceTtlMs,
        long mediaGraceMs,
        long sessionActiveMs,
        boolean hlsCountWithoutSession,
        long hlsActiveMs,
        MediaMtx mediamtx,
        Quality quality,
        Dvr dvr,
        Turn turn,
        Stats stats,
        LegacyUi legacyUi,
        Limits limits,
        Rates rates) {

    /** The relay MediaMTX, on loopback only: API, HLS, WebRTC and playback servers. */
    public record MediaMtx(String api, String hls, String webrtc, String playback, String apiUser, String apiPass, long staleMs) {
        public MediaMtx {
            api = loopbackHttp("RELAY_MEDIAMTX_API", api);
            hls = loopbackHttp("RELAY_MEDIAMTX_HLS", hls);
            webrtc = loopbackHttp("RELAY_MEDIAMTX_WEBRTC", webrtc);
            playback = loopbackHttp("RELAY_MEDIAMTX_PLAYBACK", playback);
            range("RELAY_MEDIAMTX_STALE_MS", staleMs, 0, 300_000);
        }
    }

    /**
     * The relay's quality ladder: the qualities it encodes ("720p,480p" or "480p:1.8"), the FFmpeg it runs, the loopback RTSP
     * it reads the source from and publishes to, how long it outlives its last reader.
     */
    public record Quality(String renditions, String ffmpeg, String rtsp, long idleMs) {
        public Quality {
            if (rtsp != null) rtsp = rtsp.replaceAll("/+$", "");
            range("RELAY_LADDER_IDLE_MS", idleMs, 5000, 3_600_000);
            list();  // validated at startup
        }

        /** One configured quality. */
        public record Rendition(String name, int height, double mbps) {}

        private static final Map<String, Double> DEFAULT_MBPS = Map.of("1440p", 10.0, "1080p", 6.0, "720p", 3.5, "480p", 1.8, "360p", 0.9, "240p", 0.5);

        public List<Rendition> list() {
            List<Rendition> out = new ArrayList<>();
            if (renditions == null) return out;
            for (String item : renditions.split(",")) {
                item = item.trim();
                if (item.isEmpty()) continue;
                String[] parts = item.split(":");
                if (!parts[0].matches("^(240|360|480|720|1080|1440)p$")) throw new IllegalArgumentException("RELAY_RENDITIONS entries look like 720p or 720p:3.5");
                double rate;
                try { rate = parts.length > 1 ? Double.parseDouble(parts[1]) : DEFAULT_MBPS.get(parts[0]); } catch (NumberFormatException e) { rate = -1; }
                if (!(rate > 0 && rate <= 200)) throw new IllegalArgumentException("RELAY_RENDITIONS " + item + ": bitrate must be Mbps in 0..200");
                out.add(new Rendition(parts[0], Integer.parseInt(parts[0].replace("p", "")), rate));
            }
            return out;
        }
    }

    /** Recording-based DVR: on/off and the relay MediaMTX recording folder (empty: no dvr.m3u8). */
    public record Dvr(boolean enabled, String recordDir) {}

    /** coturn use-auth-secret: short-lived TURN credentials handed out in /info. */
    public record Turn(String urls, String secret, long ttlS) {
        public Turn {
            range("RELAY_TURN_TTL_S", ttlS, 60, 86_400);
        }

        public List<String> urlList() {
            return urls == null ? List.of() : Arrays.stream(urls.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
        }
    }

    /** Playback reports: one CSV per UTC day in dir (empty: received, not stored). */
    public record Stats(String dir, long maxMb, long keepDays) {
        public Stats {
            range("RELAY_STATS_MAX_MB", maxMb, 1, 10_000);
            range("RELAY_STATS_KEEP_DAYS", keepDays, 0, 3650);
        }
    }

    /**
     * The existing viewer page at / and /{path} (the sender app's UI build, outputs/index.html) and its fonts and player
     * scripts. Configured paths only: this backend reads no other app's folder by itself. Empty: the page answers 404.
     */
    public record LegacyUi(String file, String fontsDir, String jsDir) {}

    /** The Node relay's ranges: a value outside stops startup instead of breaking at runtime. */
    public record Limits(int sockets, int broadcasts, int viewersPerPath, int sessionsPerIp, int chat, int chatPerIp,
                         int whepInflight, int dvrStreams, int dvrPerIp, int hlsInflight, int hlsPerIp) {
        public Limits {
            range("RELAY_MAX_SOCKETS", sockets, 10, 100_000);
            range("RELAY_MAX_BROADCASTS", broadcasts, 1, 256);
            range("RELAY_MAX_VIEWERS_PER_PATH", viewersPerPath, 1, 100_000);
            range("RELAY_MAX_SESSIONS_PER_IP", sessionsPerIp, 1, 100_000);
            range("RELAY_MAX_CHAT", chat, 1, 100_000);
            range("RELAY_MAX_CHAT_PER_IP", chatPerIp, 1, 10_000);
            range("RELAY_MAX_WHEP_INFLIGHT", whepInflight, 1, 10_000);
            range("RELAY_MAX_DVR_STREAMS", dvrStreams, 1, 10_000);
            range("RELAY_MAX_DVR_PER_IP", dvrPerIp, 1, 10_000);
            range("RELAY_MAX_HLS_INFLIGHT", hlsInflight, 1, 100_000);
            range("RELAY_MAX_HLS_PER_IP", hlsPerIp, 1, 100_000);
        }
    }

    /** Token buckets "burst/perSecond". */
    public record Rates(String publishIp, String announce, String authFail, String session, String chatConnect, String chatSend,
                        String whep, String dvr, String stats) {
        public Rates {
            rate("RELAY_RATE_PUBLISH_IP", publishIp);
            rate("RELAY_RATE_ANNOUNCE", announce);
            rate("RELAY_RATE_AUTH_FAIL", authFail);
            rate("RELAY_RATE_SESSION", session);
            rate("RELAY_RATE_CHAT_CONNECT", chatConnect);
            rate("RELAY_RATE_CHAT_SEND", chatSend);
            rate("RELAY_RATE_WHEP", whep);
            rate("RELAY_RATE_DVR", dvr);
            rate("RELAY_RATE_STATS", stats);
        }

        // Checked at start-up with the variable's name (the limiters are built later, where the name is not known).
        private static void rate(String name, String value) {
            try { RateLimit.parse(value); }
            catch (RuntimeException e) { throw new IllegalArgumentException(name + " must look like 30/5 (burst/perSecond)"); }
        }
    }

    public FrameProperties {
        if (publicBaseUrl != null && !publicBaseUrl.isBlank()) {
            URI u = URI.create(publicBaseUrl.trim());
            if (!"http".equals(u.getScheme()) && !"https".equals(u.getScheme()) || u.getHost() == null)
                throw new IllegalArgumentException("RELAY_PUBLIC_BASE_URL must be an http(s) URL");
            // Only the origin: list addresses are "<origin>/thumbnails/...".
            publicBaseUrl = u.getScheme() + "://" + u.getRawAuthority();
        } else {
            publicBaseUrl = "";
        }
        range("RELAY_ANNOUNCE_TTL_MS", announceTtlMs, 3000, 60_000);
        range("RELAY_MEDIA_GRACE_MS", mediaGraceMs, 0, 120_000);
        range("RELAY_SESSION_ACTIVE_MS", sessionActiveMs, 10_000, 120_000);
        range("RELAY_HLS_ACTIVE_MS", hlsActiveMs, 3000, 60_000);
    }

    /** RELAY_TRUSTED_PROXIES as a list (comma separated, blanks dropped). */
    public List<String> trustedProxyList() {
        return trustedProxies == null ? List.of() : Arrays.stream(trustedProxies.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    private static void range(String name, long value, long min, long max) {
        if (value < min || value > max) throw new IllegalArgumentException(name + " must be an integer in " + min + ".." + max);
    }

    // The MediaMTX endpoints stay on loopback HTTP: the relay never reaches MediaMTX over the network.
    private static String loopbackHttp(String name, String value) {
        URI u = URI.create(value.trim());
        if (!"http".equals(u.getScheme()) || u.getHost() == null) throw new IllegalArgumentException(name + " must be an http:// loopback URL");
        return u.getScheme() + "://" + u.getRawAuthority();
    }
}
