package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import frame.api.TestProps;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.session.MapSession;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;
import tools.jackson.databind.json.JsonMapper;

class ChatTicketsTest {
    @Test void everySendChecksTheCurrentServerSessionAndLogoutCannotKeepAnOldSocketAuthenticated()throws Exception{
        var fixture=new Fixture();
        assertNull(fixture.authentication.send(fixture.identity,"첫 메시지").refusal());
        when(fixture.sessions.findById(fixture.identity.sessionId())).thenReturn(null);
        assertEquals("CHAT_SESSION_EXPIRED",fixture.authentication.send(fixture.identity,"로그아웃 이후").refusal());
        verify(fixture.sessions,times(2)).findById(fixture.identity.sessionId());verify(fixture.moderation,times(1)).check(any(),any(),any());
    }
    @Test void replacingTheAuthenticatedPrincipalCannotReuseTheOldIdentity()throws Exception{
        var fixture=new Fixture();var context=SecurityContextHolder.createEmptyContext();context.setAuthentication(new UsernamePasswordAuthenticationToken(UUID.randomUUID().toString(),null,List.of(new SimpleGrantedAuthority("ROLE_USER"))));
        fixture.session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY,context);
        assertEquals("CHAT_SESSION_EXPIRED",fixture.authentication.send(fixture.identity,"다른 계정").refusal());verifyNoInteractions(fixture.moderation);
    }
    @Test void absoluteSessionExpiryIsNotExtendedByActiveWebSockets()throws Exception{
        var fixture=new Fixture();fixture.session.setAttribute(AccountSecurity.LOGIN_AT,System.currentTimeMillis()-AccountSecurity.SHORT_SECONDS*1000L-1);
        assertEquals("CHAT_SESSION_EXPIRED",fixture.authentication.send(fixture.identity,"계속 연결된 소켓").refusal());verifyNoInteractions(fixture.moderation);
    }
    @Test void unavailableRedisOrPolicyStorageFailsClosedWithoutDisclosingTheException()throws Exception{
        var fixture=new Fixture();when(fixture.sessions.findById(fixture.identity.sessionId())).thenThrow(new RuntimeException("private-password-server-address"));
        var refusal=fixture.authentication.send(fixture.identity,"보내면 안 됨");assertEquals("CHAT_UNAVAILABLE",refusal.refusal());assertFalse(refusal.message().contains("private-password"));verifyNoInteractions(fixture.moderation);
        doReturn(fixture.session).when(fixture.sessions).findById(fixture.identity.sessionId());when(fixture.moderation.check(any(),any(),any())).thenThrow(new RuntimeException("private-query"));
        assertEquals("CHAT_UNAVAILABLE",fixture.authentication.send(fixture.identity,"DB 장애").refusal());
    }
    @Test void anotherPathOrAReusedBroadcastIdCannotReuseTheOldTicketIdentity()throws Exception{
        var fixture=new Fixture();assertEquals("CHAT_AUTH_INVALID",fixture.authentication.join(fixture.identity,"screen-03",fixture.identity.broadcastId(),null).refusal());
        fixture.registry.announce(JsonMapper.builder().build().valueToTree(Map.of("v",1,"type","bye","id",fixture.identity.broadcastId())),0);fixture.announce();
        assertEquals("CHAT_AUTH_INVALID",fixture.authentication.send(fixture.identity,"이전 방송 신원").refusal());verifyNoInteractions(fixture.moderation);
    }
    private static final class Fixture {
        final UUID user=UUID.randomUUID(),channel=UUID.randomUUID();
        final MapSession session=new MapSession();
        @SuppressWarnings("unchecked") final SessionRepository<Session> sessions=mock(SessionRepository.class);
        final ChatModeration moderation=mock(ChatModeration.class);
        final BroadcastRegistry registry;
        final ChatTickets authentication;
        final ChatTickets.Identity identity;
        Fixture()throws Exception{
            var props=TestProps.props();registry=new BroadcastRegistry(props,new PublisherTokens(props),event->{});announce();
            var context=SecurityContextHolder.createEmptyContext();context.setAuthentication(new UsernamePasswordAuthenticationToken(user.toString(),null,List.of(new SimpleGrantedAuthority("ROLE_USER"))));
            session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY,context);session.setAttribute(AccountSecurity.LOGIN_AT,System.currentTimeMillis());session.setAttribute(AccountSecurity.REMEMBER,false);
            when(sessions.findById(session.getId())).thenReturn(session);
            when(moderation.check(any(),any(),any())).thenReturn(new ChatModeration.Decision("검증된 이름",channel,"verified-room",false,new ChatModeration.Policy(false,5,false,false),null,null,null,null));
            authentication=new ChatTickets(sessions,mock(JdbcClient.class),moderation,registry,new ProductProperties(true,"http://127.0.0.1:5360",false));
            identity=new ChatTickets.Identity(user,channel,"검증된 이름",session.getId(),"screen-01","a".repeat(32),registry.get("a".repeat(32)).instanceId);
        }
        void announce(){registry.announce(JsonMapper.builder().build().valueToTree(Map.of("v",1,"type","announce","item",Map.of("id","a".repeat(32),"path","screen-01","title","방송","publisher","PC","startedAtMs",System.currentTimeMillis(),"width",0,"height",0,"fps",0))),0);}
    }
}
