package frame.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * MediaMTX breaks off in the middle of a body the viewer's answer has already started (a restart, a publisher that goes
 * away while a preload-hinted part is produced, a recording chunk cut short). The viewer must see a failed transfer, never
 * a shorter body that ends as if it were complete: a chunked answer must not get its terminating chunk, nothing may be
 * appended to the media, and the connection is closed. The relay MediaMTX is a stand-in that sends part of a chunked body
 * and resets the connection.
 */
class UpstreamBreakTest {
    private static final String TOKEN = "upstream-break-token-0123456789abcdef";
    private static final String ID = "0123456789abcdef0123456789abcdef";
    private static final int SENT = 1000;

    /** What a viewer read from the relay, and how the connection ended. */
    private record Answer(String head, String all, String ending, long ms) {}

    @Test
    void aBodyCutUpstreamIsNeverCompletedForTheViewer() throws Exception {
        try (ServerSocket mediamtx = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))) {
            Thread server = Thread.ofVirtual().start(() -> serve(mediamtx));
            String upstream = "http://127.0.0.1:" + mediamtx.getLocalPort();
            ConfigurableApplicationContext app = SpringApplication.run(FrameApiApplication.class, "--server.port=0", "--frame.publisher-tokens=" + TOKEN + " screen-01",
                    "--frame.mediamtx.api=" + upstream, "--frame.mediamtx.hls=" + upstream, "--frame.mediamtx.playback=" + upstream);
            try {
                int port = Integer.parseInt(app.getEnvironment().getProperty("local.server.port"));
                HttpResponse<String> announced = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/broadcasts/announce"))
                        .header("Authorization", "Bearer " + TOKEN).header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + ID
                                + "\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\"screen-01\",\"width\":1280,\"height\":720,\"fps\":30,\"startedAtMs\":" + System.currentTimeMillis() + "}}"))
                        .build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(204, announced.statusCode());

                // An LL-HLS part streamed while MediaMTX produces it, and a recording chunk of the playback server.
                for (String path : new String[] {"/screen-01/hls/part7.mp4", "/screen-01/dvr/media?id=" + ID + "&start=" + System.currentTimeMillis() + "&duration=1000"}) {
                    Answer a = get(port, path);
                    System.out.println("upstream break " + path.replaceAll("\\?.*", "") + ": " + a.all().length() + " bytes in " + a.ms() + " ms, then " + a.ending()
                            + "; tail: " + a.all().substring(Math.max(0, a.all().length() - 24)).replace("\r", "\\r").replace("\n", "\\n"));
                    assertTrue(a.head().startsWith("HTTP/1.1 200"), a.head());
                    assertTrue(a.head().toLowerCase().contains("transfer-encoding: chunked"), "streamed without a length: " + a.head());
                    assertTrue(a.all().contains("x".repeat(SENT)), "what MediaMTX sent before it broke off was passed on");
                    assertFalse(a.ending().equals("left open"), "the relay ends the connection of a cut answer");
                    assertFalse(a.all().endsWith("0\r\n\r\n"), "a cut body is not completed with a terminating chunk");
                    assertFalse(a.all().contains("Internal error"), "no error text is appended to the media");
                    // The body is exactly what MediaMTX sent, as chunks of it: nothing after it (no error page, no JSON).
                    String body = a.all().substring(a.head().length() + 4);
                    assertTrue(body.matches("(?:[0-9a-f]+\r\nx+\r\n)+"), "only the upstream bytes: " + body.substring(Math.max(0, body.length() - 60)));
                    assertEquals(SENT, body.chars().filter(c -> c == 'x').count());
                }
            } finally {
                app.close();
                server.interrupt();
            }
        }
    }

    // A viewer's request on a keep-alive connection (as a browser or the front proxy sends it), read as raw bytes until the
    // relay closes or resets the connection, or for 8 s when it leaves it open (a completed answer would).
    private static Answer get(int port, String path) throws IOException {
        ByteArrayOutputStream got = new ByteArrayOutputStream();
        String ending;
        long t0 = System.nanoTime();
        try (Socket viewer = new Socket("127.0.0.1", port)) {
            viewer.setSoTimeout(8_000);
            viewer.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: relay\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            InputStream in = viewer.getInputStream();
            byte[] buf = new byte[4096];
            try {
                for (int n; (n = in.read(buf)) >= 0; ) got.write(buf, 0, n);
                ending = "closed";
            } catch (SocketTimeoutException e) {
                ending = "left open";
            } catch (IOException e) {
                ending = "reset";
            }
        }
        String all = got.toString(StandardCharsets.ISO_8859_1);
        return new Answer(all.substring(0, Math.max(0, all.indexOf("\r\n\r\n"))), all, ending, (System.nanoTime() - t0) / 1_000_000);
    }

    // One request per connection: the path list, the HLS session, and bodies (a part, a recording chunk) cut after SENT bytes.
    private static void serve(ServerSocket mediamtx) {
        while (!mediamtx.isClosed()) {
            try (Socket s = mediamtx.accept()) {
                String request = readHead(s.getInputStream());
                OutputStream out = s.getOutputStream();
                if (request.startsWith("GET /v3/paths/list")) {
                    reply(out, "application/json", "{\"pageCount\":1,\"items\":[{\"name\":\"screen-01\",\"ready\":true,\"readyTime\":\"" + Instant.now()
                            + "\",\"tracks2\":[{\"codec\":\"H264\",\"codecProps\":{\"width\":1280,\"height\":720,\"profile\":\"High\",\"level\":\"3.1\"}}],\"readers\":[],\"inboundBytes\":0,"
                            + "\"source\":{\"type\":\"rtspsSession\"}}]}");
                } else if (request.startsWith("GET /screen-01/index.m3u8")) {
                    reply(out, "application/vnd.apple.mpegurl", "#EXTM3U\nvideo1_stream.m3u8?session=abcdef12\n");
                } else if (request.startsWith("GET /screen-01/part7.mp4") || request.startsWith("GET /get?")) {
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nTransfer-Encoding: chunked\r\n\r\n" + Integer.toHexString(SENT) + "\r\n" + "x".repeat(SENT) + "\r\n")
                            .getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                    Thread.sleep(300);
                    s.setSoLinger(true, 0);  // reset: the body ends without its terminating chunk
                } else {
                    out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                }
                out.flush();
            } catch (Exception e) {
                if (Thread.currentThread().isInterrupted()) return;
            }
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        for (int b; (b = in.read()) >= 0; ) {
            head.write(b);
            byte[] h = head.toByteArray();
            int n = h.length;
            if (n >= 4 && h[n - 4] == '\r' && h[n - 3] == '\n' && h[n - 2] == '\r' && h[n - 1] == '\n') break;
        }
        return head.toString(StandardCharsets.US_ASCII);
    }

    private static void reply(OutputStream out, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
    }
}
