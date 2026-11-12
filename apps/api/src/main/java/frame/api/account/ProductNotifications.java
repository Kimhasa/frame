package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ProductNotifications {
    public record Target(UUID channelId, String channelHandle, String broadcastId, String path, boolean available) {}
    public record Report(UUID id, String status) {}
    public record Item(UUID id, String kind, String title, String body, long createdAtMs, Long readAtMs, Target target, Report report) {}
    public record Count(UUID userId, long unreadCount) {}
    public record Page(UUID userId, List<Item> items, String nextCursor, long unreadCount) {}
    record Cursor(long at, UUID id) {}
    record Filters(String filter, String kind, Cursor cursor, int limit) {}
    private record Channel(UUID id, String handle, String name, long baseline) {}
    private record ReportResult(UUID recipient, String status, String channelName) {}
    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private final JdbcClient sql;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths media;
    public ProductNotifications(JdbcClient sql, BroadcastRegistry registry, MediaMtxPaths media) { this.sql = sql; this.registry = registry; this.media = media; }
    public Page list(UUID recipient, String filter, String kind, String cursor, int limit) {
        account(recipient);
        Filters filters = filters(filter, kind, cursor, limit);
        StringBuilder statement = new StringBuilder("SELECT n.*,c.handle AS current_handle FROM product_notifications n LEFT JOIN product_channels c ON c.id=n.channel_id WHERE recipient_id=:recipient");
        if (filters.filter().equals("unread")) statement.append(" AND read_at_ms IS NULL");
        if (!filters.kind().equals("all")) statement.append(" AND kind=:kind");
        if (filters.cursor() != null) statement.append(" AND (created_at_ms,n.id)<(:cursorAt,:cursorId)");
        statement.append(" ORDER BY created_at_ms DESC,n.id DESC LIMIT :limit");
        var request = sql.sql(statement.toString()).param("recipient", recipient).param("limit", limit + 1);
        if (!filters.kind().equals("all")) request.param("kind", filters.kind());
        if (filters.cursor() != null) request.param("cursorAt", filters.cursor().at()).param("cursorId", filters.cursor().id());
        List<Item> rows = request.query(this::row).list(); boolean more = rows.size() > limit;
        List<Item> items = more ? List.copyOf(rows.subList(0, limit)) : rows;
        Item last = more ? items.getLast() : null;
        return new Page(recipient, items, last == null ? null : encode(last.createdAtMs(), last.id()), unread(recipient));
    }
    public Count count(UUID recipient) { account(recipient); return new Count(recipient, unread(recipient)); }
    @Transactional public Count read(UUID recipient, String id) {
        account(recipient);
        if (sql.sql("UPDATE product_notifications SET read_at_ms=coalesce(read_at_ms,:at) WHERE recipient_id=:recipient AND id=:id")
                .param("recipient", recipient).param("id", id(id)).param("at", System.currentTimeMillis()).update() != 1) throw missing();
        return new Count(recipient, unread(recipient));
    }
    @Transactional public Count readAll(UUID recipient) {
        account(recipient); sql.sql("UPDATE product_notifications SET read_at_ms=:at WHERE recipient_id=:recipient AND read_at_ms IS NULL").param("at", System.currentTimeMillis()).param("recipient", recipient).update();
        return new Count(recipient, unread(recipient));
    }
    @Transactional public Count remove(UUID recipient, String id) {
        account(recipient);
        if (sql.sql("DELETE FROM product_notifications WHERE recipient_id=:recipient AND id=:id").param("recipient", recipient).param("id", id(id)).update() != 1) throw missing();
        return new Count(recipient, unread(recipient));
    }
    @Transactional public Count clear(UUID recipient) { account(recipient); sql.sql("DELETE FROM product_notifications WHERE recipient_id=:recipient").param("recipient", recipient).update(); return new Count(recipient, unread(recipient)); }
    private long unread(UUID recipient) { return sql.sql("SELECT count(*) FROM product_notifications WHERE recipient_id=:recipient AND read_at_ms IS NULL").param("recipient", recipient).query(Long.class).single(); }
    private void account(UUID recipient) {
        if (recipient == null || !sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:recipient)").param("recipient", recipient).query(Boolean.class).single()) throw new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요.");
    }
    private Item row(ResultSet r, int index) throws SQLException {
        String kind = r.getString("kind"); Target target = null; Report report = null;
        if (kind.equals("live")) {
            String id = r.getString("broadcast_id"), path = r.getString("path"), source = r.getString("source_session");
            Broadcast current = registry.get(id); MediaPath found = media.last().get(path);
            boolean available = current != null && current.path.equals(path) && current.instanceId.equals(r.getObject("broadcast_instance_id", UUID.class))
                    && fresh(media) && consistent(current, found) && source.equals(source(found));
            String handle = r.getString("current_handle");
            target = new Target(r.getObject("channel_id", UUID.class), handle == null ? r.getString("channel_handle") : handle, id, path, available);
        } else report = new Report(r.getObject("report_id", UUID.class), r.getString("report_status"));
        return new Item(r.getObject("id", UUID.class), kind, r.getString("title"), r.getString("body"), r.getLong("created_at_ms"), r.getObject("read_at_ms", Long.class), target, report);
    }
    /** Called only by the isolated product reconciler, never from a synchronous registry/media event listener. */
    @Transactional(timeout = 3) public void live(Broadcast broadcast, MediaPath source) {
        if (!observed(broadcast, source)) return;
        sql.sql("SET LOCAL statement_timeout='1500ms'").update(); sql.sql("SET LOCAL lock_timeout='1000ms'").update();
        Channel channel = sql.sql("SELECT id,handle,display_name,notification_live_after_ms FROM product_channels WHERE stream_path=:path")
                .param("path", broadcast.path).query((r, index) -> new Channel(r.getObject("id", UUID.class), r.getString("handle"), r.getString("display_name"), r.getLong("notification_live_after_ms"))).optional().orElse(null);
        if (channel == null) return;
        String fingerprint = source(source), event = "live:" + channel.id() + ":" + fingerprint;
        long now = System.currentTimeMillis();
        boolean sourceNew = event(event, now);
        boolean broadcastNew = event("broadcast:" + channel.id() + ":" + broadcast.instanceId, now);
        if (!sourceNew || !broadcastNew || !consistent(broadcast, source) || source.readyMs() < channel.baseline()) return;
        sql.sql("""
                INSERT INTO product_notifications(id,recipient_id,event_key,kind,title,body,created_at_ms,channel_id,channel_handle,broadcast_id,path,broadcast_instance_id,source_session)
                SELECT gen_random_uuid(),f.user_id,:event,'live',:title,:body,:at,:channel,:handle,:broadcast,:path,:instance,:source
                FROM product_follows f WHERE f.channel_id=:channel AND f.notifications_on AND f.notifications_enabled_at<=:ready
                ON CONFLICT(recipient_id,event_key) DO NOTHING
                """).param("event", event).param("title", snapshot(channel.name()) + "님이 방송을 시작했어요").param("body", snapshot(broadcast.title)).param("at", now)
                .param("channel", channel.id()).param("handle", channel.handle()).param("broadcast", broadcast.id).param("path", broadcast.path).param("instance", broadcast.instanceId)
                .param("source", fingerprint).param("ready", OffsetDateTime.ofInstant(Instant.ofEpochMilli(source.readyMs()), ZoneOffset.UTC)).update();
    }
    /** Participates in the review transaction: a terminal result and its private generic notice commit together. */
    @Transactional public void report(UUID report) {
        var result = sql.sql("SELECT r.reporter_id,r.status,c.display_name FROM product_channel_reports r JOIN product_channels c ON c.id=r.channel_id WHERE r.id=:id AND r.status IN ('resolved','dismissed')").param("id", report)
                .query((r, index) -> new ReportResult(r.getObject("reporter_id", UUID.class), r.getString("status"), r.getString("display_name"))).optional().orElse(null);
        if (result == null) return;
        long now = System.currentTimeMillis(); String event = "report:" + report + ":terminal";
        if (!event(event, now)) return;
        sql.sql("INSERT INTO product_notifications(id,recipient_id,event_key,kind,title,body,created_at_ms,report_id,report_status) VALUES(:id,:recipient,:event,'report',:title,:body,:at,:report,:status)")
                .param("id", UUID.randomUUID()).param("recipient", result.recipient()).param("event", event).param("title", "신고 검토가 완료됐어요")
                .param("body", snapshot(result.channelName()) + (result.status().equals("resolved") ? " 채널에 접수한 신고의 검토가 완료됐어요." : " 채널에 접수한 신고가 검토 후 종결됐어요."))
                .param("at", now).param("report", report).param("status", result.status()).update();
    }
    private boolean event(String key, long at) { return sql.sql("INSERT INTO product_notification_events(event_key,created_at_ms) VALUES(:key,:at) ON CONFLICT(event_key) DO NOTHING").param("key", key).param("at", at).update() == 1; }
    static boolean fresh(MediaMtxPaths media) { return media.ok() && !media.stale() && System.currentTimeMillis() - media.goodAt() <= 6000; }
    static boolean consistent(Broadcast broadcast, MediaPath source) {
        return observed(broadcast, source) && source.readyMs() >= broadcast.startedAtRelayMs - 10_000;
    }
    private static boolean observed(Broadcast broadcast, MediaPath source) {
        return source != null && source.ready() && source.readyMs() > 0 && source.sourceType() != null && !source.sourceType().isBlank()
                && broadcast.seen != null && broadcast.lastReadyMs > 0 && source(source).equals(source(broadcast.seen));
    }
    static String source(MediaPath source) {
        if (source == null || source.readyMs() <= 0 || source.sourceType() == null || source.sourceType().isBlank()) return "";
        String value = source.sourceType().toLowerCase(Locale.ROOT) + "|" + (source.sourceId() == null ? "" : source.sourceId()) + "|" + source.readyMs();
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    static Filters filters(String filter, String kind, String cursor, int limit) {
        if (!Set.of("all", "unread").contains(filter) || !Set.of("all", "live", "report").contains(kind) || limit < 1 || limit > 100) throw new ProductProblem(400, "INVALID_NOTIFICATION_FILTER", "알림 검색 조건을 확인해 주세요.");
        return new Filters(filter, kind, decode(cursor), limit);
    }
    static String encode(long at, UUID id) { return Base64.getUrlEncoder().withoutPadding().encodeToString((at + ":" + id).getBytes(StandardCharsets.UTF_8)); }
    static Cursor decode(String value) {
        if (value.isEmpty()) return null;
        try {
            if (!value.matches("[A-Za-z0-9_-]{1,160}")) throw new IllegalArgumentException();
            String decoded = new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
            if (!decoded.matches("[1-9][0-9]{0,14}:" + UUID_PATTERN)) throw new IllegalArgumentException();
            String[] parts = decoded.split(":", 2); long at = Long.parseLong(parts[0]);
            if (at > 253402300799999L) throw new IllegalArgumentException();
            return new Cursor(at, UUID.fromString(parts[1]));
        } catch (IllegalArgumentException failure) { throw new ProductProblem(400, "INVALID_NOTIFICATION_CURSOR", "알림 목록을 새로 불러와 주세요."); }
    }
    static UUID id(String value) { if (!value.matches("(?i)" + UUID_PATTERN)) throw new ProductProblem(400, "INVALID_NOTIFICATION_ID", "알림 주소를 확인해 주세요."); return UUID.fromString(value); }
    private static String snapshot(String value) { return value.replace('\0', '\uFFFD'); }
    private static ProductProblem missing() { return new ProductProblem(404, "NOTIFICATION_NOT_FOUND", "알림을 찾을 수 없어요."); }
}
