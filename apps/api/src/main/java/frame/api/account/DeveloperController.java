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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@RequestMapping("/api/v1/me/developer")
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class DeveloperController {
    private final DeveloperSettings settings;private final JsonMapper json;
    public DeveloperController(DeveloperSettings settings,JsonMapper json){this.settings=settings;this.json=json;}
    @GetMapping("/keys") public ResponseEntity<Object> keys(HttpServletRequest request){return ok(200,settings.keys(owner(request)));}
    @PostMapping("/keys") public ResponseEntity<Object> issueKey(HttpServletRequest request){return ok(201,settings.issueKey(owner(request),ProductRequests.body(request,json)));}
    @GetMapping("/keys/receipts/{requestId}") public ResponseEntity<Object> keyReceipt(HttpServletRequest request,@PathVariable String requestId){return ok(200,settings.keyReceipt(owner(request),DeveloperSettings.id(requestId)));}
    @DeleteMapping("/keys/{id}") public ResponseEntity<Object> revokeKey(HttpServletRequest request,@PathVariable String id,@RequestParam String version,@RequestParam String requestId){return ok(200,settings.revokeKey(owner(request),DeveloperSettings.id(id),version(version),DeveloperSettings.id(requestId)));}
    @GetMapping("/keys/{id}/mutations/{requestId}") public ResponseEntity<Object> keyMutation(HttpServletRequest request,@PathVariable String id,@PathVariable String requestId){return ok(200,settings.mutationReceipt(owner(request),"key",DeveloperSettings.id(id),DeveloperSettings.id(requestId)));}
    @GetMapping("/webhooks") public ResponseEntity<Object> webhooks(HttpServletRequest request){return ok(200,settings.webhooks(owner(request)));}
    @PostMapping("/webhooks") public ResponseEntity<Object> issueWebhook(HttpServletRequest request){return ok(201,settings.issueWebhook(owner(request),ProductRequests.body(request,json)));}
    @GetMapping("/webhooks/receipts/{requestId}") public ResponseEntity<Object> webhookReceipt(HttpServletRequest request,@PathVariable String requestId){return ok(200,settings.webhookReceipt(owner(request),DeveloperSettings.id(requestId)));}
    @PatchMapping("/webhooks/{id}") public ResponseEntity<Object> updateWebhook(HttpServletRequest request,@PathVariable String id){return ok(200,settings.updateWebhook(owner(request),DeveloperSettings.id(id),ProductRequests.body(request,json)));}
    @DeleteMapping("/webhooks/{id}") public ResponseEntity<Object> revokeWebhook(HttpServletRequest request,@PathVariable String id,@RequestParam String version,@RequestParam String requestId){return ok(200,settings.revokeWebhook(owner(request),DeveloperSettings.id(id),version(version),DeveloperSettings.id(requestId)));}
    @GetMapping("/webhooks/{id}/mutations/{requestId}") public ResponseEntity<Object> webhookMutation(HttpServletRequest request,@PathVariable String id,@PathVariable String requestId){return ok(200,settings.mutationReceipt(owner(request),"webhook",DeveloperSettings.id(id),DeveloperSettings.id(requestId)));}
    @PostMapping("/webhooks/{id}/tests") public ResponseEntity<Object> test(HttpServletRequest request,@PathVariable String id){return ok(202,settings.test(owner(request),DeveloperSettings.id(id),ProductRequests.body(request,json)));}
    @GetMapping("/webhooks/{id}/tests/{requestId}") public ResponseEntity<Object> testReceipt(HttpServletRequest request,@PathVariable String id,@PathVariable String requestId){return ok(200,settings.testReceipt(owner(request),DeveloperSettings.id(id),DeveloperSettings.id(requestId)));}
    @GetMapping("/webhooks/{id}/deliveries") public ResponseEntity<Object> deliveries(HttpServletRequest request,@PathVariable String id){return ok(200,settings.deliveries(owner(request),DeveloperSettings.id(id)));}
    private static int version(String value){try{int version=Integer.parseInt(value);if(version<1)throw DeveloperSettings.invalid();return version;}catch(NumberFormatException failure){throw DeveloperSettings.invalid();}}
    private static UUID owner(HttpServletRequest request){
        UUID owner=AccountController.viewer();if(owner==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");
        String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&!expected.equalsIgnoreCase(owner.toString()))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return owner;
    }
    private static ResponseEntity<Object> ok(int status,Object value){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","private, no-store").body(value);}
}
