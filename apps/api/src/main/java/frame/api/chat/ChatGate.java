package frame.api.chat;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.account.ChatTickets;
import frame.api.web.ClientAddress;
import frame.api.web.Connections;
import frame.api.web.Counter;
import frame.api.web.Gate;
import frame.api.web.LogOnce;
import frame.api.web.RateLimit;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

/**
 * Who may open a chat socket on /{path}/chat (relay.mjs upgrade), checked before the handshake with the Node relay's
 * answers: 400 not an upgrade or a bad Sec-WebSocket-Key, 426 another WebSocket version, 503 + Retry-After 10 when the chat
 * (RELAY_MAX_CHAT, or the server's socket limit) or this address (RELAY_MAX_CHAT_PER_IP) is full, 429 + Retry-After for too
 * many attempts, 404 when nothing is broadcast on the path. A slot is held from here until the socket closes; a slot whose
 * socket never opened (the 101 could not be sent, the peer reset) is released by a sweep, so no slot is ever lost.
 */
@Component
public class ChatGate implements HandshakeInterceptor {
    private static final Logger log = LoggerFactory.getLogger(ChatGate.class);
    static final String PATH = "frame.chat.path", IP = "frame.chat.ip", HOLD = "frame.chat.hold";
    private static final long UNCONFIRMED_MS = 30_000;

