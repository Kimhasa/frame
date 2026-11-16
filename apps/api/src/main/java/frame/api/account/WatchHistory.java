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
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class WatchHistory {
    public record Item(UUID id, String kind, String broadcastId, String path, String title, String publisher,
                       String channelHandle, String thumbnailUrl, long watchedAtMs, boolean available,
                       UUID mediaId, Long durationMs, Long positionMs, boolean completed, long version) {}
    public record Page(UUID userId, List<Item> items, String nextCursor) {}
    public record MediaState(UUID userId, Item item, long epoch, long serverNowMs) {}
    record Progress(long epoch, UUID id, long version, long position, boolean completed) {}
    record Media(UUID id, UUID channel, String title, String publisher, long duration) {}
    record Cursor(long at, UUID id) {}
    record Filters(String kind, String query, Long from, Long to, Cursor cursor, int limit) {}
    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private final JdbcClient sql;
    private final BroadcastRegistry broadcasts;
    private final ProductVods vods;
    private final ProductClips clips;
    public WatchHistory(JdbcClient sql, BroadcastRegistry broadcasts, ProductVods vods, ProductClips clips) {
        this.sql = sql; this.broadcasts = broadcasts; this.vods = vods; this.clips = clips;
    }

    @Transactional public void record(UUID owner, JsonNode input) {
        epoch(owner, true);
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
    @Transactional(readOnly = true) public Page list(UUID owner, String kind, String query, String from, String to, String cursor, int limit) {
        account(owner);
        Filters filters = filters(kind, query, from, to, cursor, limit);
        StringBuilder statement = new StringBuilder("SELECT h.*,c.handle AS channel_handle FROM product_watch_history h LEFT JOIN product_channels c ON c.id=h.channel_id WHERE h.user_id=:owner");
        if (!filters.kind().equals("all")) statement.append(" AND h.kind=:kind");
        if (!filters.query().isEmpty()) statement.append(" AND position(lower(:query) IN lower(h.title || ' ' || h.publisher)) > 0");
        if (filters.from() != null) statement.append(" AND h.watched_at_ms>=:from");
        if (filters.to() != null) statement.append(" AND h.watched_at_ms<:to");
        if (filters.cursor() != null) statement.append(" AND (h.watched_at_ms,h.id)<(:cursorAt,:cursorId)");
        statement.append(" ORDER BY h.watched_at_ms DESC,h.id DESC LIMIT :limit");
        var request = sql.sql(statement.toString()).param("owner", owner).param("limit", filters.limit() + 1);
        if (!filters.kind().equals("all")) request.param("kind", filters.kind());
        if (!filters.query().isEmpty()) request.param("query", filters.query());
        if (filters.from() != null) request.param("from", filters.from());
        if (filters.to() != null) request.param("to", filters.to());
        if (filters.cursor() != null) request.param("cursorAt", filters.cursor().at()).param("cursorId", filters.cursor().id());
        List<Item> rows = request.query(this::row).list();
        boolean more = rows.size() > filters.limit();
        List<Item> items = more ? List.copyOf(rows.subList(0, filters.limit())) : rows;
        Item last = more ? items.getLast() : null;
        return new Page(owner, items, last == null ? null : encode(last.watchedAtMs(), last.id()));
    }
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public MediaState media(UUID owner, String kind, UUID mediaId) {
        long epoch = epoch(owner, false);
        media(kind, mediaId); // Reading a saved position never bypasses the public playback gate.
        return new MediaState(owner, archived(owner, kind, mediaId), epoch, System.currentTimeMillis());
    }
    @Transactional public MediaState progress(UUID owner, String kind, UUID mediaId, JsonNode input) {
        long epoch = epoch(owner, true);
        Progress progress = progress(input);
        if (progress.epoch() != epoch) throw conflict();
        Media media = media(kind, mediaId);
        long position = position(progress.position(), progress.completed(), media.duration());
        Item existing = archived(owner, kind, mediaId);
        if (progress.id() == null) {
            if (progress.version() != 0 || existing != null) throw conflict();
            sql.sql("""
                    INSERT INTO product_watch_history(id,user_id,kind,media_id,title,publisher,channel_id,watched_at_ms,duration_ms,position_ms,completed)
                    VALUES(:id,:owner,:kind,:media,:title,:publisher,:channel,:at,:duration,:position,:completed)
                    """).param("id", UUID.randomUUID()).param("owner", owner).param("kind", kind).param("media", mediaId)
                    .param("title", media.title()).param("publisher", media.publisher()).param("channel", media.channel())
                    .param("at", System.currentTimeMillis()).param("duration", media.duration()).param("position", position).param("completed", progress.completed()).update();
        } else {
            if (existing == null || !existing.id().equals(progress.id()) || existing.version() != progress.version()) throw conflict();
            int changed = sql.sql("""
                    UPDATE product_watch_history SET title=:title,publisher=:publisher,channel_id=:channel,watched_at_ms=:at,
                      duration_ms=:duration,position_ms=:position,completed=:completed,version=version+1
                    WHERE user_id=:owner AND id=:id AND version=:version
                    """).param("title", media.title()).param("publisher", media.publisher()).param("channel", media.channel())
                    .param("at", System.currentTimeMillis()).param("duration", media.duration()).param("position", position).param("completed", progress.completed())
                    .param("owner", owner).param("id", existing.id()).param("version", progress.version()).update();
            if (changed != 1) throw conflict();
        }
        return new MediaState(owner, archived(owner, kind, mediaId), epoch, System.currentTimeMillis());
    }
    @Transactional public void remove(UUID owner, UUID id) {
        epoch(owner, true);
        if (sql.sql("DELETE FROM product_watch_history WHERE user_id=:owner AND id=:id").param("owner", owner).param("id", id).update() != 1) throw missing();
        advanceEpoch(owner);
    }
    @Transactional public void removeMany(UUID owner, JsonNode input) {
        epoch(owner, true);
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
        advanceEpoch(owner);
    }
    @Transactional public void removeAll(UUID owner) {
        epoch(owner, true);
        sql.sql("DELETE FROM product_watch_history WHERE user_id=:owner").param("owner", owner).update();
        advanceEpoch(owner);
    }
    private long epoch(UUID owner, boolean lock) {
        return sql.sql("SELECT watch_history_epoch FROM product_accounts WHERE id=:owner" + (lock ? " FOR UPDATE" : ""))
                .param("owner", owner).query(Long.class).optional().orElseThrow(() -> new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요."));
    }
    private void advanceEpoch(UUID owner) {
        sql.sql("UPDATE product_accounts SET watch_history_epoch=watch_history_epoch+1 WHERE id=:owner").param("owner", owner).update();
    }
    private void account(UUID owner) {
        if (!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:owner)").param("owner", owner).query(Boolean.class).single()) throw new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요.");
    }
    private Item row(ResultSet row, int index) throws SQLException {
        String kind = row.getString("kind");
        if (!kind.equals("live")) {
            UUID mediaId = row.getObject("media_id", UUID.class);
            boolean available = kind.equals("vod") ? vods.publiclyAvailable(mediaId) : clips.publiclyAvailable(mediaId);
            return new Item(row.getObject("id", UUID.class), kind, null, null, row.getString("title"), row.getString("publisher"),
                    row.getString("channel_handle"), null, row.getLong("watched_at_ms"), available, mediaId,
                    row.getLong("duration_ms"), row.getLong("position_ms"), row.getBoolean("completed"), row.getLong("version"));
        }
        String id = row.getString("broadcast_id"), path = row.getString("path");
        Broadcast current = broadcasts.get(id);
        boolean available = current != null && current.path.equals(path) && current.instanceId.equals(row.getObject("broadcast_instance_id", UUID.class));
        return new Item(row.getObject("id", UUID.class), "live", id, path, row.getString("title"), row.getString("publisher"),
                row.getString("channel_handle"), available ? "/thumbnails/" + id + ".jpg" : null, row.getLong("watched_at_ms"), available,
                null, null, null, false, 0);
    }
    private Item archived(UUID owner, String kind, UUID mediaId) {
        return sql.sql("SELECT h.*,c.handle AS channel_handle FROM product_watch_history h LEFT JOIN product_channels c ON c.id=h.channel_id WHERE h.user_id=:owner AND h.kind=:kind AND h.media_id=:media")
                .param("owner", owner).param("kind", kind).param("media", mediaId).query(this::row).optional().orElse(null);
    }
    private Media media(String kind, UUID id) {
        if (kind.equals("vod")) {
            var item = vods.publicDetail(id).item();
            return new Media(item.id(), item.channel().id(), item.title(), item.channel().displayName(), item.durationMs());
        }
        if (kind.equals("clip")) {
            var item = clips.publicDetail(id).item();
            return new Media(item.id(), item.channel().id(), item.title(), item.channel().displayName(), item.durationMs());
        }
        throw invalidInput();
    }
    static Progress progress(JsonNode input) {
        if (input.size() != 5 || !input.has("id") || (!input.path("id").isNull() && !input.path("id").isString()) || !input.path("completed").isBoolean()) throw invalidInput();
        return new Progress(number(input.path("epoch")), input.path("id").isNull() ? null : id(input.path("id").asString()),
                number(input.path("version")), number(input.path("positionMs")), input.path("completed").booleanValue());
    }
    static long position(long position, boolean completed, long duration) {
        if (position < 0 || position > duration || (completed && duration - position > 1000)) throw invalidInput();
        return completed ? duration : position;
    }
    private static long number(JsonNode value) {
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.longValue() < 0) throw invalidInput();
        return value.longValue();
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
    private static ProductProblem conflict() { return new ProductProblem(409, "HISTORY_CONFLICT", "시청 기록이 바뀌었어요. 기록을 다시 연결해 주세요."); }
}
