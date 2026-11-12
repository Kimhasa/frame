package frame.api.obs;

import static org.junit.jupiter.api.Assertions.*;

import frame.api.FrameProperties;
import frame.api.TestProps;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.web.ClientAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.json.JsonMapper;

class ObsBroadcastsTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String PATH = "obs-spring";
    private static final MediaPath MEDIA = new MediaPath(true, System.currentTimeMillis(), List.of("H264", "MPEG-4 Audio"), 1280, 720, "High", "4.0", "rtmpConn", 0, 0, 10_000, 2.0, 0);
    private FrameProperties frame;
    private PublisherTokens tokens;
    private BroadcastRegistry registry;
    private ObsBroadcasts obs;
    private ObsController controller;

    @BeforeEach void setup() throws Exception {
        frame = withTokens(TestProps.TOKEN_A + " " + PATH + "," + TestProps.TOKEN_B + " obs-other");
        tokens = new PublisherTokens(frame);
        registry = new BroadcastRegistry(frame, tokens, event -> {});
        ObsProperties props = new ObsProperties(true, "rtmp://127.0.0.1:1935");
        obs = new ObsBroadcasts(props, frame, tokens, registry, new MediaMtxPaths(frame, JSON), JSON);
        controller = new ObsController(props, obs, tokens, new ClientAddress(frame), JSON, frame);
    }

    @Test void incomingRtmpAutomaticallyRegistersWithoutPublisherHeartbeat() {
        long now = System.currentTimeMillis();
        assertEquals("waiting", obs.status(PATH).state());
        obs.reconcile(Map.of(PATH, MEDIA), false, now);
        String id = registry.byPath(PATH).id;
        assertEquals("live", obs.status(PATH).state());
        assertEquals(1280, registry.get(id).width);
        assertEquals(1280, obs.metrics(PATH).get("width"));
        assertEquals("AAC", obs.metrics(PATH).get("audioCodec"));
        assertNull(obs.metrics(PATH).get("fps"));
        obs.reconcile(Map.of(PATH, MEDIA), false, now + 20_000);
        assertEquals(id, registry.byPath(PATH).id);
        assertNotNull(registry.get(id).seen);
    }

    @Test void stopWaitsForGraceThenNextPublicationGetsNewId() {
        long now = System.currentTimeMillis();
        obs.reconcile(Map.of(PATH, MEDIA), false, now);
        String first = registry.byPath(PATH).id;
        obs.reconcile(Map.of(), false, now + 1000);
        assertEquals("reconnecting", obs.status(PATH).state());
        obs.reconcile(Map.of(PATH, MEDIA), false, now + 2000);
        assertEquals(first, registry.byPath(PATH).id);
        obs.reconcile(Map.of(), false, now + 18_000);
        assertNull(registry.get(first));
        assertEquals("waiting", obs.status(PATH).state());
        obs.reconcile(Map.of(PATH, MEDIA), false, now + 19_000);
        assertNotEquals(first, registry.byPath(PATH).id);
    }

    @Test void staleMediaSnapshotDoesNotExtendTheGracePeriod() {
        long now = System.currentTimeMillis();
        obs.reconcile(Map.of(PATH, MEDIA), false, now);
        obs.reconcile(Map.of(PATH, MEDIA), true, now + 16_000);
        assertNull(registry.byPath(PATH));
        assertEquals("unavailable", obs.status(PATH).state());
    }

    @Test void differentPublisherAfterMissedGraceDoesNotRevivePreviousBroadcast() {
        long now = System.currentTimeMillis();
        obs.reconcile(Map.of(PATH, MEDIA), false, now);
        String first = registry.byPath(PATH).id;
        MediaPath next = new MediaPath(true, MEDIA.readyMs() + 20_000, MEDIA.tracks(), 1280, 720, "High", "4.0", "rtmpConn", 0, 0, 1, 0, 0);
        obs.reconcile(Map.of(PATH, next), false, now + 20_000);
        assertNull(registry.get(first));
        assertNotEquals(first, registry.byPath(PATH).id);
    }

    @Test void nativeAndUnassignedInputAreNotClaimed() {
        MediaPath rtsp = new MediaPath(true, 1, MEDIA.tracks(), 1280, 720, "High", "4.0", "rtspsSession", 0, 0, 1, 0, 0);
        obs.reconcile(Map.of(PATH, rtsp, "obs-unassigned", MEDIA), false, System.currentTimeMillis());
        assertEquals(0, registry.size());
        String id = "0123456789abcdef0123456789abcdef";
        assertEquals(204, registry.announce(JSON.valueToTree(Map.of("v", 1, "type", "announce", "item", Map.of("id", id, "path", PATH, "title", "Native", "publisher", "Native", "width", 1280, "height", 720, "fps", 30, "startedAtMs", System.currentTimeMillis()))), 0).status());
        obs.reconcile(Map.of(PATH, MEDIA), false, System.currentTimeMillis());
        assertEquals(id, registry.byPath(PATH).id);
    }

    @Test void anotherInputProtocolCannotBeConfirmedAsTheExistingObsBroadcast() {
        long now = System.currentTimeMillis();
        obs.reconcile(Map.of(PATH, MEDIA), false, now);
        String id = registry.byPath(PATH).id;
        MediaPath rtsp = new MediaPath(true, now + 1000, MEDIA.tracks(), 1280, 720, "High", "4.0", "rtspsSession", 0, 0, 1, 0, 0);
        obs.reconcile(Map.of(PATH, rtsp), false, now + 1500);
        assertNull(registry.get(id));
        assertFalse(obs.status(PATH).mediaReady());
    }

    @Test void sharedAndWildcardTokensCannotBecomeAnImplicitOwner() throws Exception {
        PublisherTokens shared = new PublisherTokens(withTokens(TestProps.TOKEN_A + " " + PATH + "," + TestProps.TOKEN_B + " " + PATH));
        assertEquals(-1, shared.explicitOwner(PATH));
        PublisherTokens wildcard = new PublisherTokens(withTokens(TestProps.TOKEN_A + " *"));
        assertEquals(-1, wildcard.explicitOwner(PATH));
        assertEquals(0, tokens.explicitOwner(PATH));
    }

    @Test void credentialStatusIsPublisherOnlyNoStoreAndPathScoped() {
        assertEquals(401, controller.status(PATH, request(null)).getStatusCode().value());
        assertEquals(403, controller.status(PATH, request(TestProps.TOKEN_B)).getStatusCode().value());
        assertEquals(404, controller.status("spring", request(TestProps.TOKEN_A)).getStatusCode().value());
        var response = controller.status(PATH, request(TestProps.TOKEN_A));
        assertEquals(200, response.getStatusCode().value());
        assertEquals("no-store", response.getHeaders().getCacheControl());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertEquals(PATH + "?user=" + PATH + "&pass=" + TestProps.TOKEN_A, body.get("streamKey"));
        assertFalse(body.toString().contains(TestProps.TOKEN_B));
    }

    @Test void metadataHasBoundedValidationAndUpdatesRegisteredTitle() throws Exception {
        MockHttpServletRequest req = request(TestProps.TOKEN_A);
        req.setContent("{\"title\":\"봄의 작업실\",\"publisher\":\"봄\"}".getBytes(StandardCharsets.UTF_8));
        assertEquals(204, controller.metadata(PATH, req).getStatusCode().value());
        obs.reconcile(Map.of(PATH, MEDIA), false, System.currentTimeMillis());
        assertEquals("봄의 작업실", registry.byPath(PATH).title);
        req = request(TestProps.TOKEN_A);
        req.setContent("{\"title\":\"\",\"publisher\":\"봄\"}".getBytes(StandardCharsets.UTF_8));
        assertEquals(400, controller.metadata(PATH, req).getStatusCode().value());
        assertEquals("봄의 작업실", registry.byPath(PATH).title);
    }

    @Test void publicPlainRtmpAndCredentialBearingServerOriginsAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> new ObsProperties(true, "rtmp://public.example:1935"));
        assertThrows(IllegalArgumentException.class, () -> new ObsProperties(true, "rtmps://user:secret@public.example:1936"));
        assertThrows(IllegalArgumentException.class, () -> new ObsProperties(true, "rtmps://public.example:1936/app"));
        assertEquals("rtmps://public.example:1936", new ObsProperties(true, "rtmps://public.example:1936/").serverUrl());
    }

    private static MockHttpServletRequest request(String token) {
        var req = new MockHttpServletRequest(); req.setRemoteAddr("127.0.0.1");
        if (token != null) req.addHeader("Authorization", "Bearer " + token);
        return req;
    }

    private static FrameProperties withTokens(String configured) {
        FrameProperties p = TestProps.props();
        return new FrameProperties(p.publicBaseUrl(), p.trustedProxies(), configured, "", p.hls(), p.hlsAac(), p.iceServers(), p.announceTtlMs(), p.mediaGraceMs(),
                p.sessionActiveMs(), p.hlsCountWithoutSession(), p.hlsActiveMs(), p.mediamtx(), p.quality(), p.dvr(), p.turn(), p.stats(), p.legacyUi(), p.limits(), p.rates());
    }
}
