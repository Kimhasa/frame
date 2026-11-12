package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class HistoryController {
    private final WatchHistory history;
    private final JsonMapper json;
    public HistoryController(WatchHistory history, JsonMapper json) { this.history = history; this.json = json; }
    @PostMapping("/api/v1/me/history") public ResponseEntity<Object> record(HttpServletRequest request) { history.record(owner(), ProductRequests.body(request, json)); return empty(); }
    @GetMapping("/api/v1/me/history") public ResponseEntity<Object> list(@RequestParam(defaultValue = "all") String kind, @RequestParam(defaultValue = "") String q,
            @RequestParam(defaultValue = "") String from, @RequestParam(defaultValue = "") String to, @RequestParam(defaultValue = "") String cursor, @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store").body(history.list(owner(), kind, q, from, to, cursor, limit));
    }
    @DeleteMapping("/api/v1/me/history/{id}") public ResponseEntity<Object> remove(@PathVariable String id) { history.remove(owner(), WatchHistory.id(id)); return empty(); }
    @PostMapping("/api/v1/me/history/delete") public ResponseEntity<Object> removeMany(HttpServletRequest request) { history.removeMany(owner(), ProductRequests.body(request, json)); return empty(); }
    @DeleteMapping("/api/v1/me/history") public ResponseEntity<Object> clear() { history.removeAll(owner()); return empty(); }
    private static UUID owner() { UUID owner = AccountController.viewer(); if (owner == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요."); return owner; }
    private static ResponseEntity<Object> empty() { return ResponseEntity.noContent().header("Cache-Control", "no-store").build(); }
}
