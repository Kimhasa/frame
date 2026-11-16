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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class HistoryController {
    private final WatchHistory history;
    private final JsonMapper json;
    public HistoryController(WatchHistory history, JsonMapper json) { this.history = history; this.json = json; }
    @PostMapping("/api/v1/me/history") public ResponseEntity<Object> record(HttpServletRequest request) { history.record(owner(request), ProductRequests.body(request, json)); return empty(); }
    @GetMapping("/api/v1/me/history") public ResponseEntity<Object> list(HttpServletRequest request, @RequestParam(defaultValue = "all") String kind, @RequestParam(defaultValue = "") String q,
            @RequestParam(defaultValue = "") String from, @RequestParam(defaultValue = "") String to, @RequestParam(defaultValue = "") String cursor, @RequestParam(defaultValue = "50") int limit) {
        return ok(history.list(owner(request), kind, q, from, to, cursor, limit));
    }
    @GetMapping("/api/v1/me/history/media/{kind}/{mediaId}") public ResponseEntity<Object> media(HttpServletRequest request, @PathVariable String kind, @PathVariable String mediaId) {
        return ok(history.media(owner(request), kind, WatchHistory.id(mediaId)));
    }
    @PutMapping("/api/v1/me/history/media/{kind}/{mediaId}") public ResponseEntity<Object> progress(HttpServletRequest request, @PathVariable String kind, @PathVariable String mediaId) {
        UUID owner = owner(request);
        return ok(history.progress(owner, kind, WatchHistory.id(mediaId), ProductRequests.body(request, json)));
    }
    @DeleteMapping("/api/v1/me/history/{id}") public ResponseEntity<Object> remove(HttpServletRequest request, @PathVariable String id) { history.remove(owner(request), WatchHistory.id(id)); return empty(); }
    @PostMapping("/api/v1/me/history/delete") public ResponseEntity<Object> removeMany(HttpServletRequest request) { history.removeMany(owner(request), ProductRequests.body(request, json)); return empty(); }
    @DeleteMapping("/api/v1/me/history") public ResponseEntity<Object> clear(HttpServletRequest request) { history.removeAll(owner(request)); return empty(); }
    private static UUID owner(HttpServletRequest request) {
        UUID owner = AccountController.viewer();
        if (owner == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요.");
        String expected = request.getHeader("X-FRAME-USER-ID");
        if (expected != null && !owner.toString().equalsIgnoreCase(expected)) throw new ProductProblem(409, "SESSION_CHANGED", "로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");
        return owner;
    }
    private static ResponseEntity<Object> ok(Object value) { return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store").body(value); }
    private static ResponseEntity<Object> empty() { return ResponseEntity.noContent().header("Cache-Control", "no-store").build(); }
}
