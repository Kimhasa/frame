package frame.api.account;

import frame.api.web.ClientAddress;
import frame.api.web.RateLimit;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.NoSuchFileException;
import java.util.HashMap;
import java.util.Map;
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
public class VodController {
    private final ProductVods vods;
    private final VodFiles files;
    private final JsonMapper json;
    private final ClientAddress clients;
    private final RateLimit publishRate=new RateLimit(8,0.25),mediaRate=new RateLimit(80,10);
    private final Map<String,Integer> streams=new HashMap<>();
    private int total;
    public VodController(ProductVods vods,VodFiles files,JsonMapper json,ClientAddress clients){this.vods=vods;this.files=files;this.json=json;this.clients=clients;}
    @GetMapping("/api/v1/vods") public ResponseEntity<Object> list(@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String channel,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="20")String limit){return ok(200,vods.publicList(q,channel,cursor,limit(limit)));}
    @GetMapping("/api/v1/vods/{id}") public ResponseEntity<Object> detail(@PathVariable String id){return ok(200,vods.publicDetail(ProductVods.id(id)));}
    @GetMapping("/api/v1/me/vods") public ResponseEntity<Object> ownList(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="20")String limit){return ok(200,vods.ownList(owner(request),status,q,cursor,limit(limit)));}
    @GetMapping("/api/v1/me/vods/by-recording/{recordingId}") public ResponseEntity<Object> byRecording(HttpServletRequest request,@PathVariable String recordingId){return ok(200,vods.ownRecording(owner(request),ProductVods.id(recordingId)));}
    @GetMapping("/api/v1/me/vods/{id}") public ResponseEntity<Object> own(HttpServletRequest request,@PathVariable String id){return ok(200,vods.own(owner(request),ProductVods.id(id)));}
    @PostMapping("/api/v1/me/vods") public ResponseEntity<Object> publish(HttpServletRequest request){UUID owner=owner(request);limited(publishRate,owner.toString());var result=vods.prepare(owner,ProductRequests.body(request,json));return ok(result.created()?202:200,result.result());}
    @PatchMapping("/api/v1/me/vods/{id}") public ResponseEntity<Object> edit(HttpServletRequest request,@PathVariable String id){return ok(200,vods.edit(owner(request),ProductVods.id(id),ProductRequests.body(request,json)));}
    @PostMapping("/api/v1/me/vods/{id}/retry") public ResponseEntity<Object> retry(HttpServletRequest request,@PathVariable String id){UUID owner=owner(request);limited(publishRate,owner.toString());return ok(202,vods.retry(owner,ProductVods.id(id),ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/vods/{id}/media") public void media(HttpServletRequest request,HttpServletResponse response,@PathVariable String id)throws IOException{
        String ip=clients.ip(request);limited(mediaRate,ip);
        var asset=vods.publicAsset(ProductVods.id(id)); // The read transaction ends before opening or streaming the file.
        if(!enter(ip))throw new ProductProblem(503,"VOD_STREAM_BUSY","다른 영상 전송이 끝나면 다시 시도해 주세요.",2);
        try(var channel=files.open(asset.id(),asset.size(),asset.modified(),asset.key())){
            long[] range=RecordingController.range(request.getHeader("Range"),asset.size());
            response.setHeader("Cache-Control","no-store");response.setHeader("Accept-Ranges","bytes");response.setHeader("X-Content-Type-Options","nosniff");
            if(range==null){response.setStatus(416);response.setHeader("Content-Range","bytes */"+asset.size());response.setContentLengthLong(0);return;}
            boolean partial=request.getHeader("Range")!=null;long first=range[0],last=range[1];
            response.setStatus(partial?206:200);response.setContentType("video/mp4");response.setContentLengthLong(last-first+1);
            response.setHeader("Content-Disposition","inline; filename=\"frame-vod-"+asset.id()+".mp4\"");
            if(partial)response.setHeader("Content-Range","bytes "+first+"-"+last+"/"+asset.size());
            if(request.getMethod().equals("HEAD"))return;
            var out=response.getOutputStream();ByteBuffer chunk=ByteBuffer.allocate(128*1024);long at=first,remaining=last-first+1;
            while(remaining>0){chunk.clear().limit((int)Math.min(chunk.capacity(),remaining));int count=channel.read(chunk,at);if(count<=0)throw new IOException("VOD copy ended early");out.write(chunk.array(),0,count);at+=count;remaining-=count;}
        }catch(NoSuchFileException absent){if(response.isCommitted())Replies.abort(request,response);else{response.reset();throw ProductVods.missing();}}
        catch(IOException failure){if(response.isCommitted())Replies.abort(request,response);else{response.reset();throw new ProductProblem(503,"VOD_MEDIA_UNAVAILABLE","영상을 연결할 수 없어요. 잠시 후 다시 시도해 주세요.");}}
        finally{leave(ip);}
    }
    synchronized boolean enter(String ip){int count=streams.getOrDefault(ip,0);if(total>=8||count>=4)return false;streams.put(ip,count+1);total++;return true;}
    synchronized void leave(String ip){int count=streams.getOrDefault(ip,0);if(count<=1)streams.remove(ip);else streams.put(ip,count-1);if(total>0)total--;}
    private static int limit(String input){try{return Integer.parseInt(input);}catch(NumberFormatException failure){throw ProductVods.filter();}}
    private static void limited(RateLimit rate,String key){int wait=rate.take(key);if(wait>0)throw new ProductProblem(429,"VOD_RATE_LIMITED","잠시 후 다시 시도해 주세요.",wait);}
    private static UUID owner(HttpServletRequest request){UUID owner=AccountController.viewer();if(owner==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&!owner.toString().equalsIgnoreCase(expected))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return owner;}
    private static ResponseEntity<Object> ok(int status,Object body){return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").body(body);}
}
