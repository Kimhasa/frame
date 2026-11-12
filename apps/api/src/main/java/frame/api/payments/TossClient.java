package frame.api.payments;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The public constructor can only call Toss's HTTPS API. The package constructor is for local mock-server tests. */
@Component
public class TossClient {
    public record Approved(String approvedAt, String method, String receiptUrl) {}
    public static final class Failure extends RuntimeException {
        final String code;
        Failure(String code) { super("토스 결제 승인을 확인하지 못했어요. 다시 시도해 주세요."); this.code = code; }
    }
    private final TossProperties props;
    private final JsonMapper json;
    private final URI base;
    private final Duration deadline;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    @Autowired public TossClient(TossProperties props, JsonMapper json) { this(props, json, URI.create("https://api.tosspayments.com")); }
    TossClient(TossProperties props, JsonMapper json, URI base) { this(props, json, base, Duration.ofSeconds(12)); }
    TossClient(TossProperties props, JsonMapper json, URI base, Duration deadline) {
        this.props = props; this.json = json; this.base = base; this.deadline = deadline;
        if (!base.toString().equals("https://api.tosspayments.com") && !(base.getScheme().equals("http") && base.getHost().equals("127.0.0.1")))
            throw new IllegalArgumentException("Unsupported payment API endpoint");
    }

    public Approved confirm(PaymentOrders.Order order) {
        if (!props.configured()) throw new Failure("PAYMENTS_NOT_CONFIGURED");
        try {
            byte[] body = json.writeValueAsBytes(Map.of("paymentKey", order.paymentKey(), "orderId", order.orderId(), "amount", order.amount()));
            String basic = Base64.getEncoder().encodeToString((props.secretKey() + ":").getBytes(StandardCharsets.UTF_8));
            HttpRequest request = HttpRequest.newBuilder(base.resolve("/v1/payments/confirm"))
                    .timeout(deadline).header("Authorization", "Basic " + basic).header("Content-Type", "application/json")
                    .header("Idempotency-Key", order.idempotencyKey()).POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            var pending = http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
            HttpResponse<byte[]> response;
            try { response = pending.get(deadline.toMillis(), TimeUnit.MILLISECONDS); }
            finally { if (!pending.isDone()) pending.cancel(true); }
            byte[] bytes = response.body();
            if (bytes.length > 65_536) throw new Failure("PAYMENT_RESPONSE_INVALID");
            if (response.statusCode() != 200) {
                // Provider messages can echo request data. Only a small fixed classification crosses the boundary.
                throw new Failure(response.statusCode() == 401 || response.statusCode() == 403 ? "PAYMENT_AUTH_FAILED" : "PAYMENT_CONFIRM_FAILED");
            }
            JsonNode value = json.readTree(bytes);
            if (!text(value, "orderId").equals(order.orderId()) || !text(value, "paymentKey").equals(order.paymentKey())
                    || !text(value, "currency").equals("KRW") || !text(value, "status").equals("DONE")
                    || !value.path("totalAmount").isIntegralNumber() || !value.path("totalAmount").canConvertToLong() || value.path("totalAmount").longValue() != order.amount()
                    || text(value, "approvedAt").isBlank()) throw new Failure("PAYMENT_RESPONSE_INVALID");
            String receipt = text(value.path("receipt"), "url");
            if (!validReceipt(receipt)) receipt = null;
            return new Approved(text(value, "approvedAt"), text(value, "method"), receipt);
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt(); throw new Failure("PAYMENT_CONFIRM_UNCERTAIN");
        } catch (ExecutionException | TimeoutException failure) {
            throw new Failure("PAYMENT_CONFIRM_UNCERTAIN");
        } catch (Failure failure) { throw failure; }
        catch (RuntimeException failure) { throw new Failure("PAYMENT_RESPONSE_INVALID"); }
    }

    static String text(JsonNode node, String field) { return node != null && node.path(field).isString() ? node.path(field).asString() : ""; }
    private static boolean validReceipt(String value) {
        try {
            URI uri = URI.create(value);
            return value.length() <= 3000 && "https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getHost() != null
                    && (uri.getHost().equals("tosspayments.com") || uri.getHost().endsWith(".tosspayments.com"));
        } catch (RuntimeException failure) { return false; }
    }
}
