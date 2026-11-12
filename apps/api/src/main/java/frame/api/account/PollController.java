package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class PollController {
    private final ChannelPolls polls;private final JsonMapper json;
    public PollController(ChannelPolls polls,JsonMapper json){this.polls=polls;this.json=json;}
    @GetMapping("/api/v1/me/polls") public ResponseEntity<Object> list(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String from,@RequestParam(defaultValue="")String to,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="50")String limit){UUID user=viewer(request,true);int count;try{count=Integer.parseInt(limit);}catch(NumberFormatException failure){throw new ProductProblem(400,"INVALID_POLL_FILTER","투표 검색 조건을 확인해 주세요.");}return ok(200,polls.list(user,status,q,from,to,cursor,count));}
    @GetMapping("/api/v1/me/polls/{id}") public ResponseEntity<Object> detail(HttpServletRequest request,@PathVariable String id){return ok(200,polls.detail(viewer(request,true),id));}
    @PostMapping("/api/v1/me/polls") public ResponseEntity<Object> create(HttpServletRequest request){UUID user=viewer(request,true);return ok(201,polls.create(user,ProductRequests.body(request,json)));}
    @PostMapping("/api/v1/me/polls/{id}/close") public ResponseEntity<Object> close(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);return ok(200,polls.close(user,id,ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/polls/current") public ResponseEntity<Object> current(HttpServletRequest request,@RequestParam String path,@RequestParam String broadcastId){return ok(200,polls.current(viewer(request,false),path,broadcastId));}
    @PostMapping("/api/v1/polls/{id}/votes") public ResponseEntity<Object> vote(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);return ok(200,polls.vote(user,id,ProductRequests.body(request,json)));}
    private static UUID viewer(HttpServletRequest request,boolean required){UUID user=AccountController.viewer();if(required&&user==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&(user==null||!expected.equalsIgnoreCase(user.toString())))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return user;}
    private static ResponseEntity<Object> ok(int status,Object value){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").body(value);}
}
