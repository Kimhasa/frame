package frame.api.chat;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.stream.Collectors;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The chat handshake as the Node relay negotiates it (server/lib/websocket.mjs): no extension, so Tomcat never agrees to a
 * browser's permessage-deflate (zlib state of some 300 KB per socket, and a deflate per recipient per message, with up to
 * RELAY_MAX_CHAT sockets), and "Connection: UPGRADE" in any case (Spring's own check only knows "Upgrade" and "upgrade").
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ChatHandshakeFilter extends OncePerRequestFilter {
    private static final String EXTENSIONS = "Sec-WebSocket-Extensions", CONNECTION = "Connection";

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        if (req.getHeader("Upgrade") == null || !req.getRequestURI().endsWith("/chat")) {
            chain.doFilter(req, res);
            return;
        }
        chain.doFilter(new HttpServletRequestWrapper(req) {
            @Override
            public String getHeader(String name) {
                if (EXTENSIONS.equalsIgnoreCase(name)) return null;
                String v = super.getHeader(name);
                return v != null && CONNECTION.equalsIgnoreCase(name) ? connection(v) : v;
            }

            @Override
            public Enumeration<String> getHeaders(String name) {
                if (EXTENSIONS.equalsIgnoreCase(name)) return Collections.emptyEnumeration();
                if (!CONNECTION.equalsIgnoreCase(name)) return super.getHeaders(name);
                List<String> values = Collections.list(super.getHeaders(name)).stream().map(ChatHandshakeFilter::connection).toList();
                return Collections.enumeration(values);
            }

            @Override
            public Enumeration<String> getHeaderNames() {
                return Collections.enumeration(Collections.list(super.getHeaderNames()).stream().filter(n -> !EXTENSIONS.equalsIgnoreCase(n)).toList());
            }
        }, res);
    }

    // "keep-alive, UPGRADE" -> "keep-alive, Upgrade"
    static String connection(String value) {
        return Arrays.stream(value.split(",")).map(String::trim).map(t -> t.equalsIgnoreCase("upgrade") ? "Upgrade" : t).collect(Collectors.joining(", "));
    }
}
