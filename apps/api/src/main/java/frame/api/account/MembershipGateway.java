package frame.api.account;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Test billing only. Provider secrets and response bodies never cross the public API boundary. */
@Component
@ConditionalOnProperty(name="frame.product.enabled", havingValue="true")
public class MembershipGateway {
    public record Billing(String billingKey, String customerKey, String method, String cardLabel) {
        @Override public String toString() { return "Billing[credentials=redacted]"; }
    }
    public record Payment(String orderId, String paymentKey, long amount, String status, long approvedAtMs, String method, String receiptUrl) {
        @Override public String toString() { return "Payment[status=" + status + "]"; }
    }
    public static final class Failure extends RuntimeException {
        public final String code;
        public final boolean definitive;
        public Failure(String code, boolean definitive) {
            super("멤버십 결제 결과를 확인하지 못했어요. 결제 내역에서 다시 확인해 주세요.");
            this.code=code; this.definitive=definitive;
        }
    }
    private static final URI TOSS=URI.create("https://api.tosspayments.com");
    // HTTP 400 also includes already-processing/duplicate and temporary errors. Only known card declines are terminal.
    private static final Set<String> CARD_REJECTED=Set.of("INVALID_STOPPED_CARD","INVALID_REJECT_CARD","INVALID_CARD_EXPIRATION",
            "INVALID_CARD_NUMBER","INVALID_CARD_LOST_OR_STOLEN","REJECT_CARD_PAYMENT","REJECT_CARD_COMPANY","REJECT_ACCOUNT_PAYMENT",
            "NOT_SUPPORTED_CARD_TYPE","NOT_REGISTERED_CARD_COMPANY","EXCEED_MAX_AUTH_COUNT","KYC_BLOCKED");
    private final String clientKey, secretKey;
    private final boolean enabled;
    private final JsonMapper json;
    private final URI base;
    private final Duration deadline;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER).build();

    @Autowired public MembershipGateway(JsonMapper json, Environment env) {
        this(env.getProperty("frame.membership.client-key", ""), env.getProperty("frame.membership.secret-key", ""), json,
                endpoint(env.getProperty("frame.membership.test-api-base", "")), Duration.ofSeconds(65),
                env.getProperty("frame.membership.enabled", Boolean.class, false));
    }
    protected MembershipGateway() { this("", "", JsonMapper.builder().build(), TOSS, Duration.ofSeconds(65), false); }
    MembershipGateway(String clientKey, String secretKey, JsonMapper json, URI base, Duration deadline) {
        this(clientKey,secretKey,json,base,deadline,true);
    }
    private MembershipGateway(String clientKey, String secretKey, JsonMapper json, URI base, Duration deadline, boolean enabled) {
        this.clientKey=clientKey.trim(); this.secretKey=secretKey.trim(); this.json=json; this.base=endpoint(base.toString());
        this.deadline=deadline; this.enabled=enabled;
    }
    public boolean configured() {
        return enabled && clientKey.matches("test_ck_[A-Za-z0-9_-]{8,400}") && secretKey.matches("test_sk_[A-Za-z0-9_-]{8,400}");
    }
    public String clientKey() { return configured() ? clientKey : null; }

    public Billing issue(String authKey, String customerKey, String idempotencyKey) {
        requireOpaque(authKey,300); requireCustomer(customerKey);
        JsonNode value=request("POST","/v1/billing/authorizations/issue",Map.of("authKey",authKey,"customerKey",customerKey),idempotencyKey,false);
        String key=text(value,"billingKey");
        if (!opaque(key,200) || !customerKey.equals(text(value,"customerKey")) || !"카드".equals(text(value,"method"))) throw invalid();
        // Keep only the last four digits; never trust a provider to have masked its card number.
        String digits=text(value.path("card"),"number").replaceAll("[^0-9]", "");
        String last=digits.length()>=4 ? digits.substring(digits.length()-4) : "";
        return new Billing(key,customerKey,"카드",last.isEmpty() ? "카드" : "카드 ···· " + last);
    }
    public Payment charge(String billingKey, String customerKey, String orderId, String orderName, long amount, String idempotencyKey) {
        requireOpaque(billingKey,200); requireCustomer(customerKey); requireOrder(orderId);
        if (amount<1000 || amount>1_000_000 || orderName.isBlank() || orderName.length()>100) throw invalid();
        Payment value=payment(request("POST","/v1/billing/"+segment(billingKey),Map.of("customerKey",customerKey,"orderId",orderId,"orderName",orderName,"amount",amount),idempotencyKey,false));
        if (!orderId.equals(value.orderId()) || value.amount()!=amount || !value.status().equals("DONE")) throw invalid();
        return value;
    }
    public Payment lookup(String orderId) {
        requireOrder(orderId);
        Payment value=payment(request("GET","/v1/payments/orders/"+segment(orderId),null,null,true));
        if (!orderId.equals(value.orderId())) throw invalid();
        return value;
    }
    public void delete(String billingKey, String idempotencyKey) {
        requireOpaque(billingKey,200);
        request("DELETE","/v1/billing/"+segment(billingKey),null,idempotencyKey,false);
    }
    private JsonNode request(String method, String path, Object body, String idempotencyKey, boolean lookup) {
        if (!configured()) throw new Failure("MEMBERSHIP_PAYMENTS_UNAVAILABLE",true);
        if (idempotencyKey!=null && !idempotencyKey.matches("[A-Za-z0-9_=-]{8,300}")) throw invalid();
        HttpRequest.Builder builder=HttpRequest.newBuilder(base.resolve(path)).timeout(deadline)
                .header("Authorization","Basic "+Base64.getEncoder().encodeToString((secretKey+":").getBytes(StandardCharsets.UTF_8)))
                .header("Accept","application/json");
        if (idempotencyKey!=null) builder.header("Idempotency-Key",idempotencyKey);
        if (body!=null) builder.header("Content-Type","application/json");
        builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body)));
        CompletableFuture<HttpResponse<byte[]>> pending=null;
        try {
            pending=http.sendAsync(builder.build(), info -> new LimitedBody());
            HttpResponse<byte[]> response=pending.get(deadline.toMillis(),TimeUnit.MILLISECONDS);
            int status=response.statusCode();
            JsonNode value=response.body().length==0 ? json.createObjectNode() : json.readTree(response.body());
            if (status!=200) {
                String providerCode=text(value,"code");
                if (lookup && status==404 && providerCode.equals("NOT_FOUND_PAYMENT")) throw new Failure("MEMBERSHIP_PAYMENT_NOT_FOUND",true);
                if (method.equals("DELETE") && status==404 && providerCode.equals("NOT_FOUND_BILLING")) return json.createObjectNode();
                boolean definite=status>=400 && status<500 && CARD_REJECTED.contains(providerCode);
                throw new Failure(status==401||status==403 ? "MEMBERSHIP_PROVIDER_AUTH_FAILED" : definite ? "MEMBERSHIP_PAYMENT_REJECTED" : "MEMBERSHIP_PAYMENT_UNCERTAIN",definite);
            }
            if (!value.isObject()) throw invalid();
            return value;
        } catch (Failure failure) { throw failure; }
        catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new Failure("MEMBERSHIP_PAYMENT_UNCERTAIN",false); }
        catch (Exception failure) { throw new Failure("MEMBERSHIP_PAYMENT_UNCERTAIN",false); }
        finally { if (pending!=null && !pending.isDone()) pending.cancel(true); }
    }
    private Payment payment(JsonNode value) {
        String id=text(value,"orderId"), key=text(value,"paymentKey"), status=text(value,"status"), method=text(value,"method");
        if (!id.matches("[A-Za-z0-9_=-]{6,64}") || !opaque(key,200) || !"KRW".equals(text(value,"currency"))
                || !"BILLING".equals(text(value,"type")) || !"카드".equals(method) || !value.path("card").isObject()
                || !Set.of("DONE","CANCELED","PARTIAL_CANCELED","ABORTED","EXPIRED","READY","IN_PROGRESS").contains(status)
                || !value.path("totalAmount").isIntegralNumber() || !value.path("totalAmount").canConvertToLong()) throw invalid();
        long amount=value.path("totalAmount").longValue(), approved=0;
        if (amount<1000 || amount>1_000_000) throw invalid();
        if (Set.of("DONE","CANCELED","PARTIAL_CANCELED").contains(status)) {
            try { approved=OffsetDateTime.parse(text(value,"approvedAt")).toInstant().toEpochMilli(); }
            catch (RuntimeException failure) { throw invalid(); }
            if (approved<=0 || approved>System.currentTimeMillis()+300_000) throw invalid();
        }
        return new Payment(id,key,amount,status,approved,method,receipt(text(value.path("receipt"),"url")));
    }
    private static URI endpoint(String input) {
        if (input.isBlank() || input.equals(TOSS.toString())) return TOSS;
        try {
            URI uri=URI.create(input);
            if ("http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort()>=1024 && uri.getPort()<=65535
                    && uri.getRawUserInfo()==null && uri.getRawQuery()==null && uri.getRawFragment()==null && (uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))) return uri;
        } catch (RuntimeException ignored) { }
        throw new IllegalArgumentException("Only the fixed Toss endpoint or an explicit loopback test receiver is allowed");
    }
    private static String receipt(String input) {
        try { URI uri=URI.create(input); return input.length()<=3000 && "https".equals(uri.getScheme()) && uri.getUserInfo()==null
                && uri.getHost()!=null && (uri.getHost().equals("tosspayments.com") || uri.getHost().endsWith(".tosspayments.com")) ? input : null; }
        catch (RuntimeException failure) { return null; }
    }
    private static String text(JsonNode value,String field) { return value!=null && value.path(field).isString() ? value.path(field).asString() : ""; }
    private static String segment(String value) { return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20"); }
    private static boolean opaque(String value,int max) { return value!=null && !value.isBlank() && value.length()<=max && value.codePoints().noneMatch(c->Character.isISOControl(c)||Character.isWhitespace(c)); }
    private static void requireOpaque(String value,int max) { if (!opaque(value,max)) throw invalid(); }
    private static void requireCustomer(String value) { if (value==null || !value.matches("[A-Za-z0-9_=.@-]{22,50}")) throw invalid(); }
    private static void requireOrder(String value) { if (value==null || !value.matches("[A-Za-z0-9_=-]{6,64}")) throw invalid(); }
    private static Failure invalid() { return new Failure("MEMBERSHIP_PROVIDER_RESPONSE_INVALID",false); }
    @Override public String toString() { return "MembershipGateway[configured="+configured()+", credentials=redacted]"; }

    /** Cancel before allocating beyond the limit, including chunked bodies without Content-Length. */
    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result=new CompletableFuture<>();
        private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        public CompletionStage<byte[]> getBody() { return result; }
        public void onSubscribe(Flow.Subscription value) { subscription=value; result.whenComplete((r,e)->{if(result.isCancelled()) value.cancel();}); value.request(1); }
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer:buffers) {
                if (buffer.remaining()>65_536-bytes.size()) { subscription.cancel(); result.completeExceptionally(invalid()); return; }
                byte[] chunk=new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk);
            }
            subscription.request(1);
        }
        public void onError(Throwable failure) { result.completeExceptionally(failure); }
        public void onComplete() { result.complete(bytes.toByteArray()); }
    }
}
