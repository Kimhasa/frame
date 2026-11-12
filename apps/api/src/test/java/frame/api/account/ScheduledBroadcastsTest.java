package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class ScheduledBroadcastsTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final long NOW = 1_700_000_000_000L;
    private JsonNode value(Object title, Object at) { return JSON.valueToTree(Map.of("title", title, "at", at)); }
    private void rejected(JsonNode value, String code) {
        ProductProblem error = assertThrows(ProductProblem.class, () -> ScheduledBroadcasts.validate(value, NOW));
        assertEquals(400, error.status); assertEquals(code, error.code);
    }
    @Test void titleIsTrimmedAndCountsFullUnicodeCharacters() {
        var draft = ScheduledBroadcasts.validate(value("  같이 코딩해요 🌱  ", NOW + 10_000), NOW);
        assertEquals("같이 코딩해요 🌱", draft.title());
        assertEquals(NOW + 10_000, draft.at());
        assertEquals(100, ScheduledBroadcasts.validate(value("🌱".repeat(100), NOW + 10_000), NOW).title().codePointCount(0, 200));
        rejected(value("🌱".repeat(101), NOW + 10_000), "INVALID_SCHEDULE_TITLE");
    }
    @Test void blankNonStringAndControlCharacterTitlesAreRejected() {
        for (Object title : new Object[] { "  ", "hidden\u0000title", "line\nfeed", 12, false }) rejected(value(title, NOW + 10_000), "INVALID_SCHEDULE_TITLE");
        rejected(JSON.createObjectNode().put("at", NOW + 10_000), "INVALID_SCHEDULE_TITLE");
    }
    @Test void onlyWholeFutureEpochMillisecondsWithinSupportedDateRangeAreAccepted() {
        for (Object at : new Object[] { NOW, NOW - 1, NOW + 0.5, Long.MAX_VALUE, "1700000010000", true, 253402300800000L }) rejected(value("제목", at), "INVALID_SCHEDULE_TIME");
        rejected(JSON.createObjectNode().put("title", "제목"), "INVALID_SCHEDULE_TIME");
        assertEquals(253402300799999L, ScheduledBroadcasts.validate(value("마지막 날짜", 253402300799999L), NOW).at());
    }
    @Test void callersCannotSupplyAnotherChannelOrOwner() {
        var input = JSON.createObjectNode().put("title", "다른 채널").put("at", NOW + 10_000).put("channelId", "someone-else");
        rejected(input, "INVALID_SCHEDULE_INPUT");
    }
}
