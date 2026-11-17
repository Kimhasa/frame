package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.json.JsonMapper;

class MembershipGatewayTest {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private static final String CLIENT="test_ck_unit_membership_client", SECRET="test_sk_unit_membership_secret";
    private static final String CUSTOMER="customer_"+"a".repeat(32), ORDER="membership_order_12345678", BILLING="billing_key_123456789";
    private HttpServer server;
    private MembershipGateway gateway;
    private final AtomicInteger calls=new AtomicInteger();
    private final AtomicReference<String> route=new AtomicReference<>(), requestBody=new AtomicReference<>(), authorization=new AtomicReference<>(), idempotency=new AtomicReference<>();
    private final AtomicReference<String> response=new AtomicReference<>("{}");
    private volatile int status=200;
    @BeforeEach void start() throws Exception {
        server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/", exchange -> {
            calls.incrementAndGet(); route.set(exchange.getRequestMethod()+" "+exchange.getRequestURI().getRawPath());
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization")); idempotency.set(exchange.getRequestHeaders().getFirst("Idempotency-Key"));
            exchange.getResponseHeaders().set("Location","/redirect-target"); send(exchange,status,response.get());
        });
        server.start();
        gateway=new MembershipGateway(CLIENT,SECRET,JSON,URI.create("http://127.0.0.1:"+server.getAddress().getPort()),Duration.ofSeconds(2));
    }
    @AfterEach void stop() { server.stop(0); }
    @Test void apiIndividualTestKeysAndExactOwnedTestEndpointOnly() {
        assertTrue(gateway.configured()); assertEquals(CLIENT,gateway.clientKey());
        assertFalse(new MembershipGateway(JSON,new MockEnvironment()).configured());
        var props=new MockEnvironment().withProperty("frame.membership.enabled","true").withProperty("frame.membership.client-key","test_gck_unit_widget_client").withProperty("frame.membership.secret-key","test_gsk_unit_widget_secret");
        assertFalse(new MembershipGateway(JSON,props).configured());
        props.setProperty("frame.membership.client-key","live_ck_not_allowed_123"); props.setProperty("frame.membership.secret-key","live_sk_not_allowed_123");
        assertFalse(new MembershipGateway(JSON,props).configured());
        for (String target:new String[]{"http://localhost:19091","http://127.0.0.1:80","http://127.0.0.1:19091/path","http://127.0.0.1:19091?key=bad","https://other.example","https://api.tosspayments.com.evil.example"}) {
            props.setProperty("frame.membership.test-api-base",target);
            assertThrows(IllegalArgumentException.class,()->new MembershipGateway(JSON,props));
        }
        assertFalse(gateway.toString().contains(SECRET)); assertFalse(gateway.toString().contains(CLIENT));
    }
    @Test void ownedReceiverVerifiesIssueChargeLookupDeleteAndSecretBoundaries() throws Exception {
        String requestId=UUID.randomUUID().toString();
        response.set(JSON.writeValueAsString(Map.of("billingKey",BILLING,"customerKey",CUSTOMER,"method","카드","card",Map.of("number","4330123412345678"))));
        var billing=gateway.issue("auth_key_test_123",CUSTOMER,requestId);
        assertEquals(BILLING,billing.billingKey()); assertEquals("카드 ···· 5678",billing.cardLabel());
        assertFalse(billing.toString().contains(BILLING)); assertFalse(billing.toString().contains(CUSTOMER));
        assertEquals("POST /v1/billing/authorizations/issue",route.get()); assertEquals(requestId,idempotency.get());
        assertEquals("Basic "+Base64.getEncoder().encodeToString((SECRET+":").getBytes(StandardCharsets.UTF_8)),authorization.get());
        assertEquals(CUSTOMER,JSON.readTree(requestBody.get()).path("customerKey").asString());
        response.set(payment("DONE",4900,"KRW",ORDER));
        var paid=gateway.charge(BILLING,CUSTOMER,ORDER,"채널 멤버십",4900,requestId);
        assertEquals(4900,paid.amount()); assertEquals("DONE",paid.status()); assertTrue(paid.approvedAtMs()>0);
        assertEquals("POST /v1/billing/"+BILLING,route.get()); assertEquals(4900,JSON.readTree(requestBody.get()).path("amount").longValue());
        assertFalse(paid.toString().contains(paid.paymentKey())); assertNull(paid.receiptUrl());
        assertEquals(ORDER,gateway.lookup(ORDER).orderId()); assertEquals("GET /v1/payments/orders/"+ORDER,route.get()); assertNull(idempotency.get());
        response.set(""); gateway.delete(BILLING,requestId); assertEquals("DELETE /v1/billing/"+BILLING,route.get()); assertEquals(requestId,idempotency.get());
        status=404; response.set("{\"code\":\"NOT_FOUND_BILLING\"}"); gateway.delete(BILLING,requestId);
        assertEquals(5,calls.get());
    }
    @Test void mismatchedOrUncertainResponsesNeverGrantAndRequestsAreNotAutomaticallyRepeated() throws Exception {
        for (String body:new String[]{payment("DONE",1,"KRW",ORDER),payment("DONE",4900,"USD",ORDER),payment("DONE",4900,"KRW","another_order_12345"),payment("IN_PROGRESS",4900,"KRW",ORDER),payment("DONE",4900,"KRW",ORDER).replace("BILLING","NORMAL")}) {
            response.set(body); var failure=assertThrows(MembershipGateway.Failure.class,()->gateway.charge(BILLING,CUSTOMER,ORDER,"멤버십",4900,UUID.randomUUID().toString()));
            assertFalse(failure.definitive);
        }
        status=302; response.set("{}"); int before=calls.get();
        assertThrows(MembershipGateway.Failure.class,()->gateway.lookup(ORDER)); assertEquals(before+1,calls.get());
        status=404; response.set("{\"code\":\"NOT_FOUND_PAYMENT\"}");
        var missing=assertThrows(MembershipGateway.Failure.class,()->gateway.lookup(ORDER)); assertEquals("MEMBERSHIP_PAYMENT_NOT_FOUND",missing.code);
        status=500; response.set("{\"message\":\"private provider echo\"}");
        var unknown=assertThrows(MembershipGateway.Failure.class,()->gateway.lookup(ORDER)); assertFalse(unknown.definitive); assertFalse(unknown.toString().contains("private provider echo"));
        status=200; response.set(" ".repeat(65_537));
        assertThrows(MembershipGateway.Failure.class,()->gateway.lookup(ORDER));
    }
    @Test void slowBodiesHaveOneTotalDeadline() throws Exception {
        server.removeContext("/");
        server.createContext("/", exchange -> {
            calls.incrementAndGet(); exchange.sendResponseHeaders(200,0);
            try { exchange.getResponseBody().write('{'); exchange.getResponseBody().flush(); Thread.sleep(500); exchange.getResponseBody().write('}'); }
            catch (Exception ignored) { } finally { exchange.close(); }
        });
        gateway=new MembershipGateway(CLIENT,SECRET,JSON,URI.create("http://127.0.0.1:"+server.getAddress().getPort()),Duration.ofMillis(100));
        long start=System.nanoTime();
        var failure=assertThrows(MembershipGateway.Failure.class,()->gateway.lookup(ORDER));
        assertFalse(failure.definitive); assertTrue(Duration.ofNanos(System.nanoTime()-start).toMillis()<1500); assertEquals(1,calls.get());
    }
    @Test void processingDuplicateUnknownAndConfigurationErrorsRemainUncertainWhileExplicitCardDeclinesAreTerminal() {
        status=400;
        for(String code:new String[]{"ALREADY_PROCESSING_REQUEST","DUPLICATED_ORDER_ID","ALREADY_PROCESSED_PAYMENT","PROVIDER_ERROR","NEW_PROVIDER_ERROR"}) {
            response.set("{\"code\":\""+code+"\"}");
            var failure=assertThrows(MembershipGateway.Failure.class,()->gateway.charge(BILLING,CUSTOMER,ORDER,"멤버십",4900,UUID.randomUUID().toString()));
            assertFalse(failure.definitive,code);
        }
        status=401; response.set("{\"code\":\"UNAUTHORIZED_KEY\"}");
        assertFalse(assertThrows(MembershipGateway.Failure.class,()->gateway.charge(BILLING,CUSTOMER,ORDER,"멤버십",4900,UUID.randomUUID().toString())).definitive);
        status=403; response.set("{\"code\":\"REJECT_CARD_COMPANY\"}");
        assertTrue(assertThrows(MembershipGateway.Failure.class,()->gateway.charge(BILLING,CUSTOMER,ORDER,"멤버십",4900,UUID.randomUUID().toString())).definitive);
    }
    private static String payment(String state,long amount,String currency,String order) throws Exception {
        return JSON.writeValueAsString(Map.of("orderId",order,"paymentKey","test_payment_key_123456","totalAmount",amount,"currency",currency,"type","BILLING","status",state,"approvedAt","2026-11-01T12:00:00+09:00","method","카드","card",Map.of(),"receipt",Map.of("url","https://evil.example/private")));
    }
    private static void send(HttpExchange exchange,int status,String body) throws java.io.IOException {
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8); exchange.getResponseHeaders().set("Content-Type","application/json");
        exchange.sendResponseHeaders(status,bytes.length==0?-1:bytes.length);
        if(bytes.length>0)exchange.getResponseBody().write(bytes); exchange.close();
    }
}
