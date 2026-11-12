package frame.api.web;

import org.apache.catalina.connector.Connector;
import org.apache.coyote.AbstractProtocol;
import org.springframework.boot.tomcat.TomcatConnectorCustomizer;
import org.springframework.stereotype.Component;

/**
 * Open connections of the server (Tomcat's own count: idle keep-alive and chat sockets included), for RELAY_MAX_SOCKETS as
 * the Node relay counts it: over the limit a request is still answered (503 + Retry-After), never silently dropped.
 */
@Component
public class Connections implements TomcatConnectorCustomizer {
    private volatile AbstractProtocol<?> protocol;

    @Override
    public void customize(Connector connector) {
        if (connector.getProtocolHandler() instanceof AbstractProtocol<?> p) protocol = p;
    }

    /** Open connections, or -1 when unknown (not running on Tomcat). */
    public long open() {
        AbstractProtocol<?> p = protocol;
        return p == null ? -1 : p.getConnectionCount();
    }
}
