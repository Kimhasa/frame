package frame.api.chat;

import frame.api.FrameProperties;
import frame.api.broadcast.BroadcastEvents;
import frame.api.account.ChatTickets;
import frame.api.account.ChatModeration;
import frame.api.web.RateLimit;
import frame.api.web.Unicode;
import java.text.Normalizer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Chat rooms with the protocol of native/src/chat.cpp (server/lib/chat.mjs): join/name/send from the browser,
 * state/history/message/ack/name/closed from the server. One room per stream path, bound to the broadcast id registered
 * for it; a new broadcast or the end of one closes the room for everybody (the UI then reconnects to the new id from /info).
 * Limits: 8 messages per 10 s per connection plus RELAY_RATE_CHAT_SEND per address; names and texts follow the native
 * NormaliseChatName / NormaliseChatText rules.
 */
@Component
public class ChatHub {
    private static final int HISTORY = 200, HISTORY_ON_JOIN = 100;
    private static final Set<String> RESERVED = Set.of("시스템", "관리자", "system", "admin", "administrator");
    static final String NAME_TAKEN = "이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.";

    /** The connection of a client (ChatSocket): sends never block the hub, close sends a close frame after what is queued. */
    interface Peer {
        void send(String text);
        void close(int code);
    }

    /** A connected browser. Guarded by the hub's lock. */
    static final class Client {
        final Peer peer;
        final String path, ip;
        String name = "";
        boolean joined;
        ChatTickets.Identity identity;
        ChatTickets.Access access;
        long lastJoinAt, blockedUntil;
        final ArrayDeque<Long> recent = new ArrayDeque<>();

        Client(Peer peer, String path, String ip) {
            this.peer = peer;
            this.path = path;
            this.ip = ip;
        }
    }

    private static final class Room {
        final String broadcastId;
        final UUID instance;
        ChatModeration.Policy policy;
        final Set<Client> clients = new LinkedHashSet<>();
        final ArrayDeque<Map<String, Object>> history = new ArrayDeque<>();
        long next;
        Room(String broadcastId, UUID instance) { this.broadcastId = broadcastId; this.instance=instance; }
    }

    /** A normalised name or text, or why it was refused. */
    record Checked(String value, String error) {}

    private final Map<String, Room> rooms = new HashMap<>();
    private final Set<Client> clients = new LinkedHashSet<>();
    private final RateLimit sendLimit;
    private final JsonMapper json;
    private final ChatTickets authentication;

    public ChatHub(FrameProperties props, JsonMapper json) {
        this(props,json,(ChatTickets)null);
    }
    @Autowired public ChatHub(FrameProperties props,JsonMapper json,ObjectProvider<ChatTickets> authentication){this(props,json,authentication.getIfAvailable());}
    private ChatHub(FrameProperties props, JsonMapper json,ChatTickets authentication) {
        this.sendLimit = RateLimit.parse(props.rates().chatSend());
        this.json = json;
        this.authentication=authentication;
    }

    public synchronized int count() { return clients.size(); }

    synchronized boolean hasRoom(String path) { return rooms.containsKey(path); }

    // ---- rooms follow the registry --------------------------------------------------------------------------------------

    @EventListener
    public synchronized void started(BroadcastEvents.Started e) {
        String path = e.broadcast().path, id = e.broadcast().id;
        Room r = rooms.get(path);
        if (r != null && r.broadcastId.equals(id) && r.instance.equals(e.broadcast().instanceId)) return;
        if (r != null) close(path, "새 송출이 시작되었습니다.");
        rooms.put(path, new Room(id,e.broadcast().instanceId));
    }

    @EventListener
    public synchronized void ended(BroadcastEvents.Ended e) {
        Room r = rooms.get(e.broadcast().path);
        if (r != null && r.broadcastId.equals(e.broadcast().id)) close(e.broadcast().path, e.reason());
    }

