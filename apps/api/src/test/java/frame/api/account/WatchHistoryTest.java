package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class WatchHistoryTest {
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
