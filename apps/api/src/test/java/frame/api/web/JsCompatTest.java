package frame.api.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Text and numbers leave this service as the Node relay writes them. */
class JsCompatTest {
    @Test
    void loneSurrogatesBecomeReplacementCharacters() {
        String ok = "검증 😀 text";
        assertSame(ok, Unicode.wellFormed(ok));
        assertEquals("a�b", Unicode.wellFormed("a\ud800b"));
        assertEquals("�😀�", Unicode.wellFormed("\udc00😀\ud83d"));
    }

    @Test
    void toFixedRoundsTheExactBinaryValue() {
        assertEquals("1.000", JsNumbers.toFixed(1.0005, 3));   // 1.000499999... in binary; %.3f gives 1.001
        assertEquals("0.13", JsNumbers.toFixed(0.125, 2));     // an exact tie rounds up, as toFixed
        assertEquals("29.970", JsNumbers.toFixed(29.97, 3));
        assertEquals("4.00000", JsNumbers.toFixed(4, 5));
    }

    @Test
    void jsonNumbersArePlainDigits() {
        JsonMapper json = JsonMapper.builder().build();
        assertEquals("[1761618455354,1761618455354.294]", json.writeValueAsString(new Object[] {JsNumbers.json(1761618455354.0), JsNumbers.json(1761618455354.294)}));
        assertEquals(BigDecimal.valueOf(2.5), JsNumbers.json(2.5));
    }
}
