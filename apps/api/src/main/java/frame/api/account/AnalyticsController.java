package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class AnalyticsController {
    private final ChannelAnalytics analytics;
    public AnalyticsController(ChannelAnalytics analytics){this.analytics=analytics;}
    @GetMapping("/api/v1/me/analytics") public ResponseEntity<Object> list(HttpServletRequest request,
            @RequestParam(defaultValue="7") String period,@RequestParam(defaultValue="") String q,
            @RequestParam(defaultValue="") String from,@RequestParam(defaultValue="") String to,
            @RequestParam(defaultValue="") String cursor,@RequestParam(defaultValue="20") int limit){
        UUID owner=AccountController.viewer();
        if(owner==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");
        String expected=request.getHeader("X-FRAME-USER-ID");
        if(expected!=null&&!expected.equalsIgnoreCase(owner.toString()))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store")
                .header("X-FRAME-USER-ID",owner.toString()).body(analytics.list(owner,period,q,from,to,cursor,limit));
    }
}
