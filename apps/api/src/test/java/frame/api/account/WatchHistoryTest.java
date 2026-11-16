package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class WatchHistoryTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    @Test void archivedProgressRequiresExactFieldsAndNonnegativeIntegralNumbers() {
        Map<String, Object> body = new HashMap<>(Map.of("epoch", 2, "version", 3, "positionMs", 1000, "completed", false));
        body.put("id", UUID.randomUUID().toString());
        var progress = WatchHistory.progress(JSON.valueToTree(body));
        assertEquals(2, progress.epoch()); assertEquals(3, progress.version()); assertEquals(1000, progress.position()); assertFalse(progress.completed());
        body.put("id", null); assertNull(WatchHistory.progress(JSON.valueToTree(body)).id());
        for (String key : new String[] { "epoch", "version", "positionMs" }) {
            for (Object value : new Object[] { -1, 0.5, "1", true, "9223372036854775808" }) {
                var invalid = new HashMap<>(body); invalid.put(key, value);
                assertEquals("INVALID_HISTORY_INPUT", assertThrows(ProductProblem.class, () -> WatchHistory.progress(JSON.valueToTree(invalid))).code);
            }
        }
        for (String key : body.keySet()) {
            var invalid = new HashMap<>(body); invalid.remove(key);
            assertThrows(ProductProblem.class, () -> WatchHistory.progress(JSON.valueToTree(invalid)));
        }
        for (String key : new String[] { "title", "durationMs", "channelId", "userId", "watchedAtMs" }) {
            var invalid = new HashMap<>(body); invalid.put(key, "untrusted");
            assertThrows(ProductProblem.class, () -> WatchHistory.progress(JSON.valueToTree(invalid)));
        }
        var invalid = new HashMap<>(body); invalid.put("id", "../media"); assertThrows(ProductProblem.class, () -> WatchHistory.progress(JSON.valueToTree(invalid)));
        invalid.put("id", null); invalid.put("completed", "true"); assertThrows(ProductProblem.class, () -> WatchHistory.progress(JSON.valueToTree(invalid)));
        assertThrows(ProductProblem.class, () -> WatchHistory.progress(JSON.readTree("{\"epoch\":9223372036854775808,\"id\":null,\"version\":0,\"positionMs\":0,\"completed\":false}")));
    }
    @Test void completionRequiresTheTrustedEndAndReplayCanSaveAnEarlierPosition() {
        assertEquals(0, WatchHistory.position(0, false, 6000));
        assertEquals(1500, WatchHistory.position(1500, false, 6000));
        assertEquals(6000, WatchHistory.position(5000, true, 6000));
        assertEquals(6000, WatchHistory.position(6000, true, 6000));
        for (long position : new long[] { -1, 6001, Long.MAX_VALUE }) assertThrows(ProductProblem.class, () -> WatchHistory.position(position, false, 6000));
        assertThrows(ProductProblem.class, () -> WatchHistory.position(4999, true, 6000));
        assertThrows(ProductProblem.class, () -> WatchHistory.position(0, true, 6000));
    }
    @Test void filterDatesAreInclusiveSeoulCalendarDays() {
        var filter = WatchHistory.filters("all", "  코딩  ", "2026-11-12", "2026-11-12", "", 50);
        assertEquals("코딩", filter.query());
        assertEquals(Instant.parse("2026-11-11T15:00:00Z").toEpochMilli(), filter.from());
        assertEquals(Instant.parse("2026-11-12T15:00:00Z").toEpochMilli(), filter.to());
    }
    @Test void badDatesKindsAndLimitsAreControlledRefusals() {
        for (String date : new String[] { "2026-02-30", "2026-13-01", "2026-2-01", "not-a-date" }) assertThrows(ProductProblem.class, () -> WatchHistory.filters("all", "", date, "", "", 50));
        assertThrows(ProductProblem.class, () -> WatchHistory.filters("all", "", "2026-11-13", "2026-11-12", "", 50));
        assertThrows(ProductProblem.class, () -> WatchHistory.filters("unknown", "", "", "", "", 50));
        for (int limit : new int[] { -1, 0, 101 }) assertThrows(ProductProblem.class, () -> WatchHistory.filters("all", "", "", "", "", limit));
    }
    @Test void searchIsBoundedInUnicodeCharactersWithoutControls() {
        assertEquals("🌱".repeat(120), WatchHistory.filters("live", "🌱".repeat(120), "", "", "", 100).query());
        assertThrows(ProductProblem.class, () -> WatchHistory.filters("all", "🌱".repeat(121), "", "", "", 50));
        for (String query : new String[] { "abc\0def", "abc\ndef", "abc\u007f" }) assertThrows(ProductProblem.class, () -> WatchHistory.filters("all", query, "", "", "", 50));
    }
    @Test void cursorRoundTripsAnExactMillisAndUuidPair() {
        UUID id = UUID.randomUUID(); long at = 1794442212345L;
        String value = WatchHistory.encode(at, id);
        assertEquals(new WatchHistory.Cursor(at, id), WatchHistory.decode(value));
        assertFalse(value.contains("=")); assertNull(WatchHistory.decode(""));
    }
    @Test void malformedCursorsAndIdsNeverBecomeSqlValues() {
        for (String value : new String[] { "?", "x".repeat(161), "AA", encode("-1:" + UUID.randomUUID()), encode("1794442212345:1-1-1-1-1"), encode("9007199254740991:" + UUID.randomUUID()) }) {
            ProductProblem failure = assertThrows(ProductProblem.class, () -> WatchHistory.decode(value)); assertEquals("INVALID_HISTORY_CURSOR", failure.code);
        }
        assertThrows(ProductProblem.class, () -> WatchHistory.id("1-1-1-1-1"));
        assertThrows(ProductProblem.class, () -> WatchHistory.id("' OR TRUE --"));
    }
    private static String encode(String value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
}
