package frame.api.chat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import frame.api.TestProps;
import frame.api.broadcast.BroadcastEvents;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.StringNode;

/** The chat rules of native/src/chat.cpp as server/lib/chat.mjs implements them. */
class ChatRulesTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String ID = "0123456789abcdef0123456789abcdef";

    private static ChatHub.Checked name(String s) { return ChatHub.normaliseName(StringNode.valueOf(s)); }
    private static ChatHub.Checked text(String s) { return ChatHub.normaliseText(StringNode.valueOf(s)); }

    @Test
    void namesAreNormalisedAndChecked() {
        assertEquals("검증 사용자", name("  검증 \t  사용자  ").value());
        assertEquals("가".repeat(20), name("가".repeat(20)).value());
        assertNull(name("가".repeat(21)).value());
        assertNull(name("   ").value());
        assertEquals("사용할 수 없는 이름입니다.", name("Admin").error());
        assertNull(name("a\u0007b").value());
        assertNull(name("a​b").value());
        assertEquals("<b>굵게</b>", name("<b>굵게</b>").value());
    }

    @Test
    void textsAreNormalisedAndChecked() {
        assertEquals("a\nb", text("  a\r\nb \n").value());
        assertEquals("x".repeat(1000), text("x".repeat(1000)).value());
        assertNull(text("x".repeat(1001)).value());
        assertNull(text(" \n ").value());
        assertNull(text("a\u0001b").value());
    }

    /** A peer that records what it would send. */
    private static final class Recorder implements ChatHub.Peer {
        final List<String> sent = new ArrayList<>();
        int closed;
        @Override public void send(String t) { sent.add(t); }
        @Override public void close(int code) { closed = code; }
    }

    @Test
    void aRoomFollowsItsBroadcastAndLimitsSending() throws Exception {
        ChatHub hub = new ChatHub(TestProps.props(), JSON);
        PublisherTokens tokens = new PublisherTokens(TestProps.props());
        BroadcastRegistry registry = new BroadcastRegistry(TestProps.props(), tokens, event -> {
            if (event instanceof BroadcastEvents.Started s) hub.started(s);
            if (event instanceof BroadcastEvents.Ended e) hub.ended(e);
        });
        registry.announce(JSON.readTree("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + ID
                + "\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\"screen-01\",\"width\":1280,\"height\":720,\"fps\":30,\"startedAtMs\":0}}"), 0);
        Recorder stale = new Recorder();
        hub.handle(hub.attach("screen-01", "10.0.0.1", stale), "{\"type\":\"join\",\"broadcastId\":\"" + "0".repeat(32) + "\"}");
        assertTrue(stale.sent.getFirst().contains("\"connected\":false"));
        assertEquals(1000, stale.closed);

        Recorder a = new Recorder(), b = new Recorder();
        ChatHub.Client ca = hub.attach("screen-01", "10.0.0.1", a), cb = hub.attach("screen-01", "10.0.0.2", b);
        hub.handle(ca, "{\"type\":\"join\",\"broadcastId\":\"" + ID + "\",\"name\":\"검증\"}");
        hub.handle(cb, "{\"type\":\"join\",\"broadcastId\":\"" + ID + "\",\"name\":\"검증\"}");
        assertTrue(b.sent.getFirst().contains(ChatHub.NAME_TAKEN), b.sent.getFirst());  // another address holds the name
        int accepted = 0;
        for (int i = 0; i < 12; i++) {
            hub.handle(ca, "{\"type\":\"send\",\"clientId\":\"c" + i + "\",\"text\":\"m" + i + "\"}");
            if (a.sent.getLast().contains("\"ok\":true")) accepted++;
        }
        assertEquals(8, accepted);
        // A lone surrogate (JSON "\ud800") leaves as U+FFFD: Tomcat's UTF-8 encoder would otherwise drop every member.
        Recorder c = new Recorder();
        ChatHub.Client cc = hub.attach("screen-01", "10.0.0.3", c);
        hub.handle(cc, "{\"type\":\"join\",\"broadcastId\":\"" + ID + "\",\"name\":\"셋째\"}");
        hub.handle(cc, "{\"type\":\"send\",\"clientId\":\"s\",\"text\":\"x\\ud800y\"}");
        assertTrue(b.sent.getLast().contains("\"text\":\"x�y\""), b.sent.getLast());
        assertEquals(9, b.sent.stream().filter(m -> m.startsWith("{\"type\":\"message\"")).count());  // A's 8, then the third client's
        // The broadcast ends: everybody on the path is told and closed.
        registry.announce(JSON.readTree("{\"v\":1,\"type\":\"bye\",\"id\":\"" + ID + "\"}"), 0);
        assertTrue(b.sent.getLast().contains("\"type\":\"closed\""));
        assertEquals(1000, b.closed);
    }
}
