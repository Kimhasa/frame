package frame.api.playback;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import frame.api.TestProps;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import frame.api.mediamtx.MediaPath;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Scope binding, the master playlist and the playlist rewriting, against what the Node relay produces. */
class PlaybackRulesTest {
    private static final String ID = "0123456789abcdef0123456789abcdef";

    private static Broadcast broadcast() throws Exception {
        PublisherTokens tokens = new PublisherTokens(TestProps.props());
        BroadcastRegistry registry = new BroadcastRegistry(TestProps.props(), tokens, event -> { });
        registry.announce(JsonMapper.builder().build().readTree("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + ID
                + "\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\"screen-01\",\"width\":1280,\"height\":720,\"fps\":30,\"startedAtMs\":0}}"), 0);
        return registry.byPath("screen-01");
    }

    private static MediaPath path(long readyMs, List<String> tracks) {
        return new MediaPath(true, readyMs, tracks, 1280, 720, "High", "3.1", "rtspsSession", 0, 0, 0, 2.5, 0);
    }

    @Test
    void bindingNamesTheBroadcastOnThePath() throws Exception {
        Broadcast e = broadcast();
        assertNull(BroadcastScope.binding(e, ID));
        assertEquals(409, BroadcastScope.binding(e, "f".repeat(32)).status());
        assertEquals("not-running", BroadcastScope.binding(null, ID).error());
    }

    @Test
    void aPublisherSessionOlderThanTheBroadcastIsNotItsOwn() throws Exception {
        Broadcast e = broadcast();
        assertFalse(BroadcastScope.ownMedia(e, path(e.startedAtRelayMs - 20_000, List.of("H264"))));
        assertTrue(BroadcastScope.ownMedia(e, path(e.startedAtRelayMs - 5_000, List.of("H264"))));
        // A session that began after the broadcast's last announcement waits for the next announcement.
        assertFalse(BroadcastScope.announced(e, path(e.lastAnnounceMs() + 1, List.of("H264"))));
    }

    @Test
    void masterListsTheSourceWithItsAacTrackUnderRelativeUris() throws Exception {
        Broadcast e = broadcast();
        MediaPath p = path(e.startedAtRelayMs, List.of("H264", "Opus", "MPEG-4 Audio"));
        LiveMedia.State s = new LiveMedia.State(e, p, Map.of("screen-01", p), true, false);
        String m3u8 = LivePlaylist.master(s, "", List.of(), List.of(), false, false);
        assertEquals(String.join("\n",
                "#EXTM3U", "#EXT-X-VERSION:9", "#EXT-X-INDEPENDENT-SEGMENTS",
                "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac-source\",NAME=\"audio\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"2\",URI=\"hls/audio3_stream.m3u8\"",
                "#EXT-X-STREAM-INF:BANDWIDTH=2628000,AVERAGE-BANDWIDTH=2628000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"aac-source\"",
                "hls/video1_stream.m3u8", ""), m3u8);
        assertEquals("", LivePlaylist.master(s, "480p", List.of(), List.of(), false, false));
    }

    @Test
    void withTheRelayLadderTheSourceIsItsCopyAndTheQualitiesFollow() throws Exception {
        Broadcast e = broadcast();
        MediaPath p = path(e.startedAtRelayMs, List.of("H264", "Opus", "MPEG-4 Audio"));
        LiveMedia.State s = new LiveMedia.State(e, p, Map.of("screen-01", p), true, false);
        List<frame.api.quality.Renditions.Quality> ladder = new frame.api.quality.Renditions(TestProps.props("480p")).ladder(e, p, s.paths());
        assertEquals(1, ladder.size());
        assertEquals(854, ladder.getFirst().width());
        String m3u8 = LivePlaylist.master(s, "", ladder, ladder, false, false);
        assertTrue(m3u8.contains("URI=\"src/hls/audio3_stream.m3u8\""), m3u8);
        assertTrue(m3u8.contains("\nsrc/hls/video1_stream.m3u8\n"), m3u8);
        assertTrue(m3u8.contains("RESOLUTION=854x480"), m3u8);
        assertTrue(m3u8.contains("\n480p/hls/video1_stream.m3u8\n"), m3u8);
        // A ladder that keeps failing: the source path itself, no relay quality.
        String down = LivePlaylist.master(s, "", ladder, ladder, true, false);
        assertTrue(down.contains("\nhls/video1_stream.m3u8\n") && !down.contains("480p/"), down);
        // Safari's manual choice of a relay quality while the ladder is down gets the source.
        assertTrue(LivePlaylist.master(s, "480p", ladder, ladder, true, false).contains("\nhls/video1_stream.m3u8\n"));
    }

    @Test
    void levelIsComputedWhenMediaMtxHasNoCodecProps() {
        assertEquals(31, LivePlaylist.avcLevelIdc(1280, 720, 30, 2.5));
        assertEquals(42, LivePlaylist.avcLevelIdc(1920, 1080, 60, 8));
    }

    @Test
    void sessionIdsAreRemovedFromPlaylists() {
        String in = "#EXTM3U\r\n#EXT-X-MAP:URI=\"init.mp4?session=abc&x=1\"\r\nseg1.mp4?session=abc\r\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"p2.mp4?session=abc\"";
        assertEquals("#EXTM3U\r\n#EXT-X-MAP:URI=\"init.mp4\"\r\nseg1.mp4\r\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"p2.mp4\"", HlsUpstream.stripPlaylistQueries(in));
    }

    @Test
    void onlyTheLlHlsQueryKeysPassUpstream() {
        assertEquals("&_HLS_msn=12&_HLS_part=3", HlsUpstream.params("12", "3", null));
        assertEquals("", HlsUpstream.params("12&x=1", "", "bad"));
        assertEquals("&_HLS_skip=YES", HlsUpstream.params(null, null, "YES"));
    }
}
