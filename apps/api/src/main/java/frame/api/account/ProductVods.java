package frame.api.account;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** Publishing changes product metadata; the media/DVR registry and source recording are independent. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ProductVods {
    public record Channel(UUID id,String handle,String displayName,String avatarUrl){}
    public record Item(UUID id,String title,String description,long durationMs,long sizeBytes,long publishedAtMs,Channel channel){}
    public record PublicPage(List<Item> items,String nextCursor,long serverNowMs){}
    public record PublicDetail(Item item,long serverNowMs){}
    public record OwnItem(UUID id,String title,String description,long durationMs,long sizeBytes,Long publishedAtMs,Channel channel,
                          UUID recordingId,String status,String visibility,boolean published,boolean available,long version,String reason,long createdAtMs,long updatedAtMs){}
    public record OwnDetail(UUID userId,OwnItem item,long serverNowMs,boolean storageEnabled){}
    public record OwnPage(UUID userId,List<OwnItem> items,String nextCursor,long serverNowMs,boolean storageEnabled){}
    public record Created(boolean created,OwnDetail result){}
    record Row(UUID id,UUID owner,UUID recording,Channel channel,String title,String description,String status,String visibility,
               long duration,long size,Long modified,String key,String hash,Long published,long created,long updated,long version,String reason){}
    record Work(UUID id,UUID owner,UUID recording){}
    public record Asset(UUID id,long size,Long modified,String key){}
    record Cursor(long at,UUID id){}
    record Draft(UUID recording,String title,String description){}
    record Edit(long version,String title,String description,String visibility){}
    private static final String UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final String SELECT="SELECT v.*,c.owner_id,c.handle,c.display_name FROM product_vods v JOIN product_channels c ON c.id=v.channel_id ";
    private static final String PUBLIC="v.status='ready' AND v.visibility='public'";
    private final JdbcClient sql;
    private final ChannelRecordings recordings;
    private final VodFiles files;
    public ProductVods(JdbcClient sql,ChannelRecordings recordings,VodFiles files){this.sql=sql;this.recordings=recordings;this.files=files;}

    @Transactional public Created prepare(UUID owner,JsonNode input){
        account(owner);Draft draft=draft(input);
        UUID channel=sql.sql("SELECT id FROM product_channels WHERE owner_id=:owner FOR UPDATE").param("owner",owner).query(UUID.class).optional().orElseThrow(ProductVods::missing);
        Row existing=byRecording(owner,draft.recording());
        if(existing!=null){
            if(!existing.title().equals(draft.title())||!existing.description().equals(draft.description()))throw new ProductProblem(409,"VOD_ALREADY_EXISTS","이 녹화의 다시보기가 있어요. 기존 다시보기를 확인해 주세요.");
            return new Created(false,detail(owner,existing));
        }
        if(!files.enabled())throw unavailable();
        var source=source(owner,draft.recording());
        Long duration=recordings.detail(owner,draft.recording()).item().durationMs();if(duration==null||duration<=0)throw sourceUnavailable();
        if(sql.sql("SELECT count(*) FROM product_vods v JOIN product_channels c ON c.id=v.channel_id WHERE c.owner_id=:owner AND v.status='preparing'").param("owner",owner).query(Integer.class).single()>=2)
            throw new ProductProblem(503,"VOD_PREPARATION_BUSY","진행 중인 다시보기 준비가 끝나면 다시 시도해 주세요.",2);
        UUID id=UUID.randomUUID();long now=System.currentTimeMillis();
        sql.sql("""
                INSERT INTO product_vods(id,channel_id,recording_id,title,description,status,visibility,duration_ms,size_bytes,created_at_ms,updated_at_ms)
                VALUES(:id,:channel,:recording,:title,:description,'preparing','public',:duration,:size,:now,:now)
                """).param("id",id).param("channel",channel).param("recording",draft.recording()).param("title",draft.title()).param("description",draft.description())
                .param("duration",duration).param("size",source.size()).param("now",now).update();
        return new Created(true,detail(owner,owned(owner,id,false)));
    }
    @Transactional(readOnly=true) public OwnDetail own(UUID owner,UUID id){account(owner);return detail(owner,owned(owner,id,false));}
    @Transactional(readOnly=true) public OwnDetail ownRecording(UUID owner,UUID recording){account(owner);Row row=byRecording(owner,recording);return new OwnDetail(owner,row==null?null:ownItem(row),System.currentTimeMillis(),files.enabled());}
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ) public OwnPage ownList(UUID owner,String status,String query,String cursor,int limit){
        account(owner);String q=query(query);if(!Set.of("all","preparing","ready","failed").contains(status)||limit<1||limit>100)throw filter();
        String context=hash(owner+"\n"+status+"\n"+q+"\n"+limit);Cursor after=decode(cursor,context);
        String where="WHERE c.owner_id=:owner AND position(lower(:q) IN lower(v.title))>0 ";
        if(!status.equals("all"))where+="AND v.status=:status ";
        if(after!=null)where+="AND (v.created_at_ms,v.id)<(:at,:id) ";
        var request=sql.sql(SELECT+where+"ORDER BY v.created_at_ms DESC,v.id DESC LIMIT :limit").param("owner",owner).param("q",q).param("limit",limit+1);
        if(!status.equals("all"))request.param("status",status);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> selected=more?rows.subList(0,limit):rows;
        Row last=more?selected.getLast():null;return new OwnPage(owner,selected.stream().map(this::ownItem).toList(),last==null?null:encode(last.created(),last.id(),context),System.currentTimeMillis(),files.enabled());
    }
    @Transactional public OwnDetail edit(UUID owner,UUID id,JsonNode input){
        account(owner);Edit edit=edit(input);Row row=owned(owner,id,true);if(row.version()!=edit.version())throw conflict();
        // Revoking public access always works using the database, including an unavailable disk or expired source.
        if(edit.visibility().equals("public")&&row.status().equals("ready")&&!available(row))throw new ProductProblem(409,"VOD_ARCHIVE_UNAVAILABLE","보관 파일을 확인할 수 없어 공개할 수 없어요. 비공개 전환은 계속할 수 있어요.");
        boolean changed=!row.title().equals(edit.title())||!row.description().equals(edit.description())||!row.visibility().equals(edit.visibility());
        if(changed){
            long now=System.currentTimeMillis();
            sql.sql("""
                    UPDATE product_vods SET title=:title,description=:description,visibility=:visibility,version=version+1,updated_at_ms=:now,
                      published_at_ms=CASE WHEN status='ready' AND visibility='private' AND :visibility='public' THEN :now ELSE published_at_ms END
                    WHERE id=:id
                    """).param("title",edit.title()).param("description",edit.description()).param("visibility",edit.visibility()).param("now",now).param("id",id).update();
        }
        return detail(owner,owned(owner,id,false));
    }
    @Transactional public OwnDetail retry(UUID owner,UUID id,JsonNode input){
        account(owner);long version=version(input);Row row=owned(owner,id,true);if(row.version()!=version)throw conflict();
        if(!row.status().equals("failed"))throw new ProductProblem(409,"VOD_NOT_FAILED","다시보기의 최신 준비 상태를 확인해 주세요.");
        if(!files.enabled())throw unavailable();if(row.recording()==null)throw sourceUnavailable();var source=source(owner,row.recording());
        Long duration=recordings.detail(owner,row.recording()).item().durationMs();if(duration==null||duration<=0)throw sourceUnavailable();
        sql.sql("UPDATE product_vods SET status='preparing',reason=NULL,size_bytes=:size,duration_ms=:duration,version=version+1,updated_at_ms=:now WHERE id=:id")
                .param("size",source.size()).param("duration",duration).param("now",System.currentTimeMillis()).param("id",id).update();return detail(owner,owned(owner,id,false));
    }
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ) public PublicPage publicList(String query,String channel,String cursor,int limit){
        String q=query(query);if(limit<1||limit>100||(!channel.isEmpty()&&!channel.matches("[a-z][a-z0-9_-]{2,23}")))throw filter();
        String context=hash("public\n"+q+"\n"+channel+"\n"+limit);Cursor after=decode(cursor,context);
        String where="WHERE "+PUBLIC+" AND position(lower(:q) IN lower(v.title || ' ' || c.display_name))>0 ";
        if(!channel.isEmpty())where+="AND (c.handle=:channel OR EXISTS(SELECT 1 FROM product_channel_handles h WHERE h.channel_id=c.id AND h.handle=:channel)) ";
        if(after!=null)where+="AND (v.published_at_ms,v.id)<(:at,:id) ";
        var request=sql.sql(SELECT+where+"ORDER BY v.published_at_ms DESC,v.id DESC LIMIT :limit").param("q",q).param("limit",limit+1);
        if(!channel.isEmpty())request.param("channel",channel);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> selected=more?rows.subList(0,limit):rows;List<Item> items=new ArrayList<>();
        for(Row row:selected)if(available(row))items.add(publicItem(row));
        Row last=more?selected.getLast():null;return new PublicPage(items,last==null?null:encode(last.published(),last.id(),context),System.currentTimeMillis());
    }
    @Transactional(readOnly=true) public PublicDetail publicDetail(UUID id){Row row=published(id);if(!available(row))throw missing();return new PublicDetail(publicItem(row),System.currentTimeMillis());}
    @Transactional(readOnly=true) public Asset publicAsset(UUID id){Row row=published(id);if(!available(row))throw missing();return new Asset(row.id(),row.size(),row.modified(),row.key());}
    @Transactional public List<UUID> recover(){
        var ids=sql.sql("SELECT id FROM product_vods WHERE status='preparing'").query(UUID.class).list();
        sql.sql("UPDATE product_vods SET status='failed',reason='preparation_interrupted',updated_at_ms=:now WHERE status='preparing'").param("now",System.currentTimeMillis()).update();return ids;
    }
    @Transactional(readOnly=true) public Work next(){return sql.sql(SELECT+"WHERE v.status='preparing' ORDER BY v.created_at_ms,v.id LIMIT 1").query((r,i)->new Work(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getObject("recording_id",UUID.class))).optional().orElse(null);}
    public ChannelRecordings.Asset source(UUID owner,UUID recording){
        try{return recordings.asset(owner,recording);}catch(ProductProblem problem){if(problem.status==401||problem.status==503)throw problem;if(problem.status==404)throw missing();throw sourceUnavailable();}
    }
    @Transactional public void finished(UUID id,VodFiles.Info info){
        sql.sql("""
                UPDATE product_vods SET status='ready',reason=NULL,archive_modified_ms=:modified,archive_key=:key,archive_sha256=:hash,updated_at_ms=:now,
                  published_at_ms=CASE WHEN visibility='public' THEN :now ELSE published_at_ms END WHERE id=:id AND status='preparing'
                """).param("modified",info.modified()).param("key",info.key()).param("hash",info.sha256()).param("now",System.currentTimeMillis()).param("id",id).update();
    }
    @Transactional public void failed(UUID id){sql.sql("UPDATE product_vods SET status='failed',reason='preparation_failed',updated_at_ms=:now WHERE id=:id AND status='preparing'").param("now",System.currentTimeMillis()).param("id",id).update();}
    private boolean available(Row row){return row.status().equals("ready")&&files.matches(row.id(),row.size(),row.modified(),row.key());}
    private OwnItem ownItem(Row row){boolean available=available(row);return new OwnItem(row.id(),row.title(),row.description(),row.duration(),row.size(),row.published(),row.channel(),row.recording(),row.status(),row.visibility(),
            row.status().equals("ready")&&row.visibility().equals("public")&&available,available,row.version(),
            row.status().equals("failed")?row.reason().equals("preparation_interrupted")?"서버가 다시 시작되어 준비가 중단됐어요. 원본 파일을 확인한 뒤 다시 준비해 주세요.":"다시보기 보관 파일을 준비하지 못했어요. 원본 파일과 저장 공간을 확인한 뒤 다시 시도해 주세요."
                :row.status().equals("ready")&&!available?"보관 파일을 확인할 수 없어요. 비공개 전환은 계속할 수 있어요.":null,row.created(),row.updated());}
    private Item publicItem(Row row){return new Item(row.id(),row.title(),row.description(),row.duration(),row.size(),row.published(),row.channel());}
    private OwnDetail detail(UUID owner,Row row){return new OwnDetail(owner,ownItem(row),System.currentTimeMillis(),files.enabled());}
    private Row byRecording(UUID owner,UUID recording){return sql.sql(SELECT+"WHERE c.owner_id=:owner AND v.recording_id=:recording").param("owner",owner).param("recording",recording).query(this::row).optional().orElse(null);}
    private Row owned(UUID owner,UUID id,boolean lock){return sql.sql(SELECT+"WHERE c.owner_id=:owner AND v.id=:id"+(lock?" FOR UPDATE OF v":"")).param("owner",owner).param("id",id).query(this::row).optional().orElseThrow(ProductVods::missing);}
    private Row published(UUID id){return sql.sql(SELECT+"WHERE v.id=:id AND "+PUBLIC).param("id",id).query(this::row).optional().orElseThrow(ProductVods::missing);}
    private Row row(ResultSet r,int index)throws SQLException{return new Row(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getObject("recording_id",UUID.class),new Channel(r.getObject("channel_id",UUID.class),r.getString("handle"),r.getString("display_name"),null),r.getString("title"),r.getString("description"),r.getString("status"),r.getString("visibility"),r.getLong("duration_ms"),r.getLong("size_bytes"),r.getObject("archive_modified_ms",Long.class),r.getString("archive_key"),r.getString("archive_sha256"),r.getObject("published_at_ms",Long.class),r.getLong("created_at_ms"),r.getLong("updated_at_ms"),r.getLong("version"),r.getString("reason"));}
    private void account(UUID owner){if(owner==null||!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:owner)").param("owner",owner).query(Boolean.class).single())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");}
    static Draft draft(JsonNode input){if(input.size()!=3||!input.path("recordingId").isString())throw invalid();return new Draft(id(input.path("recordingId").asString()),text(input.path("title"),1,100,false),text(input.path("description"),0,2000,true));}
    static Edit edit(JsonNode input){if(input.size()!=4||!input.path("visibility").isString()||!Set.of("public","private").contains(input.path("visibility").asString()))throw invalid();return new Edit(number(input.path("version")),text(input.path("title"),1,100,false),text(input.path("description"),0,2000,true),input.path("visibility").asString());}
    static long version(JsonNode input){if(input.size()!=1)throw invalid();return number(input.path("version"));}
    private static long number(JsonNode value){if(!value.isIntegralNumber()||!value.canConvertToLong()||value.longValue()<0)throw invalid();return value.longValue();}
    private static String text(JsonNode value,int min,int max,boolean multiline){if(!value.isString())throw invalid();String result=Normalizer.normalize(value.asString().replace("\r\n","\n").replace('\r','\n'),Normalizer.Form.NFC).strip();int count=result.codePointCount(0,result.length());if(count<min||count>max||result.codePoints().anyMatch(c->(c>=0xd800&&c<=0xdfff)||(Character.isISOControl(c)&&!(multiline&&(c=='\n'||c=='\t')))))throw invalid();return result;}
    private static String query(String input){if(input.codePointCount(0,input.length())>120||input.codePoints().anyMatch(Character::isISOControl))throw filter();return Normalizer.normalize(input.strip(),Normalizer.Form.NFC);}
    static UUID id(String input){if(input==null||!input.matches(UUID_PATTERN))throw missing();return UUID.fromString(input);}
    private static String encode(long at,UUID id,String context){return Base64.getUrlEncoder().withoutPadding().encodeToString((at+":"+id+":"+context).getBytes(StandardCharsets.UTF_8));}
    private static Cursor decode(String input,String context){if(input.isEmpty())return null;try{if(!input.matches("[A-Za-z0-9_-]{1,200}"))throw new IllegalArgumentException();String[] values=new String(Base64.getUrlDecoder().decode(input),StandardCharsets.UTF_8).split(":");if(values.length!=3||!values[0].matches("[1-9][0-9]{0,14}")||!values[1].matches(UUID_PATTERN)||!values[2].equals(context))throw new IllegalArgumentException();long at=Long.parseLong(values[0]);if(at>253402300799999L)throw new IllegalArgumentException();return new Cursor(at,UUID.fromString(values[1]));}catch(IllegalArgumentException failure){throw new ProductProblem(400,"INVALID_VOD_CURSOR","다시보기 목록을 새로 불러와 주세요.");}}
    private static String hash(String input){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
    private static ProductProblem invalid(){return new ProductProblem(400,"INVALID_VOD_INPUT","다시보기 입력 내용을 확인해 주세요.");}
    static ProductProblem filter(){return new ProductProblem(400,"INVALID_VOD_FILTER","다시보기 검색 조건을 확인해 주세요.");}
    static ProductProblem missing(){return new ProductProblem(404,"VOD_NOT_FOUND","다시보기를 찾을 수 없어요. 공개 상태를 확인해 주세요.");}
    private static ProductProblem sourceUnavailable(){return new ProductProblem(409,"VOD_SOURCE_UNAVAILABLE","공개할 수 있는 원본 녹화 파일을 확인해 주세요.");}
    private static ProductProblem unavailable(){return new ProductProblem(503,"VOD_STORAGE_UNAVAILABLE","다시보기 보관 경로가 준비되지 않았어요.");}
    private static ProductProblem conflict(){return new ProductProblem(409,"VOD_CONFLICT","다시보기 설정이 바뀌었어요. 최신 내용을 확인해 주세요.");}
}
