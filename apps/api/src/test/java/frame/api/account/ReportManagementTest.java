package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ReportManagementTest {
    private final JsonMapper json = JsonMapper.builder().build();
    @Test void filtersAcceptStatusesReasonsAndTrimLiteralQuery() {
        var filters = ReportManagement.filters("reviewing", "harassment", "  채널_%  ", "", 100);
        assertEquals("채널_%", filters.query()); assertNull(filters.cursor()); assertEquals(100, filters.limit());
        for (String status : List.of("received", "reviewing", "resolved", "dismissed", "all")) assertEquals(status, ReportManagement.filters(status, "all", "", "", 1).status());
    }
    @Test void filtersRejectInvalidBoundsAndControls() {
        assertEquals("INVALID_REPORT_FILTER", assertThrows(ProductProblem.class, () -> ReportManagement.filters("unknown", "all", "", "", 50)).code);
        assertThrows(ProductProblem.class, () -> ReportManagement.filters("all", "unknown", "", "", 50));
        for (int limit : List.of(0, 101, Integer.MAX_VALUE)) assertThrows(ProductProblem.class, () -> ReportManagement.filters("all", "all", "", "", limit));
        assertDoesNotThrow(() -> ReportManagement.filters("all", "all", "🌱".repeat(120), "", 50));
        for (String query : List.of("🌱".repeat(121), "line\nnew", "zero\0byte")) assertThrows(ProductProblem.class, () -> ReportManagement.filters("all", "all", query, "", 50));
    }
    @Test void cursorRoundTripsTheFullPostgresMicrosecondPrecision() {
        UUID id = UUID.fromString("ffffffff-0000-0000-0000-000000000001");
        OffsetDateTime at = OffsetDateTime.parse("2026-11-12T01:02:03.123456Z");
        var cursor = ReportManagement.decode(ReportManagement.encode(at, id));
        assertEquals(at, cursor.at()); assertEquals(id, cursor.id());
        assertNotEquals(ReportManagement.encode(at, id), ReportManagement.encode(at.plusNanos(1000), id));
    }
    @Test void malformedCursorAndReportIdsHaveStableErrors() {
        for (String cursor : List.of("x", "=", "a".repeat(201), encoded("2026-13-99T01:02:03Z|" + UUID.randomUUID()), encoded("2026-11-12T01:02:03.123456789Z|" + UUID.randomUUID()), encoded("1960-11-12T01:02:03Z|" + UUID.randomUUID())))
            assertEquals("INVALID_REPORT_CURSOR", assertThrows(ProductProblem.class, () -> ReportManagement.decode(cursor)).code);
        assertNull(ReportManagement.decode(""));
        assertEquals("INVALID_REPORT_ID", assertThrows(ProductProblem.class, () -> ReportManagement.id("1-1-1-1-1")).code);
    }
    @Test void reviewChangeHasExactFieldsBoundedVersionAndRequiredTerminalNote() {
        assertEquals("", ReportManagement.change(json.valueToTree(Map.of("status", "reviewing", "reviewNote", "", "version", 0))).note());
        assertEquals("처리 내용", ReportManagement.change(json.valueToTree(Map.of("status", "resolved", "reviewNote", " 처리 내용 ", "version", 1))).note());
        for (String status : List.of("received", "all", "unknown")) assertEquals("INVALID_REPORT_UPDATE", assertThrows(ProductProblem.class, () -> ReportManagement.change(json.valueToTree(Map.of("status", status, "reviewNote", "내용", "version", 0)))).code);
        for (Object version : List.of(-1, 1.5, "1", 2147483648L)) assertEquals("INVALID_REPORT_UPDATE", assertThrows(ProductProblem.class, () -> ReportManagement.change(json.valueToTree(Map.of("status", "reviewing", "reviewNote", "내용", "version", version)))).code);
        assertEquals("INVALID_REPORT_UPDATE", assertThrows(ProductProblem.class, () -> ReportManagement.change(json.valueToTree(Map.of("status", "resolved", "reviewNote", "내용", "version", 0, "reviewedBy", UUID.randomUUID().toString())))).code);
        assertEquals("INVALID_REVIEW_NOTE", assertThrows(ProductProblem.class, () -> ReportManagement.change(json.valueToTree(Map.of("status", "dismissed", "reviewNote", " ", "version", 0)))).code);
    }
    @Test void reviewNotesAllowLinesAndUnicodeButRejectExcessAndControls() {
        assertEquals("첫 줄\n둘째 줄", ReportManagement.change(json.valueToTree(Map.of("status", "reviewing", "reviewNote", "첫 줄\n둘째 줄", "version", 0))).note());
        assertDoesNotThrow(() -> ReportManagement.change(json.valueToTree(Map.of("status", "resolved", "reviewNote", "🌱".repeat(1000), "version", 0))));
        for (Object note : List.of("a".repeat(1001), "zero\0byte", true)) assertEquals("INVALID_REVIEW_NOTE", assertThrows(ProductProblem.class, () -> ReportManagement.change(json.valueToTree(Map.of("status", "reviewing", "reviewNote", note, "version", 0)))).code);
    }
    private static String encoded(String value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
}
