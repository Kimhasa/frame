package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChannelPollsTest {
    private final JsonMapper json=JsonMapper.builder().build();
    private Map<String,Object> valid(){return new HashMap<>(Map.of("question","  다음 순서는?  ","options",List.of("개발","게임"),"durationSeconds",60,"path","obs-poll","broadcastId","a".repeat(32)));}
    @Test void draftsKeepThePreviewLimitsAndUseRealBroadcastKeys(){
        var draft=ChannelPolls.draft(json.valueToTree(valid()));assertEquals("다음 순서는?",draft.question());assertEquals(List.of("개발","게임"),draft.options());assertEquals(60,draft.seconds());
        for(int duration:List.of(60,180,300,600)){var input=valid();input.put("durationSeconds",duration);assertEquals(duration,ChannelPolls.draft(json.valueToTree(input)).seconds());}
        var maximum=valid();maximum.put("question","🌱".repeat(100));maximum.put("options",java.util.stream.IntStream.range(0,8).mapToObj(i->"🌱".repeat(99)+i).toList());assertEquals(8,ChannelPolls.draft(json.valueToTree(maximum)).options().size());
    }
    @Test void blankControlsBoundsAndEquivalentChoicesAreRejected(){
        for(Map.Entry<String,Object> change:List.<Map.Entry<String,Object>>of(Map.entry("question"," "),Map.entry("question","\u200b"),Map.entry("question","a".repeat(101)),Map.entry("question","first\nsecond"),Map.entry("options",List.of("one")),Map.entry("options",java.util.Collections.nCopies(9,"x")),Map.entry("durationSeconds",120),Map.entry("durationSeconds","60"),Map.entry("broadcastId","A".repeat(32)),Map.entry("path","../other"))){var input=valid();input.put(change.getKey(),change.getValue());assertThrows(ProductProblem.class,()->ChannelPolls.draft(json.valueToTree(input)));}
        var duplicate=valid();duplicate.put("options",List.of("ＦＯＯ","foo"));assertEquals("DUPLICATE_POLL_OPTIONS",assertThrows(ProductProblem.class,()->ChannelPolls.draft(json.valueToTree(duplicate))).code);
        var injected=valid();injected.put("channelId","other-owner");assertEquals("INVALID_POLL_INPUT",assertThrows(ProductProblem.class,()->ChannelPolls.draft(json.valueToTree(injected))).code);
    }
    @Test void dateFiltersAreInclusiveKstDaysAndRejectInvalidCalendarDates(){
        assertEquals(Instant.parse("2026-11-11T15:00:00Z").toEpochMilli(),ChannelPolls.day("2026-11-12",false));assertEquals(Instant.parse("2026-11-12T15:00:00Z").toEpochMilli(),ChannelPolls.day("2026-11-12",true));assertNull(ChannelPolls.day("",false));
        for(String invalid:List.of("2026-02-30","2026-13-01","2026-1-01","2026-11-12T00:00:00Z"))assertEquals("INVALID_POLL_FILTER",assertThrows(ProductProblem.class,()->ChannelPolls.day(invalid,false)).code);
    }
    @Test void optionAndPollIdsUseCanonicalUuidShape(){
        assertThrows(ProductProblem.class,()->ChannelPolls.id("1-1-1-1-1"));assertThrows(ProductProblem.class,()->ChannelPolls.id("../poll"));assertEquals("ffffffff-0000-0000-0000-000000000001",ChannelPolls.id("FFFFFFFF-0000-0000-0000-000000000001").toString());
    }
}
