package frame.api;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

/** An empty RELAY_* value counts as unset (Node: `env.X || default`): the application.yml default applies. */
class BlankRelayVariablesTest {
    @Test
    void anEmptyListenHostFallsBackToTheLoopbackDefault() {
        StandardEnvironment env = new StandardEnvironment();
        Map<String, Object> vars = new HashMap<>(Map.of("RELAY_LISTEN_HOST", "", "RELAY_PORT", "27070", "OTHER", ""));
        env.getPropertySources().replace(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                new SystemEnvironmentPropertySource(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, vars));
        new BlankRelayVariables().postProcessEnvironment(env, null);
        assertEquals("127.0.0.1", env.resolvePlaceholders("${RELAY_LISTEN_HOST:127.0.0.1}"));
        assertEquals("27070", env.resolvePlaceholders("${RELAY_PORT:8080}"));
        assertEquals("", env.resolvePlaceholders("${OTHER:x}"));  // only RELAY_* variables are touched
    }
}
