package frame.api.payments;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Only test credentials are accepted. Secrets are supplied by the server environment, never client configuration. */
@ConfigurationProperties("frame.payments")
public record TossProperties(boolean enabled, String clientKey, String secretKey, String securityKey, String storeDir) {
    public TossProperties {
        clientKey = clean(clientKey); secretKey = clean(secretKey); securityKey = clean(securityKey); storeDir = clean(storeDir);
    }
    private static String clean(String value) { return value == null ? "" : value.trim(); }
    public boolean configured() {
        return enabled && !storeDir.isBlank() && clientKey.matches("test_(ck|gck)_[A-Za-z0-9_-]{8,400}")
                && secretKey.matches("test_(sk|gsk)_[A-Za-z0-9_-]{8,400}")
                && (clientKey.startsWith("test_ck_") == secretKey.startsWith("test_sk_"));
    }
    @Override public String toString() { return "TossProperties[enabled=" + enabled + ", configured=" + configured() + ", credentials=redacted]"; }
}
