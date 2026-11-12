package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import frame.api.TestProps;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ProductNotificationsTest {
    @Test void sourceIdentitySurvivesMeasurementsAndFallsBackOnlyToKnownReadyTime() {
        var first = media(1794442212345L, "session-one");
        var same = new MediaPath(true, first.readyMs(), first.tracks(), 1920, 1080, "High", "4.0", "rtmpConn", 25, 0, 999999, 8, 8, "session-one");
        assertEquals(ProductNotifications.source(first), ProductNotifications.source(same));
        assertNotEquals(ProductNotifications.source(first), ProductNotifications.source(media(first.readyMs(), "session-two")));
        assertNotEquals(ProductNotifications.source(first), ProductNotifications.source(media(first.readyMs() + 1, "session-one")));
        assertEquals(64, ProductNotifications.source(media(first.readyMs(), "")).length()); assertEquals("", ProductNotifications.source(media(0, "session-one")));
    }
    @Test void metadataAloneOrOldUnrelatedMediaCannotCreateLiveEvents() throws Exception {
        Broadcast broadcast = broadcast();
        MediaPath ready = media(System.currentTimeMillis(), "current-session");
        assertFalse(ProductNotifications.consistent(broadcast, ready));
        broadcast.observe(ready, false); assertTrue(ProductNotifications.consistent(broadcast, ready));
        assertFalse(ProductNotifications.consistent(broadcast, media(ready.readyMs(), "old-session")));
        var old = media(broadcast.startedAtRelayMs - 10_001, "old-session"); broadcast.observe(old, false); assertFalse(ProductNotifications.consistent(broadcast, old));
        assertFalse(ProductNotifications.consistent(broadcast, null));
    }
    @Test void unreadAndKindFiltersAndCursorBoundsAreValidated() {
        assertEquals("unread", ProductNotifications.filters("unread", "report", "", 100).filter());
        for (int limit : List.of(0, 101)) assertEquals("INVALID_NOTIFICATION_FILTER", assertThrows(ProductProblem.class, () -> ProductNotifications.filters("all", "all", "", limit)).code);
        assertThrows(ProductProblem.class, () -> ProductNotifications.filters("invalid", "all", "", 50)); assertThrows(ProductProblem.class, () -> ProductNotifications.filters("all", "unknown", "", 50));
        UUID id = UUID.randomUUID(); var cursor = ProductNotifications.decode(ProductNotifications.encode(1794442212345L, id)); assertEquals(id, cursor.id()); assertEquals(1794442212345L, cursor.at());
        for (String invalid : List.of("=", "a", "x".repeat(161))) assertEquals("INVALID_NOTIFICATION_CURSOR", assertThrows(ProductProblem.class, () -> ProductNotifications.decode(invalid)).code);
        assertEquals("INVALID_NOTIFICATION_ID", assertThrows(ProductProblem.class, () -> ProductNotifications.id("1-1-1-1-1")).code);
    }
    @Test void staleApiSnapshotsAreNeverDeliveryEvidence() {
        MediaMtxPaths media = mock(MediaMtxPaths.class); when(media.ok()).thenReturn(true); when(media.goodAt()).thenReturn(System.currentTimeMillis()); assertTrue(ProductNotifications.fresh(media));
        when(media.stale()).thenReturn(true); assertFalse(ProductNotifications.fresh(media));
        when(media.stale()).thenReturn(false); when(media.goodAt()).thenReturn(System.currentTimeMillis() - 7000); assertFalse(ProductNotifications.fresh(media));
    }
    @Test void productDeliveryFailureIsContainedAndTheNextTickCanRetry() throws Exception {
        var media = mock(MediaMtxPaths.class); var broadcasts = mock(BroadcastRegistry.class); var notifications = mock(ProductNotifications.class);
        Broadcast broadcast = broadcast(); MediaPath ready = media(System.currentTimeMillis(), "one");
        when(media.ok()).thenReturn(true); when(media.goodAt()).thenReturn(System.currentTimeMillis()); when(media.last()).thenReturn(Map.of(broadcast.path, ready)); when(broadcasts.all()).thenReturn(List.of(broadcast));
        doThrow(new RuntimeException("database-down")).doNothing().when(notifications).live(broadcast, ready);
        var worker = new NotificationReconciler(notifications, broadcasts, media);
        assertDoesNotThrow(worker::reconcile); assertDoesNotThrow(worker::reconcile); verify(notifications, times(2)).live(broadcast, ready); worker.stop();
    }
    private static MediaPath media(long ready, String source) { return new MediaPath(true, ready, List.of("H264", "MPEG-4 Audio"), 1280, 720, "High", "4.0", "rtmpConn", 0, 0, 1000, 1, 1, source); }
    private static Broadcast broadcast() throws java.io.IOException {
        var props = TestProps.props(); var tokens = new PublisherTokens(props); var registry = new BroadcastRegistry(props, tokens, event -> {});
        registry.announce(JsonMapper.builder().build().valueToTree(Map.of("v", 1, "type", "announce", "item", Map.of("id", "a".repeat(32), "path", "screen-01", "title", "방송", "publisher", "PC", "startedAtMs", System.currentTimeMillis(), "width", 0, "height", 0, "fps", 0))), 0);
        return registry.get("a".repeat(32));
    }
}
