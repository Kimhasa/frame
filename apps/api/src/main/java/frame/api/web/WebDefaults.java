package frame.api.web;

import frame.api.FrameProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.apache.catalina.connector.ClientAbortException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * What every answer gets, as from the Node relay: nosniff, no referrer, open CORS (the API carries no cookies; publisher
 * calls use a bearer token) and a 204 for a CORS preflight. Over RELAY_MAX_SOCKETS open connections a request is answered
 * 503 "Server busy" with Retry-After 5 and Connection: close, never left unanswered. An answer marked as cut off
 * (Replies.abort) ends with its connection closed here, after Spring MVC has returned.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class WebDefaults extends OncePerRequestFilter {
    private final int maxSockets;
    private final Connections connections;
    @Value("${frame.product.enabled:false}")
    private boolean productEnabled;

    public WebDefaults(FrameProperties props, Connections connections) {
        this.maxSockets = props.limits().sockets();
        this.connections = connections;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        boolean product = productEnabled && (req.getRequestURI().equals("/api/v1") || req.getRequestURI().startsWith("/api/v1/"));
        if (!product) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-Match, Range");
            res.setHeader("Access-Control-Expose-Headers", "Location, ETag, Link, Accept-Patch, Retry-After, Content-Range, Content-Length, Accept-Ranges");
        }
        // A chat upgrade over the limit is refused by the chat's own check ("Chat is full", Retry-After 10), as the Node relay.
        boolean chatUpgrade = req.getHeader("Upgrade") != null && req.getRequestURI().endsWith("/chat");
        if (!chatUpgrade && connections.open() > maxSockets) {
            byte[] body = "Server busy".getBytes(StandardCharsets.UTF_8);
            res.setStatus(503);
            res.setContentType("text/plain;charset=UTF-8");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Retry-After", "5");
            res.setHeader("Connection", "close");
            res.setContentLength(body.length);
            res.getOutputStream().write(body);
            return;
        }
        if (!product && "OPTIONS".equals(req.getMethod())) {
            res.setStatus(204);
            res.setHeader("Access-Control-Max-Age", "600");
            return;
        }
        chain.doFilter(req, res);
        // A media answer that could not be completed (Replies.abort): Tomcat closes the connection at once on this
        // exception, without the terminating chunk, and logs it only at debug level.
        if (req.getAttribute(Replies.ABORT) != null) throw new ClientAbortException(new IOException("answer cut off: the upstream body broke"));  // (a cause: Tomcat's debug log reads it)
    }
}
