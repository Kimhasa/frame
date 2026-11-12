package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChatModerationTest {
    private final JsonMapper json=JsonMapper.builder().build();
    @Test void wordsUseBoundedUnicodeAndStableOrderWithoutEquivalentDuplicates(){
        assertEquals(List.of("ＦＯＯ","한글"),ChatModeration.words(json.valueToTree(List.of(" ＦＯＯ ","foo","한글"))));
        assertEquals(30,ChatModeration.words(json.valueToTree(List.of("🌱".repeat(30)))).getFirst().codePointCount(0,60));
        for(Object invalid:List.of(List.of(" "),List.of("a".repeat(31)),List.of("\u200b"),List.of("zero\0byte"),java.util.Collections.nCopies(101,"word"),List.of(1)))assertThrows(ProductProblem.class,()->ChatModeration.words(json.valueToTree(invalid)));
    }
    @Test void matchingUsesCompatibilityCaseAndInvisibleFormatNormalization(){
        assertEquals("foo",ChatModeration.comparable("f\u200bＯＯ"));assertEquals("가",ChatModeration.comparable("가"));assertEquals("example.com",ChatModeration.comparable("ＥＸＡＭＰＬＥ．ＣＯＭ"));
    }
    @Test void malformedIdsCannotSelectAnotherScope(){
        assertThrows(ProductProblem.class,()->ChatModeration.id("1-1-1-1-1"));assertThrows(ProductProblem.class,()->ChatModeration.id("not-a-uuid"));
        assertEquals("ffffffff-0000-0000-0000-000000000001",ChatModeration.id("FFFFFFFF-0000-0000-0000-000000000001").toString());
    }
}
