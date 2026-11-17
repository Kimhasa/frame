package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class DeveloperSettingsTest {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Test void securityScopesRejectUnknownDuplicateAndNonStringValues(){
        Set<String> allowed=Set.of("broadcast:read","analytics:read","chat:manage");
        for(String value:new String[]{"[]","[\"*\"]","[\"broadcast:read\",\"broadcast:read\"]","[\"chat:manage\",null]","[\"analytics:write\"]","[true]"})assertThrows(ProductProblem.class,()->DeveloperSettings.selections(JSON.readTree(value),allowed));
        assertEquals(java.util.List.of("broadcast:read","chat:manage"),DeveloperSettings.selections(JSON.readTree("[\"broadcast:read\",\"chat:manage\"]"),allowed));
    }
    @Test void privateCredentialNamesAreBoundedUnicodeWithoutInvisibleControls(){
        assertEquals("방송 자동화",DeveloperSettings.name(JSON.valueToTree("  방송 자동화  ")));
        assertEquals("가",DeveloperSettings.name(JSON.valueToTree("가")));
        for(String value:new String[]{" ","a".repeat(41),"na\nme","na\u200bme","na\u0000me"}){
            assertThrows(ProductProblem.class,()->DeveloperSettings.name(JSON.valueToTree(value)));
        }
        assertThrows(ProductProblem.class,()->DeveloperSettings.exact(JSON.valueToTree(Map.of("name","name","ownerId","foreign")),"name"));
    }
    @Test void tokenDigestsHaveAnUnambiguousStandardEncoding(){
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",DeveloperSettings.hash("abc"));
        byte[] first=DeveloperSettings.random(),next=DeveloperSettings.random();assertEquals(32,first.length);assertEquals(32,next.length);assertFalse(java.util.Arrays.equals(first,next));
    }
    @Test void registryHandoffDoesNotCallDatabaseOrSender() throws Exception {
        // A listener must remain harmless even while another thread holds registry publishing/fan-out locks.
        var props=frame.api.TestProps.props();var tokens=new frame.api.broadcast.PublisherTokens(props);
        var registry=new frame.api.broadcast.BroadcastRegistry(props,tokens,event->{});
        registry.announce(JSON.valueToTree(Map.of("v",1,"type","announce","item",Map.of("id","a".repeat(32),"path","screen-01","title","방송","publisher","OBS","width",0,"height",0,"fps",0,"startedAtMs",System.currentTimeMillis()))),tokens.indexOf("Bearer "+frame.api.TestProps.TOKEN_A));
        var broadcast=registry.byPath("screen-01");assertNotNull(broadcast);
        var worker=new WebhookWorker(null,null,null,null);
        assertTimeoutPreemptively(java.time.Duration.ofSeconds(1),()->{for(int i=0;i<10000;i++)worker.started(new frame.api.broadcast.BroadcastEvents.Started(broadcast));});
        worker.stop();
    }
}
