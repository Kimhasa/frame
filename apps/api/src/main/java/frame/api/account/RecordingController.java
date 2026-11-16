package frame.api.account;

import frame.api.dvr.RecordedAssetProbe;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class RecordingController {
    private final ChannelRecordings catalog;
    private final RecordedAssetProbe probe;
    private final JsonMapper json;
    private final RateLimit rate=new RateLimit(40,4);
    private final Map<UUID,Integer> streams=new HashMap<>();
    private int total;
    public RecordingController(ChannelRecordings catalog,RecordedAssetProbe probe,JsonMapper json){this.catalog=catalog;this.probe=probe;this.json=json;}
    @GetMapping("/api/v1/me/recordings") public ResponseEntity<Object> list(HttpServletRequest request,@RequestParam(defaultValue="all")String status,@RequestParam(defaultValue="")String q,@RequestParam(defaultValue="")String cursor,@RequestParam(defaultValue="20")String limit){int parsed;try{parsed=Integer.parseInt(limit);}catch(NumberFormatException failure){throw ChannelRecordings.filter();}return ok(catalog.list(owner(request),status,q,cursor,parsed));}
    @GetMapping("/api/v1/me/recordings/{id}") public ResponseEntity<Object> detail(HttpServletRequest request,@PathVariable String id){return ok(catalog.detail(owner(request),ChannelRecordings.id(id)));}
    @PatchMapping("/api/v1/me/recordings/{id}") public ResponseEntity<Object> update(HttpServletRequest request,@PathVariable String id){UUID owner=owner(request);return ok(catalog.visibility(owner,ChannelRecordings.id(id),ProductRequests.body(request,json)));}
    @GetMapping("/api/v1/me/recordings/{id}/media") public void media(HttpServletRequest request,HttpServletResponse response,@PathVariable String id,@RequestParam(defaultValue="")String owner,@RequestParam(defaultValue="0")String download)throws IOException{
        UUID user=owner(request);
        if(!user.toString().equalsIgnoreCase(owner))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");
        if(!download.equals("0")&&!download.equals("1"))throw new ProductProblem(400,"INVALID_RECORDING_INPUT","내려받기 옵션을 확인해 주세요.");
        int wait=rate.take(user.toString());if(wait>0)throw new ProductProblem(429,"RECORDING_RATE_LIMITED","잠시 후 다시 시도해 주세요.",wait);
        var asset=catalog.asset(user,ChannelRecordings.id(id)); // Transaction and its connection end here, before local file IO.
        if(!enter(user))throw new ProductProblem(503,"RECORDING_STREAM_BUSY","다른 녹화 전송이 끝난 뒤 다시 시도해 주세요.",2);
        try{
            var info=probe.info(asset.path(),asset.name());
            if(!info.complete()||info.corrupt()||info.size()!=asset.size()||info.modified()!=asset.modified()||!java.util.Objects.equals(info.key(),asset.key())||!ChannelRecordings.contained(asset.recorded(),info.durationMs(),asset.windowStart(),asset.windowEnd()))throw new ProductProblem(409,"RECORDING_CHANGED","파일 상태가 바뀌었어요. 녹화 정보를 다시 확인해 주세요.");
            try(var channel=probe.open(asset.path(),asset.name())){
                if(channel.size()!=asset.size())throw new ProductProblem(409,"RECORDING_CHANGED","파일 상태가 바뀌었어요. 녹화 정보를 다시 확인해 주세요.");
                long[] range=range(request.getHeader("Range"),asset.size());
                response.setHeader("Cache-Control","no-store");response.setHeader("Accept-Ranges","bytes");response.setHeader("X-Content-Type-Options","nosniff");response.setHeader("X-FRAME-USER-ID",user.toString());
                if(range==null){response.setStatus(416);response.setHeader("Content-Range","bytes */"+asset.size());response.setContentLengthLong(0);return;}
                boolean partial=request.getHeader("Range")!=null;long first=range[0],last=range[1];
                response.setStatus(partial?206:200);response.setContentType("video/mp4");response.setContentLengthLong(last-first+1);
                response.setHeader("Content-Disposition",(download.equals("1")?"attachment":"inline")+"; filename=\"frame-recording-"+asset.id()+".mp4\"");
                if(partial)response.setHeader("Content-Range","bytes "+first+"-"+last+"/"+asset.size());
                if(request.getMethod().equals("HEAD"))return;
                var out=response.getOutputStream();ByteBuffer chunk=ByteBuffer.allocate(128*1024);long at=first,remaining=last-first+1;
                while(remaining>0){chunk.clear().limit((int)Math.min(chunk.capacity(),remaining));int got=channel.read(chunk,at);if(got<=0)throw new IOException("Recording stream ended early");out.write(chunk.array(),0,got);at+=got;remaining-=got;}
            }
        }catch(NoSuchFileException absent){if(response.isCommitted())Replies.abort(request,response);else {response.reset();throw new ProductProblem(404,"RECORDING_FILE_MISSING","녹화 파일을 찾을 수 없어요. 파일 상태를 다시 확인해 주세요.");}}
        catch(IOException failure){if(response.isCommitted())Replies.abort(request,response);else {response.reset();throw new ProductProblem(503,"RECORDINGS_UNAVAILABLE","녹화 파일을 연결할 수 없어요. 잠시 후 다시 시도해 주세요.");}}
        finally{leave(user);}
    }
    synchronized boolean enter(UUID user){int count=streams.getOrDefault(user,0);if(total>=4||count>=2)return false;streams.put(user,count+1);total++;return true;}
    synchronized void leave(UUID user){int count=streams.getOrDefault(user,0);if(count<=1)streams.remove(user);else streams.put(user,count-1);if(total>0)total--;}
    static long[] range(String value,long size){
        if(size<=0)return null;if(value==null)return new long[]{0,size-1};
        if(!value.matches("bytes=[0-9]{0,18}-[0-9]{0,18}"))return null;
        try{String[] parts=value.substring(6).split("-",-1);if(parts[0].isEmpty()){if(parts[1].isEmpty())return null;long length=Long.parseLong(parts[1]);return length<=0?null:new long[]{Math.max(0,size-length),size-1};}long first=Long.parseLong(parts[0]),last=parts[1].isEmpty()?size-1:Long.parseLong(parts[1]);if(first>=size||last<first)return null;return new long[]{first,Math.min(size-1,last)};}catch(NumberFormatException failure){return null;}
    }
    private static UUID owner(HttpServletRequest request){UUID owner=AccountController.viewer();if(owner==null)throw new ProductProblem(401,"UNAUTHENTICATED","로그인이 필요해요.");String expected=request.getHeader("X-FRAME-USER-ID");if(expected!=null&&!owner.toString().equalsIgnoreCase(expected))throw new ProductProblem(409,"SESSION_CHANGED","로그인 계정이 바뀌었어요. 화면을 새로 불러와 주세요.");return owner;}
    private static ResponseEntity<Object> ok(Object value){return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").body(value);}
}
