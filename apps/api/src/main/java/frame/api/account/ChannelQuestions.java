package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChannelQuestions {
    public record Author(UUID channelId,String handle,String displayName) {}
    public record Question(UUID id,UUID channelId,String broadcastId,String path,String text,Author author,String answer,Long answeredAtMs,boolean pinned,boolean broadcastActive,int version,long createdAtMs,long updatedAtMs) {}
    public record OwnQuestion(UUID id,UUID channelId,String broadcastId,String path,String text,Author author,String answer,Long answeredAtMs,boolean pinned,boolean broadcastActive,int version,long createdAtMs,long updatedAtMs,UUID clientRequestId) {
        OwnQuestion(Question q,UUID request){this(q.id(),q.channelId(),q.broadcastId(),q.path(),q.text(),q.author(),q.answer(),q.answeredAtMs(),q.pinned(),q.broadcastActive(),q.version(),q.createdAtMs(),q.updatedAtMs(),request);}
    }
    public record Page(UUID userId,List<Question> items,String nextCursor,ChannelPolls.CurrentBroadcast currentBroadcast,UUID pinnedQuestionId,long serverNowMs) {}
    public record Managed(UUID userId,Question item,long serverNowMs) {}
    public record Submitted(UUID userId,OwnQuestion item,long serverNowMs) {}
    public record Saved(boolean created,Submitted result) {}
    public record Current(UUID userId,Question pinned,List<OwnQuestion> mine,String nextCursor,boolean canSubmit,String reason,Long retryAfterMs,long serverNowMs) {}
    record Draft(String path,String broadcast,String text,UUID request) {}
    private record Channel(UUID id,UUID owner,String path) {}
    private record Row(UUID id,UUID channel,UUID author,UUID request,String broadcast,String path,UUID instance,String text,Author profile,String answer,Long answered,boolean pinned,long created,long updated,int version) {}
    private record Eligibility(String reason,Long retry) {}
    private static final String SELECT="SELECT q.*,a.display_name AS author_name,ac.id AS author_channel,ac.handle AS author_handle FROM product_questions q JOIN product_accounts a ON a.id=q.author_id JOIN product_channels ac ON ac.owner_id=a.id";
    private final JdbcClient sql;
    private final BroadcastRegistry registry;
    private final JsonMapper json;
    public ChannelQuestions(JdbcClient sql,BroadcastRegistry registry,JsonMapper json){this.sql=sql;this.registry=registry;this.json=json;}

    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ)
    public Page list(UUID owner,String status,String query,String from,String to,String cursor,int limit){
        Channel own=owned(owner,false);
        if(!List.of("all","waiting","answered").contains(status)||Accounts.length(query)>120||query.codePoints().anyMatch(Character::isISOControl))throw filter();
        bounds(limit);Long start=day(from,false),end=day(to,true);if(start!=null&&end!=null&&start>=end)throw filter();
        var after=cursor(cursor);StringBuilder statement=new StringBuilder(SELECT+" WHERE q.channel_id=:channel");
        if(!status.equals("all"))statement.append(status.equals("waiting")?" AND q.answer IS NULL":" AND q.answer IS NOT NULL");
        if(!query.isBlank())statement.append(" AND position(lower(:query) IN lower(q.text || ' ' || a.display_name || ' ' || ac.handle || ' ' || coalesce(q.answer,'')))>0");
        if(start!=null)statement.append(" AND q.created_at_ms>=:from");if(end!=null)statement.append(" AND q.created_at_ms<:to");
        if(after!=null)statement.append(" AND (q.created_at_ms,q.id)<(:at,:id)");statement.append(" ORDER BY q.created_at_ms DESC,q.id DESC LIMIT :limit");
        var request=sql.sql(statement.toString()).param("channel",own.id()).param("limit",limit+1);
        if(!query.isBlank())request.param("query",query.strip());if(start!=null)request.param("from",start);if(end!=null)request.param("to",end);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> page=more?rows.subList(0,limit):rows;Row last=more?page.getLast():null;
        Broadcast current=own.path()==null?null:registry.byPath(own.path());
        UUID pinned=current==null?null:sql.sql("SELECT id FROM product_questions WHERE channel_id=:channel AND pinned AND broadcast_id=:broadcast AND broadcast_instance_id=:instance").param("channel",own.id()).param("broadcast",current.id).param("instance",current.instanceId).query(UUID.class).optional().orElse(null);
        return new Page(owner,page.stream().map(this::view).toList(),last==null?null:ProductNotifications.encode(last.created(),last.id()),current==null?null:new ChannelPolls.CurrentBroadcast(current.id,current.path,current.title),pinned,System.currentTimeMillis());
    }
    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ)
    public Managed detail(UUID owner,String id){Channel own=owned(owner,false);Row question=find(uuid(id),own.id());return new Managed(owner,view(question),System.currentTimeMillis());}

    @Transactional(timeout=3)
    public Managed update(UUID owner,String rawId,JsonNode input){
        Channel own=owned(owner,true);Row question=find(uuid(rawId),own.id());
        if(!input.path("version").isIntegralNumber()||!input.path("version").canConvertToInt()||input.path("version").intValue()<0||(!input.has("answer")&&!input.has("pinned"))||input.size()!=1+(input.has("answer")?1:0)+(input.has("pinned")?1:0))throw invalid();
        String answer=question.answer();if(input.has("answer")){if(!input.path("answer").isString())throw answerError();answer=content(input.path("answer").asString(),1000,true);}
        if(input.has("pinned")&&!input.path("pinned").isBoolean())throw invalid();
        if(question.version()!=input.path("version").intValue())throw new ProductProblem(409,"QUESTION_CONFLICT","다른 화면에서 질문이 바뀌었어요. 최신 내용을 불러와 주세요.");
        boolean pin=input.has("pinned")?input.path("pinned").booleanValue():question.pinned();
        if(input.has("pinned")&&pin&&!active(question))throw unavailable();
        long now=System.currentTimeMillis();
        if(input.has("pinned")&&pin)sql.sql("UPDATE product_questions SET pinned=false,updated_at_ms=:at,version=version+1 WHERE channel_id=:channel AND pinned AND id<>:id").param("channel",own.id()).param("id",question.id()).param("at",now).update();
        sql.sql("UPDATE product_questions SET answer=:answer,answered_at_ms=:answered,pinned=:pinned,updated_at_ms=:at,version=version+1 WHERE id=:id AND channel_id=:channel")
                .param("answer",answer,java.sql.Types.VARCHAR).param("answered",input.has("answer")?Long.valueOf(now):question.answered(),java.sql.Types.BIGINT).param("pinned",pin).param("at",now).param("id",question.id()).param("channel",own.id()).update();
        return new Managed(owner,view(find(question.id(),own.id())),now);
    }
    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ)
    public Current current(UUID viewer,String path,String broadcast,String after,int limit){
        key(path,broadcast);bounds(limit);var cursor=cursor(after);Broadcast current=registry.get(broadcast);if(current!=null&&!current.path.equals(path))current=null;
        Channel channel=current==null?null:byPath(path,false);Row pinned=null;
        if(channel!=null)pinned=sql.sql(SELECT+" WHERE q.channel_id=:channel AND q.pinned AND q.broadcast_id=:broadcast AND q.broadcast_instance_id=:instance").param("channel",channel.id()).param("broadcast",broadcast).param("instance",current.instanceId).query(this::row).optional().orElse(null);
        List<Row> mine=List.of();
        if(viewer!=null){String statement=SELECT+" WHERE q.author_id=:author AND q.path=:path AND q.broadcast_id=:broadcast"+(cursor==null?"":" AND (q.created_at_ms,q.id)<(:at,:id)")+" ORDER BY q.created_at_ms DESC,q.id DESC LIMIT :limit";var request=sql.sql(statement).param("author",viewer).param("path",path).param("broadcast",broadcast).param("limit",limit+1);if(cursor!=null)request.param("at",cursor.at()).param("id",cursor.id());mine=request.query(this::row).list();}
        boolean more=mine.size()>limit;List<Row> page=more?mine.subList(0,limit):mine;Row last=more?page.getLast():null;
        long now=System.currentTimeMillis();Eligibility eligibility=channel==null?new Eligibility("broadcast_unavailable",null):eligible(viewer,channel,now,true);
        Question published=pinned==null?null:view(pinned);if(published!=null&&(!published.pinned()||!published.broadcastActive()))published=null;
        List<OwnQuestion> ownItems=page.stream().map(row->new OwnQuestion(view(row),row.request())).toList();
        Broadcast latest=registry.get(broadcast);if(current==null||latest==null||!latest.path.equals(path)||!latest.instanceId.equals(current.instanceId)){published=null;eligibility=new Eligibility("broadcast_unavailable",null);}
        return new Current(viewer,published,ownItems,last==null?null:ProductNotifications.encode(last.created(),last.id()),eligibility.reason()==null,eligibility.reason(),eligibility.retry(),System.currentTimeMillis());
    }
    @Transactional(timeout=3)
    public Saved submit(UUID author,JsonNode input){
        Draft draft=draft(input);
        // This lock serializes global per-account quota and idempotency, while still allowing FK KEY SHARE locks.
        if(sql.sql("SELECT id FROM product_accounts WHERE id=:author FOR NO KEY UPDATE").param("author",author).query(UUID.class).optional().isEmpty())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");
        Row previous=sql.sql(SELECT+" WHERE q.author_id=:author AND q.client_request_id=:request").param("author",author).param("request",draft.request()).query(this::row).optional().orElse(null);
        if(previous!=null){if(!previous.text().equals(draft.text())||!previous.path().equals(draft.path())||!previous.broadcast().equals(draft.broadcast()))throw new ProductProblem(409,"QUESTION_REQUEST_CONFLICT","이미 다른 질문에 사용한 요청이에요. 새 질문으로 다시 보내 주세요.");return receipt(author,previous,false);}
        Broadcast current=registry.get(draft.broadcast());if(current==null||!current.path.equals(draft.path()))throw unavailable();
        Channel channel=byPath(draft.path(),true);if(channel==null)throw unavailable();
        // Recheck after the channel lock: the source may have ended while another owner operation committed.
        Broadcast latest=registry.get(draft.broadcast());if(latest==null||!latest.instanceId.equals(current.instanceId)||!latest.path.equals(draft.path()))throw unavailable();
        long now=System.currentTimeMillis();Eligibility eligibility=eligible(author,channel,now,false);
        if("blocked".equals(eligibility.reason()))throw new ProductProblem(403,"QUESTION_PARTICIPATION_BLOCKED","이 채널에는 질문을 보낼 수 없어요.");
        if("followers_only".equals(eligibility.reason()))throw new ProductProblem(403,"QUESTION_FOLLOW_REQUIRED","채널을 팔로우한 뒤 질문을 보내 주세요.");
        if(eligibility.reason()!=null)throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");
        var policy=sql.sql("SELECT block_links,banned_words FROM product_chat_settings WHERE channel_id=:channel").param("channel",channel.id()).query((r,i)->new TextPolicy(r.getBoolean("block_links"),ChatModeration.words(json.readTree(r.getString("banned_words"))))).optional().orElse(new TextPolicy(false,List.of()));
        if(policy.links()&&ChatModeration.containsLink(draft.text()))throw new ProductProblem(400,"QUESTION_LINK_BLOCKED","이 채널에는 링크가 포함된 질문을 보낼 수 없어요.");
        if(ChatModeration.containsWord(policy.words(),draft.text()))throw new ProductProblem(400,"QUESTION_WORD_BLOCKED","이 채널에서 허용하지 않는 표현이 포함돼 있어요.");
        Long wait=quota(author,now);if(wait!=null)throw new ProductProblem(429,"QUESTION_RATE_LIMITED","질문은 1분에 3개까지 보낼 수 있어요. 잠시 후 다시 시도해 주세요.",(int)Math.max(1,(wait+999)/1000));
        UUID id=UUID.randomUUID();sql.sql("INSERT INTO product_questions(id,channel_id,author_id,client_request_id,broadcast_id,path,broadcast_instance_id,text,created_at_ms,updated_at_ms) VALUES(:id,:channel,:author,:request,:broadcast,:path,:instance,:text,:at,:at)")
                .param("id",id).param("channel",channel.id()).param("author",author).param("request",draft.request()).param("broadcast",draft.broadcast()).param("path",draft.path()).param("instance",latest.instanceId).param("text",draft.text()).param("at",now).update();
        return receipt(author,find(id,null),true);
    }
    private record TextPolicy(boolean links,List<String> words) {}
    private Saved receipt(UUID author,Row question,boolean created){return new Saved(created,new Submitted(author,new OwnQuestion(view(question),question.request()),System.currentTimeMillis()));}
    private Eligibility eligible(UUID author,Channel channel,long now,boolean withQuota){
        if(author==null||!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:author)").param("author",author).query(Boolean.class).single())return new Eligibility("login_required",null);
        if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:author AND (expires_at_ms IS NULL OR expires_at_ms>:now))").param("channel",channel.id()).param("author",author).param("now",now).query(Boolean.class).single())return new Eligibility("blocked",null);
        if(!channel.owner().equals(author)&&sql.sql("SELECT coalesce((SELECT followers_only FROM product_chat_settings WHERE channel_id=:channel),false) AND NOT EXISTS(SELECT 1 FROM product_follows WHERE channel_id=:channel AND user_id=:author)").param("channel",channel.id()).param("author",author).query(Boolean.class).single())return new Eligibility("followers_only",null);
        Long wait=withQuota?quota(author,now):null;return new Eligibility(wait==null?null:"rate_limited",wait);
    }
    private Long quota(UUID author,long now){List<Long> recent=sql.sql("SELECT created_at_ms FROM product_questions WHERE author_id=:author AND created_at_ms>:since ORDER BY created_at_ms LIMIT 3").param("author",author).param("since",now-60000).query(Long.class).list();return recent.size()<3?null:Math.max(1,recent.getFirst()+60000-now);}
    private boolean active(Row row){Broadcast current=registry.get(row.broadcast());return current!=null&&current.path.equals(row.path())&&current.instanceId.equals(row.instance());}
    private Question view(Row row){boolean active=active(row);return new Question(row.id(),row.channel(),row.broadcast(),row.path(),row.text(),row.profile(),row.answer(),row.answered(),row.pinned()&&active,active,row.version(),row.created(),row.updated());}
    private Channel owned(UUID author,boolean lock){return sql.sql("SELECT id,owner_id,stream_path FROM product_channels WHERE owner_id=:author"+(lock?" FOR UPDATE":"")).param("author",author).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("stream_path"))).optional().orElseThrow(()->new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요."));}
    private Channel byPath(String path,boolean lock){return sql.sql("SELECT id,owner_id,stream_path FROM product_channels WHERE stream_path=:path"+(lock?" FOR UPDATE":"")).param("path",path).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("stream_path"))).optional().orElse(null);}
    private Row find(UUID id,UUID ownerChannel){var request=sql.sql(SELECT+" WHERE q.id=:id"+(ownerChannel==null?"":" AND q.channel_id=:channel")).param("id",id);if(ownerChannel!=null)request.param("channel",ownerChannel);return request.query(this::row).optional().orElseThrow(()->new ProductProblem(404,"QUESTION_NOT_FOUND","질문을 찾을 수 없어요."));}
    private Row row(ResultSet r,int index)throws SQLException{return new Row(r.getObject("id",UUID.class),r.getObject("channel_id",UUID.class),r.getObject("author_id",UUID.class),r.getObject("client_request_id",UUID.class),r.getString("broadcast_id"),r.getString("path"),r.getObject("broadcast_instance_id",UUID.class),r.getString("text"),new Author(r.getObject("author_channel",UUID.class),r.getString("author_handle"),r.getString("author_name")),r.getString("answer"),r.getObject("answered_at_ms",Long.class),r.getBoolean("pinned"),r.getLong("created_at_ms"),r.getLong("updated_at_ms"),r.getInt("version"));}
    static Draft draft(JsonNode input){if(input.size()!=4||!input.path("path").isString()||!input.path("broadcastId").isString()||!input.path("text").isString()||!input.path("clientRequestId").isString())throw invalid();String path=input.path("path").asString(),broadcast=input.path("broadcastId").asString();key(path,broadcast);return new Draft(path,broadcast,content(input.path("text").asString(),500,false),uuid(input.path("clientRequestId").asString()));}
    static String content(String raw,int maximum,boolean answer){String value=Normalizer.normalize(raw.replace("\r\n","\n").replace('\r','\n'),Normalizer.Form.NFC).strip();if(Accounts.length(value)<1||Accounts.length(value)>maximum||ChatModeration.comparable(value).isBlank()||value.codePoints().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\t'))throw answer?answerError():invalid();return value;}
    private static Long day(String value,boolean after){try{return ChannelPolls.day(value,after);}catch(ProductProblem failure){throw filter();}}
    private static ProductNotifications.Cursor cursor(String value){try{return ProductNotifications.decode(value);}catch(ProductProblem failure){throw new ProductProblem(400,"INVALID_QUESTION_CURSOR","질문 목록을 새로 불러와 주세요.");}}
    private static void bounds(int limit){if(limit<1||limit>100)throw filter();}
    private static void key(String path,String broadcast){if(!path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")||!broadcast.matches("[0-9a-f]{32}"))throw invalid();}
    private static UUID uuid(String value){if(!value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return UUID.fromString(value);}
    static ProductProblem invalid(){return new ProductProblem(400,"INVALID_QUESTION_INPUT","질문 입력을 확인해 주세요.");}
    static ProductProblem filter(){return new ProductProblem(400,"INVALID_QUESTION_FILTER","질문 검색 조건을 확인해 주세요.");}
    private static ProductProblem answerError(){return new ProductProblem(400,"INVALID_QUESTION_ANSWER","답변을 1~1,000자로 입력해 주세요.");}
    private static ProductProblem unavailable(){return new ProductProblem(409,"QUESTION_BROADCAST_UNAVAILABLE","현재 방송의 질문만 고정하거나 보낼 수 있어요.");}
}
