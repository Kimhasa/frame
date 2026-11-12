package frame.api.payments;

import frame.api.FrameProperties;
import frame.api.broadcast.PublisherTokens;
import frame.api.web.ClientAddress;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Local operator test checkout. Product customer accounts must replace this publisher-token boundary before internet use. */
@RestController
public class PaymentsController {
    private final TossProperties props;
    private final PaymentOrders orders;
    private final PublisherTokens tokens;
    private final ClientAddress client;
    private final JsonMapper json;
    private final RateLimit ipLimit, requests;

    public PaymentsController(TossProperties props, PaymentOrders orders, PublisherTokens tokens, ClientAddress client, JsonMapper json, FrameProperties frame) {
        this.props = props; this.orders = orders; this.tokens = tokens; this.client = client; this.json = json;
        this.ipLimit = RateLimit.parse(frame.rates().publishIp()); this.requests = RateLimit.parse(frame.rates().announce());
    }

    @GetMapping("/api/payments/config")
    public ResponseEntity<Object> configuration(HttpServletRequest req) {
        return authorized(req, () -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("enabled", props.configured()); out.put("environment", "test"); out.put("clientKey", props.configured() ? props.clientKey() : null);
            out.put("currency", "KRW"); out.put("minAmount", 1000); out.put("maxAmount", 10_000_000);
            return Replies.json(200, out);
        });
    }

    @PostMapping("/api/payments/orders")
    public ResponseEntity<Object> create(HttpServletRequest req) {
        return authorized(req, () -> Replies.json(201, orders.publicView(orders.create(owner(req), body(req)))));
    }

    @PostMapping("/api/payments/confirm")
    public ResponseEntity<Object> confirm(HttpServletRequest req) {
        return authorized(req, () -> {
            JsonNode value = body(req);
            String id = TossClient.text(value, "orderId"), key = TossClient.text(value, "paymentKey");
            if (!id.matches("frame_[a-f0-9]{32}") || !value.path("amount").isIntegralNumber() || !value.path("amount").canConvertToLong())
                return error(400, "INVALID_CONFIRMATION", "결제 승인 정보를 확인해 주세요.");
            return Replies.json(200, orders.publicView(orders.confirm(owner(req), id, key, value.path("amount").longValue())));
        });
    }

    @GetMapping("/api/payments/orders/{orderId}")
    public ResponseEntity<Object> order(@PathVariable String orderId, HttpServletRequest req) {
        return authorized(req, () -> Replies.json(200, orders.publicView(orders.get(owner(req), orderId))));
    }

    @GetMapping("/api/payments/orders")
    public ResponseEntity<Object> list(HttpServletRequest req) {
        return authorized(req, () -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("items", orders.list(owner(req)).stream().map(orders::publicView).toList()); out.put("nextCursor", null);
            return Replies.json(200, out);
        });
    }

    private ResponseEntity<Object> authorized(HttpServletRequest req, Supplier<ResponseEntity<Object>> run) {
        if (!props.enabled()) return error(404, "PAYMENTS_DISABLED", "결제 서비스를 연결할 수 없어요.");
        int wait = ipLimit.take(client.ip(req));
        if (wait > 0) return Replies.limited(wait);
        if (tokens.indexOf(req.getHeader(HttpHeaders.AUTHORIZATION)) < 0)
            return ResponseEntity.status(401).contentType(Replies.JSON).header(HttpHeaders.CACHE_CONTROL, "no-store")
                    .header(HttpHeaders.WWW_AUTHENTICATE, "Bearer realm=\"frame-relay\"").body(Map.of("code", "UNAUTHORIZED", "message", "결제 권한을 확인해 주세요."));
        wait = requests.take(owner(req));
        if (wait > 0) return Replies.limited(wait);
        try { return run.get(); }
        catch (PaymentOrders.Refusal failure) { return error(failure.status, failure.code, failure.getMessage()); }
    }

    private JsonNode body(HttpServletRequest req) {
        try {
            if (req.getContentLengthLong() > 4096) throw new PaymentOrders.Refusal(413, "BODY_TOO_LARGE", "요청 내용이 너무 길어요.");
            byte[] bytes = req.getInputStream().readNBytes(4097);
            if (bytes.length > 4096) throw new PaymentOrders.Refusal(413, "BODY_TOO_LARGE", "요청 내용이 너무 길어요.");
            JsonNode value = json.readTree(bytes);
            if (value == null || !value.isObject()) throw new PaymentOrders.Refusal(400, "INVALID_JSON", "요청 내용을 확인해 주세요.");
            return value;
        } catch (PaymentOrders.Refusal failure) { throw failure; }
        catch (IOException | RuntimeException failure) { throw new PaymentOrders.Refusal(400, "INVALID_JSON", "요청 내용을 확인해 주세요."); }
    }
    static String owner(HttpServletRequest req) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(req.getHeader(HttpHeaders.AUTHORIZATION).substring(7).getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException failure) { throw new IllegalStateException("SHA-256 unavailable"); }
    }
    private static ResponseEntity<Object> error(int status, String code, String message) { return Replies.json(status, Map.of("code", code, "message", message)); }
}
