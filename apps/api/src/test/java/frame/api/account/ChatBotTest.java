package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChatBotTest {
    private final JsonMapper json=JsonMapper.builder().build();
    private static Map<String,Object> rule(UUID id,String command,String response,int cooldown) {
        return Map.of("id",id.toString(),"command",command,"response",response,"enabled",true,"cooldownSeconds",cooldown);
    }
    @Test void commandsHaveStableIdsNormalizedUniqueNamesAndBoundedPlainText() {
        UUID id=UUID.randomUUID();
        var result=ChatBot.commands(json.valueToTree(List.of(rule(id," !HeLLo_1 "," 안녕\n\t세상\u00a0 ",15),rule(UUID.randomUUID(),"!가","🌱".repeat(500),3600))));
        assertEquals(id,result.getFirst().id());assertEquals("!hello_1",result.getFirst().command());assertEquals("안녕 세상",result.getFirst().response());
        assertEquals("!가",result.getLast().command());assertEquals(500,result.getLast().response().codePointCount(0,result.getLast().response().length()));
        assertThrows(ProductProblem.class,()->ChatBot.commands(json.valueToTree(List.of(rule(id,"!a","a",15),rule(UUID.randomUUID(),"!A","b",15)))));
        assertThrows(ProductProblem.class,()->ChatBot.commands(json.valueToTree(List.of(rule(id,"!a","a",15),rule(id,"!b","b",15)))));
        for(String command:List.of("hello","!","!hello world","!é","!"+"a".repeat(21),"!가\u200b"))assertNull(ChatBot.matchingCommand(command));
        assertEquals("!가",ChatBot.matchingCommand("!가"));assertEquals("!hello",ChatBot.matchingCommand("!HELLO"));
    }
    @Test void configurationRejectsMalformedOversizedOrUnsafeRulesIncludingDisabledOnes() {
        for(int cooldown:List.of(0,4,3601))assertThrows(ProductProblem.class,()->ChatBot.commands(json.valueToTree(List.of(rule(UUID.randomUUID(),"!a","a",cooldown)))));
        for(String text:List.of(" ","a".repeat(501),"a\0b","a\u200bb","a\ud800b"))assertThrows(ProductProblem.class,()->ChatBot.response(text));
        List<Map<String,Object>> maximum=new ArrayList<>();for(int i=0;i<20;i++)maximum.add(rule(UUID.randomUUID(),"!a"+i,"응답",5));
        assertEquals(20,ChatBot.commands(json.valueToTree(maximum)).size());maximum.add(rule(UUID.randomUUID(),"!last","응답",5));
        assertThrows(ProductProblem.class,()->ChatBot.commands(json.valueToTree(maximum)));
        assertThrows(ProductProblem.class,()->ChatBot.commands(json.valueToTree(List.of(Map.of("id","not-a-uuid","command","!a","response","ok","enabled",false,"cooldownSeconds",15)))));
        assertThrows(ProductProblem.class,()->ChatBot.commands(json.valueToTree(List.of(rule(UUID.randomUUID(),"!a","a",15),"bad"))));
    }
}
