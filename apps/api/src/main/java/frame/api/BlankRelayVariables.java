package frame.api;

import java.util.HashMap;
import java.util.Map;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

/**
 * A RELAY_* variable set to an empty value counts as unset, as in the Node relay (config.mjs: `env.X || default`). Spring's
 * {@code ${X:default}} would otherwise take the empty value: an empty RELAY_LISTEN_HOST in a systemd EnvironmentFile would
 * make the server listen on every interface. Runs before logging and the server read their settings.
 * Registered in META-INF/spring.factories.
 */
public class BlankRelayVariables implements EnvironmentPostProcessor, Ordered {
    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication application) {
        String name = StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME;
        PropertySource<?> system = env.getPropertySources().get(name);
        if (!(system instanceof MapPropertySource map)) return;
        Map<String, Object> source = new HashMap<>(map.getSource());
        boolean removed = source.entrySet().removeIf(e -> e.getKey().startsWith("RELAY_") && String.valueOf(e.getValue()).isBlank());
        if (removed) env.getPropertySources().replace(name, new SystemEnvironmentPropertySource(name, source));
    }

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }
}