    private void close(String path, String reason) {
        if (rooms.remove(path) == null) return;
        String closed = write(map("type", "closed", "reason", reason));
        for (Client c : new ArrayList<>(clients)) if (c.path.equals(path)) { c.peer.send(closed); c.peer.close(1000); }
    }

    // ---- connections ----------------------------------------------------------------------------------------------------

    synchronized Client attach(String path, String ip, Peer peer) {
        Client c = new Client(peer, path, ip);
        clients.add(c);
        return c;
    }

    synchronized void detach(Client c) {
        clients.remove(c);
        Room r = rooms.get(c.path);
        if (r != null) r.clients.remove(c);
    }

    /** Server shutdown: every client is told the server goes away (1001). */
    public synchronized void closeAll() {
        for (Client c : new ArrayList<>(clients)) c.peer.close(1001);
    }

    // ---- the protocol -------------------------------------------------------------------------------------------------

    void handle(Client client, String text) {
        JsonNode msg;
        try { msg = json.readTree(text); } catch (RuntimeException e) { return; }
        if (msg == null || !msg.isObject() || !msg.path("type").isString()) return;
        String type = msg.path("type").asString();
        ChatTickets.Access access=null;
        if(authentication!=null){
            if(type.equals("join")){
                synchronized(this){long now=System.currentTimeMillis();if(now-client.lastJoinAt<1000)return;client.lastJoinAt=now;}
                access=authentication.join(client.identity,client.path,msg.path("broadcastId").asString(""),msg.path("ticket").isString()?msg.path("ticket").asString():null);
            }else if(type.equals("name")){
                synchronized(this){send(client,map("type","name","ok",false,"displayName",client.name,"code","CHAT_IDENTITY_FIXED","error","계정 이름을 사용해요. 이름은 내 설정에서 변경해 주세요."));}return;
            }else if(type.equals("send")){
                Checked checked=normaliseText(msg.path("text"));String id=msg.path("clientId").asString("");
                synchronized(this){if(!client.joined||!rooms.containsKey(client.path))return;if(checked.value()==null){nack(client,id,checked.error());return;}if(!takeRate(client,id))return;}
                access=authentication.send(client.identity,checked.value());
            }
        }
        // Session/Redis/DB checks above never hold the room's global fan-out lock.
        synchronized(this){handleChecked(client,msg,access);}
    }
    private void handleChecked(Client client,JsonNode msg,ChatTickets.Access access){
        String type=msg.path("type").asString();
        Room room = rooms.get(client.path);
        if(authentication!=null&&access!=null&&access.identity()!=null&&room!=null&&(!room.broadcastId.equals(access.identity().broadcastId())||!room.instance.equals(access.identity().instance())))access=new ChatTickets.Access(null,null,"CHAT_AUTH_INVALID","방송이 종료되었거나 다른 방송으로 바뀌었어요.");
        if (type.equals("join")) {
            String wanted = msg.path("broadcastId").isString() ? msg.path("broadcastId").asString() : "";
            if (room == null || !room.broadcastId.equals(wanted)) {
                send(client, map("type", "state", "connected", false, "canSend", false, "broadcastId", wanted, "error", "방송이 종료되었거나 다른 방송으로 바뀌었습니다."));
                client.peer.close(1000);
                return;
            }
            client.joined = true;
            room.clients.add(client);
            if(authentication!=null){
                apply(client,access,room);
                if("CHAT_AUTH_INVALID".equals(access.refusal())){state(client,room,"CHAT_AUTH_INVALID",access.message(),null,false);client.peer.close(1008);return;}
                state(client,room,access.refusal(),access.message(),access.decision()==null?null:access.decision().retryAfterMs(),true);
                List<Map<String,Object>> history=new ArrayList<>(room.history);send(client,map("type","history","messages",history.subList(Math.max(0,history.size()-HISTORY_ON_JOIN),history.size())));return;
            }
            String nameError = "";
            if (msg.path("name").isString() && !msg.path("name").asString().isEmpty()) {
                Checked n = normaliseName(msg.path("name"));
                if (n.value() == null) nameError = n.error();
                else if (nameTaken(room, n.value(), client)) nameError = NAME_TAKEN;
                else client.name = n.value();
            }
            send(client, map("type", "state", "connected", true, "canSend", true, "broadcastId", room.broadcastId, "displayName", client.name, "error", nameError));
            List<Map<String, Object>> history = new ArrayList<>(room.history);
            send(client, map("type", "history", "messages", history.subList(Math.max(0, history.size() - HISTORY_ON_JOIN), history.size())));
            return;
        }
        if (!client.joined || room == null || !room.clients.contains(client)) return;
        if (type.equals("name")) {
            Checked n = normaliseName(msg.path("name"));
            if (n.value() == null) { send(client, map("type", "name", "ok", false, "displayName", client.name, "error", n.error())); return; }
            if (nameTaken(room, n.value(), client)) { send(client, map("type", "name", "ok", false, "displayName", client.name, "error", NAME_TAKEN)); return; }
            client.name = n.value();
            send(client, map("type", "name", "ok", true, "displayName", client.name));
            return;
        }
        if (type.equals("send")) {
            String clientId = msg.path("clientId").isString() ? msg.path("clientId").asString() : "";
            if (clientId.length() > 64) clientId = clientId.substring(0, 64);
            if(authentication!=null){
                apply(client,access,room);
                if(access.refusal()!=null){
                    Map<String,Object> refused=map("type","ack","clientId",clientId,"ok",false,"code",access.refusal(),"error",access.message());
                    Long retry=access.decision()==null?null:access.decision().retryAfterMs();if(retry!=null)refused.put("retryAfterMs",retry);send(client,refused);
                    if(Set.of("CHAT_BLOCKED","CHAT_LOGIN_REQUIRED","CHAT_SESSION_EXPIRED","CHAT_AUTH_INVALID","CHAT_UNAVAILABLE","CHAT_CHANNEL_UNAVAILABLE").contains(access.refusal()))state(client,room,access.refusal(),access.message(),retry,true);
                    if("CHAT_AUTH_INVALID".equals(access.refusal()))client.peer.close(1008);
                    return;
                }
            }
            if (client.name.isEmpty()) { nack(client, clientId, "이름을 먼저 설정하십시오."); return; }
            Checked t = normaliseText(msg.path("text"));
            if (t.value() == null) { nack(client, clientId, t.error()); return; }
            long now = System.currentTimeMillis();
            if(authentication==null&&!takeRate(client,clientId))return;
            Map<String, Object> m = map("id", room.broadcastId.substring(0, 8) + "-" + ++room.next, "broadcastId", room.broadcastId, "author", client.name, "text", t.value(), "ts", now);
            if(authentication!=null&&access.decision()!=null){m.put("authorChannelId",access.decision().authorChannelId().toString());m.put("authorHandle",access.decision().authorHandle());m.put("isOwner",access.decision().isOwner());}
            room.history.addLast(m);
            if (room.history.size() > HISTORY) room.history.pollFirst();
            // Encoded once, written to every member: fan-out cost stays one JSON per message.
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("type", "message");
            out.putAll(m);
            String shared = write(out);
            for (Client c : room.clients) if (c.joined) c.peer.send(shared);
            send(client, map("type", "ack", "clientId", clientId, "ok", true, "id", m.get("id")));
        }
    }
    private boolean takeRate(Client client,String id){long now=System.currentTimeMillis();while(!client.recent.isEmpty()&&now-client.recent.peekFirst()>10000)client.recent.pollFirst();if(client.recent.size()>=8||sendLimit.take(client.ip)>0){nack(client,id,"메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내십시오.");return false;}client.recent.addLast(now);return true;}
    private void apply(Client client,ChatTickets.Access access,Room room){
        client.access=access;if(access.identity()!=null)client.identity=access.identity();
        if(access.decision()!=null){client.name=access.decision().displayName().isEmpty()&&client.identity!=null?client.identity.displayName():access.decision().displayName();room.policy=access.decision().policy();client.blockedUntil="CHAT_BLOCKED".equals(access.refusal())?access.decision().expiresAtMs()==null?Long.MAX_VALUE:access.decision().expiresAtMs():0;}
        else if(client.identity!=null)client.name=client.identity.displayName();
    }
    private void state(Client client,Room room,String code,String error,Long retry,boolean connected){
        boolean authenticated=client.access!=null&&client.access.authenticated();boolean restricted=code!=null&&Set.of("CHAT_BLOCKED","CHAT_SESSION_EXPIRED","CHAT_AUTH_INVALID","CHAT_UNAVAILABLE","CHAT_CHANNEL_UNAVAILABLE","CHAT_LOGIN_REQUIRED").contains(code);
        Map<String,Object> value=map("type","state","connected",connected,"canSend",authenticated&&!restricted,"broadcastId",room.broadcastId,"displayName",client.name,"authenticated",authenticated,"userId",authenticated?client.identity.userId().toString():null,"authorChannelId",authenticated?client.identity.channelId().toString():null);
        if(room.policy!=null)value.put("policy",room.policy);if(code!=null)value.put("code",code);if(error!=null)value.put("error",error);if(retry!=null)value.put("retryAfterMs",retry);send(client,value);
    }
    @TransactionalEventListener public synchronized void changed(ChatModeration.PolicyChanged event){
        if(event.path()==null)return;Room room=rooms.get(event.path());if(room==null)return;room.policy=event.policy();
        for(Client client:room.clients){String saved=client.access==null?"CHAT_LOGIN_REQUIRED":client.access.refusal();String code=client.blockedUntil>System.currentTimeMillis()?"CHAT_BLOCKED":saved!=null&&Set.of("CHAT_LOGIN_REQUIRED","CHAT_SESSION_EXPIRED","CHAT_AUTH_INVALID","CHAT_UNAVAILABLE","CHAT_CHANNEL_UNAVAILABLE").contains(saved)?saved:null;state(client,room,code,code==null?null:code.equals("CHAT_BLOCKED")?"이 채널에서는 채팅을 보낼 수 없어요.":client.access==null?"로그인한 뒤 채팅에 참여해 주세요.":client.access.message(),client.blockedUntil>System.currentTimeMillis()&&client.blockedUntil!=Long.MAX_VALUE?client.blockedUntil-System.currentTimeMillis():null,true);}
    }
    @TransactionalEventListener public synchronized void blocked(ChatModeration.BlockChanged event){
        if(event.path()==null)return;Room room=rooms.get(event.path());if(room==null)return;
        for(Client client:room.clients)if(client.identity!=null&&client.identity.userId().equals(event.userId())){client.blockedUntil=event.blocked()?event.expiresAtMs()==null?Long.MAX_VALUE:event.expiresAtMs():0;String saved=client.access==null?null:client.access.refusal();String code=event.blocked()?"CHAT_BLOCKED":saved!=null&&!saved.equals("CHAT_BLOCKED")&&Set.of("CHAT_SESSION_EXPIRED","CHAT_AUTH_INVALID","CHAT_UNAVAILABLE","CHAT_CHANNEL_UNAVAILABLE").contains(saved)?saved:null;state(client,room,code,event.blocked()?"이 채널에서는 채팅을 보낼 수 없어요.":code==null?null:client.access.message(),event.expiresAtMs()==null?null:Math.max(1,event.expiresAtMs()-System.currentTimeMillis()),true);}
    }

