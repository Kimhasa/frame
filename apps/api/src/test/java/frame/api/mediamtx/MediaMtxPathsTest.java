package frame.api.mediamtx;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** MediaMTX readyTime as 1.21.3 really sends it: a broken parse would turn the broadcast-ID media checks off (readyMs 0). */
class MediaMtxPathsTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Test
    void readyTimeWithLocalOffsetAndSevenFractionDigits() {
        long ms = MediaMtxPaths.time(JSON.readTree("\"2026-11-09T16:33:44.5946245+09:00\""));
        assertEquals(Instant.parse("2026-11-09T07:33:44.594Z").toEpochMilli(), ms);
    }

    @Test
    void utcAndMissingValues() {
        assertEquals(Instant.parse("2026-11-09T07:33:44Z").toEpochMilli(), MediaMtxPaths.time(JSON.readTree("\"2026-11-09T07:33:44Z\"")));
        assertEquals(0, MediaMtxPaths.time(JSON.readTree("null")));
        assertEquals(0, MediaMtxPaths.time(JSON.readTree("\"not a time\"")));
    }
}
