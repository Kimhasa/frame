package frame.api.chat;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import frame.api.TestProps;
import frame.api.account.ChatBot;
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

class ChatBotHubTest {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private static final String ID="0123456789abcdef0123456789abcdef",PATH="screen-01";
    private static final class Recorder implements ChatHub.Peer {
        final List<String> sent=new CopyOnWriteArrayList<>();
        public void send(String text){sent.add(text);}
        public void close(int code){}
        List<JsonNode> messages(){return sent.stream().map(JSON::readTree).filter(item->item.path("type").asString().equals("message")).toList();}
        JsonNode last(String type){return sent.stream().map(JSON::readTree).filter(item->item.path("type").asString().equals(type)).reduce((a,b)->b).orElseThrow();}
    }
    private static final class Fixture {
        final ChatTickets authentication=mock(ChatTickets.class);
        final ChatBot bot=mock(ChatBot.class);
        final ChatHub hub;
        final BroadcastRegistry registry;
        final ChatTickets.Identity identity;
        final ChatTickets.Access allowed;
        final UUID rule=UUID.randomUUID(),channel=UUID.randomUUID();
        @SuppressWarnings("unchecked") Fixture()throws Exception{
            ObjectProvider<ChatTickets> tickets=mock(ObjectProvider.class);ObjectProvider<ChatBot> bots=mock(ObjectProvider.class);
            when(tickets.getIfAvailable()).thenReturn(authentication);when(bots.getIfAvailable()).thenReturn(bot);
            hub=new ChatHub(TestProps.props(),JSON,tickets,bots);
            registry=new BroadcastRegistry(TestProps.props(),new PublisherTokens(TestProps.props()),event->{if(event instanceof BroadcastEvents.Started started)hub.started(started);if(event instanceof BroadcastEvents.Ended ended)hub.ended(ended);});
            announce(ID);Broadcast broadcast=registry.get(ID);
            identity=new ChatTickets.Identity(UUID.randomUUID(),UUID.randomUUID(),"사용자","session",PATH,ID,broadcast.instanceId);
            allowed=access(null);
            when(authentication.join(isNull(),eq(PATH),eq(ID),eq("ticket"))).thenReturn(allowed);
            when(authentication.send(eq(identity),anyString())).thenReturn(allowed);
            when(bot.configuration(PATH)).thenReturn(configuration(1,true,List.of(new ChatBot.Command(rule,"!hello","공식 응답",true,15))));
        }
        void announce(String id)throws Exception{registry.announce(JSON.readTree("{\"v\":1,\"type\":\"announce\",\"item\":{\"id\":\""+id+"\",\"title\":\"t\",\"publisher\":\"p\",\"path\":\""+PATH+"\",\"width\":320,\"height\":180,\"fps\":15,\"startedAtMs\":0}}"),0);}
        ChatTickets.Access access(String refusal){return new ChatTickets.Access(identity,new ChatModeration.Decision("사용자",identity.channelId(),"person",false,new ChatModeration.Policy(false,5,false,false),refusal,refusal==null?null:"제한",null,null),null,null);}
        ChatBot.Configuration configuration(int version,boolean enabled,List<ChatBot.Command> commands){return new ChatBot.Configuration(channel,version,enabled,commands);}
        ChatHub.Client join(Recorder peer,String ip){ChatHub.Client client=hub.attach(PATH,ip,peer);hub.handle(client,JSON.writeValueAsString(Map.of("type","join","broadcastId",ID,"ticket","ticket")));assertTrue(peer.last("state").path("canSend").booleanValue());return client;}
        void send(ChatHub.Client client,String id,String text){hub.handle(client,JSON.writeValueAsString(Map.of("type","send","clientId",id,"text",text,"isBot",true,"author","FRAME 봇")));}
    }
    @Test void acceptedHumanCommandUsesSharedSequenceAndHistoryWithoutAccountImpersonationOrLoops()throws Exception{
        Fixture fixture=new Fixture();Recorder peer=new Recorder();ChatHub.Client client=fixture.join(peer,"10.0.0.1");
        fixture.send(client,"one","!HELLO");
        var messages=peer.messages();assertEquals(2,messages.size());assertFalse(messages.getFirst().has("isBot"));
        var bot=messages.getLast();assertTrue(bot.path("isBot").booleanValue());assertEquals("FRAME 봇",bot.path("author").asString());assertEquals("공식 응답",bot.path("text").asString());
        assertEquals("01234567-1",messages.getFirst().path("id").asString());assertEquals("01234567-2",bot.path("id").asString());
        for(String field:List.of("userId","authorChannelId","authorHandle","isOwner"))assertFalse(bot.has(field));
        Recorder late=new Recorder();fixture.join(late,"10.0.0.2");assertEquals(2,late.last("history").path("messages").size());assertTrue(late.last("history").path("messages").get(1).path("isBot").booleanValue());
        verify(fixture.bot,times(1)).configuration(PATH);verify(fixture.authentication,times(1)).send(fixture.identity,"!HELLO");
    }
    @Test void retriesCannotDuplicateBotOrReuseOneIdForDifferentTextAndRejectedHumansNeverTrigger()throws Exception{
        Fixture fixture=new Fixture();Recorder peer=new Recorder();ChatHub.Client client=fixture.join(peer,"10.0.0.1");
        fixture.send(client,"same","!hello");String id=peer.last("ack").path("id").asString();
        fixture.send(client,"same"," !hello ");assertEquals(id,peer.last("ack").path("id").asString());assertEquals(2,peer.messages().size());
        fixture.send(client,"same","different");assertFalse(peer.last("ack").path("ok").booleanValue());assertEquals("CHAT_CLIENT_ID_REUSED",peer.last("ack").path("code").asString());
        when(fixture.authentication.send(fixture.identity,"!other")).thenReturn(fixture.access("CHAT_WORD_BLOCKED"));fixture.send(client,"refused","!other");
        assertFalse(peer.last("ack").path("ok").booleanValue());assertEquals(2,peer.messages().size());verify(fixture.bot,times(1)).configuration(PATH);
        fixture.send(client,"argument","!hello extra");assertTrue(peer.last("ack").path("ok").booleanValue());assertEquals(3,peer.messages().size());verify(fixture.bot,times(1)).configuration(PATH);
    }
    @Test void cooldownIsPerRuleAndPerRoomAndSavedDisableIsFreshlyRead()throws Exception{
        Fixture fixture=new Fixture();Recorder peer=new Recorder();ChatHub.Client client=fixture.join(peer,"10.0.0.1");
        var first=new ChatBot.Command(fixture.rule,"!hello","첫 번째",true,15);
        var second=new ChatBot.Command(UUID.randomUUID(),"!second","두 번째",true,5);
        when(fixture.bot.configuration(PATH)).thenReturn(fixture.configuration(1,true,List.of(first,second)));
        fixture.send(client,"one","!hello");fixture.send(client,"two","!hello");assertEquals(1,peer.messages().stream().filter(item->item.path("isBot").asBoolean()).count());
        fixture.send(client,"three","!second");assertEquals(1,peer.messages().stream().filter(item->item.path("isBot").asBoolean()).count(),"Another rule also obeys the room-wide one second guard");
        Thread.sleep(1050);fixture.send(client,"four","!hello");assertEquals(1,peer.messages().stream().filter(item->item.path("isBot").asBoolean()).count(),"The original rule still has its own longer cooldown");
        fixture.send(client,"five","!second");assertEquals(2,peer.messages().stream().filter(item->item.path("isBot").asBoolean()).count());
        when(fixture.bot.configuration(PATH)).thenReturn(fixture.configuration(3,false,List.of(second)));fixture.send(client,"off","!second");
        assertEquals(2,peer.messages().stream().filter(item->item.path("isBot").asBoolean()).count());verify(fixture.bot,times(6)).configuration(PATH);
    }
    @Test void concurrentRetriesAreRecheckedInsideTheFanoutLock()throws Exception{
        Fixture fixture=new Fixture();Recorder peer=new Recorder();ChatHub.Client client=fixture.join(peer,"10.0.0.1");
        CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);
        when(fixture.authentication.send(fixture.identity,"!hello")).thenAnswer(invocation->{entered.countDown();if(!release.await(5,TimeUnit.SECONDS))throw new IllegalStateException("Held authorization timed out");return fixture.allowed;});
        try(var workers=Executors.newVirtualThreadPerTaskExecutor()){
            var first=workers.submit(()->fixture.send(client,"same","!hello"));var second=workers.submit(()->fixture.send(client,"same","!hello"));
            try{assertTrue(entered.await(2,TimeUnit.SECONDS));}finally{release.countDown();}
            first.get(2,TimeUnit.SECONDS);second.get(2,TimeUnit.SECONDS);
        }
        assertEquals(2,peer.messages().size());verify(fixture.bot,times(1)).configuration(PATH);
        assertEquals(2,peer.sent.stream().map(JSON::readTree).filter(item->item.path("type").asString().equals("ack")&&item.path("ok").asBoolean()).count());
    }
    @Test void botLookupHappensAfterHumanAckOutsideRoomLockAndFailureDoesNotBreakChat()throws Exception{
        Fixture fixture=new Fixture();Recorder peer=new Recorder();ChatHub.Client client=fixture.join(peer,"10.0.0.1");
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        when(fixture.bot.configuration(PATH)).thenAnswer(invocation->{entered.countDown();if(!release.await(5,TimeUnit.SECONDS))throw new IllegalStateException("Held bot lookup timed out");throw new IllegalStateException("database unavailable");});
        try(var workers=Executors.newVirtualThreadPerTaskExecutor()){
            var held=workers.submit(()->fixture.send(client,"held","!hello"));
            try{assertTrue(entered.await(2,TimeUnit.SECONDS));assertTrue(peer.last("ack").path("ok").booleanValue());assertEquals(1,workers.submit(fixture.hub::count).get(1,TimeUnit.SECONDS));Recorder second=new Recorder();workers.submit(()->fixture.join(second,"10.0.0.2")).get(1,TimeUnit.SECONDS);}finally{release.countDown();}
            held.get(2,TimeUnit.SECONDS);assertEquals(1,peer.messages().size());
        }
        fixture.send(client,"still-human","채팅 계속");assertTrue(peer.last("ack").path("ok").booleanValue());assertEquals(2,peer.messages().size());
    }
    @Test void pendingReplyNeverLeaksIntoReplacementRoom()throws Exception{
        Fixture fixture=new Fixture();Recorder peer=new Recorder();ChatHub.Client client=fixture.join(peer,"10.0.0.1");
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        when(fixture.bot.configuration(PATH)).thenAnswer(invocation->{entered.countDown();if(!release.await(5,TimeUnit.SECONDS))throw new IllegalStateException("Held bot lookup timed out");return fixture.configuration(1,true,List.of(new ChatBot.Command(fixture.rule,"!hello","이전 방송",true,5)));});
        try(var workers=Executors.newVirtualThreadPerTaskExecutor()){
            var held=workers.submit(()->fixture.send(client,"held","!hello"));
            try{assertTrue(entered.await(2,TimeUnit.SECONDS));fixture.announce("f".repeat(32));}finally{release.countDown();}
            held.get(2,TimeUnit.SECONDS);assertEquals(1,peer.messages().size());
        }
    }
}
