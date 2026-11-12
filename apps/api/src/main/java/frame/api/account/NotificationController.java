package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class NotificationController {
    private final ProductNotifications notifications;
    public NotificationController(ProductNotifications notifications) { this.notifications = notifications; }
    @GetMapping("/api/v1/me/notifications") public ResponseEntity<Object> list(HttpServletRequest request, @RequestParam(defaultValue = "all") String filter, @RequestParam(defaultValue = "all") String kind,
            @RequestParam(defaultValue = "") String cursor, @RequestParam(defaultValue = "50") String limit) {
        UUID recipient = owner(request); int count;
        try { count = Integer.parseInt(limit); } catch (NumberFormatException failure) { throw new ProductProblem(400, "INVALID_NOTIFICATION_FILTER", "알림 검색 조건을 확인해 주세요."); }
        return ok(notifications.list(recipient, filter, kind, cursor, count));
    }
    @GetMapping("/api/v1/me/notifications/unread-count") public ResponseEntity<Object> count(HttpServletRequest request) { return ok(notifications.count(owner(request))); }
    @PatchMapping("/api/v1/me/notifications/{id}/read") public ResponseEntity<Object> read(HttpServletRequest request, @PathVariable String id) { return ok(notifications.read(owner(request), id)); }
    @PostMapping("/api/v1/me/notifications/read-all") public ResponseEntity<Object> readAll(HttpServletRequest request) { return ok(notifications.readAll(owner(request))); }
    @DeleteMapping("/api/v1/me/notifications/{id}") public ResponseEntity<Object> remove(HttpServletRequest request, @PathVariable String id) { return ok(notifications.remove(owner(request), id)); }
    @DeleteMapping("/api/v1/me/notifications") public ResponseEntity<Object> clear(HttpServletRequest request) { return ok(notifications.clear(owner(request))); }
    private static UUID owner(HttpServletRequest request) {
        UUID owner = AccountController.viewer(); if (owner == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요.");
        String expected = request.getHeader("X-FRAME-USER-ID");
        if (expected != null && !expected.equalsIgnoreCase(owner.toString())) throw new ProductProblem(409, "SESSION_CHANGED", "로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");
        return owner;
    }
    private static ResponseEntity<Object> ok(Object value) { return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store").body(value); }
}
