package frame.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import frame.api.playback.LiveMedia;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * A restart of the service empties its broadcast list until each sender announces again (every 2 s). A page that was
 * playing must not be told "not running" in that gap (both viewer pages take that as the end of the broadcast): for
 * {@link LiveMedia#STARTUP_GRACE_MS} after the start, a path without a broadcast answers 503 + Retry-After with a text the
 * viewers wait on ("not ready"); an announced broadcast is served at once; after the grace "not running" is the answer.
 */
class StartupGraceTest {
    private static final String TOKEN = "startup-grace-token-0123456789abcdef";
    private static final String ID = "0123456789abcdef0123456789abcdef";

    @Test
    void aPathIsNotCalledOffRightAfterAStart() throws Exception {
        ConfigurableApplicationContext app = SpringApplication.run(FrameApiApplication.class, "--server.port=0", "--frame.publisher-tokens=" + TOKEN + " screen-01 screen-02",
                "--frame.mediamtx.api=http://127.0.0.1:1");
        try {
            String base = "http://127.0.0.1:" + app.getEnvironment().getProperty("local.server.port");
            HttpClient http = HttpClient.newHttpClient();
            long startedAt = System.currentTimeMillis();

            // Within the grace: wait and retry, on the path routes and under a broadcast prefix.
            for (String path : new String[] {"/screen-01/info", "/screen-01/b/" + ID + "/live.m3u8", "/screen-01/live.m3u8", "/screen-01/dvr"}) {
                HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(base + path)).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(503, r.statusCode(), path);
                assertEquals("2", r.headers().firstValue("Retry-After").orElse(null), path);
                assertEquals("no-store", r.headers().firstValue("Cache-Control").orElse(null), path);
                assertTrue(r.body().toLowerCase().contains("not ready"), "viewers wait on this wording: " + r.body());
            }
            HttpResponse<String> session = http.send(HttpRequest.newBuilder(URI.create(base + "/screen-01/b/" + ID + "/session")).POST(HttpRequest.BodyPublishers.noBody()).build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(503, session.statusCode());
            // The WebRTC fallback of the React page names its broadcast too (?b=): it waits as well, with or without the name.
            for (String whep : new String[] {"/screen-01/whep?b=" + ID, "/screen-01/whep"}) {
                HttpResponse<String> offer = http.send(HttpRequest.newBuilder(URI.create(base + whep)).header("Content-Type", "application/sdp")
                        .POST(HttpRequest.BodyPublishers.ofString("v=0\r\n")).build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(503, offer.statusCode(), whep);
                assertTrue(offer.body().toLowerCase().contains("not ready"), offer.body());
            }

            // The sender announces again: served at once (running, waiting for media since no MediaMTX answers here).
            HttpResponse<String> announced = http.send(HttpRequest.newBuilder(URI.create(base + "/api/broadcasts/announce"))
                    .header("Authorization", "Bearer " + TOKEN).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + ID
                            + "\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\"screen-01\",\"width\":1280,\"height\":720,\"fps\":30,\"startedAtMs\":" + startedAt + "}}"))
                    .build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(204, announced.statusCode());
            HttpResponse<String> info = http.send(HttpRequest.newBuilder(URI.create(base + "/screen-01/info")).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(200, info.statusCode());
            assertTrue(info.body().contains("\"running\":true") && info.body().contains("\"broadcastId\":\"" + ID + "\""), info.body());

            // After the grace a path nobody announced is not running: JSON on /info, 404 under a prefix.
            Thread.sleep(Math.max(0, startedAt + LiveMedia.STARTUP_GRACE_MS + 700 - System.currentTimeMillis()));
            HttpResponse<String> off = http.send(HttpRequest.newBuilder(URI.create(base + "/screen-02/info")).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(200, off.statusCode());
            assertTrue(off.body().contains("\"running\":false"), off.body());
            HttpResponse<String> scoped = http.send(HttpRequest.newBuilder(URI.create(base + "/screen-02/b/" + ID + "/live.m3u8")).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(404, scoped.statusCode());
            assertTrue(scoped.body().contains("not-running"), scoped.body());
        } finally {
            app.close();
        }
    }
}
