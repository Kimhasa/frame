package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class MembershipController {
    private final Memberships memberships;private final JsonMapper json;
    public MembershipController(Memberships memberships,JsonMapper json){this.memberships=memberships;this.json=json;}
    @GetMapping("/api/v1/me/membership/plan") public ResponseEntity<Object> plan(HttpServletRequest request){return ok(200,memberships.plan(owner(request)));}
    @PatchMapping("/api/v1/me/membership/plan") public ResponseEntity<Object> planUpdate(HttpServletRequest request){return ok(200,memberships.updatePlan(owner(request),ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/me/membership/plan/requests/{requestId}") public ResponseEntity<Object> planReceipt(HttpServletRequest request,@PathVariable String requestId){return ok(200,memberships.planReceipt(owner(request),Memberships.id(requestId)));}
    @GetMapping("/api/v1/channels/{channelId}/membership") public ResponseEntity<Object> channel(HttpServletRequest request,@PathVariable String channelId){return ok(200,memberships.channel(Memberships.id(channelId),viewer(request)));}
    @GetMapping("/api/v1/me/membership/members") public ResponseEntity<Object> members(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String from,@RequestParam(defaultValue="")String to,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="20")String limit){return ok(200,memberships.members(owner(request),status,q,from,to,cursor,limit(limit)));}
    @GetMapping("/api/v1/me/membership/members/{id}") public ResponseEntity<Object> member(HttpServletRequest request,@PathVariable String id){return ok(200,memberships.member(owner(request),Memberships.id(id)));}
    @GetMapping("/api/v1/me/memberships") public ResponseEntity<Object> mine(HttpServletRequest request){return ok(200,memberships.mine(owner(request)));}
    @PostMapping("/api/v1/me/memberships") public ResponseEntity<Object> create(HttpServletRequest request){Memberships.Signup created=memberships.create(owner(request),ProductRequests.body(request,json));return ok(created.status(),created.body());}
    @GetMapping("/api/v1/me/memberships/requests/{requestId}") public ResponseEntity<Object> signupReceipt(HttpServletRequest request,@PathVariable String requestId){return ok(200,memberships.signupReceipt(owner(request),Memberships.id(requestId)));}
    @GetMapping("/api/v1/me/memberships/{id}") public ResponseEntity<Object> detail(HttpServletRequest request,@PathVariable String id){return ok(200,memberships.detail(owner(request),Memberships.id(id)));}
    @PostMapping("/api/v1/me/memberships/{id}/authorize") public ResponseEntity<Object> authorize(HttpServletRequest request,@PathVariable String id){return ok(202,memberships.authorize(owner(request),Memberships.id(id),ProductRequests.body(request,json)));}
    @PostMapping("/api/v1/me/memberships/{id}/cancel") public ResponseEntity<Object> cancel(HttpServletRequest request,@PathVariable String id){return ok(200,memberships.cancel(owner(request),Memberships.id(id),ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/me/memberships/{id}/requests/{requestId}") public ResponseEntity<Object> cancelReceipt(HttpServletRequest request,@PathVariable String id,@PathVariable String requestId){return ok(200,memberships.cancelReceipt(owner(request),Memberships.id(id),Memberships.id(requestId)));}
    @GetMapping("/api/v1/me/memberships/{id}/payments") public ResponseEntity<Object> payments(HttpServletRequest request,@PathVariable String id){return ok(200,memberships.payments(owner(request),Memberships.id(id)));}
    @PostMapping("/api/v1/me/memberships/{id}/reconcile") public ResponseEntity<Object> reconcile(HttpServletRequest request,@PathVariable String id){return ok(200,memberships.reconcile(owner(request),Memberships.id(id),ProductRequests.body(request,json)));}
    private static int limit(String value){try{return Integer.parseInt(value);}catch(NumberFormatException error){throw Memberships.invalid();}}
    private static UUID owner(HttpServletRequest request){UUID user=viewer(request);if(user==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");return user;}
    private static UUID viewer(HttpServletRequest request){UUID user=AccountController.viewer();String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&(user==null||!expected.equalsIgnoreCase(user.toString())))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return user;}
    private static ResponseEntity<Object> ok(int status,Object value){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","private, no-store").body(value);}
}
