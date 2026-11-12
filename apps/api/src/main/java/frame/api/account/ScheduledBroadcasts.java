package frame.api.account;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ScheduledBroadcasts {
    public record Item(UUID id, String title, long at) {}
    record Draft(String title, long at) {}
    private final JdbcClient sql;
    public ScheduledBroadcasts(JdbcClient sql) { this.sql = sql; }

    public List<Item> own(UUID owner) {
        return sql.sql("""
                SELECT * FROM (
                  (SELECT id,title,starts_at FROM product_broadcast_schedules WHERE channel_id=:channel AND starts_at > current_timestamp ORDER BY starts_at,id LIMIT 100)
                  UNION ALL
                  (SELECT id,title,starts_at FROM product_broadcast_schedules WHERE channel_id=:channel AND starts_at <= current_timestamp ORDER BY starts_at DESC,id DESC LIMIT 100)
                ) schedules
                ORDER BY (starts_at > current_timestamp) DESC,
                  CASE WHEN starts_at > current_timestamp THEN starts_at END ASC,
                  starts_at DESC,id DESC
                """).param("channel", channel(owner)).query(this::row).list();
    }
    public List<Item> upcoming(String handle) {
        UUID channel = sql.sql("SELECT c.id FROM product_channels c WHERE c.handle=:handle OR EXISTS(SELECT 1 FROM product_channel_handles h WHERE h.handle=:handle AND h.channel_id=c.id)").param("handle", handle.toLowerCase(Locale.ROOT))
                .query(UUID.class).optional().orElseThrow(() -> new ProductProblem(404, "CHANNEL_NOT_FOUND", "채널을 찾을 수 없어요."));
        return sql.sql("SELECT id,title,starts_at FROM product_broadcast_schedules WHERE channel_id=:channel AND starts_at > current_timestamp ORDER BY starts_at,id LIMIT 200")
                .param("channel", channel).query(this::row).list();
    }
    @Transactional public Item create(UUID owner, JsonNode input) {
        UUID channel = channel(owner, true);
        Draft draft = validate(input, System.currentTimeMillis());
        if (sql.sql("SELECT count(*) FROM product_broadcast_schedules WHERE channel_id=:channel AND starts_at > statement_timestamp()")
                .param("channel", channel).query(Integer.class).single() >= 100) throw new ProductProblem(409, "SCHEDULE_LIMIT", "예정된 방송은 100개까지 예약할 수 있어요.");
        return write(UUID.randomUUID(), channel, draft, false);
    }
    @Transactional public Item update(UUID owner, UUID id, JsonNode input) {
        UUID channel = channel(owner);
        Item previous = locked(channel, id);
        if (previous.at() <= System.currentTimeMillis()) throw past();
        return write(id, channel, validate(input, System.currentTimeMillis()), true);
    }
    @Transactional public void cancel(UUID owner, UUID id) {
        UUID channel = channel(owner);
        if (locked(channel, id).at() <= System.currentTimeMillis()) throw past();
        sql.sql("DELETE FROM product_broadcast_schedules WHERE id=:id AND channel_id=:channel").param("id", id).param("channel", channel).update();
    }
    private Item write(UUID id, UUID channel, Draft draft, boolean update) {
        String statement = update
                ? "UPDATE product_broadcast_schedules SET title=:title,starts_at=:at WHERE id=:id AND channel_id=:channel RETURNING id,title,starts_at"
                : "INSERT INTO product_broadcast_schedules(id,channel_id,title,starts_at) VALUES(:id,:channel,:title,:at) RETURNING id,title,starts_at";
        try {
            return sql.sql(statement).param("id", id).param("channel", channel).param("title", draft.title())
                    .param("at", OffsetDateTime.ofInstant(Instant.ofEpochMilli(draft.at()), ZoneOffset.UTC)).query(this::row).single();
        } catch (DuplicateKeyException failure) { throw new ProductProblem(409, "SCHEDULE_CONFLICT", "같은 시간에 예약된 방송이 있어요."); }
    }
    private UUID channel(UUID owner) {
        return channel(owner, false);
    }
    private UUID channel(UUID owner, boolean lock) {
        return sql.sql("SELECT id FROM product_channels WHERE owner_id=:owner" + (lock ? " FOR UPDATE" : "")).param("owner", owner).query(UUID.class).optional()
                .orElseThrow(() -> new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요."));
    }
    private Item locked(UUID channel, UUID id) {
        return sql.sql("SELECT id,title,starts_at FROM product_broadcast_schedules WHERE id=:id AND channel_id=:channel FOR UPDATE")
                .param("id", id).param("channel", channel).query(this::row).optional()
                .orElseThrow(() -> new ProductProblem(404, "SCHEDULE_NOT_FOUND", "예약을 찾을 수 없어요. 목록을 새로 확인해 주세요."));
    }
    static Draft validate(JsonNode value, long now) {
        JsonNode title = value.path("title"), at = value.path("at");
        if (!title.isString() || title.asString().codePoints().anyMatch(Character::isISOControl)) throw new ProductProblem(400, "INVALID_SCHEDULE_TITLE", "방송 제목을 1~100자로 입력해 주세요.");
        String text = title.asString().strip();
        if (text.codePointCount(0, text.length()) < 1 || text.codePointCount(0, text.length()) > 100) throw new ProductProblem(400, "INVALID_SCHEDULE_TITLE", "방송 제목을 1~100자로 입력해 주세요.");
        if (!at.isIntegralNumber() || !at.canConvertToLong() || at.longValue() <= now || at.longValue() > 253402300799999L) throw new ProductProblem(400, "INVALID_SCHEDULE_TIME", "현재 이후의 날짜와 시간을 선택해 주세요.");
        if (value.size() != 2) throw new ProductProblem(400, "INVALID_SCHEDULE_INPUT", "방송 제목과 일시만 입력해 주세요.");
        return new Draft(text, at.longValue());
    }
    private Item row(ResultSet row, int index) throws SQLException { return new Item(row.getObject("id", UUID.class), row.getString("title"), row.getObject("starts_at", OffsetDateTime.class).toInstant().toEpochMilli()); }
    private static ProductProblem past() { return new ProductProblem(409, "SCHEDULE_PAST", "지난 예약은 변경하거나 취소할 수 없어요."); }
}
