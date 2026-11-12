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
public class RewardController {
    private final ChannelRewards rewards;private final ChannelPoints points;private final JsonMapper json;
    public RewardController(ChannelRewards rewards,ChannelPoints points,JsonMapper json){this.rewards=rewards;this.points=points;this.json=json;}
    @GetMapping("/api/v1/me/rewards") public ResponseEntity<Object> list(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String from,@RequestParam(defaultValue="")String to,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="50")String limit){UUID user=viewer(request,true);return ok(200,rewards.rewards(user,status,q,from,to,cursor,limit(limit)));}
    @GetMapping("/api/v1/me/rewards/{id}") public ResponseEntity<Object> reward(HttpServletRequest request,@PathVariable String id){return ok(200,rewards.reward(viewer(request,true),id));}
    @PostMapping("/api/v1/me/rewards") public ResponseEntity<Object> create(HttpServletRequest request){UUID user=viewer(request,true);var saved=rewards.create(user,ProductRequests.body(request,json));return ok(saved.created()?201:200,saved.result());}
    @PatchMapping("/api/v1/me/rewards/{id}") public ResponseEntity<Object> edit(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);return ok(200,rewards.update(user,id,ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/rewards/current") public ResponseEntity<Object> current(HttpServletRequest request,@RequestParam String path,@RequestParam String broadcastId,@RequestParam(defaultValue="20")String limit,@RequestParam(defaultValue="")String cursor){UUID user=viewer(request,false);return ok(200,rewards.current(user,path,broadcastId,cursor,limit(limit)));}
    @PostMapping("/api/v1/rewards/{id}/redemptions") public ResponseEntity<Object> redeem(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);var saved=rewards.redeem(user,id,ProductRequests.body(request,json));return ok(saved.created()?201:200,saved.result());}
    @GetMapping("/api/v1/me/redemptions") public ResponseEntity<Object> redemptions(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String from,@RequestParam(defaultValue="")String to,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="50")String limit){UUID user=viewer(request,true);return ok(200,rewards.redemptions(user,status,q,from,to,cursor,limit(limit)));}
    @GetMapping("/api/v1/me/redemptions/{id}") public ResponseEntity<Object> redemption(HttpServletRequest request,@PathVariable String id){return ok(200,rewards.redemption(viewer(request,true),id));}
    @PatchMapping("/api/v1/me/redemptions/{id}") public ResponseEntity<Object> review(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);return ok(200,rewards.review(user,id,ProductRequests.body(request,json)));}
    @PostMapping("/api/v1/redemptions/{id}/cancel") public ResponseEntity<Object> cancel(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);return ok(200,rewards.cancel(user,id,ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/me/points") public ResponseEntity<Object> points(HttpServletRequest request,@RequestParam String channelId,@RequestParam(defaultValue="50")String limit,@RequestParam(defaultValue="")String cursor){UUID user=viewer(request,true);return ok(200,points.ledger(user,channelId,cursor,limit(limit)));}
    @PostMapping("/api/v1/points/watch") public ResponseEntity<Object> watch(HttpServletRequest request){UUID user=viewer(request,true);return ok(200,points.watch(user,ProductRequests.body(request,json),request));}
    private static int limit(String value){try{return Integer.parseInt(value);}catch(NumberFormatException failure){throw ChannelRewards.filter();}}
    private static UUID viewer(HttpServletRequest request,boolean required){UUID user=AccountController.viewer();if(required&&user==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&(user==null||!expected.equalsIgnoreCase(user.toString())))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return user;}
    private static ResponseEntity<Object> ok(int status,Object value){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").body(value);}
}
