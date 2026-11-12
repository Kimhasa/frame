package frame.api.account;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ChannelReports {
    public record Receipt(UUID id, String status, long createdAtMs) {}
    record Draft(String reason, String details) {}
    private static final Set<String> REASONS = Set.of("spam", "impersonation", "harassment", "inappropriate", "other");
    private final JdbcClient sql;
    public ChannelReports(JdbcClient sql) { this.sql = sql; }
    @Transactional public Receipt receive(UUID reporter, UUID channel, JsonNode input) {
        Draft draft = validate(input);
        // One owner row serializes the time-window checks and insert, including concurrent requests after restart.
        if (sql.sql("SELECT id FROM product_accounts WHERE id=:reporter FOR UPDATE").param("reporter", reporter).query(UUID.class).optional().isEmpty()) throw new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요.");
        UUID owner = sql.sql("SELECT owner_id FROM product_channels WHERE id=:channel").param("channel", channel).query(UUID.class).optional()
                .orElseThrow(() -> new ProductProblem(404, "CHANNEL_NOT_FOUND", "채널을 찾을 수 없어요."));
        if (owner.equals(reporter)) throw new ProductProblem(400, "SELF_REPORT_NOT_ALLOWED", "내 채널은 신고할 수 없어요.");
        long now = System.currentTimeMillis();
        if (sql.sql("SELECT EXISTS(SELECT 1 FROM product_channel_reports WHERE reporter_id=:reporter AND channel_id=:channel AND reason=:reason AND created_at>:since)")
                .param("reporter", reporter).param("channel", channel).param("reason", draft.reason()).param("since", time(now - 86_400_000L)).query(Boolean.class).single())
            throw new ProductProblem(409, "REPORT_ALREADY_RECEIVED", "같은 사유의 신고가 이미 접수됐어요.");
        if (sql.sql("SELECT count(*) FROM product_channel_reports WHERE reporter_id=:reporter AND created_at>:since").param("reporter", reporter).param("since", time(now - 60_000L)).query(Integer.class).single() >= 5)
            throw new ProductProblem(429, "REPORT_RATE_LIMITED", "잠시 후 다시 신고해 주세요.", 60);
        UUID id = UUID.randomUUID();
        sql.sql("INSERT INTO product_channel_reports(id,channel_id,reporter_id,reason,details,created_at,updated_at) VALUES(:id,:channel,:reporter,:reason,:details,:at,:at)")
                .param("id", id).param("channel", channel).param("reporter", reporter).param("reason", draft.reason()).param("details", draft.details()).param("at", time(now)).update();
        return new Receipt(id, "received", now);
    }
    static Draft validate(JsonNode input) {
        if (!input.isObject() || !input.path("reason").isString() || !REASONS.contains(input.path("reason").asString())
                || input.size() != (input.has("details") ? 2 : 1)) throw new ProductProblem(400, "INVALID_REPORT_REASON", "신고 사유를 선택해 주세요.");
        if (input.has("details") && !input.path("details").isString()) throw invalidDetails();
        String details = input.has("details") ? input.path("details").asString().strip() : "";
        if (Accounts.length(details) > 1000 || details.codePoints().anyMatch(c -> Character.isISOControl(c) && c != '\n' && c != '\r' && c != '\t')
                || (input.path("reason").asString().equals("other") && details.isBlank())) throw invalidDetails();
        return new Draft(input.path("reason").asString(), details);
    }
    private static OffsetDateTime time(long at) { return OffsetDateTime.ofInstant(Instant.ofEpochMilli(at), ZoneOffset.UTC); }
    private static ProductProblem invalidDetails() { return new ProductProblem(400, "INVALID_REPORT_DETAILS", "신고 내용을 1,000자 이내로 입력해 주세요. 기타 사유에는 내용이 필요해요."); }
}
