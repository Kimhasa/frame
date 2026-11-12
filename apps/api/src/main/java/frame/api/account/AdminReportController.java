package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class AdminReportController {
    private final ReportManagement reports;
    private final JsonMapper json;
    public AdminReportController(ReportManagement reports, JsonMapper json) { this.reports = reports; this.json = json; }
    @GetMapping("/api/v1/admin/reports") public ResponseEntity<Object> list(@RequestParam(defaultValue = "all") String status, @RequestParam(defaultValue = "all") String reason,
            @RequestParam(defaultValue = "") String q, @RequestParam(defaultValue = "") String cursor, @RequestParam(defaultValue = "50") String limit) {
        UUID operator = AccountController.viewer(); reports.requireOperator(operator);
        int count;
        try { count = Integer.parseInt(limit); } catch (NumberFormatException failure) { throw new ProductProblem(400, "INVALID_REPORT_FILTER", "신고 검색 조건을 확인해 주세요."); }
        return ok(reports.list(operator, status, reason, q, cursor, count));
    }
    @GetMapping("/api/v1/admin/reports/{id}") public ResponseEntity<Object> detail(@PathVariable String id) { return ok(reports.detail(AccountController.viewer(), id)); }
    @PatchMapping("/api/v1/admin/reports/{id}") public ResponseEntity<Object> update(@PathVariable String id, HttpServletRequest request) {
        UUID operator = AccountController.viewer();
        reports.requireOperator(operator); // Reject non-operators before parsing or describing a private request.
        return ok(reports.update(operator, id, ProductRequests.body(request, json)));
    }
    private static ResponseEntity<Object> ok(Object value) { return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store").body(value); }
}
