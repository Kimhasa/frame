package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ProductVodsTest {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Test void validatesAndNormalizesUserMetadataWithoutAcceptingUnknownFields(){
        UUID recording=UUID.randomUUID();var draft=ProductVods.draft(JSON.valueToTree(Map.of("recordingId",recording.toString(),"title","  e\u0301 🌱  ","description","  first\r\nsecond\tline  ")));
        assertEquals(recording,draft.recording());assertEquals("é 🌱",draft.title());assertEquals("first\nsecond\tline",draft.description());
        for(String title:new String[]{" ","x".repeat(101),"bad\nline","bad\u0000value","bad\ud800"})
            assertEquals(400,assertThrows(ProductProblem.class,()->ProductVods.draft(JSON.valueToTree(Map.of("recordingId",recording.toString(),"title",title,"description","")))).status);
        assertEquals(400,assertThrows(ProductProblem.class,()->ProductVods.draft(JSON.valueToTree(Map.of("recordingId",recording.toString(),"title","ok","description","x".repeat(2001))))).status);
        assertEquals(400,assertThrows(ProductProblem.class,()->ProductVods.draft(JSON.valueToTree(Map.of("recordingId",recording.toString(),"title","ok","description","","ownerId",UUID.randomUUID())))).status);
    }
    @Test void editAndRetryRequireExactNonnegativeIntegerVersionsAndKnownVisibility(){
        var edit=ProductVods.edit(JSON.valueToTree(Map.of("version",2,"title","Title","description","","visibility","private")));assertEquals(2,edit.version());assertEquals("private",edit.visibility());
        for(Object version:new Object[]{-1,0.5,"0",true})assertEquals(400,assertThrows(ProductProblem.class,()->ProductVods.version(JSON.valueToTree(Map.of("version",version)))).status);
        assertEquals(400,assertThrows(ProductProblem.class,()->ProductVods.edit(JSON.valueToTree(Map.of("version",0,"title","ok","description","","visibility","unlisted")))).status);
        assertEquals(400,assertThrows(ProductProblem.class,()->ProductVods.version(JSON.valueToTree(Map.of("version",0,"visibility","public")))).status);
        assertEquals(404,assertThrows(ProductProblem.class,()->ProductVods.id("../recording")).status);
    }
    @Test void publicMediaTransfersHavePerAddressAndGlobalLimitsAndReleaseSlots(){
        var controller=new VodController(null,null,null,null);for(int i=0;i<4;i++)assertTrue(controller.enter("one"));assertFalse(controller.enter("one"));for(int i=0;i<4;i++)assertTrue(controller.enter("two"));assertFalse(controller.enter("three"));
        controller.leave("one");assertTrue(controller.enter("three"));for(int i=0;i<3;i++)controller.leave("one");for(int i=0;i<4;i++)controller.leave("two");controller.leave("three");assertTrue(controller.enter("one"));
    }
}
