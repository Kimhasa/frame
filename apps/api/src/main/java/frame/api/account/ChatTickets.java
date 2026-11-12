package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.web.RateLimit;
import jakarta.servlet.http.HttpServletRequest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChatTickets {
    public record Identity(UUID userId, UUID channelId, String displayName, String sessionId, String path, String broadcastId, UUID instance) {
        @Override public String toString(){return "ChatIdentity[userId="+userId+"]";}
    }
    public record Issued(String ticket, long expiresAtMs, UUID userId, String displayName) {}
    private record Ticket(Identity identity,long expires) {}
    public record Access(Identity identity, ChatModeration.Decision decision, String code, String error) {
        public String refusal(){return code!=null?code:decision==null?null:decision.code();}
        public String message(){return error!=null?error:decision==null?null:decision.error();}
        public boolean authenticated(){return identity!=null&&!"CHAT_SESSION_EXPIRED".equals(refusal())&&!"CHAT_AUTH_INVALID".equals(refusal());}
    }
    private final ConcurrentHashMap<String,Ticket> tickets=new ConcurrentHashMap<>();
    private final SecureRandom random=new SecureRandom();
    private final RateLimit rate=new RateLimit(10,0.5);
    private final SessionRepository<? extends Session> sessions;
    private final JdbcClient sql;
    private final ChatModeration moderation;
    private final BroadcastRegistry broadcasts;
    private final ProductProperties properties;
    public ChatTickets(SessionRepository<? extends Session> sessions,JdbcClient sql,ChatModeration moderation,BroadcastRegistry broadcasts,ProductProperties properties){this.sessions=sessions;this.sql=sql;this.moderation=moderation;this.broadcasts=broadcasts;this.properties=properties;}
    public String origin(){return properties.publicOrigin();}
    public Issued issue(UUID user,HttpServletRequest request,JsonNode input){
        if(input.size()!=2||!input.path("path").isString()||!input.path("broadcastId").isString())throw ChatModeration.invalid();
        String path=input.path("path").asString(),id=input.path("broadcastId").asString();
        if(!path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")||!id.matches("[0-9a-f]{32}"))throw ChatModeration.invalid();
        Broadcast current=broadcasts.get(id);if(current==null||!current.path.equals(path))throw new ProductProblem(404,"CHAT_BROADCAST_NOT_FOUND","방송이 종료되었거나 다른 방송으로 바뀌었어요.");
        int wait=rate.take(user.toString());if(wait>0)throw new ProductProblem(429,"CHAT_TICKET_RATE_LIMITED","잠시 후 채팅에 다시 연결해 주세요.",wait);
        var own=sql.sql("SELECT c.id,a.display_name FROM product_accounts a JOIN product_channels c ON c.owner_id=a.id WHERE a.id=:user").param("user",user).query((r,i)->Map.entry(r.getObject("id",UUID.class),r.getString("display_name"))).optional().orElseThrow(()->new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요."));
        long now=System.currentTimeMillis();tickets.entrySet().removeIf(entry->entry.getValue().expires()<now);
        if(tickets.size()>=10000)throw new ProductProblem(503,"CHAT_UNAVAILABLE","채팅 연결이 잠시 지연되고 있어요.");
        byte[] bytes=new byte[32];random.nextBytes(bytes);String value=Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        Identity identity=new Identity(user,own.getKey(),own.getValue(),request.getSession().getId(),path,id,current.instanceId);
        tickets.put(value,new Ticket(identity,now+30000));return new Issued(value,now+30000,user,own.getValue());
    }
    public Access join(Identity previous,String path,String id,String ticket){
        Identity identity=previous;
        if(identity==null){
            if(ticket==null||ticket.isEmpty())return new Access(null,null,"CHAT_LOGIN_REQUIRED","로그인한 뒤 채팅에 참여해 주세요.");
            Ticket found=tickets.remove(ticket);
            if(found==null||found.expires()<System.currentTimeMillis())return invalid();
            identity=found.identity();
        }
        if(!identity.path().equals(path)||!identity.broadcastId().equals(id))return invalid();
        return check(identity,null);
    }
    public Access send(Identity identity,String text){
        if(identity==null)return new Access(null,null,"CHAT_LOGIN_REQUIRED","로그인한 뒤 채팅에 참여해 주세요.");
        return check(identity,text);
    }
    private Access check(Identity identity,String text){
        Broadcast current=broadcasts.get(identity.broadcastId());
        if(current==null||!current.path.equals(identity.path())||!current.instanceId.equals(identity.instance()))return invalid();
        try{
            Session session=sessions.findById(identity.sessionId());
            if(session==null)return expired(identity);
            Object saved=session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
            Object login=session.getAttribute(AccountSecurity.LOGIN_AT);
            boolean remember=Boolean.TRUE.equals(session.getAttribute(AccountSecurity.REMEMBER));
            if(!(saved instanceof SecurityContext context)||context.getAuthentication()==null||!context.getAuthentication().isAuthenticated()||!identity.userId().toString().equals(context.getAuthentication().getPrincipal())
                    ||!(login instanceof Number at)||System.currentTimeMillis()-at.longValue()>=(remember?AccountSecurity.LONG_SECONDS:AccountSecurity.SHORT_SECONDS)*1000L)return expired(identity);
            return new Access(identity,moderation.check(identity.userId(),identity.path(),text),null,null);
        }catch(RuntimeException failure){return new Access(identity,null,"CHAT_UNAVAILABLE","채팅을 연결할 수 없어요. 잠시 후 다시 시도해 주세요.");}
    }
    private static Access invalid(){return new Access(null,null,"CHAT_AUTH_INVALID","채팅 연결 인증이 만료됐어요. 다시 연결해 주세요.");}
    private static Access expired(Identity identity){return new Access(identity,null,"CHAT_SESSION_EXPIRED","로그인이 만료됐어요. 다시 로그인해 주세요.");}
}
