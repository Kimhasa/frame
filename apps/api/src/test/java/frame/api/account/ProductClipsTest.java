package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ProductClipsTest {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Test void validatesRangesWithoutRoundingOrOverflow(){
        ProductClips.bounds(0,5000,5000);ProductClips.bounds(2000,62000,62000);
        for(long[] value:new long[][]{{-1,5000,10000},{0,4999,10000},{0,60001,70000},{5000,5000,10000},{2000,8000,7999},{Long.MAX_VALUE-1,Long.MAX_VALUE,Long.MAX_VALUE}})
            assertEquals("INVALID_CLIP_RANGE",assertThrows(ProductProblem.class,()->ProductClips.bounds(value[0],value[1],value[2])).code);
    }
    @Test void strictDraftKeepsRequestIdentityAndNormalizesText(){
        UUID source=UUID.randomUUID(),request=UUID.randomUUID();var body=Map.of("sourceVodId",source.toString(),"clientRequestId",request.toString(),"startMs",2000,"endMs",8000,"title","  e\u0301 🌱  ","description"," line one\r\nline two ");
        var draft=ProductClips.draft(JSON.valueToTree(body));assertEquals(source,draft.source());assertEquals(request,draft.request());assertEquals("é 🌱",draft.title());assertEquals("line one\nline two",draft.description());
        var extra=new java.util.HashMap<String,Object>(body);extra.put("ownerId",UUID.randomUUID());assertEquals(400,assertThrows(ProductProblem.class,()->ProductClips.draft(JSON.valueToTree(extra))).status);
        var fractional=new java.util.HashMap<String,Object>(body);fractional.put("startMs",2.5);assertEquals(400,assertThrows(ProductProblem.class,()->ProductClips.draft(JSON.valueToTree(fractional))).status);
        var invalidTitle=new java.util.HashMap<String,Object>(body);invalidTitle.put("title","bad\nline");assertEquals(400,assertThrows(ProductProblem.class,()->ProductClips.draft(JSON.valueToTree(invalidTitle))).status);
    }
    @Test void revisionsAndVisibilityAreExplicit(){
        var edit=ProductClips.edit(JSON.valueToTree(Map.of("version",2,"title","Clip","description","","visibility","private")));assertEquals(2,edit.version());
        for(Object version:new Object[]{-1,0.5,"0",true})assertEquals(400,assertThrows(ProductProblem.class,()->ProductClips.version(JSON.valueToTree(Map.of("version",version)))).status);
        assertEquals(400,assertThrows(ProductProblem.class,()->ProductClips.edit(JSON.valueToTree(Map.of("version",0,"title","Clip","description","","visibility","unlisted")))).status);
        assertEquals(404,assertThrows(ProductProblem.class,()->ProductClips.id("../source")).status);
    }
    @Test void publicMediaSlotsAreBoundedAndReleased(){
        var controller=new ClipController(null,null,null,null);for(int i=0;i<4;i++)assertTrue(controller.enter("one"));assertFalse(controller.enter("one"));for(int i=0;i<4;i++)assertTrue(controller.enter("two"));assertFalse(controller.enter("three"));controller.leave("one");assertTrue(controller.enter("three"));
        for(int i=0;i<3;i++)controller.leave("one");for(int i=0;i<4;i++)controller.leave("two");controller.leave("three");assertTrue(controller.enter("one"));
    }
}
