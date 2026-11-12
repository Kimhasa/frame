package frame.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * What "systemctl restart frame-relay" does to viewers (the JVM's SIGTERM hook closes the application context, as here):
 * the stop must not wait out a viewer's long-held LL-HLS request (MediaMTX holds a blocking playlist reload until the next
 * part, up to 15 s), a chat socket is told the server goes away (1001), and the whole stop takes a few seconds at most.
 * The relay MediaMTX is a stand-in that lists one ready path and holds the playlist request.
 */
class ShutdownTest {
    private static final String TOKEN = "shutdown-test-token-0123456789abcdef";
    private static final String ID = "0123456789abcdef0123456789abcdef";

    @Test
    void stoppingIsQuickAndTellsTheClients() throws Exception {
        ExecutorService pool = Executors.newCachedThreadPool();
        HttpServer mediamtx = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        CountDownLatch held = new CountDownLatch(1);
        mediamtx.createContext("/v3/paths/list", x -> reply(x, "{\"pageCount\":1,\"items\":[{\"name\":\"screen-01\",\"ready\":true,\"readyTime\":\"" + Instant.now()
                + "\",\"tracks2\":[{\"codec\":\"H264\",\"codecProps\":{\"width\":1280,\"height\":720,\"profile\":\"High\",\"level\":\"3.1\"}}],\"readers\":[],\"inboundBytes\":0,"
                + "\"source\":{\"type\":\"rtspsSession\"}}]}"));
        mediamtx.createContext("/screen-01/index.m3u8", x -> reply(x, "#EXTM3U\nvideo1_stream.m3u8?session=abcdef12\n"));
        mediamtx.createContext("/screen-01/video1_stream.m3u8", x -> {
            held.countDown();
            try { Thread.sleep(20_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            reply(x, "#EXTM3U\n");
        });
        mediamtx.setExecutor(pool);
        mediamtx.start();
        String upstream = "http://127.0.0.1:" + mediamtx.getAddress().getPort();
        ConfigurableApplicationContext app = SpringApplication.run(FrameApiApplication.class, "--server.port=0", "--frame.publisher-tokens=" + TOKEN + " screen-01",
                "--frame.mediamtx.api=" + upstream, "--frame.mediamtx.hls=" + upstream);
        boolean closed = false;
        try {
            String base = "127.0.0.1:" + app.getEnvironment().getProperty("local.server.port");
            HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
            HttpResponse<String> announced = http.send(HttpRequest.newBuilder(URI.create("http://" + base + "/api/broadcasts/announce"))
                    .header("Authorization", "Bearer " + TOKEN).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + ID
                            + "\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\"screen-01\",\"width\":1280,\"height\":720,\"fps\":30,\"startedAtMs\":" + System.currentTimeMillis() + "}}"))
                    .build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(204, announced.statusCode());

            // A chat member.
            CompletableFuture<String> joined = new CompletableFuture<>();
            CompletableFuture<Integer> chatClosed = new CompletableFuture<>();
            WebSocket chat = http.newWebSocketBuilder().buildAsync(URI.create("ws://" + base + "/screen-01/chat"), new WebSocket.Listener() {
                private final StringBuilder text = new StringBuilder();
                @Override public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                    text.append(data);
                    if (last) { joined.complete(text.toString()); text.setLength(0); }
                    ws.request(1);
                    return null;
                }
                @Override public CompletionStage<?> onClose(WebSocket ws, int status, String reason) { chatClosed.complete(status); return null; }
                @Override public void onError(WebSocket ws, Throwable error) { chatClosed.complete(-1); }
            }).get(5, TimeUnit.SECONDS);
            chat.sendText("{\"type\":\"join\",\"broadcastId\":\"" + ID + "\",\"name\":\"viewer\"}", true);
            assertTrue(joined.get(5, TimeUnit.SECONDS).contains("\"connected\":true"));

            // A viewer's blocking playlist reload, held by MediaMTX.
            CompletableFuture<HttpResponse<String>> reload = http.sendAsync(
                    HttpRequest.newBuilder(URI.create("http://" + base + "/screen-01/hls/video1_stream.m3u8?_HLS_msn=5&_HLS_part=0")).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertTrue(held.await(5, TimeUnit.SECONDS), "the reload reached MediaMTX");

            long t0 = System.nanoTime();
            app.close();
            closed = true;
            long stopMs = (System.nanoTime() - t0) / 1_000_000;

            String reloadSaw;
            try { reloadSaw = "status " + reload.get(5, TimeUnit.SECONDS).statusCode(); } catch (Exception e) { reloadSaw = String.valueOf(e.getCause() == null ? e : e.getCause()); }
            int chatStatus = chatClosed.get(5, TimeUnit.SECONDS);
            System.out.println("shutdown: stop " + stopMs + " ms; held reload saw: " + reloadSaw + "; chat closed with " + chatStatus);
            assertTrue(stopMs < 6000, "stop took " + stopMs + " ms");
            assertEquals(1001, chatStatus, "chat members are told the server goes away");
        } finally {
            if (!closed) app.close();
            mediamtx.stop(0);
            pool.shutdownNow();
        }
    }

    private static void reply(HttpExchange x, String body) throws java.io.IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        x.sendResponseHeaders(200, bytes.length);
        try (var out = x.getResponseBody()) { out.write(bytes); }
    }
}
