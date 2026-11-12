package frame.api.chat;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import frame.api.TestProps;
import frame.api.account.ChatModeration;
import frame.api.account.ChatTickets;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastEvents;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class ManagedChatHubTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String ID = "0123456789abcdef0123456789abcdef", PATH = "screen-01";
    private static final ChatModeration.Policy POLICY = new ChatModeration.Policy(false, 5, false, false);

    private static final class Recorder implements ChatHub.Peer {
        final List<String> sent = new CopyOnWriteArrayList<>();
        @Override public void send(String value) { sent.add(value); }
        @Override public void close(int code) {}
        JsonNode last(String type) {
            return sent.stream().map(JSON::readTree).filter(value -> value.path("type").asString().equals(type)).reduce((first, next) -> next).orElseThrow();
        }
    }

    private static final class Fixture {
        final ChatTickets authentication = mock(ChatTickets.class);
        final ChatHub hub;
        final ChatTickets.Identity identity;
        final ChatTickets.Access allowed;
        @SuppressWarnings("unchecked") Fixture() throws java.io.IOException {
            ObjectProvider<ChatTickets> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(authentication);
            hub = new ChatHub(TestProps.props(), JSON, provider);
            BroadcastRegistry registry = new BroadcastRegistry(TestProps.props(), new PublisherTokens(TestProps.props()), event -> {
                if (event instanceof BroadcastEvents.Started started) hub.started(started);
                if (event instanceof BroadcastEvents.Ended ended) hub.ended(ended);
            });
            registry.announce(JSON.readTree("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\"" + ID
                    + "\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\"" + PATH + "\",\"width\":320,\"height\":180,\"fps\":15,\"startedAtMs\":0}}"), 0);
            Broadcast broadcast = registry.get(ID);
            identity = new ChatTickets.Identity(UUID.randomUUID(), UUID.randomUUID(), "검증 계정", "fixture-session", PATH, ID, broadcast.instanceId);
            allowed = access(null);
            when(authentication.join(isNull(), eq(PATH), eq(ID), eq("ticket"))).thenReturn(allowed);
        }
        ChatTickets.Access access(String refusal) {
            return new ChatTickets.Access(identity, new ChatModeration.Decision("검증 계정", identity.channelId(), "verified", false,
                    POLICY, refusal, refusal == null ? null : "전송 제한", null, null), null, null);
        }
        ChatHub.Client join(Recorder peer, String ip) {
            ChatHub.Client client = hub.attach(PATH, ip, peer);
            hub.handle(client, JSON.writeValueAsString(Map.of("type", "join", "broadcastId", ID, "ticket", "ticket")));
            assertTrue(peer.last("state").path("canSend").booleanValue());
            return client;
        }
        void send(ChatHub.Client client, String text) { hub.handle(client, JSON.writeValueAsString(Map.of("type", "send", "clientId", UUID.randomUUID().toString(), "text", text))); }
    }

    @Test void unblockAndPolicyUpdatesDoNotReviveOldBlockOrTransientRefusals() throws Exception {
        Fixture fixture = new Fixture(); Recorder peer = new Recorder(); ChatHub.Client client = fixture.join(peer, "10.0.0.1");
        when(fixture.authentication.send(fixture.identity, "blocked")).thenReturn(fixture.access("CHAT_BLOCKED"));
        fixture.send(client, "blocked"); assertEquals("CHAT_BLOCKED", peer.last("ack").path("code").asString());
        fixture.hub.blocked(new ChatModeration.BlockChanged(PATH, fixture.identity.userId(), false, null));
        fixture.hub.changed(new ChatModeration.PolicyChanged(PATH, POLICY));
        assertTrue(peer.last("state").path("canSend").booleanValue());
        assertFalse(peer.last("state").has("code"), "Saving settings after an unblock must not restore the earlier block refusal");
        for (String code : List.of("CHAT_WORD_BLOCKED", "CHAT_LINK_BLOCKED", "CHAT_SLOW_MODE")) {
            when(fixture.authentication.send(fixture.identity, code)).thenReturn(fixture.access(code));
            fixture.send(client, code); assertEquals(code, peer.last("ack").path("code").asString());
            fixture.hub.changed(new ChatModeration.PolicyChanged(PATH, POLICY));
            assertTrue(peer.last("state").path("canSend").booleanValue());
            assertFalse(peer.last("state").has("code"), "A changed policy must not repeat an old per-message refusal");
        }
        when(fixture.authentication.send(fixture.identity, "allowed")).thenReturn(fixture.allowed);
        fixture.send(client, "allowed"); assertTrue(peer.last("ack").path("ok").booleanValue());
    }

    @Test void slowSessionOrDatabaseCheckDoesNotHoldTheGlobalRoomLock() throws Exception {
        Fixture fixture = new Fixture(); Recorder first = new Recorder(); ChatHub.Client client = fixture.join(first, "10.0.0.1");
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(fixture.authentication.send(fixture.identity, "held")).thenAnswer(invocation -> {
            entered.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Verification authorization was not released");
            return fixture.allowed;
        });
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            var held = workers.submit(() -> fixture.send(client, "held"));
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                assertEquals(1, workers.submit(fixture.hub::count).get(1, TimeUnit.SECONDS));
                Recorder second = new Recorder();
                workers.submit(() -> fixture.join(second, "10.0.0.2")).get(1, TimeUnit.SECONDS);
                assertTrue(second.last("state").path("connected").booleanValue());
                assertEquals(2, fixture.hub.count());
            } finally { release.countDown(); }
            held.get(2, TimeUnit.SECONDS);
            assertTrue(first.last("ack").path("ok").booleanValue());
        }
    }
}
