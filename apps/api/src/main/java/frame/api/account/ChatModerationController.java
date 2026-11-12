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
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChatModerationController {
    private final ChatModeration moderation;private final ChatTickets tickets;private final JsonMapper json;
    public ChatModerationController(ChatModeration moderation,ChatTickets tickets,JsonMapper json){this.moderation=moderation;this.tickets=tickets;this.json=json;}
    @GetMapping("/api/v1/me/chat/settings") public ResponseEntity<Object> settings(HttpServletRequest request){return ok(200,moderation.settings(owner(request)));}
    @PatchMapping("/api/v1/me/chat/settings") public ResponseEntity<Object> updateSettings(HttpServletRequest request){UUID user=owner(request);return ok(200,moderation.update(user,ProductRequests.body(request,json,16384)));}
    @GetMapping("/api/v1/me/chat/blocks") public ResponseEntity<Object> blocks(HttpServletRequest request,@RequestParam(defaultValue="active")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="50")String limit){UUID user=owner(request);return ok(200,moderation.blocks(user,status,q,cursor,number(limit)));}
    @PostMapping("/api/v1/me/chat/blocks") public ResponseEntity<Object> create(HttpServletRequest request){UUID user=owner(request);return ok(201,moderation.create(user,ProductRequests.body(request,json)));}
    @DeleteMapping("/api/v1/me/chat/blocks/{id}") public ResponseEntity<Object> remove(HttpServletRequest request,@PathVariable String id,@RequestParam(defaultValue="-1")String version){return ok(200,moderation.remove(owner(request),id,number(version)));}
    @PostMapping("/api/v1/chat/tickets") public ResponseEntity<Object> ticket(HttpServletRequest request){UUID user=owner(request);return ok(200,tickets.issue(user,request,ProductRequests.body(request,json)));}
    private static int number(String value){try{return Integer.parseInt(value);}catch(NumberFormatException failure){throw ChatModeration.invalid();}}
    private static UUID owner(HttpServletRequest request){UUID user=AccountController.viewer();if(user==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&!expected.equalsIgnoreCase(user.toString()))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return user;}
    private static ResponseEntity<Object> ok(int status,Object value){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").body(value);}
}
