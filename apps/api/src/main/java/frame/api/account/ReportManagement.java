package frame.api.account;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
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
public class ReportManagement {
    public record Channel(UUID id, String handle, String displayName) {}
    public record Person(UUID id, String displayName) {}
    public record Item(UUID id, String status, String reason, String details, long createdAtMs, long updatedAtMs, int version, Channel channel, Person reporter) {}
    public record Detail(UUID id, String status, String reason, String details, long createdAtMs, long updatedAtMs, int version, Channel channel, Person reporter, String reviewNote, Person reviewedBy) {}
    public record Page(List<Item> items, String nextCursor) {}
    record Cursor(OffsetDateTime at, UUID id) {}
    record Filters(String status, String reason, String query, Cursor cursor, int limit) {}
    record Change(String status, String note, int version) {}
    private record Stored(Detail detail, OffsetDateTime created) { Item item() { return new Item(detail.id(), detail.status(), detail.reason(), detail.details(), detail.createdAtMs(), detail.updatedAtMs(), detail.version(), detail.channel(), detail.reporter()); } }
    private static final Set<String> STATUSES = Set.of("all", "received", "reviewing", "resolved", "dismissed");
    private static final Set<String> REASONS = Set.of("all", "spam", "impersonation", "harassment", "inappropriate", "other");
    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final String SELECT = """
            SELECT r.*,c.handle,c.display_name AS channel_name,a.display_name AS reporter_name,reviewer.display_name AS reviewer_name
            FROM product_channel_reports r JOIN product_channels c ON c.id=r.channel_id JOIN product_accounts a ON a.id=r.reporter_id
            LEFT JOIN product_accounts reviewer ON reviewer.id=r.reviewed_by
            """;
    private final JdbcClient sql;
    private final ProductNotifications notifications;
    public ReportManagement(JdbcClient sql, ProductNotifications notifications) { this.sql = sql; this.notifications = notifications; }
    public void requireOperator(UUID operator) { operator(operator, false); }
    private void operator(UUID operator, boolean lock) {
        if (operator == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요.");
        boolean allowed = sql.sql("SELECT is_operator FROM product_accounts WHERE id=:operator" + (lock ? " FOR SHARE" : ""))
                .param("operator", operator).query(Boolean.class).optional().orElseThrow(() -> new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요."));
        if (!allowed) throw new ProductProblem(403, "OPERATOR_REQUIRED", "운영자 권한이 필요해요.");
    }
    public Page list(UUID operator, String status, String reason, String query, String cursor, int limit) {
        requireOperator(operator);
        Filters filters = filters(status, reason, query, cursor, limit);
        StringBuilder statement = new StringBuilder(SELECT + " WHERE true");
        if (!filters.status().equals("all")) statement.append(" AND r.status=:status");
        if (!filters.reason().equals("all")) statement.append(" AND r.reason=:reason");
        if (!filters.query().isEmpty()) statement.append(" AND position(lower(:query) IN lower(c.display_name || ' ' || c.handle || ' ' || r.details)) > 0");
        if (filters.cursor() != null) statement.append(" AND (r.created_at,r.id)<(:cursorAt,:cursorId)");
        statement.append(" ORDER BY r.created_at DESC,r.id DESC LIMIT :limit");
        var request = sql.sql(statement.toString()).param("limit", filters.limit() + 1);
        if (!filters.status().equals("all")) request.param("status", filters.status());
        if (!filters.reason().equals("all")) request.param("reason", filters.reason());
        if (!filters.query().isEmpty()) request.param("query", filters.query());
        if (filters.cursor() != null) request.param("cursorAt", filters.cursor().at()).param("cursorId", filters.cursor().id());
        List<Stored> rows = request.query(this::row).list();
        boolean more = rows.size() > filters.limit();
        List<Stored> page = more ? rows.subList(0, filters.limit()) : rows;
        Stored last = more ? page.getLast() : null;
        return new Page(page.stream().map(Stored::item).toList(), last == null ? null : encode(last.created(), last.detail().id()));
    }
    public Detail detail(UUID operator, String id) {
        requireOperator(operator);
        return find(id(id)).detail();
    }
    @Transactional public Detail update(UUID operator, String id, JsonNode input) {
        // A committed permission revocation is effective for the next request, even with the same Redis session.
        operator(operator, true);
        UUID report = id(id);
        Change change = change(input);
        var current = sql.sql("SELECT status,version FROM product_channel_reports WHERE id=:id FOR UPDATE").param("id", report)
                .query((r, index) -> new Change(r.getString("status"), "", r.getInt("version"))).optional().orElseThrow(ReportManagement::missing);
        if (current.status().equals("resolved") || current.status().equals("dismissed")) throw new ProductProblem(409, "REPORT_ALREADY_CLOSED", "이미 처리가 끝난 신고예요.");
        if (current.version() != change.version()) throw new ProductProblem(409, "REPORT_CONFLICT", "다른 운영자가 내용을 변경했어요. 새로 불러와 주세요.");
        if (current.status().equals(change.status())) throw new ProductProblem(400, "INVALID_REPORT_TRANSITION", "현재 상태에서 선택한 상태로 변경할 수 없어요.");
        sql.sql("UPDATE product_channel_reports SET status=:status,review_note=:note,reviewed_by=:operator,updated_at=:at,version=version+1 WHERE id=:id")
                .param("status", change.status()).param("note", change.note()).param("operator", operator)
                .param("at", OffsetDateTime.ofInstant(Instant.ofEpochMilli(System.currentTimeMillis()), ZoneOffset.UTC)).param("id", report).update();
        if (!change.status().equals("reviewing")) notifications.report(report);
        return find(report).detail();
    }
    private Stored find(UUID id) { return sql.sql(SELECT + " WHERE r.id=:id").param("id", id).query(this::row).optional().orElseThrow(ReportManagement::missing); }
    private Stored row(ResultSet r, int index) throws SQLException {
        OffsetDateTime created = r.getObject("created_at", OffsetDateTime.class);
        UUID reviewedBy = r.getObject("reviewed_by", UUID.class);
        Detail detail = new Detail(r.getObject("id", UUID.class), r.getString("status"), r.getString("reason"), r.getString("details"), created.toInstant().toEpochMilli(),
                r.getObject("updated_at", OffsetDateTime.class).toInstant().toEpochMilli(), r.getInt("version"),
                new Channel(r.getObject("channel_id", UUID.class), r.getString("handle"), r.getString("channel_name")),
                new Person(r.getObject("reporter_id", UUID.class), r.getString("reporter_name")), r.getString("review_note"),
                reviewedBy == null ? null : new Person(reviewedBy, r.getString("reviewer_name")));
        return new Stored(detail, created);
    }
    static Filters filters(String status, String reason, String query, String cursor, int limit) {
        if (!STATUSES.contains(status) || !REASONS.contains(reason) || limit < 1 || limit > 100 || Accounts.length(query) > 120 || query.codePoints().anyMatch(Character::isISOControl)) throw new ProductProblem(400, "INVALID_REPORT_FILTER", "신고 검색 조건을 확인해 주세요.");
        return new Filters(status, reason, query.strip(), decode(cursor), limit);
    }
    static Change change(JsonNode input) {
        if (!input.isObject() || input.size() != 3 || !input.path("status").isString() || !Set.of("reviewing", "resolved", "dismissed").contains(input.path("status").asString())
                || !input.path("version").isIntegralNumber() || !input.path("version").canConvertToInt() || input.path("version").intValue() < 0)
            throw new ProductProblem(400, "INVALID_REPORT_UPDATE", "신고 상태와 버전을 확인해 주세요.");
        if (!input.path("reviewNote").isString()) throw invalidNote();
        String status = input.path("status").asString(), note = input.path("reviewNote").asString().strip();
        if (Accounts.length(note) > 1000 || note.codePoints().anyMatch(c -> Character.isISOControl(c) && c != '\n' && c != '\r' && c != '\t')
                || (!status.equals("reviewing") && note.isBlank())) throw invalidNote();
        return new Change(status, note, input.path("version").intValue());
    }
    static UUID id(String value) { if (!value.matches("(?i)" + UUID_PATTERN)) throw new ProductProblem(400, "INVALID_REPORT_ID", "신고 주소를 확인해 주세요."); return UUID.fromString(value); }
    static String encode(OffsetDateTime at, UUID id) { return Base64.getUrlEncoder().withoutPadding().encodeToString((at.toInstant() + "|" + id).getBytes(StandardCharsets.UTF_8)); }
    static Cursor decode(String value) {
        if (value.isEmpty()) return null;
        try {
            if (!value.matches("[A-Za-z0-9_-]{1,200}")) throw new IllegalArgumentException();
            String decoded = new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
            if (!decoded.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z\\|" + UUID_PATTERN)) throw new IllegalArgumentException();
            String[] parts = decoded.split("\\|", 2);
            Instant at = Instant.parse(parts[0]);
            if (at.toEpochMilli() <= 0 || at.toEpochMilli() > 253402300799999L) throw new IllegalArgumentException();
            return new Cursor(at.atOffset(ZoneOffset.UTC), UUID.fromString(parts[1]));
        } catch (java.time.DateTimeException | IllegalArgumentException failure) { throw new ProductProblem(400, "INVALID_REPORT_CURSOR", "신고 목록을 새로 불러와 주세요."); }
    }
    private static ProductProblem invalidNote() { return new ProductProblem(400, "INVALID_REVIEW_NOTE", "처리 내용을 1,000자 이내로 입력해 주세요. 처리를 마칠 때는 내용이 필요해요."); }
    private static ProductProblem missing() { return new ProductProblem(404, "REPORT_NOT_FOUND", "신고를 찾을 수 없어요."); }
}