    private void nack(Client client, String clientId, String error) {
        send(client, map("type", "ack", "clientId", clientId, "ok", false, "error", error));
    }

    // The same address may hold one name in several tabs or across a reconnect (as the native "same PC" rule).
    private static boolean nameTaken(Room room, String name, Client except) {
        String wanted = name.toLowerCase(Locale.ROOT);
        for (Client c : room.clients)
            if (c != except && c.joined && !c.name.isEmpty() && !c.ip.equals(except.ip) && c.name.toLowerCase(Locale.ROOT).equals(wanted)) return true;
        return false;
    }

    private void send(Client client, Map<String, Object> value) { client.peer.send(write(value)); }

    // Lone surrogates (a "\ud800" escape, a clientId cut inside a pair) would make Tomcat's UTF-8 encoder fail the send and
    // drop the socket, for every member of the room: they leave as U+FFFD.
    private String write(Object value) { return Unicode.wellFormed(json.writeValueAsString(value)); }

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    // ---- names and texts ------------------------------------------------------------------------------------------------

    // JavaScript's \s (the Node relay's rule): ASCII whitespace, NBSP, the Unicode space separators, LS/PS and BOM.
    private static boolean space(int u) {
        return u == 9 || u == 10 || u == 11 || u == 12 || u == 13 || u == 32 || u == 0xa0 || u == 0x1680 || (u >= 0x2000 && u <= 0x200a)
                || u == 0x2028 || u == 0x2029 || u == 0x202f || u == 0x205f || u == 0x3000 || u == 0xfeff;
    }

