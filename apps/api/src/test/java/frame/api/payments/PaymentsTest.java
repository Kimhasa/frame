package frame.api.payments;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpServer;
import frame.api.FrameProperties;
import frame.api.TestProps;
import frame.api.broadcast.PublisherTokens;
import frame.api.web.ClientAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class PaymentsTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String OWNER = "a".repeat(64), OTHER = "b".repeat(64);
    private static final String SECRET = "test_sk_unit_test_secret", CLIENT = "test_ck_unit_test_client";
    @TempDir Path dir;
    HttpServer server;
    TossProperties props;
    PaymentOrders orders;
    TossClient client;
    AtomicInteger calls = new AtomicInteger();
    AtomicReference<String> mode = new AtomicReference<>("done");
    AtomicReference<String> auth = new AtomicReference<>(), idempotency = new AtomicReference<>();
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);

    @BeforeEach void setup() throws Exception {
        props = new TossProperties(true, CLIENT, SECRET, "unused-security-key", dir.toString());
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/payments/confirm", exchange -> {
            calls.incrementAndGet(); auth.set(exchange.getRequestHeaders().getFirst("Authorization")); idempotency.set(exchange.getRequestHeaders().getFirst("Idempotency-Key"));
            JsonNode body = JSON.readTree(exchange.getRequestBody().readAllBytes());
            if (mode.get().equals("blocked")) { entered.countDown(); try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException failure) { Thread.currentThread().interrupt(); } }
            int status = mode.get().equals("failure") ? 500 : mode.get().equals("redirect") ? 307 : 200;
            if (mode.get().equals("slowbody")) {
                exchange.sendResponseHeaders(200, 2);
                try { Thread.sleep(1500); exchange.getResponseBody().write("{}".getBytes(StandardCharsets.UTF_8)); } catch (InterruptedException failure) { Thread.currentThread().interrupt(); } catch (java.io.IOException ignored) {}
                exchange.close(); return;
            }
            if (status == 307) exchange.getResponseHeaders().add("Location", "https://unrelated.example/steal");
            Map<String, Object> response = status != 200 ? Map.of("message", SECRET, "code", "PRIVATE_ERROR") : Map.of(
                    "orderId", mode.get().equals("order") ? "wrong" : body.path("orderId").asString(),
                    "paymentKey", mode.get().equals("key") ? "wrong" : body.path("paymentKey").asString(),
                    "totalAmount", mode.get().equals("huge") ? new java.math.BigInteger("18446744073709556616") : mode.get().equals("amount") ? 1 : body.path("amount").longValue(),
                    "currency", mode.get().equals("currency") ? "USD" : "KRW", "status", mode.get().equals("pending") ? "WAITING_FOR_DEPOSIT" : "DONE",
                    "approvedAt", "2026-11-11T17:00:00+09:00", "method", "카드", "receipt", Map.of("url", "https://dashboard.tosspayments.com/receipt/test"));
            byte[] bytes = JSON.writeValueAsBytes(response); exchange.sendResponseHeaders(status, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start(); client = new TossClient(props, JSON, URI.create("http://127.0.0.1:" + server.getAddress().getPort()));
        orders = new PaymentOrders(props, client, JSON);
    }
    @AfterEach void close() { release.countDown(); if (server != null) server.stop(0); }
    PaymentOrders.Order create() { return orders.create(OWNER, JSON.valueToTree(Map.of("channel", "spring", "kind", "메시지", "amount", 5000, "message", "응원해요"))); }

    @Test void onlyMatchingTestFamiliesCanBeConfigured() {
        assertTrue(props.configured());
        assertTrue(new TossProperties(true, "test_gck_docs_client_key", "test_gsk_docs_secret_key", "", dir.toString()).configured());
        assertFalse(new TossProperties(true, CLIENT, "live_sk_not_allowed_here", "", dir.toString()).configured());
        assertFalse(new TossProperties(true, "test_gck_docs_client_key", SECRET, "", dir.toString()).configured());
        assertFalse(new TossProperties(true, "", SECRET, "", dir.toString()).configured());
        assertFalse(props.toString().contains(SECRET)); assertFalse(props.toString().contains(CLIENT));
    }
    @Test void serverRejectsAmountAndRecipientManipulationBeforeProviderRequest() {
        for (Object amount : new Object[]{999, 10_000_001, 5000.5, "5000"}) assertThrows(PaymentOrders.Refusal.class,
                () -> orders.create(OWNER, JSON.valueToTree(Map.of("channel", "spring", "kind", "메시지", "amount", amount))));
        assertThrows(PaymentOrders.Refusal.class, () -> orders.create(OWNER, JSON.valueToTree(Map.of("channel", "unknown", "kind", "메시지", "amount", 5000))));
        var order = create();
        assertEquals("AMOUNT_MISMATCH", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-test", 1000)).code);
        assertEquals("ORDER_NOT_FOUND", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OTHER, order.orderId(), "pay-test", 5000)).code);
        assertTrue(orders.list(OTHER).isEmpty()); assertEquals(0, calls.get());
    }
    @Test void confirmationValidatesProviderAndOmitsPrivateFields() {
        var order = create(); var paid = orders.confirm(OWNER, order.orderId(), "pay-success", 5000);
        assertEquals("DONE", paid.status()); assertEquals(1, calls.get());
        assertEquals("Basic " + Base64.getEncoder().encodeToString((SECRET + ":").getBytes(StandardCharsets.UTF_8)), auth.get());
        assertEquals(order.idempotencyKey(), idempotency.get());
        var publicView = orders.publicView(paid);
        assertFalse(publicView.containsKey("owner")); assertFalse(publicView.containsKey("paymentKey")); assertFalse(publicView.containsKey("idempotencyKey"));
        assertFalse(publicView.toString().contains(SECRET)); assertNotNull(publicView.get("receiptUrl"));
    }
    @Test void duplicateAndDifferentKeyDoNotCreateASecondPayment() {
        var order = create(); orders.confirm(OWNER, order.orderId(), "pay-once", 5000);
        assertEquals("DONE", orders.confirm(OWNER, order.orderId(), "pay-once", 5000).status());
        assertEquals("PAYMENT_KEY_MISMATCH", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-changed", 5000)).code);
        var other = create();
        assertEquals("PAYMENT_KEY_REUSED", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, other.orderId(), "pay-once", 5000)).code);
        assertEquals(1, calls.get());
    }
    @Test void errorAndRestartRetryKeepDurableTupleAndSameIdempotency() throws Exception {
        var order = create(); mode.set("failure");
        var failure = assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-retry", 5000));
        assertFalse(failure.getMessage().contains(SECRET)); assertEquals("CONFIRMING", orders.get(OWNER, order.orderId()).status());
        String firstIdempotency = idempotency.get(); orders = new PaymentOrders(props, client, JSON); mode.set("done");
        assertEquals("DONE", orders.confirm(OWNER, order.orderId(), "pay-retry", 5000).status());
        assertEquals(firstIdempotency, idempotency.get()); assertEquals(2, calls.get());
    }
    @Test void doneIsNeverInferredFromHttp200Alone() {
        for (String invalid : new String[]{"order", "key", "amount", "huge", "currency", "pending", "redirect"}) {
            mode.set(invalid); var order = create();
            assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-" + invalid, 5000));
            assertNotEquals("DONE", orders.get(OWNER, order.orderId()).status());
        }
        assertEquals(7, calls.get());
    }
    @Test void concurrentConfirmationCannotStartASecondProviderRequest() throws Exception {
        var order = create(); mode.set("blocked");
        CompletableFuture<PaymentOrders.Order> first = CompletableFuture.supplyAsync(() -> orders.confirm(OWNER, order.orderId(), "pay-blocked", 5000));
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertEquals("PAYMENT_PROCESSING", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-blocked", 5000)).code);
        release.countDown(); assertEquals("DONE", first.get(5, TimeUnit.SECONDS).status()); assertEquals(1, calls.get());
    }
    @Test void ledgerFailureStopsBeforeProviderAndCorruptionFailsClosed() throws Exception {
        var order = create(); Path ledger = dir.resolve("orders.json"); Files.delete(ledger); Files.createDirectory(ledger); Files.writeString(ledger.resolve("guard"), "guard");
        assertEquals("PAYMENT_STORAGE_UNAVAILABLE", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-storage", 5000)).code);
        assertEquals(0, calls.get());
        assertThrows(java.io.IOException.class, () -> new PaymentOrders(props, client, JSON));
    }
    @Test void controllerRequiresPublisherAndNeverExposesSecretsInConfig() throws Exception {
        FrameProperties frame = TestProps.props();
        var controller = new PaymentsController(props, orders, new PublisherTokens(frame), new ClientAddress(frame), JSON, frame);
        assertEquals(401, controller.configuration(request(null)).getStatusCode().value());
        var response = controller.configuration(request(TestProps.TOKEN_A)); assertEquals(200, response.getStatusCode().value());
        assertEquals("no-store", response.getHeaders().getFirst("Cache-Control"));
        assertFalse(response.getBody().toString().contains(SECRET)); assertFalse(response.getBody().toString().contains("unused-security-key"));
        var bad = request(TestProps.TOKEN_A); bad.setContent("{bad".getBytes(StandardCharsets.UTF_8));
        assertEquals(400, controller.create(bad).getStatusCode().value());
        var huge = request(TestProps.TOKEN_A); huge.setContent("{\"channel\":\"spring\",\"kind\":\"메시지\",\"amount\":18446744073709556616}".getBytes(StandardCharsets.UTF_8));
        assertEquals(400, controller.create(huge).getStatusCode().value());
    }
    @Test void stalledResponseBodyHasABoundedDeadlineWithoutFakePaidState() throws Exception {
        var shortClient = new TossClient(props, JSON, URI.create("http://127.0.0.1:" + server.getAddress().getPort()), java.time.Duration.ofMillis(250));
        orders = new PaymentOrders(props, shortClient, JSON); var order = create(); mode.set("slowbody");
        long started = System.nanoTime();
        assertEquals("PAYMENT_CONFIRM_UNCERTAIN", assertThrows(PaymentOrders.Refusal.class, () -> orders.confirm(OWNER, order.orderId(), "pay-slow", 5000)).code);
        assertTrue(java.time.Duration.ofNanos(System.nanoTime() - started).toMillis() < 1200);
        assertNotEquals("DONE", orders.get(OWNER, order.orderId()).status());
    }
    static MockHttpServletRequest request(String token) { var req = new MockHttpServletRequest(); req.setRemoteAddr("127.0.0.1"); if (token != null) req.addHeader("Authorization", "Bearer " + token); return req; }
}
