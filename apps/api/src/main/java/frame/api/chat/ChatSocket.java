package frame.api.chat;

import frame.api.web.LogOnce;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * The chat WebSocket of /{path}/chat (server/lib/websocket.mjs): text messages of at most 16 KB (Tomcat closes a larger one
 * with 1009, an unmasked frame with 1002, invalid UTF-8 with 1007, a binary message is refused with 1003), pings every 25 s,
 * a peer silent for 75 s is dropped. Each client has its own send queue written by its own virtual thread, so one stalled
 * phone never holds the room's fan-out; a client with more than 1 MB queued is dropped instead of buffered without bound.
 * <p>On shutdown (a restart of the service) every member is told the server goes away (1001, as the Node relay) while the
 * web server still runs: this stops in the first lifecycle phase, before Tomcat, which would otherwise just drop the
 * sockets (a client then sees an abnormal 1006).
 */
@Component
public class ChatSocket extends TextWebSocketHandler implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(ChatSocket.class);
    private static final long PING_MS = 25_000, IDLE_MS = 75_000, MAX_QUEUED = 1 << 20, GOODBYE_MS = 1000;

    private final ChatHub hub;
    private final ChatGate gate;
    private final Map<String, Connection> open = new ConcurrentHashMap<>();
    private volatile boolean running, stopping;

    public ChatSocket(ChatHub hub, ChatGate gate) {
        this.hub = hub;
        this.gate = gate;
    }

    @Override
    public void start() { running = true; stopping = false; }

    @Override
    public boolean isRunning() { return running; }

    /** Close frames (1001) to every member, then up to a second for them to leave before the web server stops. */
    @Override
    public void stop() {
        stopping = true;
        running = false;
        hub.closeAll();
        long until = System.currentTimeMillis() + GOODBYE_MS;
        try {
            while (!open.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(20);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** One client's connection: its send queue, writer thread and last sign of life. */
    private static final class Connection implements ChatHub.Peer {
        private static final Object PING = new Object();
        private final WebSocketSession session;
        private final LinkedBlockingQueue<Object> queue = new LinkedBlockingQueue<>();
        private final AtomicLong queued = new AtomicLong();
        private final Thread writer;
        volatile long lastSeen = System.currentTimeMillis();
        volatile boolean closing;
        ChatHub.Client client;

        Connection(WebSocketSession session) {
            this.session = session;
            this.writer = Thread.ofVirtual().name("chat-writer").start(this::write);
        }

        @Override
        public void send(String text) {
            if (closing) return;
            if (queued.addAndGet(text.length()) > MAX_QUEUED) { drop(CloseStatus.SESSION_NOT_RELIABLE); return; }
            queue.add(new TextMessage(text));
        }

        @Override
        public void close(int code) {
            if (closing) return;
            closing = true;
            queue.add(new CloseStatus(code));
        }

        void ping() { if (!closing) queue.add(PING); }

        // A stalled or silent peer: closed without waiting for what is queued (the close itself may block on a full
        // socket, so it runs on its own thread).
        void drop(CloseStatus status) {
            closing = true;
            writer.interrupt();
            Thread.ofVirtual().start(() -> { try { session.close(status); } catch (Exception ignored) { } });
        }

        void stop() {
            closing = true;
            writer.interrupt();
        }

        private void write() {
            try {
                while (true) {
                    Object next = queue.take();
                    if (next instanceof CloseStatus status) { session.close(status); return; }
                    if (next == PING) { session.sendMessage(new PingMessage()); continue; }
                    TextMessage m = (TextMessage) next;
                    queued.addAndGet(-m.getPayload().length());
                    session.sendMessage(m);
                }
            } catch (InterruptedException e) {
                // stopped
            } catch (IOException | RuntimeException e) {
                try { session.close(CloseStatus.SESSION_NOT_RELIABLE); } catch (Exception ignored) { }
            }
        }
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        gate.confirm((ChatGate.Hold) session.getAttributes().get(ChatGate.HOLD));
        String path = (String) session.getAttributes().get(ChatGate.PATH), ip = (String) session.getAttributes().get(ChatGate.IP);
        Connection c = new Connection(session);
        c.client = hub.attach(path, ip, c);
        open.put(session.getId(), c);
        // A handshake that completed while the service was already stopping: told to go away like the others.
        if (stopping) c.close(1001);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        Connection c = open.get(session.getId());
        if (c == null) return;
        c.lastSeen = System.currentTimeMillis();
        try {
            hub.handle(c.client, message.getPayload());
        } catch (RuntimeException e) {
            if (LogOnce.allow("chat-err")) log.warn("chat message failed: {}", e.toString());
        }
    }

    @Override
    protected void handlePongMessage(WebSocketSession session, PongMessage message) {
        Connection c = open.get(session.getId());
        if (c != null) c.lastSeen = System.currentTimeMillis();
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        Connection c = open.get(session.getId());
        if (c != null) c.drop(CloseStatus.SERVER_ERROR);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Connection c = open.remove(session.getId());
        if (c != null) {
            c.stop();
            hub.detach(c.client);
        }
        gate.release((ChatGate.Hold) session.getAttributes().get(ChatGate.HOLD));
    }

    /** Pings keep NAT bindings and proxies alive; a peer silent for 75 s (no pong, no message) is gone. */
    @Scheduled(fixedRate = PING_MS)
    public void pingAll() {
        long now = System.currentTimeMillis();
        for (Connection c : open.values()) {
            if (now - c.lastSeen > IDLE_MS) c.drop(CloseStatus.SESSION_NOT_RELIABLE);
            else c.ping();
        }
    }
}