    /**
     * NormaliseChatName: NFC, tabs/newlines become spaces, other controls and zero-width marks are refused, whitespace runs
     * collapse, 1..20 characters, reserved names refused.
     */
    static Checked normaliseName(JsonNode input) {
        if (input == null || !input.isString()) return new Checked(null, "이름을 확인하십시오.");
        String s = Normalizer.normalize(input.asString(), Normalizer.Form.NFC);
        StringBuilder collapsed = new StringBuilder();
        for (int i = 0; i < s.length(); ) {
            int u = s.codePointAt(i);
            i += Character.charCount(u);
            if (u < 0x20 || u == 0x7f || (u >= 0x200b && u <= 0x200f) || u == 0x2028 || u == 0x2029 || u == 0xfeff) {
                if (u == '\t' || u == '\n' || u == '\r') u = ' ';
                else return new Checked(null, "이름에 사용할 수 없는 문자가 있습니다.");
            }
            if (space(u)) { if (!collapsed.isEmpty() && collapsed.charAt(collapsed.length() - 1) != ' ') collapsed.append(' '); }
            else collapsed.appendCodePoint(u);
        }
        String name = collapsed.toString().replaceAll(" +\\z", "");
        int n = name.codePointCount(0, name.length());
        if (n < 1 || n > 20) return new Checked(null, "1~20자의 이름을 입력하십시오.");
        if (RESERVED.contains(name.toLowerCase(Locale.ROOT))) return new Checked(null, "사용할 수 없는 이름입니다.");
        return new Checked(name, null);
    }

    /** NormaliseChatText: NFC, CR dropped, controls other than LF/TAB refused, trimmed, 1..1000 characters. */
    static Checked normaliseText(JsonNode input) {
        if (input == null || !input.isString()) return new Checked(null, "메시지를 확인하십시오.");
        String s = Normalizer.normalize(input.asString(), Normalizer.Form.NFC);
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < s.length(); ) {
            int u = s.codePointAt(i);
            i += Character.charCount(u);
            if (u == '\r') continue;
            if ((u < 0x20 && u != '\n' && u != '\t') || u == 0x7f) return new Checked(null, "보낼 수 없는 문자가 있습니다.");
            clean.appendCodePoint(u);
        }
        // \A and \z: Java's ^/$ would also match next to a final line terminator (U+0085, U+2028), JavaScript's do not.
        String text = clean.toString().replaceAll("\\A[ \\t\\n]+|[ \\t\\n]+\\z", "");
        int n = text.codePointCount(0, text.length());
        if (n < 1) return new Checked(null, "메시지를 입력하십시오.");
        if (n > 1000) return new Checked(null, "메시지는 1000자까지 보낼 수 있습니다.");
        return new Checked(text, null);
    }
}
