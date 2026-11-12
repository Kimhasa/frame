package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class WatchHistory {
    public record Item(UUID id, String kind, String broadcastId, String path, String title, String publisher,
                       String channelHandle, String thumbnailUrl, long watchedAtMs, boolean available) {}
    public record Page(List<Item> items, String nextCursor) {}
    record Cursor(long at, UUID id) {}
    record Filters(String kind, String query, Long from, Long to, Cursor cursor, int limit) {}
    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private final JdbcClient sql;
    private final BroadcastRegistry broadcasts;
    public WatchHistory(JdbcClient sql, BroadcastRegistry broadcasts) { this.sql = sql; this.broadcasts = broadcasts; }

    @Transactional public void record(UUID owner, JsonNode input) {
        account(owner);
        if (input.size() != 2 || !input.path("broadcastId").isString() || !input.path("path").isString()) throw invalidInput();
        String id = input.path("broadcastId").asString(), path = input.path("path").asString();
        if (!id.matches("[0-9a-f]{32}") || !path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")) throw invalidInput();
        Broadcast broadcast = broadcasts.get(id);
        if (broadcast == null || !broadcast.path.equals(path)) throw new ProductProblem(404, "HISTORY_BROADCAST_NOT_FOUND", "이 방송은 더 이상 시청 기록에 저장할 수 없어요.");
        UUID channel = sql.sql("SELECT id FROM product_channels WHERE stream_path=:path").param("path", path).query(UUID.class).optional().orElse(null);
        sql.sql("""
                INSERT INTO product_watch_history(id,user_id,broadcast_id,path,broadcast_instance_id,title,publisher,channel_id,watched_at_ms)
                VALUES(:id,:owner,:broadcast,:path,:instance,:title,:publisher,:channel,:at)
                ON CONFLICT(user_id,path,broadcast_id,broadcast_instance_id) DO UPDATE SET
                  title=excluded.title,publisher=excluded.publisher,channel_id=excluded.channel_id,watched_at_ms=excluded.watched_at_ms
                """).param("id", UUID.randomUUID()).param("owner", owner).param("broadcast", broadcast.id).param("path", broadcast.path)
                .param("instance", broadcast.instanceId).param("title", snapshot(broadcast.title)).param("publisher", snapshot(broadcast.publisher))
                .param("channel", channel, java.sql.Types.OTHER).param("at", System.currentTimeMillis()).update();
    }
    public Page list(UUID owner, String kind, String query, String from, String to, String cursor, int limit) {
        account(owner);
        Filters filters = filters(kind, query, from, to, cursor, limit);
        if (filters.kind().equals("vod") || filters.kind().equals("clip")) return new Page(List.of(), null);
        StringBuilder statement = new StringBuilder("SELECT h.*,c.handle AS channel_handle FROM product_watch_history h LEFT JOIN product_channels c ON c.id=h.channel_id WHERE h.user_id=:owner");
        if (!filters.query().isEmpty()) statement.append(" AND position(lower(:query) IN lower(h.title || ' ' || h.publisher)) > 0");
        if (filters.from() != null) statement.append(" AND h.watched_at_ms>=:from");
        if (filters.to() != null) statement.append(" AND h.watched_at_ms<:to");
        if (filters.cursor() != null) statement.append(" AND (h.watched_at_ms,h.id)<(:cursorAt,:cursorId)");
        statement.append(" ORDER BY h.watched_at_ms DESC,h.id DESC LIMIT :limit");
        var request = sql.sql(statement.toString()).param("owner", owner).param("limit", filters.limit() + 1);
        if (!filters.query().isEmpty()) request.param("query", filters.query());
        if (filters.from() != null) request.param("from", filters.from());
        if (filters.to() != null) request.param("to", filters.to());
        if (filters.cursor() != null) request.param("cursorAt", filters.cursor().at()).param("cursorId", filters.cursor().id());
        List<Item> rows = request.query(this::row).list();
        boolean more = rows.size() > filters.limit();
        List<Item> items = more ? List.copyOf(rows.subList(0, filters.limit())) : rows;
        Item last = more ? items.getLast() : null;
        return new Page(items, last == null ? null : encode(last.watchedAtMs(), last.id()));
    }
    @Transactional public void remove(UUID owner, UUID id) {
        account(owner);
        if (sql.sql("DELETE FROM product_watch_history WHERE user_id=:owner AND id=:id").param("owner", owner).param("id", id).update() != 1) throw missing();
    }
    @Transactional public void removeMany(UUID owner, JsonNode input) {
        account(owner);
        JsonNode values = input.path("ids");
        if (input.size() != 1 || !values.isArray() || values.size() < 1 || values.size() > 200) throw invalidInput();
        Set<UUID> ids = new HashSet<>();
        for (JsonNode value : values) {
            if (!value.isString()) throw invalidInput();
            ids.add(id(value.asString()));
        }
        // Lock every requested row before deleting any; mixed-owner/missing requests never partially delete.
        List<UUID> owned = sql.sql("SELECT id FROM product_watch_history WHERE user_id=:owner AND id IN (:ids) ORDER BY id FOR UPDATE")
                .param("owner", owner).param("ids", ids).query(UUID.class).list();
        if (owned.size() != ids.size()) throw missing();
        sql.sql("DELETE FROM product_watch_history WHERE user_id=:owner AND id IN (:ids)").param("owner", owner).param("ids", ids).update();
    }
    @Transactional public void removeAll(UUID owner) { account(owner); sql.sql("DELETE FROM product_watch_history WHERE user_id=:owner").param("owner", owner).update(); }
    private void account(UUID owner) {
        if (!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:owner)").param("owner", owner).query(Boolean.class).single()) throw new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요.");
    }
    private Item row(ResultSet row, int index) throws SQLException {
        String id = row.getString("broadcast_id"), path = row.getString("path");
        Broadcast current = broadcasts.get(id);
        boolean available = current != null && current.path.equals(path) && current.instanceId.equals(row.getObject("broadcast_instance_id", UUID.class));
        return new Item(row.getObject("id", UUID.class), "live", id, path, row.getString("title"), row.getString("publisher"),
                row.getString("channel_handle"), available ? "/thumbnails/" + id + ".jpg" : null, row.getLong("watched_at_ms"), available);
    }
    static Filters filters(String kind, String query, String from, String to, String cursor, int limit) {
        if (!Set.of("all", "live", "vod", "clip").contains(kind) || limit < 1 || limit > 100 || query.codePointCount(0, query.length()) > 120 || query.codePoints().anyMatch(Character::isISOControl)) throw invalidFilter();
        Long start = day(from, false), end = day(to, true);
        if (start != null && end != null && start >= end) throw invalidFilter();
        return new Filters(kind, query.strip(), start, end, decode(cursor), limit);
    }
    private static Long day(String value, boolean after) {
        if (value.isEmpty()) return null;
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw invalidFilter();
        try { LocalDate date = LocalDate.parse(value); return (after ? date.plusDays(1) : date).atStartOfDay(SEOUL).toInstant().toEpochMilli(); }
        catch (DateTimeException failure) { throw invalidFilter(); }
    }
    static Cursor decode(String value) {
        if (value.isEmpty()) return null;
        try {
            if (!value.matches("[A-Za-z0-9_-]{1,160}")) throw new IllegalArgumentException();
            String decoded = new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
            if (!decoded.matches("[1-9][0-9]{0,14}:" + UUID_PATTERN)) throw new IllegalArgumentException();
            String[] parts = decoded.split(":", 2); long at = Long.parseLong(parts[0]);
            if (at > 253402300799999L) throw new IllegalArgumentException();
            return new Cursor(at, UUID.fromString(parts[1]));
        } catch (IllegalArgumentException failure) { throw new ProductProblem(400, "INVALID_HISTORY_CURSOR", "시청 기록을 새로 불러와 주세요."); }
    }
    static String encode(long at, UUID id) { return Base64.getUrlEncoder().withoutPadding().encodeToString((at + ":" + id).getBytes(StandardCharsets.UTF_8)); }
    // Existing native announcements allow NUL; PostgreSQL text does not. Keep the snapshot readable without changing media contracts.
    private static String snapshot(String value) { return value.replace('\0', '\uFFFD'); }
    static UUID id(String value) { if (!value.matches(UUID_PATTERN)) throw invalidInput(); return UUID.fromString(value); }
    private static ProductProblem invalidInput() { return new ProductProblem(400, "INVALID_HISTORY_INPUT", "시청 기록 요청을 확인해 주세요."); }
    private static ProductProblem invalidFilter() { return new ProductProblem(400, "INVALID_HISTORY_FILTER", "시청 기록 검색 조건을 확인해 주세요."); }
    private static ProductProblem missing() { return new ProductProblem(404, "HISTORY_NOT_FOUND", "시청 기록을 찾을 수 없어요. 목록을 새로 확인해 주세요."); }
}
