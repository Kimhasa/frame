package frame.api.broadcast;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import frame.api.TestProps;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The registry rules of server/lib/registry.mjs: ownership per token and path, path takeover, limits, invalid extras. */
class BroadcastRegistryTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String A1 = "0123456789abcdef0123456789abcdef", A2 = "fedcba9876543210fedcba9876543210";
    private PublisherTokens tokens;
    private BroadcastRegistry registry;
    private int a, b;

    @BeforeEach
    void setUp() throws Exception {
        tokens = new PublisherTokens(TestProps.props());
        registry = new BroadcastRegistry(TestProps.props(), tokens, event -> { });
        a = tokens.indexOf("Bearer " + TestProps.TOKEN_A);
        b = tokens.indexOf("Bearer " + TestProps.TOKEN_B);
    }

    private static JsonNode announce(String id, String path, String extra) {
        return JSON.readTree("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + id + "\",\"title\":\"방송\",\"publisher\":\"PC\",\"path\":\"" + path
                + "\",\"width\":1280,\"height\":720,\"fps\":30,\"startedAtMs\":1700000000000" + extra + "}}");
    }

    @Test
    void tokensAreMatchedByDigestAndBearerOnly() {
        assertEquals(0, a);
        assertEquals(1, b);
        assertEquals(-1, tokens.indexOf("Bearer wrong-token-0123456789abcdef0123"));
        assertEquals(-1, tokens.indexOf(TestProps.TOKEN_A));
        assertEquals(-1, tokens.indexOf(null));
    }

    @Test
    void announceListsAndByeEnds() {
        BroadcastRegistry.Result r = registry.announce(announce(A1, "screen-01", ""), a);
        assertEquals(204, r.status());
        Broadcast e = registry.byPath("screen-01");
        assertNotNull(e);
        assertEquals("방송", e.title);
        assertEquals(204, registry.announce(JSON.readTree("{\"v\":1,\"type\":\"bye\",\"id\":\"" + A1 + "\"}"), a).status());
        assertNull(registry.byPath("screen-01"));
    }

    @Test
    void aTokenUsesOnlyItsPaths() {
        assertEquals(403, registry.announce(announce(A1, "screen-02", ""), a).status());
    }

    @Test
    void anotherTokenCannotTakeOverOrEnd() {
        assertEquals(204, registry.announce(announce(A1, "screen-01", ""), a).status());
        assertEquals(403, registry.announce(JSON.readTree("{\"v\":1,\"type\":\"bye\",\"id\":\"" + A1 + "\"}"), b).status());
        assertEquals(403, registry.setThumbnail(A1, b, new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 0}));
        assertNotNull(registry.byPath("screen-01"));
    }

    @Test
    void theSamePublisherRestartingOnItsPathReplacesTheOldBroadcast() {
        assertEquals(204, registry.announce(announce(A1, "screen-01", ""), a).status());
        assertEquals(204, registry.announce(announce(A2, "screen-01", ""), a).status());
        assertEquals(A2, registry.byPath("screen-01").id);
        assertNull(registry.get(A1));
    }

    @Test
    void invalidExtrasAreDroppedNotRefused() {
        BroadcastRegistry.Result r = registry.announce(announce(A1, "screen-01", ",\"audio\":\"loud\",\"bitrate\":500,\"sentAtMs\":-1"), a);
        assertEquals(204, r.status());
        assertEquals(List.of("bitrate", "audio", "sentAtMs"), r.ignored());
    }

    @Test
    void invalidCoreFieldsAreRefused() {
        assertEquals(400, registry.announce(announce("XYZ", "screen-01", ""), a).status());
        assertEquals(400, registry.announce(JSON.readTree("{\"v\":2,\"type\":\"announce\"}"), a).status());
        assertEquals(400, registry.announce(JSON.readTree("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + A1
                + "\",\"title\":\"t\",\"path\":\"screen-01\",\"width\":1280.5}}"), a).status());
    }

    @Test
    void wholeFloatNumbersCountAsIntegersLikeJavaScript() {
        assertEquals(204, registry.announce(JSON.readTree("{\"v\":1.0,\"type\":\"announce\",\"item\":{\"id\":\"" + A1
                + "\",\"title\":\"t\",\"path\":\"screen-01\",\"width\":1280.0,\"height\":720}}"), a).status());
    }

    @Test
    void anotherSenderCannotTakeAUsedPath() throws Exception {
        int c = tokens.indexOf("Bearer " + TestProps.TOKEN_C);
        assertEquals(204, registry.announce(announce(A1, "screen-01", ""), a).status());
        BroadcastRegistry.Result r = registry.announce(announce(A2, "screen-01", ""), c);
        assertEquals(409, r.status());
        assertEquals("path is used by another broadcast", r.reason());
    }

    @Test
    void anExpiredBroadcastsPathStaysReservedForItsSender() {
        int c = tokens.indexOf("Bearer " + TestProps.TOKEN_C);
        assertEquals(204, registry.announce(announce(A1, "screen-01", ""), a).status());
        registry.byPath("screen-01").expiresAt = 0;  // no announcement for RELAY_ANNOUNCE_TTL_MS
        registry.sweep();
        assertNull(registry.byPath("screen-01"));
        assertEquals("path is reserved for its broadcaster (reconnecting)", registry.announce(announce(A2, "screen-01", ""), c).reason());
        assertEquals(204, registry.announce(announce(A2, "screen-01", ""), a).status());
    }

    @Test
    void aTokenFileWithAByteOrderMarkAndAnotherCodePageStillLoads() throws Exception {
        java.nio.file.Path file = java.nio.file.Files.createTempFile("tokens", ".txt");
        try {
            byte[] bom = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};
            byte[] cp949Comment = {'#', ' ', (byte) 0xC5, (byte) 0xE4, (byte) 0xC5, (byte) 0xAB, '\r', '\n'};
            byte[] entry = (TestProps.TOKEN_A + " screen-01\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            out.write(bom); out.write(cp949Comment); out.write(entry);
            java.nio.file.Files.write(file, out.toByteArray());
            frame.api.FrameProperties p = TestProps.props();
            PublisherTokens fromFile = new PublisherTokens(new frame.api.FrameProperties(p.publicBaseUrl(), p.trustedProxies(), "", file.toString(), p.hls(),
                    p.hlsAac(), p.iceServers(), p.announceTtlMs(), p.mediaGraceMs(), p.sessionActiveMs(), p.hlsCountWithoutSession(), p.hlsActiveMs(),
                    p.mediamtx(), p.quality(), p.dvr(), p.turn(), p.stats(), p.legacyUi(), p.limits(), p.rates()));
            assertEquals(1, fromFile.size());
            assertEquals(0, fromFile.indexOf("Bearer " + TestProps.TOKEN_A));
        } finally {
            java.nio.file.Files.deleteIfExists(file);
        }
    }

    @Test
    void theListIsLimited() {
        // TestProps allows 2 broadcasts (RELAY_MAX_BROADCASTS): the third path is refused with 503 "directory full".
        assertEquals(204, registry.announce(announce(A1, "screen-01", ""), a).status());
        assertEquals(204, registry.announce(announce(A2, "screen-02", ""), b).status());
        BroadcastRegistry.Result third = registry.announce(announce("00000000000000000000000000000003", "screen-03", ""), a);
        assertEquals(503, third.status());
        assertEquals("directory full", third.reason());
        assertTrue(registry.all().size() == 2);
    }
}
