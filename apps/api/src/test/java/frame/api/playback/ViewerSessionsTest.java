package frame.api.playback;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import frame.api.FrameProperties;
import frame.api.TestProps;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;

/** Viewer caps: per path (sessions + the other viewers) and per address, exact under a burst of concurrent opens. */
class ViewerSessionsTest {
    private static ViewerSessions sessions(int perPath, int perIp) {
        FrameProperties p = TestProps.props();
        FrameProperties.Limits l = p.limits();
        return new ViewerSessions(new FrameProperties(p.publicBaseUrl(), p.trustedProxies(), p.publisherTokens(), p.publisherTokensFile(), p.hls(), p.hlsAac(),
                p.iceServers(), p.announceTtlMs(), p.mediaGraceMs(), p.sessionActiveMs(), p.hlsCountWithoutSession(), p.hlsActiveMs(), p.mediamtx(), p.quality(),
                p.dvr(), p.turn(), p.stats(), p.legacyUi(),
                new FrameProperties.Limits(l.sockets(), l.broadcasts(), perPath, perIp, l.chat(), l.chatPerIp(), l.whepInflight(), l.dvrStreams(), l.dvrPerIp(),
                        l.hlsInflight(), l.hlsPerIp()), p.rates()));
    }

    @Test
    void thePathCapCountsTheOtherViewersAndHoldsUnderABurst() throws Exception {
        ViewerSessions s = sessions(10, 1000);
        try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<ViewerSessions.Opened>> all = new ArrayList<>();
            for (int i = 0; i < 50; i++) { int n = i; all.add(pool.submit(() -> s.open("screen-01", "a:" + n, "10.0.0.1", () -> 2))); }
            int opened = 0;
            for (Future<ViewerSessions.Opened> f : all) if (f.get().sid() != null) opened++;
            assertEquals(8, opened);  // 10 minus the 2 WebRTC readers
        }
        assertEquals(ViewerSessions.Refusal.VIEWER_LIMIT, s.open("screen-01", "a:x", "10.0.0.2", () -> 2).refusal());
    }

    @Test
    void theAddressCapAndLeaving() {
        ViewerSessions s = sessions(1000, 1);
        ViewerSessions.Opened first = s.open("screen-01", "a:1", "10.0.0.1", () -> 0);
        assertNotNull(first.sid());
        assertTrue(s.valid("screen-01",first.sid(),"a:1","10.0.0.1"));
        assertFalse(s.valid("another",first.sid(),"a:1","10.0.0.1"));
        assertFalse(s.valid("screen-01",first.sid(),"a:other","10.0.0.1"));
        assertFalse(s.valid("screen-01",first.sid(),"a:1","10.0.0.2"));
        assertTrue(s.hasKey("screen-01", "a:1"));
        assertEquals(ViewerSessions.Refusal.ADDRESS_LIMIT, s.open("screen-01", "a:2", "10.0.0.1", () -> 0).refusal());
        assertTrue(s.touch("screen-01", first.sid(), "a:1", "10.0.0.1", false));
        assertTrue(s.touch("screen-01", first.sid(), "a:1", "10.0.0.1", true));
        assertFalse(s.touch("screen-01", first.sid(), "a:1", "10.0.0.1", false));
        assertFalse(s.valid("screen-01",first.sid(),"a:1","10.0.0.1"));
        assertFalse(s.hasKey("screen-01", "a:1"));
        assertNotNull(s.open("screen-01", "a:1", "10.0.0.1", () -> 0).sid());
    }

    @Test
    void aSessionFollowsItsPageToAnotherAddress() {
        ViewerSessions s = sessions(1000, 1);
        ViewerSessions.Opened first = s.open("screen-01", "a:1", "10.0.0.1", () -> 0);
        // Wi-Fi -> mobile data: the heartbeat moves the per-address count, so the old address may open a session again.
        assertTrue(s.touch("screen-01", first.sid(), "a:2", "10.0.0.9", false));
        assertNotNull(s.open("screen-01", "a:1", "10.0.0.1", () -> 0).sid());
        assertTrue(s.hasKey("screen-01", "a:2"));
    }
}
