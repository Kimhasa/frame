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

/** Explicitly owned clips. The source VOD's public choice gates every anonymous request. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ProductClips {
    public record Source(UUID id,String title,String handle){}
    public record Item(UUID id,String title,String description,long durationMs,long sizeBytes,long publishedAtMs,ProductVods.Channel channel,Source source,long startMs,long endMs){}
    public record PublicPage(List<Item> items,String nextCursor,long serverNowMs){}
    public record PublicDetail(Item item,long serverNowMs){}
    public record OwnItem(UUID id,String title,String description,long durationMs,long sizeBytes,Long publishedAtMs,ProductVods.Channel channel,Source source,long startMs,long endMs,
                          UUID sourceVodId,UUID clientRequestId,String status,String visibility,boolean published,boolean available,boolean sourcePublished,long version,String reason,long createdAtMs,long updatedAtMs){}
    public record OwnDetail(UUID userId,OwnItem item,long serverNowMs,boolean storageEnabled){}
    public record OwnPage(UUID userId,List<OwnItem> items,String nextCursor,long serverNowMs,boolean storageEnabled){}
    public record Created(boolean created,OwnDetail result){}
    record Row(UUID id,UUID owner,ProductVods.Channel channel,Source source,UUID request,String requestTitle,String requestDescription,String title,String description,
               long start,long end,long sourceSize,long sourceModified,String sourceKey,String sourceHash,String status,String visibility,long duration,long size,Long modified,String key,
               Long published,long created,long updated,long version,String reason,boolean sourcePublished){}
    record Work(UUID id,UUID owner,UUID source,long start,long end,long sourceSize,long sourceModified,String sourceKey,String sourceHash){}
    public record Asset(UUID id,long size,Long modified,String key){}
    record Cursor(long at,UUID id){}
    record Draft(UUID source,UUID request,long start,long end,String title,String description){}
    record Edit(long version,String title,String description,String visibility){}
    private static final String UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final String SELECT="SELECT k.*,c.owner_id,c.handle,c.display_name,v.title AS source_title,(v.status='ready' AND v.visibility='public') AS source_published FROM product_clips k JOIN product_channels c ON c.id=k.channel_id JOIN product_vods v ON v.id=k.source_vod_id AND v.channel_id=k.channel_id ";
    private static final String PUBLIC="k.status='ready' AND k.visibility='public' AND v.status='ready' AND v.visibility='public'";
    private final JdbcClient sql;private final ProductVods vods;private final ClipFiles files;
    public ProductClips(JdbcClient sql,ProductVods vods,ClipFiles files){this.sql=sql;this.vods=vods;this.files=files;}
    @Transactional public Created prepare(UUID owner,JsonNode input){
        account(owner);Draft draft=draft(input);
        UUID channel=sql.sql("SELECT id FROM product_channels WHERE owner_id=:owner FOR UPDATE").param("owner",owner).query(UUID.class).optional().orElseThrow(ProductClips::missing);
        Row existing=byRequest(owner,draft.request());
        if(existing!=null){
            if(!existing.source().id().equals(draft.source())||existing.start()!=draft.start()||existing.end()!=draft.end()||!existing.requestTitle().equals(draft.title())||!existing.requestDescription().equals(draft.description()))
                throw new ProductProblem(409,"CLIP_REQUEST_CONFLICT","같은 요청으로 다른 클립을 만들 수 없어요. 기존 결과를 먼저 확인해 주세요.");
            return new Created(false,detail(owner,existing));
        }
        if(!files.enabled())throw unavailable();var source=vods.clipSource(owner,draft.source());bounds(draft.start(),draft.end(),source.duration());
        if(!channel.equals(source.channel()))throw missing();busy(owner);
        UUID id=UUID.randomUUID();long now=System.currentTimeMillis();
        sql.sql("""
                INSERT INTO product_clips(id,channel_id,source_vod_id,client_request_id,request_title,request_description,title,description,start_ms,end_ms,
                  source_size_bytes,source_modified_ms,source_key,source_sha256,status,visibility,duration_ms,created_at_ms,updated_at_ms)
                VALUES(:id,:channel,:source,:request,:title,:description,:title,:description,:start,:end,:size,:modified,:key,:hash,'preparing','public',:duration,:now,:now)
                """).param("id",id).param("channel",channel).param("source",source.id()).param("request",draft.request()).param("title",draft.title()).param("description",draft.description())
                .param("start",draft.start()).param("end",draft.end()).param("size",source.size()).param("modified",source.modified()).param("key",source.key()).param("hash",source.hash())
                .param("duration",draft.end()-draft.start()).param("now",now).update();return new Created(true,detail(owner,owned(owner,id,false)));
    }
    @Transactional(readOnly=true) public OwnDetail own(UUID owner,UUID id){account(owner);return detail(owner,owned(owner,id,false));}
    @Transactional(readOnly=true) public OwnDetail receipt(UUID owner,UUID request){account(owner);Row row=byRequest(owner,request);return new OwnDetail(owner,row==null?null:ownItem(row),System.currentTimeMillis(),files.enabled());}
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ) public OwnPage ownList(UUID owner,String source,String status,String query,String cursor,int limit){
        account(owner);String q=query(query);if(!Set.of("all","preparing","ready","failed").contains(status)||limit<1||limit>100)throw filter();UUID sourceId=source.isEmpty()?null:id(source);
        String context=hash(owner+"\n"+source+"\n"+status+"\n"+q+"\n"+limit);Cursor after=decode(cursor,context);
        String where="WHERE c.owner_id=:owner AND position(lower(:q) IN lower(k.title))>0 ";if(sourceId!=null)where+="AND k.source_vod_id=:source ";if(!status.equals("all"))where+="AND k.status=:status ";if(after!=null)where+="AND (k.created_at_ms,k.id)<(:at,:id) ";
        var request=sql.sql(SELECT+where+"ORDER BY k.created_at_ms DESC,k.id DESC LIMIT :limit").param("owner",owner).param("q",q).param("limit",limit+1);
        if(sourceId!=null)request.param("source",sourceId);if(!status.equals("all"))request.param("status",status);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> selected=more?rows.subList(0,limit):rows;Row last=more?selected.getLast():null;
        return new OwnPage(owner,selected.stream().map(this::ownItem).toList(),last==null?null:encode(last.created(),last.id(),context),System.currentTimeMillis(),files.enabled());
    }
    @Transactional public OwnDetail edit(UUID owner,UUID id,JsonNode input){
        account(owner);Edit edit=edit(input);Row row=owned(owner,id,true);if(row.version()!=edit.version())throw conflict();
        if(edit.visibility().equals("public")&&row.status().equals("ready")&&!available(row))throw new ProductProblem(409,"CLIP_ARCHIVE_UNAVAILABLE","클립 보관 파일을 확인할 수 없어 공개할 수 없어요. 비공개 전환은 계속할 수 있어요.");
        if(!row.title().equals(edit.title())||!row.description().equals(edit.description())||!row.visibility().equals(edit.visibility())){
            sql.sql("""
                    UPDATE product_clips SET title=:title,description=:description,visibility=:visibility,version=version+1,updated_at_ms=:now,
                      published_at_ms=CASE WHEN status='ready' AND visibility='private' AND :visibility='public' THEN :now ELSE published_at_ms END WHERE id=:id
                    """).param("title",edit.title()).param("description",edit.description()).param("visibility",edit.visibility()).param("now",System.currentTimeMillis()).param("id",id).update();
        }return detail(owner,owned(owner,id,false));
    }
    @Transactional public OwnDetail retry(UUID owner,UUID id,JsonNode input){
        account(owner);long version=version(input);sql.sql("SELECT id FROM product_channels WHERE owner_id=:owner FOR UPDATE").param("owner",owner).query(UUID.class).optional().orElseThrow(ProductClips::missing);
        Row row=owned(owner,id,true);if(row.version()!=version)throw conflict();if(!row.status().equals("failed"))throw new ProductProblem(409,"CLIP_NOT_FAILED","클립의 최신 준비 상태를 확인해 주세요.");
        if(!files.enabled())throw unavailable();var source=vods.clipSource(owner,row.source().id());bounds(row.start(),row.end(),source.duration());busy(owner);
        sql.sql("""
                UPDATE product_clips SET status='preparing',reason=NULL,size_bytes=0,duration_ms=end_ms-start_ms,source_size_bytes=:size,source_modified_ms=:modified,
                  source_key=:key,source_sha256=:hash,version=version+1,updated_at_ms=:now WHERE id=:id
                """).param("size",source.size()).param("modified",source.modified()).param("key",source.key()).param("hash",source.hash()).param("now",System.currentTimeMillis()).param("id",id).update();return detail(owner,owned(owner,id,false));
    }
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ) public PublicPage publicList(String query,String channel,String cursor,int limit){
        String q=query(query);if(limit<1||limit>100||(!channel.isEmpty()&&!channel.matches("[a-z][a-z0-9_-]{2,23}")))throw filter();
        String context=hash("public\n"+q+"\n"+channel+"\n"+limit);Cursor after=decode(cursor,context);String where="WHERE "+PUBLIC+" AND position(lower(:q) IN lower(k.title || ' ' || c.display_name))>0 ";
        if(!channel.isEmpty())where+="AND (c.handle=:channel OR EXISTS(SELECT 1 FROM product_channel_handles h WHERE h.channel_id=c.id AND h.handle=:channel)) ";if(after!=null)where+="AND (k.published_at_ms,k.id)<(:at,:id) ";
        var request=sql.sql(SELECT+where+"ORDER BY k.published_at_ms DESC,k.id DESC LIMIT :limit").param("q",q).param("limit",limit+1);if(!channel.isEmpty())request.param("channel",channel);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> selected=more?rows.subList(0,limit):rows;List<Item> items=new ArrayList<>();for(Row row:selected)if(available(row))items.add(publicItem(row));Row last=more?selected.getLast():null;
        return new PublicPage(items,last==null?null:encode(last.published(),last.id(),context),System.currentTimeMillis());
    }
    @Transactional(readOnly=true) public PublicDetail publicDetail(UUID id){Row row=published(id);if(!available(row))throw missing();return new PublicDetail(publicItem(row),System.currentTimeMillis());}
    @Transactional(readOnly=true) public Asset publicAsset(UUID id){Row row=published(id);if(!available(row))throw missing();return new Asset(row.id(),row.size(),row.modified(),row.key());}
    @Transactional public List<UUID> recover(){var ids=sql.sql("SELECT id FROM product_clips WHERE status='preparing'").query(UUID.class).list();sql.sql("UPDATE product_clips SET status='failed',reason='preparation_interrupted',updated_at_ms=:now WHERE status='preparing'").param("now",System.currentTimeMillis()).update();return ids;}
    @Transactional(readOnly=true) public Work next(){return sql.sql(SELECT+"WHERE k.status='preparing' ORDER BY k.created_at_ms,k.id LIMIT 1").query((r,i)->new Work(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getObject("source_vod_id",UUID.class),r.getLong("start_ms"),r.getLong("end_ms"),r.getLong("source_size_bytes"),r.getLong("source_modified_ms"),r.getString("source_key"),r.getString("source_sha256"))).optional().orElse(null);}
    public ProductVods.ClipSource source(Work work){var source=vods.clipSource(work.owner(),work.source());bounds(work.start(),work.end(),source.duration());if(source.size()!=work.sourceSize()||source.modified()!=work.sourceModified()||!source.key().equals(work.sourceKey())||!source.hash().equals(work.sourceHash()))throw new ProductProblem(409,"CLIP_SOURCE_CHANGED","원본 다시보기의 보관 파일이 바뀌었어요. 다시 준비해 주세요.");return source;}
    @Transactional public void finished(UUID id,ClipFiles.Info info){sql.sql("""
            UPDATE product_clips SET status='ready',reason=NULL,size_bytes=:size,duration_ms=:duration,archive_modified_ms=:modified,archive_key=:key,archive_sha256=:hash,updated_at_ms=:now,
              published_at_ms=CASE WHEN visibility='public' THEN :now ELSE published_at_ms END WHERE id=:id AND status='preparing'
            """).param("size",info.size()).param("duration",info.duration()).param("modified",info.modified()).param("key",info.key()).param("hash",info.sha256()).param("now",System.currentTimeMillis()).param("id",id).update();}
    @Transactional public void failed(UUID id){sql.sql("UPDATE product_clips SET status='failed',reason='preparation_failed',updated_at_ms=:now WHERE id=:id AND status='preparing'").param("now",System.currentTimeMillis()).param("id",id).update();}
    private boolean available(Row row){return row.status().equals("ready")&&files.matches(row.id(),row.size(),row.modified(),row.key());}
    private OwnItem ownItem(Row row){boolean available=available(row);return new OwnItem(row.id(),row.title(),row.description(),row.duration(),row.size(),row.published(),row.channel(),row.source(),row.start(),row.end(),row.source().id(),row.request(),row.status(),row.visibility(),row.status().equals("ready")&&row.visibility().equals("public")&&available&&row.sourcePublished(),available,row.sourcePublished(),row.version(),
            row.status().equals("failed")?"preparation_interrupted".equals(row.reason())?"서버가 다시 시작되어 클립 준비가 중단됐어요. 원본을 확인한 뒤 다시 준비해 주세요.":"클립을 준비하지 못했어요. 원본 다시보기·인코더·저장 공간을 확인하고 다시 시도해 주세요.":row.status().equals("ready")&&!available?"클립 보관 파일을 확인할 수 없어요. 비공개 전환은 계속할 수 있어요.":null,row.created(),row.updated());}
    private Item publicItem(Row row){return new Item(row.id(),row.title(),row.description(),row.duration(),row.size(),row.published(),row.channel(),row.source(),row.start(),row.end());}
    private OwnDetail detail(UUID owner,Row row){return new OwnDetail(owner,ownItem(row),System.currentTimeMillis(),files.enabled());}
    private Row byRequest(UUID owner,UUID request){return sql.sql(SELECT+"WHERE c.owner_id=:owner AND k.client_request_id=:request").param("owner",owner).param("request",request).query(this::row).optional().orElse(null);}
    private Row owned(UUID owner,UUID id,boolean lock){return sql.sql(SELECT+"WHERE c.owner_id=:owner AND k.id=:id"+(lock?" FOR UPDATE OF k":"")).param("owner",owner).param("id",id).query(this::row).optional().orElseThrow(ProductClips::missing);}
    private Row published(UUID id){return sql.sql(SELECT+"WHERE k.id=:id AND "+PUBLIC).param("id",id).query(this::row).optional().orElseThrow(ProductClips::missing);}
    private Row row(ResultSet r,int index)throws SQLException{return new Row(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),new ProductVods.Channel(r.getObject("channel_id",UUID.class),r.getString("handle"),r.getString("display_name"),null),new Source(r.getObject("source_vod_id",UUID.class),r.getString("source_title"),r.getString("handle")),r.getObject("client_request_id",UUID.class),r.getString("request_title"),r.getString("request_description"),r.getString("title"),r.getString("description"),r.getLong("start_ms"),r.getLong("end_ms"),r.getLong("source_size_bytes"),r.getLong("source_modified_ms"),r.getString("source_key"),r.getString("source_sha256"),r.getString("status"),r.getString("visibility"),r.getLong("duration_ms"),r.getLong("size_bytes"),r.getObject("archive_modified_ms",Long.class),r.getString("archive_key"),r.getObject("published_at_ms",Long.class),r.getLong("created_at_ms"),r.getLong("updated_at_ms"),r.getLong("version"),r.getString("reason"),r.getBoolean("source_published"));}
    private void account(UUID owner){if(owner==null||!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:owner)").param("owner",owner).query(Boolean.class).single())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");}
    private void busy(UUID owner){if(sql.sql("SELECT count(*) FROM product_clips k JOIN product_channels c ON c.id=k.channel_id WHERE c.owner_id=:owner AND k.status='preparing'").param("owner",owner).query(Integer.class).single()>=2)throw new ProductProblem(503,"CLIP_PREPARATION_BUSY","진행 중인 클립 준비가 끝나면 다시 시도해 주세요.",2);}
    static Draft draft(JsonNode input){if(input.size()!=6||!input.path("sourceVodId").isString()||!input.path("clientRequestId").isString())throw invalid();long start=number(input.path("startMs")),end=number(input.path("endMs"));bounds(start,end,Long.MAX_VALUE);return new Draft(id(input.path("sourceVodId").asString()),id(input.path("clientRequestId").asString()),start,end,text(input.path("title"),1,100,false),text(input.path("description"),0,2000,true));}
    static Edit edit(JsonNode input){if(input.size()!=4||!input.path("visibility").isString()||!Set.of("public","private").contains(input.path("visibility").asString()))throw invalid();return new Edit(number(input.path("version")),text(input.path("title"),1,100,false),text(input.path("description"),0,2000,true),input.path("visibility").asString());}
    static long version(JsonNode input){if(input.size()!=1)throw invalid();return number(input.path("version"));}
    static void bounds(long start,long end,long duration){if(start<0||end<=start||end>duration||end-start<5000||end-start>60000)throw new ProductProblem(400,"INVALID_CLIP_RANGE","클립은 원본 안에서 5초 이상 60초 이하로 선택해 주세요.");}
    private static long number(JsonNode value){if(!value.isIntegralNumber()||!value.canConvertToLong()||value.longValue()<0)throw invalid();return value.longValue();}
    private static String text(JsonNode value,int min,int max,boolean multiline){if(!value.isString())throw invalid();String result=Normalizer.normalize(value.asString().replace("\r\n","\n").replace('\r','\n'),Normalizer.Form.NFC).strip();int count=result.codePointCount(0,result.length());if(count<min||count>max||result.codePoints().anyMatch(c->(c>=0xd800&&c<=0xdfff)||(Character.isISOControl(c)&&!(multiline&&(c=='\n'||c=='\t')))))throw invalid();return result;}
    private static String query(String input){if(input.codePointCount(0,input.length())>120||input.codePoints().anyMatch(Character::isISOControl))throw filter();return Normalizer.normalize(input.strip(),Normalizer.Form.NFC);}
    static UUID id(String input){if(input==null||!input.matches(UUID_PATTERN))throw missing();return UUID.fromString(input);}
    private static String encode(long at,UUID id,String context){return Base64.getUrlEncoder().withoutPadding().encodeToString((at+":"+id+":"+context).getBytes(StandardCharsets.UTF_8));}
    private static Cursor decode(String input,String context){if(input.isEmpty())return null;try{if(!input.matches("[A-Za-z0-9_-]{1,200}"))throw new IllegalArgumentException();String[] values=new String(Base64.getUrlDecoder().decode(input),StandardCharsets.UTF_8).split(":");if(values.length!=3||!values[0].matches("[1-9][0-9]{0,14}")||!values[1].matches(UUID_PATTERN)||!values[2].equals(context))throw new IllegalArgumentException();long at=Long.parseLong(values[0]);if(at>253402300799999L)throw new IllegalArgumentException();return new Cursor(at,UUID.fromString(values[1]));}catch(IllegalArgumentException failure){throw new ProductProblem(400,"INVALID_CLIP_CURSOR","클립 목록을 새로 불러와 주세요.");}}
    private static String hash(String input){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
    private static ProductProblem invalid(){return new ProductProblem(400,"INVALID_CLIP_INPUT","클립 입력 내용을 확인해 주세요.");}
    static ProductProblem filter(){return new ProductProblem(400,"INVALID_CLIP_FILTER","클립 검색 조건을 확인해 주세요.");}
    static ProductProblem missing(){return new ProductProblem(404,"CLIP_NOT_FOUND","공개된 클립을 찾을 수 없어요. 클립과 원본의 공개 상태를 확인해 주세요.");}
    private static ProductProblem unavailable(){return new ProductProblem(503,"CLIP_STORAGE_UNAVAILABLE","클립 보관 경로가 준비되지 않았어요.");}
    private static ProductProblem conflict(){return new ProductProblem(409,"CLIP_CONFLICT","클립 설정이 바뀌었어요. 최신 내용을 확인해 주세요.");}
}
