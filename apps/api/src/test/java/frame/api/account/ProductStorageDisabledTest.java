package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import frame.api.FrameApiApplication;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.MapPropertySource;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.session.SessionRepository;

class ProductStorageDisabledTest {
    @Test void mediaOnlyProcessStartsWithoutCreatingDatabaseRedisOrFlywayComponents() throws Exception {
        var media = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        media.createContext("/v3/paths/list", exchange -> {
            byte[] body = "{\"items\":[]}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body); exchange.close();
        });
        media.start();
        SpringApplication application = new SpringApplication(FrameApiApplication.class);
        application.addInitializers(context -> context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("storage-disabled-verification", Map.ofEntries(
                Map.entry("frame.product.enabled", "false"), Map.entry("server.address", "127.0.0.1"), Map.entry("server.port", "0"),
                Map.entry("spring.datasource.url", "jdbc:postgresql://127.0.0.1:1/never_connect"),
                Map.entry("spring.datasource.username", "verification-only"), Map.entry("spring.datasource.password", "verification-only"),
                Map.entry("spring.data.redis.port", "1"), Map.entry("frame.payments.enabled", "false"), Map.entry("frame.obs.enabled", "false"),
                Map.entry("frame.mediamtx.api", "http://127.0.0.1:" + media.getAddress().getPort()), Map.entry("logging.level.root", "warn")))));
        try (var app = application.run()) {
            assertEquals(0, app.getBeansOfType(Flyway.class).size());
            assertEquals(0, app.getBeansOfType(DataSource.class).size());
            assertEquals(0, app.getBeansOfType(RedisConnectionFactory.class).size());
            assertEquals(0, app.getBeansOfType(SessionRepository.class).size());
            assertEquals(0, app.getBeansOfType(ChannelRecordings.class).size());assertEquals(0, app.getBeansOfType(RecordingCollector.class).size());assertEquals(0, app.getBeansOfType(frame.api.dvr.RecordedAssetProbe.class).size());
            assertEquals(0, app.getBeansOfType(ProductVods.class).size());assertEquals(0, app.getBeansOfType(VodFiles.class).size());assertEquals(0, app.getBeansOfType(VodPublisher.class).size());
            assertEquals(0, app.getBeansOfType(ProductClips.class).size());assertEquals(0, app.getBeansOfType(ClipFiles.class).size());assertEquals(0, app.getBeansOfType(ClipPublisher.class).size());
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + app.getEnvironment().getProperty("local.server.port") + "/healthz")).GET().build();
            try (var http = HttpClient.newHttpClient()) { assertEquals(200, http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()); }
        } finally { media.stop(0); }
    }
}
