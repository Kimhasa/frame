package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

/** Deliberately separate from account APIs: every route requires a bearer key and its explicit scope. */
@RestController
@RequestMapping("/api/v1/integrations")
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class IntegrationController {
    static final String ACCESS="frame.integration.access";
    private final JdbcClient sql;private final BroadcastRegistry registry;private final MediaMtxPaths media;private final ChannelAnalytics analytics;private final ChatModeration moderation;private final JsonMapper json;
    public IntegrationController(JdbcClient sql,BroadcastRegistry registry,MediaMtxPaths media,ChannelAnalytics analytics,ChatModeration moderation,JsonMapper json){this.sql=sql;this.registry=registry;this.media=media;this.analytics=analytics;this.moderation=moderation;this.json=json;}
    @GetMapping("/broadcast") public ResponseEntity<Object> broadcast(HttpServletRequest request){
        UUID owner=access(request,"broadcast:read");var channel=sql.sql("SELECT id,handle,display_name,stream_path FROM product_channels WHERE owner_id=:owner").param("owner",owner)
                .query((r,i)->new Object[]{r.getObject("id",UUID.class),r.getString("handle"),r.getString("display_name"),r.getString("stream_path")}).optional().orElseThrow(DeveloperSettings::unauthorized);
        var result=new LinkedHashMap<String,Object>();result.put("channel",Map.of("id",channel[0],"handle",channel[1],"displayName",channel[2]));result.put("broadcast",null);
        String path=(String)channel[3];Broadcast live=path==null?null:registry.byPath(path);
        if(live!=null){Map<String,MediaPath> paths=media.list();MediaPath source=paths.get(path);if(ProductNotifications.fresh(media)&&AnalyticsCollector.observed(live,source)&&registry.get(live.id)==live)result.put("broadcast",Map.of("id",live.id,"title",live.title,"startedAtMs",live.startedAtRelayMs));}
        return ok(result);
    }
    @GetMapping("/analytics") public ResponseEntity<Object> analytics(HttpServletRequest request){UUID owner=access(request,"analytics:read");var page=analytics.list(owner,"30","","","","",1);return ok(Map.of("periodDays",page.periodDays(),"fromDate",page.fromDate(),"toDate",page.toDate(),"serverNowMs",page.serverNowMs(),"summary",page.summary()));}
    @GetMapping("/chat/settings") public ResponseEntity<Object> chat(HttpServletRequest request){return ok(moderation.settings(access(request,"chat:manage")));}
    @PatchMapping("/chat/settings") public ResponseEntity<Object> chatUpdate(HttpServletRequest request){UUID owner=access(request,"chat:manage");return ok(moderation.update(owner,ProductRequests.body(request,json,16384)));}
    private static UUID access(HttpServletRequest request,String scope){if(!(request.getAttribute(ACCESS) instanceof DeveloperSettings.Access access))throw DeveloperSettings.unauthorized();if(!access.scopes().contains(scope))throw new ProductProblem(403,"API_SCOPE_REQUIRED","이 API에 필요한 권한이 없어요.");return access.ownerId();}
    private static ResponseEntity<Object> ok(Object value){return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control","private, no-store").body(value);}
}
