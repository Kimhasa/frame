package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChannelRewardsTest {
    private final JsonMapper json=JsonMapper.builder().build();
    @Test void rewardDraftHasCanonicalNameAndBoundedPriceWithoutAcceptingClientAuthority(){
        var input=new HashMap<String,Object>(Map.of("name","  가 보상  ","points",1,"limit","once_per_broadcast","enabled",true,"clientRequestId",UUID.randomUUID()));
        assertEquals("가 보상",ChannelRewards.draft(json.valueToTree(input),true).name());
        input.put("name","🌱".repeat(40));input.put("points",1000000);assertEquals(1000000,ChannelRewards.draft(json.valueToTree(input),true).points());
        for(Object cost:java.util.List.of(0,1000001,1.5,"10")){input.put("points",cost);assertThrows(ProductProblem.class,()->ChannelRewards.draft(json.valueToTree(input),true));}
        input.put("points",10);input.put("ownerId",UUID.randomUUID());assertThrows(ProductProblem.class,()->ChannelRewards.draft(json.valueToTree(input),true));
        input.remove("ownerId");input.put("name","\u200b");assertThrows(ProductProblem.class,()->ChannelRewards.draft(json.valueToTree(input),true));
    }
    @Test void watchPulseRejectsUnsafeTimeSequenceIdentityAndExtraAuthority(){
        var pulse=new HashMap<String,Object>(Map.of("path","source","broadcastId","a".repeat(32),"viewerSessionId","b".repeat(32),"visitId",UUID.randomUUID(),"sequence",0,"eligibleMs",20000,"watching",true));
        assertEquals(20000,ChannelPoints.pulse(json.valueToTree(pulse)).eligible());
        for(Object time:java.util.List.of(-1,20001,0.1,"10000")){pulse.put("eligibleMs",time);assertThrows(ProductProblem.class,()->ChannelPoints.pulse(json.valueToTree(pulse)));}
        pulse.put("eligibleMs",0);pulse.put("sequence",9007199254740992L);assertThrows(ProductProblem.class,()->ChannelPoints.pulse(json.valueToTree(pulse)));
        pulse.put("sequence",1);pulse.put("balance",1000);assertThrows(ProductProblem.class,()->ChannelPoints.pulse(json.valueToTree(pulse)));
    }
    @Test void notesAndReasonsNormalizeNewlinesWithoutControlInjection(){
        assertEquals("가\n본문\t내용",ChannelRewards.text(" 가\r\n본문\t내용 ",500,true,true));
        assertEquals("",ChannelRewards.text("  ",500,true,true));
        assertThrows(ProductProblem.class,()->ChannelRewards.text("zero\0byte",500,true,true));
        assertThrows(ProductProblem.class,()->ChannelRewards.text("🌱".repeat(501),500,true,true));
        assertThrows(ProductProblem.class,()->ChannelRewards.text("줄\n바꿈",40,false,false));
    }
}
