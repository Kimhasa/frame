package frame.api.stats;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Playback report rows of server/lib/stats.mjs: anonymous fields only, numbers as JavaScript writes them, CSV quoting. */
class StatsRowTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Test
    void aReportBecomesOneAnonymousRow() {
        StatsLog.Row r = StatsLog.row("screen-01", JSON.readTree("{\"sid\":\"s-1\",\"broadcast\":\"0123456789abcdef0123456789abcdef\",\"transport\":\"hls\","
                + "\"quality\":\"720p\",\"height\":720,\"fps\":29.97,\"lossPct\":0.125,\"mbps\":2.50,\"lastSwitch\":\"=SUM(A1)\",\"event\":\" a,\\\"b\\\" \","
                + "\"ip\":\"10.0.0.1\"}"), 1_762_000_000_000L);
        assertEquals("s-1", r.session());
        assertEquals(List.of("2025-11-01T12:26:40.000Z", "screen-01", "s-1", "0123456789abcdef0123456789abcdef", "hls", "", "720p", "720", "30", "0.13", "",
                "", "2.5", "", "=SUM(A1)", "a,\"b\"", ""), r.fields());
        assertEquals("2025-11-01T12:26:40.000Z,screen-01,s-1,0123456789abcdef0123456789abcdef,hls,,720p,720,30,0.13,,,2.5,,'=SUM(A1),\"a,\"\"b\"\"\",\n",
                StatsLog.line(r.fields()));
    }

    @Test
    void aLoneSurrogateIsWrittenAsTheReplacementCharacter() {
        StatsLog.Row r = StatsLog.row("p", JSON.readTree("{\"sid\":\"s\",\"event\":\"a\\ud800b\"}"), 0);
        assertEquals(true, StatsLog.line(r.fields()).contains(",a�b,"));
    }

    @Test
    void refusals() {
        assertEquals("JSON object required", StatsLog.row("p", JSON.readTree("[1]"), 0).error());
        assertEquals("sid required", StatsLog.row("p", JSON.readTree("{\"sid\":\"-bad\"}"), 0).error());
    }
}
