package frame.api.payments;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Small local-test order ledger. Every irreversible provider request is preceded by an atomic durable tuple write. */
@Component
public class PaymentOrders {
    public record Order(String orderId, String owner, String channel, String kind, long amount, String orderName, String customerKey,
                        String message, String videoUrl, String start, String createdAt, String status,
                        String paymentKey, String idempotencyKey, String approvedAt, String method, String receiptUrl) {}
    public static final class Refusal extends RuntimeException {
        final int status; final String code;
        Refusal(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }
    static final Set<String> CHANNELS = Set.of("spring", "green", "pado", "seojae", "moa");
    static final Set<String> KINDS = Set.of("메시지", "음성", "영상");
    private final JsonMapper json;
    private final TossProperties props;
    private final TossClient client;
    private final Path file;
    private final Map<String, Order> orders = new LinkedHashMap<>();
    private final Set<String> inFlight = new HashSet<>();

    public PaymentOrders(TossProperties props, TossClient client, JsonMapper json) throws IOException {
        this.props = props; this.client = client; this.json = json;
        this.file = props.storeDir().isBlank() ? null : Path.of(props.storeDir()).toAbsolutePath().normalize().resolve("orders.json");
        if (file != null && Files.exists(file)) {
            JsonNode stored;
            try { stored = json.readTree(Files.readAllBytes(file)); } catch (RuntimeException failure) { throw new IOException("Payment ledger could not be read"); }
            if (!stored.isArray()) throw new IOException("Payment ledger is invalid");
            for (JsonNode value : stored) {
                Order order;
                try { order = json.treeToValue(value, Order.class); } catch (RuntimeException failure) { throw new IOException("Payment ledger is invalid"); }
                if (!validStored(order) || orders.putIfAbsent(order.orderId(), order) != null) throw new IOException("Payment ledger is invalid");
            }
            Set<String> boundKeys = new HashSet<>();
            for (Order order : orders.values()) if (order.paymentKey() != null && !boundKeys.add(order.paymentKey())) throw new IOException("Payment ledger is invalid");
        }
    }

    public synchronized Order create(String owner, JsonNode value) {
        requireReady();
        String channel = TossClient.text(value, "channel"), kind = TossClient.text(value, "kind");
        if (!CHANNELS.contains(channel) || !KINDS.contains(kind)) throw reject(400, "INVALID_ORDER", "후원할 채널과 후원 방식을 확인해 주세요.");
        if (!value.path("amount").isIntegralNumber() || !value.path("amount").canConvertToLong()) throw reject(400, "INVALID_AMOUNT", "후원 금액을 확인해 주세요.");
        long amount = value.path("amount").longValue();
        if (amount < 1000 || amount > 10_000_000) throw reject(400, "INVALID_AMOUNT", "금액은 1,000~10,000,000원 사이로 입력해 주세요.");
        String message = TossClient.text(value, "message").trim(), videoUrl = TossClient.text(value, "videoUrl").trim(), start = TossClient.text(value, "start").trim();
        if (message.length() > 300 || (kind.equals("음성") && message.isBlank()) || videoUrl.length() > 500 || start.length() > 8)
            throw reject(400, "INVALID_ORDER", "후원 내용을 확인해 주세요.");
        if (kind.equals("영상") && (!validVideo(videoUrl) || !start.matches("\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?")))
            throw reject(400, "INVALID_ORDER", "영상 주소와 재생 시작 시간을 확인해 주세요.");
        if (orders.size() >= 10_000) throw reject(503, "ORDER_CAPACITY", "지금은 새 결제를 준비할 수 없어요.");
        Order order = new Order("frame_" + UUID.randomUUID().toString().replace("-", ""), owner, channel, kind, amount,
                channel + " 채널 " + kind + " 후원", "frame_test_" + owner.substring(0, 24), message, videoUrl, start,
                Instant.now().toString(), "READY", null, UUID.randomUUID().toString(), null, null, null);
        saveWith(order);
        return order;
    }

    public synchronized Order get(String owner, String id) {
        Order order = orders.get(id);
        if (order == null || !order.owner().equals(owner)) throw reject(404, "ORDER_NOT_FOUND", "결제 내역을 찾을 수 없어요.");
        return order;
    }

    public synchronized List<Order> list(String owner) {
        return orders.values().stream().filter(order -> order.owner().equals(owner)).sorted(Comparator.comparing(Order::createdAt).reversed()).limit(200).toList();
    }

