package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChatBotController {
    private final ChatBot bot;
    private final JsonMapper json;
    public ChatBotController(ChatBot bot,JsonMapper json) { this.bot=bot;this.json=json; }
    @GetMapping("/api/v1/me/chat/bot") public ResponseEntity<Object> settings(HttpServletRequest request) { return ok(bot.settings(owner(request))); }
    @PatchMapping("/api/v1/me/chat/bot") public ResponseEntity<Object> update(HttpServletRequest request) { UUID user=owner(request);return ok(bot.update(user,ProductRequests.body(request,json,65536))); }
    private static UUID owner(HttpServletRequest request) {
        UUID user=AccountController.viewer();
        if(user==null) throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");
        String expected=request.getHeader("X-FRAME-USER-ID");
        if(expected!=null&&!expected.equalsIgnoreCase(user.toString())) throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");
        return user;
    }
    private static ResponseEntity<Object> ok(Object value) { return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control","private, no-store").body(value); }
}
