package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ChannelQuestionsTest {
    private final JsonMapper json=JsonMapper.builder().build();

    @Test void retriesHaveOneCanonicalPayloadWithoutTrustingExtraIdentityFields(){
        UUID request=UUID.randomUUID();
        var draft=ChannelQuestions.draft(json.valueToTree(Map.of("path","source","broadcastId","a".repeat(32),"text","  가\r\n질문\t본문  ","clientRequestId",request)));
        assertEquals("가\n질문\t본문",draft.text());assertEquals(request,draft.request());
        assertEquals(draft,ChannelQuestions.draft(json.valueToTree(Map.of("path","source","broadcastId","a".repeat(32),"text","가\n질문\t본문","clientRequestId",request))));
        var forged=json.valueToTree(Map.of("path","source","broadcastId","a".repeat(32),"text","질문","clientRequestId",request,"authorId",UUID.randomUUID()));
        assertEquals("INVALID_QUESTION_INPUT",assertThrows(ProductProblem.class,()->ChannelQuestions.draft(forged)).code);
    }

    @Test void unicodeLengthsAndControlsUseTheSameRulesForQuestionAndAnswer(){
        assertEquals("🌱".repeat(500),ChannelQuestions.content("🌱".repeat(500),500,false));
        assertEquals("가".repeat(1000),ChannelQuestions.content("가".repeat(1000),1000,true));
        for(String invalid:java.util.List.of("", "  \n\t ", "\u200b\u200d", "bad\u0000value", "🌱".repeat(501)))
            assertEquals("INVALID_QUESTION_INPUT",assertThrows(ProductProblem.class,()->ChannelQuestions.content(invalid,500,false)).code);
        for(String invalid:java.util.List.of("", "가".repeat(1001), "bad\u0007value"))
            assertEquals("INVALID_QUESTION_ANSWER",assertThrows(ProductProblem.class,()->ChannelQuestions.content(invalid,1000,true)).code);
    }

    @Test void linkAndWordChecksArePureAndNormalizeFormattingWithoutConsumingChatSlowMode(){
        for(String address:java.util.List.of("https://example.test","http://example.test/a","www.example.com","example.한국","EXAMPLE.COM","ＥＸＡＭＰＬＥ．ＣＯＭ"))assertTrue(ChatModeration.containsLink(address),address);
        assertTrue(ChatModeration.containsWord(java.util.List.of("ＦＯＯ"),"f\u200boＯ 질문"));
        for(String plain:java.util.List.of("평범한 질문이에요","버전 1.23으로 실행했어요","오늘 오후 3시","코드에 점을 추가했어요 ."))assertFalse(ChatModeration.containsLink(plain),plain);
        assertFalse(ChatModeration.containsWord(java.util.List.of("금칙어"),"질문을 보냅니다"));
    }
}
