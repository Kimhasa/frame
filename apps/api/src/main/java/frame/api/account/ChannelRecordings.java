package frame.api.account;

import frame.api.dvr.RecordedAssetProbe;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** Only catalog metadata is mutable; product operations never remove or rewrite the source recording. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChannelRecordings {
    public record Item(UUID id,String title,String displayName,long recordedAtMs,Long durationMs,Long sizeBytes,String status,long version,boolean hidden,boolean readyPlayable,long updatedAtMs,String broadcastId,String reason){}
    public record Storage(long knownFileCount,long knownSizeBytes,long availableFileCount,long availableSizeBytes){}
    public record Page(UUID userId,List<Item> items,String nextCursor,Storage storage,long serverNowMs,boolean collectionEnabled,int retentionHours){}
    public record Detail(UUID userId,Item item,long serverNowMs){}
    record Observation(UUID instance,String broadcast,String path,String source,String title){}
    record Window(UUID id,UUID channel,UUID instance,String broadcast,String path,String source,String title,long start,long last,Long end,String reason,long connectionAt){}
    record Binding(UUID id,long at){}
    record FileRow(UUID id,Window window,String name,long recorded,Long size,Long duration,Long modified,String key,String status,String reason,long version,boolean hidden,long updated,long checked){}
    public record Asset(UUID id,String path,String name,long size,long modified,String key,long recorded,long windowStart,long windowEnd){}
    record Cursor(long at,UUID id){}
    private static final String UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final DateTimeFormatter NAME=DateTimeFormatter.ofPattern("uuuu-MM-dd_HH-mm-ss").withZone(ZoneId.of("Asia/Seoul"));
    private static final String JOIN=" FROM product_recording_files f JOIN product_recording_windows w ON w.id=f.window_id ";
    private static final String COLUMNS="SELECT f.*,w.channel_id,w.broadcast_instance_id,w.broadcast_id,w.source_session,w.title,w.started_at_ms,w.last_observed_at_ms,w.ended_at_ms,w.connection_at_ms,w.reason AS window_reason,w.id AS window_uuid";
    private final JdbcClient sql;
    private final RecordedAssetProbe probe;
    private volatile boolean available=true;
    public ChannelRecordings(JdbcClient sql,RecordedAssetProbe probe){this.sql=sql;this.probe=probe;}
    void availability(boolean value){available=value;}
    @Transactional(timeout=3) public void recover(){bounded();sql.sql("UPDATE product_recording_windows SET ended_at_ms=last_observed_at_ms,reason='server_restart' WHERE ended_at_ms IS NULL").update();}
    @Transactional(timeout=4) public List<Window> observe(List<Observation> observations,long now,boolean continuous){
        bounded();Map<UUID,Observation> byInstance=new HashMap<>();observations.forEach(value->byInstance.put(value.instance(),value));
        Map<UUID,Window> kept=new HashMap<>();
        for(Window window:sql.sql("SELECT *,id AS window_uuid,reason AS window_reason FROM product_recording_windows WHERE ended_at_ms IS NULL FOR UPDATE").query(this::window).list()){
            Observation current=byInstance.get(window.instance());
            boolean ownerMatches=current!=null&&sql.sql("SELECT EXISTS(SELECT 1 FROM product_channels WHERE id=:id AND stream_path=:path AND notification_live_after_ms=:connection)").param("id",window.channel()).param("path",window.path()).param("connection",window.connectionAt()).query(Boolean.class).single();
            String reason=!continuous||now-window.last()>6000?"observation_gap":current==null?"broadcast_boundary":!ownerMatches?"ownership_changed":!current.source().equals(window.source())?"source_changed":null;
            if(reason!=null){close(window.id(),reason);continue;}
            sql.sql("UPDATE product_recording_windows SET last_observed_at_ms=:now WHERE id=:id").param("now",now).param("id",window.id()).update();
            kept.put(window.instance(),new Window(window.id(),window.channel(),window.instance(),window.broadcast(),window.path(),window.source(),window.title(),window.start(),now,null,null,window.connectionAt()));
        }
        List<Window> result=new ArrayList<>();
        for(Observation observation:observations){
            Window window=kept.get(observation.instance());
            if(window==null){
                Binding binding=sql.sql("SELECT id,notification_live_after_ms FROM product_channels WHERE stream_path=:path").param("path",observation.path()).query((r,i)->new Binding(r.getObject("id",UUID.class),r.getLong("notification_live_after_ms"))).optional().orElse(null);if(binding==null)continue;UUID channel=binding.id();
                window=new Window(UUID.randomUUID(),channel,observation.instance(),observation.broadcast(),observation.path(),observation.source(),observation.title().replace('\0','\uFFFD'),now,now,null,null,binding.at());
                sql.sql("""
                        INSERT INTO product_recording_windows(id,channel_id,broadcast_instance_id,broadcast_id,path,source_session,title,started_at_ms,last_observed_at_ms,connection_at_ms)
                        VALUES(:id,:channel,:instance,:broadcast,:path,:source,:title,:now,:now,:connection)
                        """).param("id",window.id()).param("channel",channel).param("instance",window.instance()).param("broadcast",window.broadcast()).param("path",window.path()).param("source",window.source()).param("title",window.title()).param("now",now).param("connection",window.connectionAt()).update();
            }
            result.add(window);
        }
        return result;
    }
    private void close(UUID id,String reason){sql.sql("UPDATE product_recording_windows SET ended_at_ms=last_observed_at_ms,reason=:reason WHERE id=:id AND ended_at_ms IS NULL").param("id",id).param("reason",reason).update();}
    @Transactional(timeout=3) public void discover(Window window,String name,long at,long now){
        if(at<window.start()||at>now)return; // No retroactive ownership of pre-observation files, including old files after restart.
        bounded();sql.sql("""
                INSERT INTO product_recording_files(id,window_id,path,file_name,recorded_at_ms,status,reason,checked_at_ms,updated_at_ms)
                VALUES(:id,:window,:path,:name,:at,'recording','not_final',:now,:now) ON CONFLICT(path,file_name) DO NOTHING
                """).param("id",UUID.randomUUID()).param("window",window.id()).param("path",window.path()).param("name",name).param("at",at).param("now",now).update();
    }
    public Set<String> known(String path,long since){return Set.copyOf(sql.sql("SELECT file_name FROM product_recording_files WHERE path=:path AND recorded_at_ms>=:since LIMIT 2049").param("path",path).param("since",since).query(String.class).list());}
    public List<FileRow> inspect(int limit){return sql.sql(COLUMNS+JOIN+"ORDER BY f.checked_at_ms,f.id LIMIT :limit").param("limit",limit).query(this::file).list();}
    @Transactional(timeout=3) public void inspected(FileRow row,RecordedAssetProbe.Info info,boolean missing,long now){
        bounded();String status,reason;
        if(missing){status="missing";reason="file_missing";}
        else if(now-info.modified()<4000){status="recording";reason="not_final";}
        else if(info.corrupt()){status="corrupt";reason="file_corrupt";}
        else if(!info.complete()){status=row.window().end()==null?"recording":"ambiguous";reason=row.window().end()==null?"not_final":"finalization_unconfirmed";}
        else if(!contained(row.recorded(),info.durationMs(),row.window().start(),row.window().last())){status="ambiguous";reason=row.window().reason()==null?"boundary_uncertain":row.window().reason();}
        else{status="ready";reason="verified";}
        boolean changed=!status.equals(row.status())||!reason.equals(row.reason())||(!missing&&(!java.util.Objects.equals(row.size(),info.size())||!java.util.Objects.equals(row.duration(),info.durationMs())||!java.util.Objects.equals(row.modified(),info.modified())||!java.util.Objects.equals(row.key(),info.key())));
        sql.sql("""
                UPDATE product_recording_files SET status=:status,reason=:reason,size_bytes=:size,duration_ms=:duration,file_modified_ms=:modified,file_key=:key,
                  checked_at_ms=:now,updated_at_ms=CASE WHEN :changed THEN :now ELSE updated_at_ms END WHERE id=:id
                """).param("status",status).param("reason",reason).param("size",missing?row.size():Long.valueOf(info.size()),java.sql.Types.BIGINT).param("duration",missing?row.duration():info.durationMs(),java.sql.Types.BIGINT)
                .param("modified",missing?row.modified():Long.valueOf(info.modified()),java.sql.Types.BIGINT).param("key",missing?row.key():info.key(),java.sql.Types.VARCHAR).param("now",now).param("changed",changed).param("id",row.id()).update();
    }
    static boolean contained(long start,Long duration,long from,long until){return duration!=null&&duration>0&&from<=Long.MAX_VALUE-1000&&start>=from+1000&&start<=Long.MAX_VALUE-duration-1000&&start+duration+1000<=until;}
    private void bounded(){sql.sql("SET LOCAL statement_timeout='1500ms'").update();sql.sql("SET LOCAL lock_timeout='1000ms'").update();}
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ) public Page list(UUID owner,String status,String query,String cursor,int limit){
        account(owner);checkAvailable();if(!Set.of("all","ready","recording","ambiguous","missing","corrupt","hidden").contains(status)||limit<1||limit>100||query.codePointCount(0,query.length())>120||query.codePoints().anyMatch(Character::isISOControl))throw filter();
        String q=query.strip(),context=hash(owner+"\n"+status+"\n"+q+"\n"+limit);Cursor after=decode(cursor,context);
        String where=" WHERE w.channel_id=(SELECT id FROM product_channels WHERE owner_id=:owner) AND f.hidden=:hidden AND position(lower(:q) IN lower(w.title || ' ' || f.file_name || ' 녹화_' || to_char(to_timestamp(f.recorded_at_ms/1000.0) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD_HH24-MI-SS') || '.mp4'))>0";
        if(!status.equals("all")&&!status.equals("hidden"))where+=" AND f.status=:status";
        var request=sql.sql(COLUMNS+JOIN+where+(after==null?"":" AND (f.recorded_at_ms,f.id)<(:at,:id)")+" ORDER BY f.recorded_at_ms DESC,f.id DESC LIMIT :limit").param("owner",owner).param("hidden",status.equals("hidden")).param("q",q).param("limit",limit+1);
        if(!status.equals("all")&&!status.equals("hidden"))request.param("status",status);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<FileRow> rows=request.query(this::file).list();boolean more=rows.size()>limit;List<Item> items=rows.subList(0,Math.min(rows.size(),limit)).stream().map(this::item).toList();
        Storage storage=sql.sql("SELECT count(*) AS known_count,coalesce(sum(f.size_bytes),0)::bigint AS known_size,count(*) FILTER(WHERE f.status<>'missing' AND f.size_bytes IS NOT NULL) AS available_count,coalesce(sum(f.size_bytes) FILTER(WHERE f.status<>'missing'),0)::bigint AS available_size"+JOIN+" WHERE w.channel_id=(SELECT id FROM product_channels WHERE owner_id=:owner)").param("owner",owner).query((r,i)->new Storage(r.getLong("known_count"),r.getLong("known_size"),r.getLong("available_count"),r.getLong("available_size"))).single();
        Item last=more?items.getLast():null;return new Page(owner,items,last==null?null:encode(last.recordedAtMs(),last.id(),context),storage,System.currentTimeMillis(),probe.enabled(),6);
    }
    @Transactional(readOnly=true) public Detail detail(UUID owner,UUID id){account(owner);checkAvailable();return new Detail(owner,item(owned(owner,id,false)),System.currentTimeMillis());}
    @Transactional public Detail visibility(UUID owner,UUID id,JsonNode body){
        account(owner);checkAvailable();if(body.size()!=2||!body.path("version").isIntegralNumber()||!body.path("version").canConvertToLong()||body.path("version").longValue()<0||!body.path("hidden").isBoolean())throw new ProductProblem(400,"INVALID_RECORDING_INPUT","입력 내용을 확인해 주세요.");
        FileRow row=owned(owner,id,true);if(body.path("version").longValue()!=row.version())throw conflict();boolean hidden=body.path("hidden").asBoolean();
        if(hidden!=row.hidden())sql.sql("UPDATE product_recording_files SET hidden=:hidden,version=version+1,updated_at_ms=:now WHERE id=:id").param("hidden",hidden).param("now",System.currentTimeMillis()).param("id",id).update();
        return new Detail(owner,item(owned(owner,id,false)),System.currentTimeMillis());
    }
    /** Materializes ownership metadata, then releases its transaction before any file is opened or streamed. */
    @Transactional(readOnly=true) public Asset asset(UUID owner,UUID id){account(owner);checkAvailable();FileRow row=owned(owner,id,false);if(!probe.enabled()||row.hidden()||!row.status().equals("ready")||row.size()==null||row.modified()==null||!contained(row.recorded(),row.duration(),row.window().start(),row.window().last()))throw unplayable();return new Asset(id,row.window().path(),row.name(),row.size(),row.modified(),row.key(),row.recorded(),row.window().start(),row.window().last());}
    private FileRow owned(UUID owner,UUID id,boolean lock){return sql.sql(COLUMNS+JOIN+"WHERE f.id=:id AND w.channel_id=(SELECT id FROM product_channels WHERE owner_id=:owner)"+(lock?" FOR UPDATE OF f":"")).param("id",id).param("owner",owner).query(this::file).optional().orElseThrow(()->new ProductProblem(404,"RECORDING_NOT_FOUND","녹화 항목을 찾을 수 없어요."));}
    private void account(UUID owner){if(owner==null||!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:owner)").param("owner",owner).query(Boolean.class).single())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");}
    private void checkAvailable(){if(!available)throw new ProductProblem(503,"RECORDINGS_UNAVAILABLE","녹화 저장소를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");}
    private Window window(ResultSet row,int index)throws SQLException{return new Window(row.getObject("window_uuid",UUID.class),row.getObject("channel_id",UUID.class),row.getObject("broadcast_instance_id",UUID.class),row.getString("broadcast_id"),row.getString("path"),row.getString("source_session"),row.getString("title"),row.getLong("started_at_ms"),row.getLong("last_observed_at_ms"),row.getObject("ended_at_ms",Long.class),row.getString("window_reason"),row.getLong("connection_at_ms"));}
    private FileRow file(ResultSet row,int index)throws SQLException{return new FileRow(row.getObject("id",UUID.class),window(row,index),row.getString("file_name"),row.getLong("recorded_at_ms"),row.getObject("size_bytes",Long.class),row.getObject("duration_ms",Long.class),row.getObject("file_modified_ms",Long.class),row.getString("file_key"),row.getString("status"),row.getString("reason"),row.getLong("version"),row.getBoolean("hidden"),row.getLong("updated_at_ms"),row.getLong("checked_at_ms"));}
    private Item item(FileRow row){return new Item(row.id(),row.window().title(),"녹화_"+NAME.format(Instant.ofEpochMilli(row.recorded()))+".mp4",row.recorded(),row.duration(),row.size(),row.status(),row.version(),row.hidden(),probe.enabled()&&row.status().equals("ready")&&!row.hidden(),row.updated(),row.window().broadcast(),!probe.enabled()&&row.status().equals("ready")?"서버 녹화 경로가 비활성화되어 파일을 열 수 없어요.":description(row.reason()));}
    private static String description(String reason){return switch(reason){case "verified"->null;case "not_final"->"파일을 기록하고 있거나 최종 저장을 확인하고 있어요.";case "finalization_unconfirmed"->"방송이 끝났지만 파일의 최종 저장을 확인할 수 없어요.";case "file_missing"->"서버에서 파일을 찾을 수 없어요. 보관 기간이 지났을 수 있어요.";case "file_corrupt"->"녹화 파일의 영상 정보를 확인할 수 없어요.";case "server_restart"->"서버 재시작 경계를 포함해 방송 전체 귀속을 확인할 수 없어요.";case "ownership_changed"->"채널 연결이 바뀐 구간을 포함해 재생할 수 없어요.";case "source_changed"->"송출 원본이 바뀐 구간을 포함해 재생할 수 없어요.";case "observation_gap"->"관찰이 끊긴 구간을 포함해 재생할 수 없어요.";default->"파일 전체가 같은 방송에 속하는지 확인할 수 없어요. 첫·마지막 경계 파일은 제한될 수 있어요.";};}
    static UUID id(String value){if(value==null||!value.matches(UUID_PATTERN))throw new ProductProblem(404,"RECORDING_NOT_FOUND","녹화 항목을 찾을 수 없어요.");return UUID.fromString(value);}
    private static String encode(long at,UUID id,String context){return Base64.getUrlEncoder().withoutPadding().encodeToString((at+":"+id+":"+context).getBytes(StandardCharsets.UTF_8));}
    private static Cursor decode(String input,String context){if(input.isEmpty())return null;try{if(!input.matches("[A-Za-z0-9_-]{1,200}"))throw new IllegalArgumentException();String[] values=new String(Base64.getUrlDecoder().decode(input),StandardCharsets.UTF_8).split(":");if(values.length!=3||!values[0].matches("[1-9][0-9]{0,14}")||!values[1].matches(UUID_PATTERN)||!values[2].equals(context))throw new IllegalArgumentException();long at=Long.parseLong(values[0]);if(at>253402300799999L)throw new IllegalArgumentException();return new Cursor(at,UUID.fromString(values[1]));}catch(IllegalArgumentException failure){throw new ProductProblem(400,"INVALID_RECORDING_CURSOR","녹화 목록을 새로 불러와 주세요.");}}
    private static String hash(String input){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
    static ProductProblem filter(){return new ProductProblem(400,"INVALID_RECORDING_FILTER","녹화 검색 조건을 확인해 주세요.");}
    static ProductProblem conflict(){return new ProductProblem(409,"RECORDING_CONFLICT","녹화 목록의 상태가 바뀌었어요. 최신 내용을 확인해 주세요.");}
    static ProductProblem unplayable(){return new ProductProblem(409,"RECORDING_NOT_PLAYABLE","이 녹화 파일은 지금 재생하거나 내려받을 수 없어요. 파일 상태를 다시 확인해 주세요.");}
}
