package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.web.RateLimit;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChannelPolls {
    public record Option(UUID id,String text,long votes) {}
    public record Poll(UUID id,UUID channelId,String broadcastId,String path,String question,long createdAtMs,long endsAtMs,String status,String closeReason,int version,List<Option> options,long totalVotes,UUID myOptionId) {}
    public record CurrentBroadcast(String id,String path,String title) {}
    public record Page(UUID userId,List<Poll> items,String nextCursor,CurrentBroadcast currentBroadcast,UUID activePollId,long serverNowMs) {}
    public record Owned(UUID userId,Poll poll,long serverNowMs) {}
    public record PublicView(UUID userId,Poll poll,boolean canVote,String reason,long serverNowMs) {}
    record Draft(String question,List<String> options,int seconds,String broadcastId,String path) {}
    private record Channel(UUID id,String path) {}
    private record Row(UUID id,UUID channel,String broadcast,String path,UUID instance,String question,long created,long ends,Long closed,String reason,int version) {}
    private record OptionRow(UUID poll,Option option) {}
    private record Choice(UUID poll,UUID option) {}
    private final JdbcClient sql;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths media;
    private final RateLimit voteRate=new RateLimit(20,2),createRate=new RateLimit(8,0.1);
    public ChannelPolls(JdbcClient sql,BroadcastRegistry registry,MediaMtxPaths media){this.sql=sql;this.registry=registry;this.media=media;}

    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ) public Page list(UUID owner,String status,String query,String from,String to,String cursor,int limit){
        Channel channel=channel(owner,false);
        if(!Set.of("all","active","closed").contains(status)||Accounts.length(query)>120||query.codePoints().anyMatch(Character::isISOControl)||limit<1||limit>100)throw invalidFilter();
        Long start=day(from,false),end=day(to,true);if(start!=null&&end!=null&&start>=end)throw invalidFilter();
        ProductNotifications.Cursor after;
        try{after=ProductNotifications.decode(cursor);}catch(ProductProblem failure){throw new ProductProblem(400,"INVALID_POLL_CURSOR","투표 목록을 새로 불러와 주세요.");}
        long now=System.currentTimeMillis();Broadcast current=channel.path()==null?null:registry.byPath(channel.path());
        String active="(closed_at_ms IS NULL AND ends_at_ms>:now AND broadcast_instance_id=:instance AND broadcast_id=:broadcast)";
        StringBuilder statement=new StringBuilder("SELECT * FROM product_polls WHERE channel_id=:channel");
        if(!status.equals("all"))statement.append(" AND ").append(status.equals("active")?active:"NOT "+active);
        if(!query.isBlank())statement.append(" AND position(lower(:query) IN lower(question))>0");
        if(start!=null)statement.append(" AND created_at_ms>=:from");if(end!=null)statement.append(" AND created_at_ms<:to");
        if(after!=null)statement.append(" AND (created_at_ms,id)<(:cursorAt,:cursorId)");
        statement.append(" ORDER BY created_at_ms DESC,id DESC LIMIT :limit");
        var request=sql.sql(statement.toString()).param("channel",channel.id()).param("limit",limit+1);
        if(!status.equals("all"))request.param("now",now).param("instance",current==null?new UUID(0,0):current.instanceId).param("broadcast",current==null?"":current.id);
        if(!query.isBlank())request.param("query",query.strip());if(start!=null)request.param("from",start);if(end!=null)request.param("to",end);
        if(after!=null)request.param("cursorAt",after.at()).param("cursorId",after.id());
        List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> page=more?rows.subList(0,limit):rows;Row last=more?page.getLast():null;
        UUID activeId=current==null?null:sql.sql("SELECT id FROM product_polls WHERE channel_id=:channel AND "+active).param("channel",channel.id()).param("now",now).param("instance",current.instanceId).param("broadcast",current.id).query(UUID.class).optional().orElse(null);
        Broadcast ready=ready(channel);
        return new Page(owner,views(page,owner,now),last==null?null:ProductNotifications.encode(last.created(),last.id()),ready==null?null:new CurrentBroadcast(ready.id,ready.path,ready.title),activeId,now);
    }
    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ) public Owned detail(UUID owner,String id){Channel own=channel(owner,false);Row row=find(id(id),own.id());long now=System.currentTimeMillis();return new Owned(owner,views(List.of(row),owner,now).getFirst(),now);}

    @Transactional(timeout=3) public Owned create(UUID owner,JsonNode input){
        Channel own=channel(owner,true);Draft draft=draft(input);int wait=createRate.take(owner.toString());if(wait>0)throw new ProductProblem(429,"POLL_RATE_LIMITED","잠시 후 다시 투표를 만들어 주세요.",wait);
        Broadcast current=ready(own);if(current==null||!current.id.equals(draft.broadcastId())||!current.path.equals(draft.path()))throw unavailable();
        long now=System.currentTimeMillis();
        List<Row> previous=sql.sql("SELECT * FROM product_polls WHERE channel_id=:channel AND closed_at_ms IS NULL FOR UPDATE").param("channel",own.id()).query(this::row).list();
        for(Row poll:previous){String reason=reason(poll,now);if(reason==null)throw new ProductProblem(409,"POLL_ACTIVE_EXISTS","이미 진행 중인 투표가 있어요.");closeRow(poll,reason,reason.equals("expired")?poll.ends():now);}
        UUID id=UUID.randomUUID();sql.sql("INSERT INTO product_polls(id,channel_id,broadcast_id,path,broadcast_instance_id,question,created_at_ms,ends_at_ms) VALUES(:id,:channel,:broadcast,:path,:instance,:question,:at,:ends)")
                .param("id",id).param("channel",own.id()).param("broadcast",current.id).param("path",current.path).param("instance",current.instanceId).param("question",draft.question()).param("at",now).param("ends",now+draft.seconds()*1000L).update();
        for(int index=0;index<draft.options().size();index++)sql.sql("INSERT INTO product_poll_options(id,poll_id,position,text) VALUES(:id,:poll,:position,:text)").param("id",UUID.randomUUID()).param("poll",id).param("position",index).param("text",draft.options().get(index)).update();
        return new Owned(owner,views(List.of(find(id,own.id())),owner,now).getFirst(),now);
    }
    @Transactional(timeout=3) public Owned close(UUID owner,String id,JsonNode input){
        Channel own=channel(owner,true);Row poll=find(id(id),own.id());long now=System.currentTimeMillis();
        if(input.size()!=1||!input.path("version").isIntegralNumber()||!input.path("version").canConvertToInt()||input.path("version").intValue()<0)throw invalid();
        if(reason(poll,now)!=null)throw closed();if(poll.version()!=input.path("version").intValue())throw new ProductProblem(409,"POLL_CONFLICT","투표 상태가 바뀌었어요. 최신 결과를 불러와 주세요.");
        closeRow(poll,"manual",now);return new Owned(owner,views(List.of(find(poll.id(),own.id())),owner,now).getFirst(),now);
    }
    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ) public PublicView current(UUID viewer,String path,String broadcast){
        key(path,broadcast);Row poll=sql.sql("SELECT * FROM product_polls WHERE path=:path AND broadcast_id=:broadcast ORDER BY created_at_ms DESC,id DESC LIMIT 1").param("path",path).param("broadcast",broadcast).query(this::row).optional().orElse(null);
        long now=System.currentTimeMillis();
        if(poll==null){Broadcast entry=registry.get(broadcast);return new PublicView(viewer,null,false,entry!=null&&entry.path.equals(path)?null:"broadcast_unavailable",now);}
        return publicView(poll,viewer,now);
    }
    @Transactional(timeout=3) public PublicView vote(UUID viewer,String rawId,JsonNode input){
        if(input.size()!=3||!input.path("optionId").isString()||!input.path("path").isString()||!input.path("broadcastId").isString())throw invalid();
        UUID pollId=id(rawId),option=id(input.path("optionId").asString());String path=input.path("path").asString(),broadcast=input.path("broadcastId").asString();key(path,broadcast);
        Row first=find(pollId,null);
        sql.sql("SELECT id FROM product_channels WHERE id=:channel FOR UPDATE").param("channel",first.channel()).query(UUID.class).optional().orElseThrow(ChannelPolls::missing);
        Row poll=find(pollId,null);long now=System.currentTimeMillis();
        if(!poll.path().equals(path)||!poll.broadcast().equals(broadcast))throw new ProductProblem(409,"POLL_BROADCAST_MISMATCH","다른 방송의 투표예요. 현재 방송에서 다시 확인해 주세요.");
        if(!sql.sql("SELECT EXISTS(SELECT 1 FROM product_poll_options WHERE id=:id AND poll_id=:poll)").param("id",option).param("poll",pollId).query(Boolean.class).single())throw new ProductProblem(400,"INVALID_POLL_OPTION","선택지를 다시 확인해 주세요.");
        UUID previous=sql.sql("SELECT option_id FROM product_poll_votes WHERE poll_id=:poll AND user_id=:viewer").param("poll",pollId).param("viewer",viewer).query(UUID.class).optional().orElse(null);
        if(previous!=null){if(!previous.equals(option))throw new ProductProblem(409,"POLL_ALREADY_VOTED","이미 다른 선택지에 참여했어요.");return publicView(poll,viewer,now);}
        if(reason(poll,now)!=null)throw closed();
        String restriction=participation(viewer,poll.channel(),now);
        if("blocked".equals(restriction))throw new ProductProblem(403,"POLL_PARTICIPATION_BLOCKED","이 채널의 투표에 참여할 수 없어요.");
        if("followers_only".equals(restriction))throw new ProductProblem(403,"POLL_FOLLOW_REQUIRED","채널을 팔로우한 뒤 투표에 참여해 주세요.");
        if(restriction!=null)throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");
        int wait=voteRate.take(viewer.toString());if(wait>0)throw new ProductProblem(429,"POLL_RATE_LIMITED","잠시 후 다시 참여해 주세요.",wait);
        sql.sql("INSERT INTO product_poll_votes(poll_id,user_id,option_id,created_at_ms) VALUES(:poll,:user,:option,:at)").param("poll",pollId).param("user",viewer).param("option",option).param("at",now).update();
        return publicView(poll,viewer,now);
    }
    private PublicView publicView(Row row,UUID viewer,long now){
        Poll poll=views(List.of(row),viewer,now).getFirst();String restriction=poll.status().equals("closed")?"closed":viewer==null?"login_required":poll.myOptionId()!=null?"already_voted":participation(viewer,row.channel(),now);
        return new PublicView(viewer,poll,restriction==null,restriction,now);
    }
    private String participation(UUID viewer,UUID channel,long now){
        if(viewer==null||!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:id)").param("id",viewer).query(Boolean.class).single())return "login_required";
        if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:viewer AND (expires_at_ms IS NULL OR expires_at_ms>:now))").param("channel",channel).param("viewer",viewer).param("now",now).query(Boolean.class).single())return "blocked";
        return sql.sql("SELECT c.owner_id<>:viewer AND coalesce(s.followers_only,false) AND NOT EXISTS(SELECT 1 FROM product_follows f WHERE f.channel_id=c.id AND f.user_id=:viewer) FROM product_channels c LEFT JOIN product_chat_settings s ON s.channel_id=c.id WHERE c.id=:channel")
                .param("viewer",viewer).param("channel",channel).query(Boolean.class).optional().orElse(false)?"followers_only":null;
    }
    private List<Poll> views(List<Row> rows,UUID viewer,long now){
        if(rows.isEmpty())return List.of();List<UUID> ids=rows.stream().map(Row::id).toList();Map<UUID,List<Option>> options=new HashMap<>();
        sql.sql("SELECT o.poll_id,o.id,o.text,count(v.user_id) AS votes FROM product_poll_options o LEFT JOIN product_poll_votes v ON v.poll_id=o.poll_id AND v.option_id=o.id WHERE o.poll_id IN (:ids) GROUP BY o.poll_id,o.id,o.text,o.position ORDER BY o.position")
                .param("ids",ids).query((r,i)->new OptionRow(r.getObject("poll_id",UUID.class),new Option(r.getObject("id",UUID.class),r.getString("text"),r.getLong("votes")))).list().forEach(row->options.computeIfAbsent(row.poll(),ignored->new ArrayList<>()).add(row.option()));
        Map<UUID,UUID> choices=new HashMap<>();if(viewer!=null)sql.sql("SELECT poll_id,option_id FROM product_poll_votes WHERE user_id=:viewer AND poll_id IN (:ids)").param("viewer",viewer).param("ids",ids).query((r,i)->new Choice(r.getObject("poll_id",UUID.class),r.getObject("option_id",UUID.class))).list().forEach(choice->choices.put(choice.poll(),choice.option()));
        return rows.stream().map(row->{String reason=reason(row,now);List<Option> list=List.copyOf(options.getOrDefault(row.id(),List.of()));return new Poll(row.id(),row.channel(),row.broadcast(),row.path(),row.question(),row.created(),row.ends(),reason==null?"active":"closed",reason,row.version(),list,list.stream().mapToLong(Option::votes).sum(),choices.get(row.id()));}).toList();
    }
    private String reason(Row row,long now){if(row.reason()!=null)return row.reason();if(now>=row.ends())return "expired";Broadcast current=registry.get(row.broadcast());return current==null||!current.path.equals(row.path())||!current.instanceId.equals(row.instance())?"broadcast_ended":null;}
    private Broadcast ready(Channel channel){if(channel.path()==null||!ProductNotifications.fresh(media))return null;Broadcast current=registry.byPath(channel.path());MediaPath source=media.last().get(channel.path());return current!=null&&source!=null&&source.ready()&&current.seen!=null&&current.lastReadyMs>0&&ProductNotifications.source(source).equals(ProductNotifications.source(current.seen))?current:null;}
    private Channel channel(UUID user,boolean lock){return sql.sql("SELECT id,stream_path FROM product_channels WHERE owner_id=:user"+(lock?" FOR UPDATE":"")).param("user",user).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getString("stream_path"))).optional().orElseThrow(()->new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요."));}
    private Row find(UUID id,UUID ownerChannel){var request=sql.sql("SELECT * FROM product_polls WHERE id=:id"+(ownerChannel==null?"":" AND channel_id=:channel")).param("id",id);if(ownerChannel!=null)request.param("channel",ownerChannel);return request.query(this::row).optional().orElseThrow(ChannelPolls::missing);}
    private Row row(ResultSet r,int index)throws SQLException{return new Row(r.getObject("id",UUID.class),r.getObject("channel_id",UUID.class),r.getString("broadcast_id"),r.getString("path"),r.getObject("broadcast_instance_id",UUID.class),r.getString("question"),r.getLong("created_at_ms"),r.getLong("ends_at_ms"),r.getObject("closed_at_ms",Long.class),r.getString("close_reason"),r.getInt("version"));}
    private void closeRow(Row row,String reason,long at){sql.sql("UPDATE product_polls SET closed_at_ms=:at,close_reason=:reason,version=version+1 WHERE id=:id").param("at",at).param("reason",reason).param("id",row.id()).update();}
    static Draft draft(JsonNode input){
        if(input.size()!=5||!input.path("question").isString()||!input.path("options").isArray()||input.path("options").size()<2||input.path("options").size()>8||!input.path("durationSeconds").isIntegralNumber()||!input.path("durationSeconds").canConvertToInt()||!Set.of(60,180,300,600).contains(input.path("durationSeconds").intValue())||!input.path("path").isString()||!input.path("broadcastId").isString())throw invalid();
        String question=text(input.path("question").asString());List<String> options=new ArrayList<>();Set<String> distinct=new HashSet<>();for(JsonNode value:input.path("options")){if(!value.isString())throw invalid();String option=text(value.asString());if(!distinct.add(Normalizer.normalize(option,Normalizer.Form.NFKC).toLowerCase(Locale.ROOT)))throw new ProductProblem(400,"DUPLICATE_POLL_OPTIONS","서로 다른 선택지를 입력해 주세요.");options.add(option);}
        String path=input.path("path").asString(),broadcast=input.path("broadcastId").asString();key(path,broadcast);return new Draft(question,List.copyOf(options),input.path("durationSeconds").intValue(),broadcast,path);
    }
    private static String text(String value){value=value.strip();if(Accounts.length(value)<1||Accounts.length(value)>100||value.codePoints().anyMatch(Character::isISOControl)||ChatModeration.comparable(value).isBlank())throw invalid();return value;}
    static Long day(String value,boolean after){if(value.isEmpty())return null;if(!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))throw invalidFilter();try{LocalDate date=LocalDate.parse(value);return (after?date.plusDays(1):date).atStartOfDay(ZoneId.of("Asia/Seoul")).toInstant().toEpochMilli();}catch(DateTimeException failure){throw invalidFilter();}}
    static void key(String path,String broadcast){if(!path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")||!broadcast.matches("[0-9a-f]{32}"))throw invalid();}
    static UUID id(String value){if(!value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return UUID.fromString(value);}
    static ProductProblem invalid(){return new ProductProblem(400,"INVALID_POLL_INPUT","투표 입력을 확인해 주세요.");}
    private static ProductProblem invalidFilter(){return new ProductProblem(400,"INVALID_POLL_FILTER","투표 검색 조건을 확인해 주세요.");}
    private static ProductProblem missing(){return new ProductProblem(404,"POLL_NOT_FOUND","투표를 찾을 수 없어요.");}
    private static ProductProblem unavailable(){return new ProductProblem(409,"POLL_BROADCAST_UNAVAILABLE","현재 송출 중인 방송에서 투표를 시작해 주세요.");}
    private static ProductProblem closed(){return new ProductProblem(409,"POLL_CLOSED","이미 마감된 투표예요.");}
}