    /** The chat slot of one connection: released exactly once. */
    static final class Hold {
        final String ip;
        final long at = System.currentTimeMillis();
        volatile boolean confirmed;
        final AtomicBoolean released = new AtomicBoolean();
        Hold(String ip) { this.ip = ip; }
    }
    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9+/]{22}==$");

    private final BroadcastRegistry registry;
    private final ClientAddress client;
    private final Connections connections;
    private final RateLimit connectRate;
    private final Gate slots;
    private final Counter perIp = new Counter();
    /** Slots whose socket has not opened yet. */
    private final Set<Hold> pending = ConcurrentHashMap.newKeySet();
    private final int perIpLimit, maxSockets;
    private final ChatTickets authentication;

    public ChatGate(BroadcastRegistry registry, ClientAddress client, Connections connections, FrameProperties props) {
        this(registry,client,connections,props,(ChatTickets)null);
    }
    @Autowired public ChatGate(BroadcastRegistry registry,ClientAddress client,Connections connections,FrameProperties props,ObjectProvider<ChatTickets> authentication){this(registry,client,connections,props,authentication.getIfAvailable());}
    private ChatGate(BroadcastRegistry registry,ClientAddress client,Connections connections,FrameProperties props,ChatTickets authentication){
        this.registry = registry;
        this.client = client;
        this.connections = connections;
        this.connectRate = RateLimit.parse(props.rates().chatConnect());
        this.slots = new Gate(props.limits().chat());
        this.perIpLimit = props.limits().chatPerIp();
        this.maxSockets = props.limits().sockets();
        this.authentication=authentication;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Map<String, Object> attributes) throws IOException {
        HttpServletRequest req = ((ServletServerHttpRequest) request).getServletRequest();
        HttpServletResponse res = ((ServletServerHttpResponse) response).getServletResponse();
        String uri = req.getRequestURI();
        String path = uri.length() > 6 && uri.endsWith("/chat") ? uri.substring(1, uri.length() - 5) : "";
        String upgrade = header(req, "Upgrade"), connection = header(req, "Connection");
        boolean upgradeRequest = upgrade.equalsIgnoreCase("websocket");
        if (!Announcement.PATH.matcher(path).matches()) return refuse(req, res, 404, "Not found", null, null);
        // A plain request to the chat URL: what the Node relay's request handler answers.
        if (!upgradeRequest && !req.getMethod().equals("GET") && !req.getMethod().equals("HEAD")) return refuse(req, res, 405, "Method not allowed", null, null);
        if (!req.getMethod().equals("GET") || !upgradeRequest
                || Arrays.stream(connection.toLowerCase(Locale.ROOT).split(",")).noneMatch(t -> t.trim().equals("upgrade"))) return refuse(req, res, 400, "WebSocket upgrade required", null, null);
        if (!KEY.matcher(header(req, "Sec-WebSocket-Key")).matches()) return refuse(req, res, 400, "Bad Sec-WebSocket-Key", null, null);
        if (!header(req, "Sec-WebSocket-Version").equals("13")) return refuse(req, res, 426, "Unsupported WebSocket version", "Sec-WebSocket-Version", "13");
        if(authentication!=null&&!authentication.origin().equals(header(req,"Origin")))return refuse(req,res,403,"Origin is not allowed",null,null);
        String ip = client.ip(req);
        if (connections.open() > maxSockets || slots.active() >= slots.max()) return full(req, res);
        if (perIp.get(ip) >= perIpLimit) return refuse(req, res, 503, "Too many chat connections from this address", "Retry-After", "10");
        int wait = connectRate.take(ip);
        if (wait > 0) return refuse(req, res, 429, "Too many requests", "Retry-After", Integer.toString(wait));
        if (registry.byPath(path) == null) return refuse(req, res, 404, "Stream is not running", null, null);
        // Held from here (two handshakes at once cannot both take the last slot) until the socket closes, or the handshake fails.
        if (!slots.enter()) return full(req, res);
        if (perIp.add(ip, 1) > perIpLimit) {
            perIp.add(ip, -1);
            slots.leave();
            return refuse(req, res, 503, "Too many chat connections from this address", "Retry-After", "10");
        }
        Hold hold = new Hold(ip);
        pending.add(hold);
        req.setAttribute(HOLD, hold);
        attributes.put(PATH, path);
        attributes.put(IP, ip);
        attributes.put(HOLD, hold);
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Exception exception) {
        HttpServletRequest req = ((ServletServerHttpRequest) request).getServletRequest();
        HttpServletResponse res = ((ServletServerHttpResponse) response).getServletResponse();
        // No socket came of it (the slot is otherwise released when the socket closes).
        if (req.getAttribute(HOLD) instanceof Hold hold && (exception != null || res.getStatus() != 101)) release(hold);
    }

    /** The socket of this slot opened. */
    void confirm(Hold hold) {
        if (hold == null) return;
        hold.confirmed = true;
        pending.remove(hold);
    }

    /** The socket of this slot closed (or its handshake failed): released once, whatever calls it again. */
    void release(Hold hold) {
        if (hold == null || !hold.released.compareAndSet(false, true)) return;
        pending.remove(hold);
        perIp.add(hold.ip, -1);
        slots.leave();
    }

    /** A 101 that never reached the peer starts no socket and calls no handler: such a slot is released here. */
    @Scheduled(fixedRate = 10_000)
    public void releaseUnconfirmed() {
        long old = System.currentTimeMillis() - UNCONFIRMED_MS;
        for (Hold hold : pending) if (!hold.confirmed && hold.at < old) release(hold);
    }

    private boolean full(HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (LogOnce.allow("chat-cap")) log.warn("chat connection limit reached");
        return refuse(req, res, 503, "Chat is full", "Retry-After", "10");
    }

    private static String header(HttpServletRequest req, String name) {
        String v = req.getHeader(name);
        return v == null ? "" : v.trim();
    }

    private static boolean refuse(HttpServletRequest req, HttpServletResponse res, int status, String message, String header, String value) throws IOException {
        byte[] body = message.getBytes(StandardCharsets.UTF_8);
        res.setStatus(status);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        // A refused upgrade closes the connection (relay.mjs refuseUpgrade); a plain request to the chat URL keeps it.
        if (!header(req, "Upgrade").isEmpty()) res.setHeader("Connection", "close");
        if (header != null) res.setHeader(header, value);
        res.setContentLength(body.length);
        res.getOutputStream().write(body);
        res.flushBuffer();
        return false;
    }
}
