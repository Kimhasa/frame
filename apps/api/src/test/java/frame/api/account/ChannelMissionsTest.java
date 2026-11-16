package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChannelMissionsTest {
    private final JsonMapper json=JsonMapper.builder().build();

    @Test void canonicalProposalRejectsPaidAndForgedIdentityFields(){
        UUID request=UUID.randomUUID();var input=new HashMap<String,Object>(Map.of("path","source","broadcastId","a".repeat(32),"title"," 가 미션 ","description"," 첫 줄\r\n다음 줄 ","durationMinutes",15,"clientRequestId",request));
        var draft=ChannelMissions.draft(json.valueToTree(input));assertEquals("가 미션",draft.title());assertEquals("첫 줄\n다음 줄",draft.description());assertEquals(request,draft.request());
        for(String field:java.util.List.of("amount","points","authorId","deadlineAtMs")){var forged=new HashMap<>(input);forged.put(field,100);assertEquals("INVALID_MISSION_INPUT",assertThrows(ProductProblem.class,()->ChannelMissions.draft(json.valueToTree(forged))).code);}
        for(int minutes:new int[]{0,14,16,120}){var invalid=new HashMap<>(input);invalid.put("durationMinutes",minutes);assertThrows(ProductProblem.class,()->ChannelMissions.draft(json.valueToTree(invalid)));}
        assertEquals("🌱".repeat(100),ChannelMissions.text("🌱".repeat(100),100,false,false));
        for(String invalid:java.util.List.of("", " \t ", "\u200b\u200d", "bad\nline", "🌱".repeat(101)))assertThrows(ProductProblem.class,()->ChannelMissions.text(invalid,100,false,false));
        assertEquals("설명\n\t내용",ChannelMissions.text("설명\r\n\t내용",1000,true,true));
    }

    @Test void terminalDecisionsNeedAReasonAndCannotReopenAMission(){
        assertTrue(ChannelMissions.allowed("received","running"));assertTrue(ChannelMissions.allowed("received","rejected"));assertFalse(ChannelMissions.allowed("received","completed"));
        assertTrue(ChannelMissions.allowed("running","completed"));assertTrue(ChannelMissions.allowed("running","failed"));assertFalse(ChannelMissions.allowed("running","rejected"));
        for(String terminal:java.util.List.of("completed","rejected","canceled","expired","failed"))for(String next:java.util.List.of("running","received","completed","canceled","expired"))assertFalse(ChannelMissions.allowed(terminal,next));
        assertEquals("",ChannelMissions.change(json.valueToTree(Map.of("version",0,"status","running","reason",""))).reason());
        for(String terminal:java.util.List.of("completed","rejected","canceled","failed"))assertThrows(ProductProblem.class,()->ChannelMissions.change(json.valueToTree(Map.of("version",0,"status",terminal,"reason"," \u200b "))));
        assertThrows(ProductProblem.class,()->ChannelMissions.change(json.valueToTree(Map.of("version",0,"status","expired","reason","수동 만료는 없음"))));
    }

    @Test void deadlineHasPrecedenceOverAnObservedBroadcastEnd(){
        assertNull(MissionExpiry.reason(1001,true,1000));
        assertEquals("미션 진행 기한이 지났어요.",MissionExpiry.reason(1000,true,1000));
        assertEquals("미션 진행 기한이 지났어요.",MissionExpiry.reason(999,false,1000));
        assertEquals("방송이 종료되어 미션 진행 기한이 끝났어요.",MissionExpiry.reason(1001,false,1000));
    }
}
