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
public class QuestionController {
    private final ChannelQuestions questions;private final JsonMapper json;
    public QuestionController(ChannelQuestions questions,JsonMapper json){this.questions=questions;this.json=json;}
    @GetMapping("/api/v1/me/questions") public ResponseEntity<Object> list(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String from,@RequestParam(defaultValue="")String to,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="50")String limit){UUID user=viewer(request,true);return ok(200,questions.list(user,status,q,from,to,cursor,limit(limit)));}
    @GetMapping("/api/v1/me/questions/{id}") public ResponseEntity<Object> detail(HttpServletRequest request,@PathVariable String id){return ok(200,questions.detail(viewer(request,true),id));}
    @PatchMapping("/api/v1/me/questions/{id}") public ResponseEntity<Object> update(HttpServletRequest request,@PathVariable String id){UUID user=viewer(request,true);return ok(200,questions.update(user,id,ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/questions/current") public ResponseEntity<Object> current(HttpServletRequest request,@RequestParam String path,@RequestParam String broadcastId,@RequestParam(defaultValue="20")String limit,@RequestParam(defaultValue="")String cursor){return ok(200,questions.current(viewer(request,false),path,broadcastId,cursor,limit(limit)));}
    @PostMapping("/api/v1/questions") public ResponseEntity<Object> submit(HttpServletRequest request){UUID user=viewer(request,true);var saved=questions.submit(user,ProductRequests.body(request,json));return ok(saved.created()?201:200,saved.result());}
    private static int limit(String value){try{return Integer.parseInt(value);}catch(NumberFormatException failure){throw ChannelQuestions.filter();}}
    private static UUID viewer(HttpServletRequest request,boolean required){UUID user=AccountController.viewer();if(required&&user==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&(user==null||!expected.equalsIgnoreCase(user.toString())))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return user;}
    private static ResponseEntity<Object> ok(int status,Object value){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").body(value);}
}
