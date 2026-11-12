package frame.api.obs;

import java.net.URI;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Opt-in OBS ingest. Plain RTMP is for this PC only; public input uses RTMPS. */
@ConfigurationProperties("frame.obs")
public record ObsProperties(boolean enabled, String serverUrl) {
    public ObsProperties {
        if (serverUrl == null || serverUrl.isBlank()) serverUrl = "rtmp://127.0.0.1:1935";
        URI u = URI.create(serverUrl);
        if (u.getHost() == null || u.getUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null
                || !(u.getRawPath() == null || u.getRawPath().isEmpty() || u.getRawPath().equals("/"))
                || !("rtmps".equals(u.getScheme()) || ("rtmp".equals(u.getScheme()) && Set.of("127.0.0.1", "localhost", "[::1]", "::1").contains(u.getHost())))) {
            throw new IllegalArgumentException("RELAY_OBS_SERVER_URL must be a public rtmps:// origin or a loopback rtmp:// origin, without credentials/path/query");
        }
        serverUrl = serverUrl.replaceAll("/+$", "");
    }
}
