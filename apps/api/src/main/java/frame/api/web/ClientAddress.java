package frame.api.web;

import frame.api.FrameProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.util.Locale;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Who is asking and which origin they use. X-Forwarded-For/-Proto/-Host are believed only from a configured front proxy
 * (Caddy on loopback); then the right-most address that is not itself a trusted proxy is the client (as the Node relay).
 */
@Component
public class ClientAddress {
    private static final Pattern HOST = Pattern.compile("^([A-Za-z0-9.-]{1,253}|\\[[0-9A-Fa-f:.]{2,45}\\])(:\\d{1,5})?$");
    private final Set<String> trusted = new HashSet<>();
    private final String publicBase;

    public ClientAddress(FrameProperties props) {
        for (String p : props.trustedProxyList()) trusted.add(normal(p));
        this.publicBase = props.publicBaseUrl();
    }

    /** The browser's (or sender's) address. */
    public String ip(HttpServletRequest req) {
        String peer = normal(req.getRemoteAddr());
        if (!trusted.contains(peer)) return peer;
        String header = req.getHeader("X-Forwarded-For");
        if (header == null) return peer;
        String[] chain = header.split(",");
        for (int i = chain.length - 1; i >= 0; i--) {
            String a = normal(chain[i].trim());
            if (!a.isEmpty() && !trusted.contains(a)) return a;
        }
        return peer;
    }

    /** The public origin viewers use: RELAY_PUBLIC_BASE_URL in production, else what the (trusted) request says. */
    public String publicBase(HttpServletRequest req) {
        if (!publicBase.isEmpty()) return publicBase;
        boolean viaProxy = trusted.contains(normal(req.getRemoteAddr()));
        String host = viaProxy && req.getHeader("X-Forwarded-Host") != null ? req.getHeader("X-Forwarded-Host") : req.getHeader("Host");
        host = host == null ? "" : host.split(",")[0].trim();
        if (!HOST.matcher(host).matches()) host = req.getLocalAddr() + ":" + req.getLocalPort();
        String proto = req.isSecure() ? "https" : "http";
        if (viaProxy && req.getHeader("X-Forwarded-Proto") != null) {
            String p = req.getHeader("X-Forwarded-Proto").split(",")[0].trim().toLowerCase(Locale.ROOT);
            if (p.equals("https") || p.equals("http")) proto = p;
        }
        return proto + "://" + host;
    }

    // One spelling per address: "::ffff:1.2.3.4" -> "1.2.3.4", "0:0:0:0:0:0:0:1" and "::1" -> "::1".
    static String normal(String address) {
        if (address == null) return "";
        String a = address.trim();
        if (a.startsWith("::ffff:")) a = a.substring(7);
        if (a.startsWith("[") && a.endsWith("]")) a = a.substring(1, a.length() - 1);
        if (a.indexOf(':') >= 0 && a.matches("[0-9A-Fa-f:.%a-zA-Z]+")) {
            try {
                String canonical = InetAddress.getByName(a).getHostAddress();
                return canonical.equals("0:0:0:0:0:0:0:1") ? "::1" : canonical;
            } catch (Exception e) {
                return a;
            }
        }
        return a;
    }
}
