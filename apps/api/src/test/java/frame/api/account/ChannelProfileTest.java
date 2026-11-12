package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChannelProfileTest {
    private final JsonMapper json = JsonMapper.builder().build();
    @Test void countriesUseActualIsoCodesAndAllowExplicitClearing() {
        assertEquals("KR", ChannelProfile.country(json.valueToTree(" kr ")));
        assertEquals("US", ChannelProfile.country(json.valueToTree("US")));
        assertNull(ChannelProfile.country(json.valueToTree(null)));
        for (Object invalid : List.of("", "ZZ", "KOR", "한국", 1)) assertEquals("INVALID_COUNTRY", assertThrows(ProductProblem.class, () -> ChannelProfile.country(json.valueToTree(invalid))).code);
    }
    @Test void linksKeepOrderAndAcceptOnlyBoundedPublicHttpAddresses() {
        var links = ChannelProfile.links(json.valueToTree(List.of(Map.of("title", "첫 링크", "url", "https://example.test/a?q=1#fragment"), Map.of("title", "두 번째", "url", "http://localhost:8080/"))));
        assertEquals("첫 링크", links.getFirst().title()); assertEquals("두 번째", links.getLast().title());
        assertEquals(14, ChannelProfile.links(json.valueToTree(java.util.Collections.nCopies(14, Map.of("title", "가".repeat(50), "url", "https://example.test/")))).size());
        assertThrows(ProductProblem.class, () -> ChannelProfile.links(json.valueToTree(java.util.Collections.nCopies(15, Map.of("title", "링크", "url", "https://example.test/")))));
    }
    @Test void unsafeLinksAndUnknownFieldsAreRejected() {
        for (String address : List.of("javascript:alert(1)", "data:text/html,x", "//example.test", "/relative", "ftp://example.test", "https://user:pass@example.test", "https://example.test:0/", "https://example.test:65536/", "https://example.test/\n", "https://example.test/" + "a".repeat(500)))
            assertEquals("INVALID_CHANNEL_LINKS", assertThrows(ProductProblem.class, () -> ChannelProfile.links(json.valueToTree(List.of(Map.of("title", "링크", "url", address))))).code, address);
        assertThrows(ProductProblem.class, () -> ChannelProfile.links(json.valueToTree(List.of(Map.of("title", " ", "url", "https://example.test")))));
        assertThrows(ProductProblem.class, () -> ChannelProfile.links(json.valueToTree(List.of(Map.of("title", "링크", "url", "https://example.test", "id", "client-value")))));
    }
    @Test void handlesNormalizeAsciiCaseAndKeepReservedNamespace() {
        assertEquals("spring-room_1", Accounts.handle(" Spring-Room_1 "));
        for (String invalid : List.of("ab", "a".repeat(25), "@spring", "한글", "Kelvin", "9name", "API", "studio", "a.b")) assertEquals("INVALID_HANDLE", assertThrows(ProductProblem.class, () -> Accounts.handle(invalid)).code);
    }
    @Test void reportsAllowOptionalDetailsButOtherNeedsAReasonDescription() {
        assertEquals("", ChannelReports.validate(json.valueToTree(Map.of("reason", "spam"))).details());
        assertEquals("내용\n둘째 줄", ChannelReports.validate(json.valueToTree(Map.of("reason", "other", "details", " 내용\n둘째 줄 "))).details());
        assertEquals("INVALID_REPORT_DETAILS", assertThrows(ProductProblem.class, () -> ChannelReports.validate(json.valueToTree(Map.of("reason", "other")))).code);
        for (Map<String, Object> invalid : List.<Map<String, Object>>of(Map.of("reason", "unknown"), Map.of("reason", "spam", "reporterId", "someone"), Map.of("reason", 1)))
            assertEquals("INVALID_REPORT_REASON", assertThrows(ProductProblem.class, () -> ChannelReports.validate(json.valueToTree(invalid))).code);
    }
    @Test void reportDetailsUseUnicodeLengthAndRejectControls() {
        assertEquals(1000, ChannelReports.validate(json.valueToTree(Map.of("reason", "other", "details", "🌱".repeat(1000)))).details().codePointCount(0, 2000));
        for (Object invalid : List.of("가".repeat(1001), "zero\0byte", "bad\u007fcontrol", true))
            assertEquals("INVALID_REPORT_DETAILS", assertThrows(ProductProblem.class, () -> ChannelReports.validate(json.valueToTree(Map.of("reason", "spam", "details", invalid)))).code);
    }
}
