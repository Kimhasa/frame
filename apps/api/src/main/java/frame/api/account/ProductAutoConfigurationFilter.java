package frame.api.account;

import org.springframework.boot.autoconfigure.AutoConfigurationImportFilter;
import org.springframework.boot.autoconfigure.AutoConfigurationMetadata;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.env.Environment;

/** The existing media relay must still start without a product database, Redis, or login configuration. */
public final class ProductAutoConfigurationFilter implements AutoConfigurationImportFilter, EnvironmentAware {
    private Environment environment;
    @Override public void setEnvironment(Environment environment) { this.environment = environment; }
    @Override public boolean[] match(String[] names, AutoConfigurationMetadata metadata) {
        boolean enabled = environment.getProperty("frame.product.enabled", Boolean.class, false);
        boolean[] accepted = new boolean[names.length];
        for (int i = 0; i < names.length; i++) {
            String name = names[i];
            accepted[i] = enabled || name == null || !(name.startsWith("org.springframework.boot.jdbc.")
                    || name.startsWith("org.springframework.boot.flyway.") || name.startsWith("org.springframework.boot.data.redis.")
                    || name.startsWith("org.springframework.boot.session.") || name.startsWith("org.springframework.boot.security."));
        }
        return accepted;
    }
}
