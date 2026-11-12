package frame.api.chat;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** "Connection: UPGRADE" is accepted in any case, as the Node relay accepts it. */
class ChatHandshakeFilterTest {
    @Test
    void theUpgradeTokenIsNormalised() {
        assertEquals("Upgrade", ChatHandshakeFilter.connection("UPGRADE"));
        assertEquals("keep-alive, Upgrade", ChatHandshakeFilter.connection("keep-alive,upgrade"));
        assertEquals("keep-alive", ChatHandshakeFilter.connection("keep-alive"));
    }
}
