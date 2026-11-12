package frame.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * FRAME backend: the relay API that the Windows sender app and the React viewer use (first phase: {@code broadcast} and
 * {@code playback}), later also the product API. One process; each feature lives in its own package.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class FrameApiApplication {
    public static void main(String[] args) {
        SpringApplication.run(FrameApiApplication.class, args);
    }
}
