package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ChannelReportController {
    private final ChannelReports reports;
    private final JsonMapper json;
    public ChannelReportController(ChannelReports reports, JsonMapper json) { this.reports = reports; this.json = json; }
    @PostMapping("/api/v1/channels/{channelId}/reports") public ResponseEntity<Object> receive(@PathVariable String channelId, HttpServletRequest request) {
        UUID reporter = AccountController.viewer();
        if (reporter == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요.");
        if (!channelId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw new ProductProblem(400, "INVALID_CHANNEL_ID", "채널 주소를 확인해 주세요.");
        return ResponseEntity.status(201).contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store")
                .body(reports.receive(reporter, UUID.fromString(channelId), ProductRequests.body(request, json)));
    }
}
