package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Free proposals only. Money, paid missions and the point wallet are deliberately separate contracts. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChannelMissions {
    public record Author(UUID channelId,String handle,String displayName) {}
    public record History(UUID id,String status,String reason,String actor,long createdAtMs) {}
    public record Mission(UUID id,UUID channelId,String broadcastId,String path,String title,String description,int durationMinutes,long deadlineAtMs,String status,String reason,int version,long createdAtMs,long updatedAtMs,boolean broadcastActive,Author author,List<History> history) {}
    public record OwnMission(UUID id,UUID channelId,String broadcastId,String path,String title,String description,int durationMinutes,long deadlineAtMs,String status,String reason,int version,long createdAtMs,long updatedAtMs,boolean broadcastActive,Author author,List<History> history,UUID clientRequestId) {
        OwnMission(Mission m,UUID request){this(m.id(),m.channelId(),m.broadcastId(),m.path(),m.title(),m.description(),m.durationMinutes(),m.deadlineAtMs(),m.status(),m.reason(),m.version(),m.createdAtMs(),m.updatedAtMs(),m.broadcastActive(),m.author(),m.history(),request);}
    }
    public record Page(UUID userId,List<Mission> items,String nextCursor,long serverNowMs) {}
    public record Managed(UUID userId,Mission item,long serverNowMs) {}
    public record Submitted(UUID userId,OwnMission item,long serverNowMs) {}
    public record Saved(boolean created,Submitted result) {}
    public record Current(UUID userId,List<OwnMission> mine,String nextCursor,boolean canSubmit,String reason,Long retryAfterMs,long serverNowMs) {}
    // The controller throws these failures only after the transaction commits a just-observed expiry.
    public record ManagedChange(Managed result,ProductProblem failure) {}
    public record OwnChange(Submitted result,ProductProblem failure) {}
    record Draft(String path,String broadcast,String title,String description,int minutes,UUID request) {}
    record Change(int version,String status,String reason) {}
    private record Channel(UUID id,UUID owner,String path) {}
    private record Row(UUID id,UUID channel,UUID author,UUID request,String broadcast,String path,UUID instance,String title,String description,int minutes,long deadline,String status,String reason,int version,long created,long updated,Author profile) {}
    private record Eligibility(String reason,Long retry) {}
    private record Search(String q,Long from,Long to,ProductNotifications.Cursor cursor) {}
    private static final Set<String> OPEN=Set.of("received","running"),STATUSES=Set.of("all","received","running","completed","rejected","canceled","expired","failed");
    private static final String SELECT="SELECT m.*,a.display_name AS author_name,ac.id AS author_channel,ac.handle AS author_handle FROM product_missions m JOIN product_accounts a ON a.id=m.author_id JOIN product_channels ac ON ac.owner_id=a.id";
    private final JdbcClient sql;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths media;
    private final MissionExpiry expiry;
    private final JsonMapper json;
    private final TransactionTemplate reads,writes;
    public ChannelMissions(JdbcClient sql,BroadcastRegistry registry,MediaMtxPaths media,MissionExpiry expiry,JsonMapper json,PlatformTransactionManager transactions){
        this.sql=sql;this.registry=registry;this.media=media;this.expiry=expiry;this.json=json;
        reads=new TransactionTemplate(transactions);reads.setReadOnly(true);reads.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);reads.setTimeout(5);
        writes=new TransactionTemplate(transactions);writes.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);writes.setTimeout(5);
    }

    // Permission reads release their connection before expiry. Never reserve an outer connection while asking expiry for another.
    public Page list(UUID owner,String status,String query,String from,String to,String cursor,int limit){
        Channel own=owned(owner,false);if(!STATUSES.contains(status))throw filter();Search search=search(query,from,to,cursor,limit);
        expiry.channel(own.id());
        return reads.execute(transaction->{
        String statement=SELECT+" WHERE m.channel_id=:channel"+(status.equals("all")?"":" AND m.status=:status")+conditions(search)+" ORDER BY m.created_at_ms DESC,m.id DESC LIMIT :limit";
        var request=bind(sql.sql(statement).param("channel",own.id()),search,limit);if(!status.equals("all"))request.param("status",status);
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> page=more?rows.subList(0,limit):rows;Row last=more?page.getLast():null;
        return new Page(owner,views(page),last==null?null:ProductNotifications.encode(last.created(),last.id()),System.currentTimeMillis());
        });
    }
    public Managed detail(UUID owner,String id){Channel own=owned(owner,false);UUID mission=uuid(id);find(mission,own.id(),null,false);expiry.channel(own.id());return reads.execute(transaction->managed(owner,find(mission,own.id(),null,false)));}

    public ManagedChange update(UUID owner,String id,JsonNode input){
        Change change=change(input);Channel own=owned(owner,false);UUID mission=uuid(id);find(mission,own.id(),null,false);expiry.channel(own.id());
        return writes.execute(transaction->{
        owned(owner,true);Row current=find(mission,own.id(),null,true);
        if(expireLocked(current))return new ManagedChange(null,expired());
        check(current,change.version());
        if(!allowed(current.status(),change.status()))throw new ProductProblem(409,"MISSION_INVALID_TRANSITION","현재 상태에서 선택한 상태로 변경할 수 없어요.");
        transition(current,change.status(),change.reason(),"owner");return new ManagedChange(managed(owner,find(mission,own.id(),null,false)),null);
        });
    }

    public Current current(UUID viewer,String path,String broadcast,String rawCursor,int limit){
        key(path,broadcast);bounds(limit);var after=cursor(rawCursor);if(viewer!=null)expiry.mine(viewer,path,broadcast);
        return reads.execute(transaction->{
        List<Row> mine=List.of();
        if(viewer!=null){String statement=SELECT+" WHERE m.author_id=:author AND m.path=:path AND m.broadcast_id=:broadcast"+(after==null?"":" AND (m.created_at_ms,m.id)<(:at,:id)")+" ORDER BY m.created_at_ms DESC,m.id DESC LIMIT :limit";var request=sql.sql(statement).param("author",viewer).param("path",path).param("broadcast",broadcast).param("limit",limit+1);if(after!=null)request.param("at",after.at()).param("id",after.id());mine=request.query(this::row).list();}
        boolean more=mine.size()>limit;List<Row> page=more?mine.subList(0,limit):mine;Row last=more?page.getLast():null;
        Channel channel=byPath(path,false);Broadcast current=ready(path,broadcast);Eligibility eligibility=channel==null||current==null?new Eligibility("broadcast_unavailable",null):eligible(viewer,channel,System.currentTimeMillis(),true);
        var histories=histories(page);List<OwnMission> own=page.stream().map(row->new OwnMission(view(row,histories.getOrDefault(row.id(),List.of())),row.request())).toList();
        Broadcast latest=registry.get(broadcast);if(current==null||latest==null||!latest.path.equals(path)||!latest.instanceId.equals(current.instanceId))eligibility=new Eligibility("broadcast_unavailable",null);
        return new Current(viewer,own,last==null?null:ProductNotifications.encode(last.created(),last.id()),eligibility.reason()==null,eligibility.reason(),eligibility.retry(),System.currentTimeMillis());
        });
    }

    public Saved submit(UUID author,JsonNode input){
        Draft draft=draft(input);expiry.mine(author,draft.path(),draft.broadcast());
        return writes.execute(transaction->{
        accountLock(author);
        Row previous=sql.sql(SELECT+" WHERE m.author_id=:author AND m.client_request_id=:request FOR SHARE OF m").param("author",author).param("request",draft.request()).query(this::row).optional().orElse(null);
        if(previous!=null){if(!same(previous,draft))throw new ProductProblem(409,"MISSION_REQUEST_CONFLICT","이미 다른 미션에 사용한 요청이에요. 새 미션으로 다시 보내 주세요.");return new Saved(false,submitted(author,previous));}
        Broadcast current=ready(draft.path(),draft.broadcast());Channel channel=byPath(draft.path(),true);if(current==null||channel==null)throw unavailable();
        Broadcast latest=registry.get(draft.broadcast());if(latest==null||!latest.path.equals(draft.path())||!latest.instanceId.equals(current.instanceId))throw unavailable();
        long now=System.currentTimeMillis();Eligibility eligibility=eligible(author,channel,now,false);
        if("blocked".equals(eligibility.reason()))throw new ProductProblem(403,"MISSION_PARTICIPATION_BLOCKED","이 채널에는 미션을 제안할 수 없어요.");
        if("followers_only".equals(eligibility.reason()))throw new ProductProblem(403,"MISSION_FOLLOW_REQUIRED","채널을 팔로우한 뒤 미션을 제안해 주세요.");
        if(eligibility.reason()!=null)throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");
        var policy=sql.sql("SELECT block_links,banned_words FROM product_chat_settings WHERE channel_id=:channel").param("channel",channel.id()).query((r,i)->new TextPolicy(r.getBoolean("block_links"),ChatModeration.words(json.readTree(r.getString("banned_words"))))).optional().orElse(new TextPolicy(false,List.of()));
        String content=draft.title()+"\n"+draft.description();
        if(policy.links()&&ChatModeration.containsLink(content))throw new ProductProblem(400,"MISSION_LINK_BLOCKED","이 채널에는 링크가 포함된 미션을 제안할 수 없어요.");
        if(ChatModeration.containsWord(policy.words(),content))throw new ProductProblem(400,"MISSION_WORD_BLOCKED","이 채널에서 허용하지 않는 표현이 포함돼 있어요.");
        Long retry=quota(author,now);if(retry!=null)throw new ProductProblem(429,"MISSION_RATE_LIMITED","미션은 1분에 3개까지 제안할 수 있어요. 잠시 후 다시 시도해 주세요.",(int)Math.max(1,(retry+999)/1000));
        UUID id=UUID.randomUUID();sql.sql("INSERT INTO product_missions(id,channel_id,author_id,client_request_id,broadcast_id,path,broadcast_instance_id,title,description,duration_minutes,deadline_at_ms,created_at_ms,updated_at_ms) VALUES(:id,:channel,:author,:request,:broadcast,:path,:instance,:title,:description,:minutes,:deadline,:at,:at)")
                .param("id",id).param("channel",channel.id()).param("author",author).param("request",draft.request()).param("broadcast",draft.broadcast()).param("path",draft.path()).param("instance",current.instanceId).param("title",draft.title()).param("description",draft.description()).param("minutes",draft.minutes()).param("deadline",now+draft.minutes()*60000L).param("at",now).update();
        MissionExpiry.history(sql,id,0,"received","","viewer",now);
        return new Saved(true,submitted(author,find(id,null,author,false)));
        });
    }

    public OwnChange cancel(UUID author,String id,JsonNode input){
        int version=cancelVersion(input);UUID mission=uuid(id);Row permission=find(mission,null,author,false);expiry.mine(author,permission.path(),permission.broadcast());
        return writes.execute(transaction->{
        Row current=find(mission,null,author,true);if(expireLocked(current))return new OwnChange(null,expired());check(current,version);
        if(!current.status().equals("received"))throw new ProductProblem(409,"MISSION_INVALID_TRANSITION","진행이 시작된 미션은 직접 취소할 수 없어요.");
        transition(current,"canceled","제안자가 미션을 취소했어요.","viewer");return new OwnChange(submitted(author,find(mission,null,author,false)),null);
        });
    }

    private record TextPolicy(boolean links,List<String> words) {}
    private Managed managed(UUID owner,Row row){return new Managed(owner,views(List.of(row)).getFirst(),System.currentTimeMillis());}
    private Submitted submitted(UUID author,Row row){return new Submitted(author,new OwnMission(views(List.of(row)).getFirst(),row.request()),System.currentTimeMillis());}
    private void transition(Row row,String status,String reason,String actor){long now=Math.max(System.currentTimeMillis(),row.updated());sql.sql("UPDATE product_missions SET status=:status,reason=:reason,version=version+1,updated_at_ms=:at WHERE id=:id").param("status",status).param("reason",reason).param("at",now).param("id",row.id()).update();MissionExpiry.history(sql,row.id(),row.version()+1,status,reason,actor,now);}
    private boolean expireLocked(Row row){if(!OPEN.contains(row.status()))return false;long now=System.currentTimeMillis();String reason=MissionExpiry.reason(row.deadline(),active(row),now);if(reason==null)return false;MissionExpiry.expireOne(sql,row.id(),row.version(),reason,row.deadline()<=now?row.deadline():Math.max(now,row.updated()));return true;}
    private static void check(Row row,int version){if(row.status().equals("expired"))throw expired();if(row.version()!=version)throw new ProductProblem(409,"MISSION_CONFLICT","다른 화면에서 미션이 바뀌었어요. 최신 내용을 불러와 주세요.");if(!OPEN.contains(row.status()))throw new ProductProblem(409,"MISSION_ALREADY_CLOSED","이미 처리가 끝난 미션이에요.");}
    static boolean allowed(String from,String to){return from.equals("received")?Set.of("running","rejected","canceled").contains(to):from.equals("running")&&Set.of("completed","failed","canceled").contains(to);}
    private Eligibility eligible(UUID author,Channel channel,long now,boolean withQuota){
        if(author==null)return new Eligibility("login_required",null);
        if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:author AND (expires_at_ms IS NULL OR expires_at_ms>:now))").param("channel",channel.id()).param("author",author).param("now",now).query(Boolean.class).single())return new Eligibility("blocked",null);
        if(!channel.owner().equals(author)&&sql.sql("SELECT coalesce((SELECT followers_only FROM product_chat_settings WHERE channel_id=:channel),false) AND NOT EXISTS(SELECT 1 FROM product_follows WHERE channel_id=:channel AND user_id=:author)").param("channel",channel.id()).param("author",author).query(Boolean.class).single())return new Eligibility("followers_only",null);
        Long retry=withQuota?quota(author,now):null;return new Eligibility(retry==null?null:"rate_limited",retry);
    }
    private Long quota(UUID author,long now){List<Long> recent=sql.sql("SELECT created_at_ms FROM product_missions WHERE author_id=:author AND created_at_ms>:since ORDER BY created_at_ms LIMIT 3").param("author",author).param("since",now-60000).query(Long.class).list();return recent.size()<3?null:Math.max(1,recent.getFirst()+60000-now);}
    private void accountLock(UUID author){if(sql.sql("SELECT id FROM product_accounts WHERE id=:author FOR NO KEY UPDATE").param("author",author).query(UUID.class).optional().isEmpty())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");}
    private Channel owned(UUID author,boolean lock){return sql.sql("SELECT id,owner_id,stream_path FROM product_channels WHERE owner_id=:author"+(lock?" FOR NO KEY UPDATE":"")).param("author",author).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("stream_path"))).optional().orElseThrow(()->new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요."));}
    private Channel byPath(String path,boolean lock){return sql.sql("SELECT id,owner_id,stream_path FROM product_channels WHERE stream_path=:path"+(lock?" FOR NO KEY UPDATE":"")).param("path",path).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("stream_path"))).optional().orElse(null);}
    private Row find(UUID id,UUID channel,UUID author,boolean lock){var request=sql.sql(SELECT+" WHERE m.id=:id"+(channel==null?"":" AND m.channel_id=:channel")+(author==null?"":" AND m.author_id=:author")+(lock?" FOR UPDATE OF m":"")).param("id",id);if(channel!=null)request.param("channel",channel);if(author!=null)request.param("author",author);return request.query(this::row).optional().orElseThrow(()->new ProductProblem(404,"MISSION_NOT_FOUND","미션을 찾을 수 없어요."));}
    private Row row(ResultSet r,int index)throws SQLException{return new Row(r.getObject("id",UUID.class),r.getObject("channel_id",UUID.class),r.getObject("author_id",UUID.class),r.getObject("client_request_id",UUID.class),r.getString("broadcast_id"),r.getString("path"),r.getObject("broadcast_instance_id",UUID.class),r.getString("title"),r.getString("description"),r.getInt("duration_minutes"),r.getLong("deadline_at_ms"),r.getString("status"),r.getString("reason"),r.getInt("version"),r.getLong("created_at_ms"),r.getLong("updated_at_ms"),new Author(r.getObject("author_channel",UUID.class),r.getString("author_handle"),r.getString("author_name")));}
    private boolean active(Row row){Broadcast current=registry.get(row.broadcast());return current!=null&&current.path.equals(row.path())&&current.instanceId.equals(row.instance());}
    private Broadcast ready(String path,String id){media.list();if(!ProductNotifications.fresh(media))return null;Broadcast current=registry.get(id);var source=media.last().get(path);return current!=null&&current.path.equals(path)&&source!=null&&source.ready()&&current.seen!=null&&current.lastReadyMs>0&&ProductNotifications.source(source).equals(ProductNotifications.source(current.seen))?current:null;}
    private Mission view(Row r,List<History> history){return new Mission(r.id(),r.channel(),r.broadcast(),r.path(),r.title(),r.description(),r.minutes(),r.deadline(),r.status(),r.reason(),r.version(),r.created(),r.updated(),active(r),r.profile(),history);}
    private List<Mission> views(List<Row> rows){var histories=histories(rows);return rows.stream().map(row->view(row,histories.getOrDefault(row.id(),List.of()))).toList();}
    private Map<UUID,List<History>> histories(List<Row> rows){
        Map<UUID,List<History>> result=new HashMap<>();if(rows.isEmpty())return result;
        sql.sql("SELECT * FROM product_mission_history WHERE mission_id IN (:ids) ORDER BY mission_id,version").param("ids",rows.stream().map(Row::id).toList()).query((r,i)->{result.computeIfAbsent(r.getObject("mission_id",UUID.class),key->new ArrayList<>()).add(new History(r.getObject("id",UUID.class),r.getString("status"),r.getString("reason"),r.getString("actor"),r.getLong("created_at_ms")));return 0;}).list();return result;
    }
    private static boolean same(Row row,Draft draft){return row.path().equals(draft.path())&&row.broadcast().equals(draft.broadcast())&&row.title().equals(draft.title())&&row.description().equals(draft.description())&&row.minutes()==draft.minutes();}
    private static Search search(String q,String from,String to,String rawCursor,int limit){bounds(limit);if(Accounts.length(q)>120||q.codePoints().anyMatch(Character::isISOControl))throw filter();Long start,end;try{start=ChannelPolls.day(from,false);end=ChannelPolls.day(to,true);}catch(ProductProblem failure){throw filter();}if(start!=null&&end!=null&&start>=end)throw filter();return new Search(q.strip(),start,end,cursor(rawCursor));}
    private static String conditions(Search search){return(search.q().isBlank()?"":" AND position(lower(:query) IN lower(m.title || ' ' || m.description || ' ' || a.display_name || ' ' || ac.handle || ' ' || m.reason))>0")+(search.from()==null?"":" AND m.created_at_ms>=:from")+(search.to()==null?"":" AND m.created_at_ms<:to")+(search.cursor()==null?"":" AND (m.created_at_ms,m.id)<(:at,:id)");}
    private static JdbcClient.StatementSpec bind(JdbcClient.StatementSpec request,Search search,int limit){request.param("limit",limit+1);if(!search.q().isBlank())request.param("query",search.q());if(search.from()!=null)request.param("from",search.from());if(search.to()!=null)request.param("to",search.to());if(search.cursor()!=null)request.param("at",search.cursor().at()).param("id",search.cursor().id());return request;}
    static Draft draft(JsonNode input){if(input.size()!=6||!input.path("path").isString()||!input.path("broadcastId").isString()||!input.path("title").isString()||!input.path("description").isString()||!input.path("durationMinutes").isIntegralNumber()||!input.path("durationMinutes").canConvertToInt()||!input.path("clientRequestId").isString())throw invalid();String path=input.path("path").asString(),broadcast=input.path("broadcastId").asString();key(path,broadcast);int minutes=input.path("durationMinutes").intValue();if(!Set.of(15,30,60).contains(minutes))throw invalid();return new Draft(path,broadcast,text(input.path("title").asString(),100,false,false),text(input.path("description").asString(),1000,true,true),minutes,uuid(input.path("clientRequestId").asString()));}
    static Change change(JsonNode input){if(input.size()!=3||!input.path("status").isString()||!input.path("reason").isString())throw invalid();int version=version(input);String status=input.path("status").asString(),reason=text(input.path("reason").asString(),500,true,true);if(!Set.of("running","completed","rejected","canceled","failed").contains(status)||(!status.equals("running")&&ChatModeration.comparable(reason).isBlank()))throw invalid();return new Change(version,status,reason);}
    private static int cancelVersion(JsonNode input){if(input.size()!=1)throw invalid();return version(input);}
    private static int version(JsonNode input){if(!input.path("version").isIntegralNumber()||!input.path("version").canConvertToInt()||input.path("version").intValue()<0)throw invalid();return input.path("version").intValue();}
    static String text(String raw,int maximum,boolean blank,boolean multiline){String value=Normalizer.normalize(raw.replace("\r\n","\n").replace('\r','\n'),Normalizer.Form.NFC).strip();if(Accounts.length(value)>maximum||(!blank&&ChatModeration.comparable(value).isBlank())||value.codePoints().anyMatch(c->Character.isISOControl(c)&&(!multiline||(c!='\n'&&c!='\t'))))throw invalid();return value;}
    private static ProductNotifications.Cursor cursor(String raw){try{return ProductNotifications.decode(raw);}catch(ProductProblem failure){throw new ProductProblem(400,"INVALID_MISSION_CURSOR","미션 목록을 새로 불러와 주세요.");}}
    private static void bounds(int limit){if(limit<1||limit>100)throw filter();}
    private static void key(String path,String broadcast){if(!path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")||!broadcast.matches("[0-9a-f]{32}"))throw invalid();}
    private static UUID uuid(String raw){if(!raw.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return UUID.fromString(raw);}
    static ProductProblem invalid(){return new ProductProblem(400,"INVALID_MISSION_INPUT","미션 입력을 확인해 주세요.");}
    static ProductProblem filter(){return new ProductProblem(400,"INVALID_MISSION_FILTER","미션 검색 조건을 확인해 주세요.");}
    private static ProductProblem expired(){return new ProductProblem(409,"MISSION_EXPIRED","미션 진행 기한이 끝났어요. 최신 상태를 확인해 주세요.");}
    private static ProductProblem unavailable(){return new ProductProblem(409,"MISSION_BROADCAST_UNAVAILABLE","현재 방송에서만 미션을 제안할 수 있어요.");}
}
