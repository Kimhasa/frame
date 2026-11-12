package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ScheduleController {
    private final ScheduledBroadcasts schedules;
    private final JsonMapper json;
    public ScheduleController(ScheduledBroadcasts schedules, JsonMapper json) { this.schedules = schedules; this.json = json; }
    @GetMapping("/api/v1/me/schedules") public ResponseEntity<Object> own() { return ok(200, Map.of("items", schedules.own(owner()))); }
    @PostMapping("/api/v1/me/schedules") public ResponseEntity<Object> create(HttpServletRequest request) { return ok(201, schedules.create(owner(), ProductRequests.body(request, json))); }
    @PatchMapping("/api/v1/me/schedules/{id}") public ResponseEntity<Object> update(@PathVariable String id, HttpServletRequest request) { return ok(200, schedules.update(owner(), id(id), ProductRequests.body(request, json))); }
    @DeleteMapping("/api/v1/me/schedules/{id}") public ResponseEntity<Object> cancel(@PathVariable String id) { schedules.cancel(owner(), id(id)); return ResponseEntity.noContent().header("Cache-Control", "no-store").build(); }
    @GetMapping("/api/v1/channels/{handle}/schedule") public ResponseEntity<Object> upcoming(@PathVariable String handle) { return ok(200, Map.of("items", schedules.upcoming(handle))); }
    private static UUID owner() { UUID owner = AccountController.viewer(); if (owner == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요."); return owner; }
    private static UUID id(String value) { try { return UUID.fromString(value); } catch (IllegalArgumentException failure) { throw new ProductProblem(400, "INVALID_SCHEDULE_ID", "예약 주소를 확인해 주세요."); } }
    private static ResponseEntity<Object> ok(int status, Object value) { return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store").body(value); }
}