    public Order confirm(String owner, String id, String key, long amount) {
        Order order;
        synchronized (this) {
            requireReady();
            order = get(owner, id);
            if (order.amount() != amount) throw reject(400, "AMOUNT_MISMATCH", "주문 금액과 결제 금액이 달라요.");
            if (key == null || key.isBlank() || key.length() > 200 || key.chars().anyMatch(Character::isISOControl)) throw reject(400, "INVALID_PAYMENT_KEY", "결제 정보를 확인해 주세요.");
            if (order.paymentKey() != null && !order.paymentKey().equals(key)) throw reject(409, "PAYMENT_KEY_MISMATCH", "이 주문에 연결된 결제 정보가 달라요.");
            if (order.status().equals("DONE")) return order;
            if (inFlight.contains(id)) throw reject(409, "PAYMENT_PROCESSING", "결제 승인을 확인하고 있어요. 잠시 후 다시 확인해 주세요.");
            for (Order other : orders.values()) if (!other.orderId().equals(id) && key.equals(other.paymentKey()))
                throw reject(409, "PAYMENT_KEY_REUSED", "이미 다른 주문에 연결된 결제 정보예요.");
            order = new Order(order.orderId(), order.owner(), order.channel(), order.kind(), order.amount(), order.orderName(), order.customerKey(),
                    order.message(), order.videoUrl(), order.start(), order.createdAt(), "CONFIRMING", key, order.idempotencyKey(), null, null, null);
            saveWith(order); // Failure here prevents a provider call.
            inFlight.add(id);
        }
        try {
            TossClient.Approved approved = client.confirm(order);
            synchronized (this) {
                Order paid = new Order(order.orderId(), order.owner(), order.channel(), order.kind(), order.amount(), order.orderName(), order.customerKey(),
                        order.message(), order.videoUrl(), order.start(), order.createdAt(), "DONE", key, order.idempotencyKey(), approved.approvedAt(), approved.method(), approved.receiptUrl());
                saveWith(paid);
                return paid;
            }
        } catch (TossClient.Failure failure) {
            throw reject(502, failure.code, failure.getMessage());
        } finally { synchronized (this) { inFlight.remove(id); } }
    }

    public Map<String, Object> publicView(Order order) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("orderId", order.orderId()); out.put("orderName", order.orderName()); out.put("amount", order.amount()); out.put("currency", "KRW");
        out.put("customerKey", order.customerKey()); out.put("status", order.status()); out.put("channel", order.channel()); out.put("kind", order.kind());
        out.put("createdAt", order.createdAt()); out.put("approvedAt", order.approvedAt()); out.put("method", order.method()); out.put("receiptUrl", order.receiptUrl());
        return out;
    }

    private void requireReady() { if (!props.configured()) throw reject(503, "PAYMENTS_NOT_CONFIGURED", "결제 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요."); }
    private void saveWith(Order order) {
        Map<String, Order> next = new LinkedHashMap<>(orders); next.put(order.orderId(), order);
        try {
            Files.createDirectories(file.getParent());
            Path temp = Files.createTempFile(file.getParent(), "orders-", ".tmp");
            try {
                Files.write(temp, json.writeValueAsBytes(next.values()));
                try (var channel = java.nio.channels.FileChannel.open(temp, java.nio.file.StandardOpenOption.WRITE)) { channel.force(true); }
                try { Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
                catch (AtomicMoveNotSupportedException failure) { throw new IOException("Atomic payment ledger writes are unavailable"); }
            } finally { Files.deleteIfExists(temp); }
            orders.clear(); orders.putAll(next);
        } catch (IOException | RuntimeException failure) { throw reject(503, "PAYMENT_STORAGE_UNAVAILABLE", "결제 내역을 저장할 수 없어요. 잠시 후 다시 시도해 주세요."); }
    }
    private static boolean validStored(Order order) {
        return order != null && order.orderId() != null && order.orderId().matches("frame_[a-f0-9]{32}") && order.owner() != null && order.owner().matches("[a-f0-9]{64}")
                && order.channel() != null && order.kind() != null && CHANNELS.contains(order.channel()) && KINDS.contains(order.kind()) && order.amount() >= 1000 && order.amount() <= 10_000_000
                && order.idempotencyKey() != null && !order.idempotencyKey().isBlank() && order.idempotencyKey().length() <= 300
                && order.orderName() != null && !order.orderName().isBlank() && order.customerKey() != null && !order.customerKey().isBlank()
                && order.createdAt() != null && order.status() != null && Set.of("READY", "CONFIRMING", "DONE").contains(order.status())
                && (order.status().equals("READY") || (order.paymentKey() != null && !order.paymentKey().isBlank() && order.paymentKey().length() <= 200))
                && (!order.status().equals("DONE") || order.approvedAt() != null);
    }
    private static boolean validVideo(String value) {
        try { var url = java.net.URI.create(value); return "https".equals(url.getScheme()) && url.getHost() != null && url.getUserInfo() == null; } catch (RuntimeException failure) { return false; }
    }
    private static Refusal reject(int status, String code, String message) { return new Refusal(status, code, message); }
}
