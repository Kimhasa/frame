package frame.api.account;

import java.net.URI;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("frame.product")
public record ProductProperties(boolean enabled, String publicOrigin, boolean cookieSecure) {
    public ProductProperties {
        if (enabled) {
            URI origin;
            try { origin = URI.create(publicOrigin); } catch (RuntimeException failure) { throw new IllegalArgumentException("Product public origin is invalid"); }
            boolean local = "http".equals(origin.getScheme()) && ("127.0.0.1".equals(origin.getHost()) || "localhost".equals(origin.getHost()) || "[::1]".equals(origin.getHost()));
            if ((!local && !"https".equals(origin.getScheme())) || origin.getHost() == null || origin.getUserInfo() != null
                    || origin.getQuery() != null || origin.getFragment() != null || !(origin.getPath() == null || origin.getPath().isEmpty())
                    || ("https".equals(origin.getScheme()) && !cookieSecure))
                throw new IllegalArgumentException("Product requires an exact HTTPS origin and Secure cookie; HTTP is local-only");
        }
    }
}
