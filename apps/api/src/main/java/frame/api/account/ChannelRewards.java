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
public class ChannelRewards {
    public record Reward(UUID id,UUID channelId,String name,int points,String limit,boolean enabled,int version,long createdAtMs,long updatedAtMs) {}
    public record User(UUID channelId,String handle,String displayName) {}
    public record Redemption(UUID id,UUID channelId,UUID rewardId,String rewardName,int points,String broadcastId,String path,User user,String note,String reason,String status,int version,long createdAtMs,long updatedAtMs) {}
    public record OwnRedemption(UUID id,UUID channelId,UUID rewardId,String rewardName,int points,String broadcastId,String path,User user,String note,String reason,String status,int version,long createdAtMs,long updatedAtMs,UUID clientRequestId) {
        OwnRedemption(Redemption r,UUID request){this(r.id(),r.channelId(),r.rewardId(),r.rewardName(),r.points(),r.broadcastId(),r.path(),r.user(),r.note(),r.reason(),r.status(),r.version(),r.createdAtMs(),r.updatedAtMs(),request);}
    }
    public record RewardPage(UUID userId,List<Reward> items,String nextCursor,long serverNowMs) {}
    public record ManagedReward(UUID userId,Reward item,long serverNowMs) {}
    public record RewardSaved(boolean created,ManagedReward result) {}
    public record RedemptionPage(UUID userId,List<Redemption> items,String nextCursor,long serverNowMs) {}
    public record ManagedRedemption(UUID userId,Redemption item,long serverNowMs) {}
    public record Submitted(UUID userId,OwnRedemption item,long balance,long serverNowMs) {}
    public record RedemptionSaved(boolean created,Submitted result) {}
    public record Current(UUID userId,UUID channelId,List<Reward> rewards,List<UUID> usedRewardIds,Long balance,List<OwnRedemption> mine,String nextCursor,boolean canRedeem,String reason,long serverNowMs) {}
    record Draft(String name,int points,String limit,boolean enabled) {}
    private record Channel(UUID id,UUID owner,String path) {}
    private record Request(UUID reward,int version,String path,String broadcast,String note,UUID request) {}
    private record Row(Redemption item,UUID user,UUID request,int requestedVersion,UUID instance) {}
    private static final String REDEMPTIONS="SELECT r.*,a.display_name AS user_name,uc.id AS user_channel,uc.handle AS user_handle FROM product_redemptions r JOIN product_accounts a ON a.id=r.user_id JOIN product_channels uc ON uc.owner_id=a.id";
    private final JdbcClient sql;private final ChannelPoints points;private final BroadcastRegistry registry;private final JsonMapper json;
    public ChannelRewards(JdbcClient sql,ChannelPoints points,BroadcastRegistry registry,JsonMapper json){this.sql=sql;this.points=points;this.registry=registry;this.json=json;}

    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ)
    public RewardPage rewards(UUID user,String status,String q,String from,String to,String cursor,int limit){
        Channel channel=owned(user,false);if(!List.of("all","enabled","disabled").contains(status))throw filter();Search search=search(q,from,to,cursor,limit);
        String statement="SELECT * FROM product_rewards WHERE channel_id=:channel"+(status.equals("all")?"":" AND enabled="+status.equals("enabled"))+conditions(search,"name","")+" ORDER BY created_at_ms DESC,id DESC LIMIT :limit";
        var request=bind(sql.sql(statement).param("channel",channel.id()),search,limit);List<Reward> rows=request.query(this::reward).list();boolean more=rows.size()>limit;List<Reward> page=more?rows.subList(0,limit):rows;Reward last=more?page.getLast():null;
        return new RewardPage(user,page,last==null?null:ProductNotifications.encode(last.createdAtMs(),last.id()),System.currentTimeMillis());
    }
    @Transactional(readOnly=true,timeout=3) public ManagedReward reward(UUID user,String id){Channel own=owned(user,false);return new ManagedReward(user,findReward(uuid(id),own.id(),false),System.currentTimeMillis());}
    @Transactional(timeout=3) public RewardSaved create(UUID user,JsonNode input){
        Draft draft=draft(input,true);UUID requestId=uuid(input.path("clientRequestId").asString());String payload=json.writeValueAsString(draft);Channel own=owned(user,true);
        UUID old=sql.sql("SELECT id FROM product_rewards WHERE channel_id=:channel AND client_request_id=:request").param("channel",own.id()).param("request",requestId).query(UUID.class).optional().orElse(null);
        if(old!=null){String previous=sql.sql("SELECT create_payload FROM product_rewards WHERE id=:id").param("id",old).query(String.class).single();if(!previous.equals(payload))throw new ProductProblem(409,"REWARD_REQUEST_CONFLICT","이미 다른 보상에 사용한 요청이에요.");return new RewardSaved(false,new ManagedReward(user,findReward(old,own.id(),false),System.currentTimeMillis()));}
        if(sql.sql("SELECT count(*) FROM product_rewards WHERE channel_id=:channel").param("channel",own.id()).query(Integer.class).single()>=50)throw new ProductProblem(409,"REWARD_LIMIT_REACHED","보상은 50개까지 등록할 수 있어요. 기존 보상을 수정해 주세요.");
        UUID id=UUID.randomUUID();long now=System.currentTimeMillis();sql.sql("INSERT INTO product_rewards(id,channel_id,client_request_id,create_payload,name,points,redemption_limit,enabled,created_at_ms,updated_at_ms) VALUES(:id,:channel,:request,:payload,:name,:points,:limit,:enabled,:at,:at)").param("id",id).param("channel",own.id()).param("request",requestId).param("payload",payload).param("name",draft.name()).param("points",draft.points()).param("limit",draft.limit()).param("enabled",draft.enabled()).param("at",now).update();return new RewardSaved(true,new ManagedReward(user,findReward(id,own.id(),false),now));
    }
    @Transactional(timeout=3) public ManagedReward update(UUID user,String rawId,JsonNode input){
        Draft draft=draft(input,false);Channel own=owned(user,true);Reward reward=findReward(uuid(rawId),own.id(),true);int version=version(input,"version",false);if(reward.version()!=version)throw conflict();long now=System.currentTimeMillis();
        sql.sql("UPDATE product_rewards SET name=:name,points=:points,redemption_limit=:limit,enabled=:enabled,version=version+1,updated_at_ms=:at WHERE id=:id").param("name",draft.name()).param("points",draft.points()).param("limit",draft.limit()).param("enabled",draft.enabled()).param("at",now).param("id",reward.id()).update();return new ManagedReward(user,findReward(reward.id(),own.id(),false),now);
    }

    @Transactional(readOnly=true,timeout=4,isolation=Isolation.REPEATABLE_READ)
    public Current current(UUID user,String path,String broadcast,String cursor,int limit){
        key(path,broadcast);bounds(limit);var after=cursor(cursor);Channel channel=byPath(path,false);Broadcast current=points.ready(path,broadcast);boolean active=channel!=null&&current!=null;UUID context=channel==null?null:channel.id();
        if(!active&&user!=null)context=sql.sql("SELECT channel_id FROM product_redemptions WHERE user_id=:user AND path=:path AND broadcast_id=:broadcast ORDER BY created_at_ms DESC,id DESC LIMIT 1").param("user",user).param("path",path).param("broadcast",broadcast).query(UUID.class).optional().orElse(context);
        List<Reward> rewards=active?sql.sql("SELECT * FROM product_rewards WHERE channel_id=:channel AND enabled ORDER BY created_at_ms DESC,id DESC").param("channel",channel.id()).query(this::reward).list():List.of();
        List<UUID> used=active&&user!=null?sql.sql("SELECT DISTINCT reward_id FROM product_redemptions WHERE channel_id=:channel AND user_id=:user AND broadcast_instance_id=:instance").param("channel",channel.id()).param("user",user).param("instance",current.instanceId).query(UUID.class).list():List.of();
        List<Row> mine=List.of();if(user!=null&&context!=null){String statement=REDEMPTIONS+" WHERE r.user_id=:user AND r.channel_id=:channel AND r.path=:path AND r.broadcast_id=:broadcast"+(after==null?"":" AND (r.created_at_ms,r.id)<(:at,:id)")+" ORDER BY r.created_at_ms DESC,r.id DESC LIMIT :limit";var request=sql.sql(statement).param("user",user).param("channel",context).param("path",path).param("broadcast",broadcast).param("limit",limit+1);if(after!=null)request.param("at",after.at()).param("id",after.id());mine=request.query(this::row).list();}
        boolean more=mine.size()>limit;List<Row> page=more?mine.subList(0,limit):mine;Row last=more?page.getLast():null;String reason=!active?"broadcast_unavailable":eligibility(user,channel,System.currentTimeMillis());
        if(active){Broadcast latest=registry.get(broadcast);if(latest==null||!latest.path.equals(path)||!latest.instanceId.equals(current.instanceId)){rewards=List.of();used=List.of();reason="broadcast_unavailable";}}
        return new Current(user,context,rewards,used,user==null?null:context==null?0L:points.balance(context,user),page.stream().map(this::own).toList(),last==null?null:ProductNotifications.encode(last.item().createdAtMs(),last.item().id()),reason==null,reason,System.currentTimeMillis());
    }

    @Transactional(timeout=4)
    public RedemptionSaved redeem(UUID user,String rawReward,JsonNode input){
        Request draft=request(uuid(rawReward),input);accountLock(user);
        Row previous=sql.sql(REDEMPTIONS+" WHERE r.user_id=:user AND r.client_request_id=:request").param("user",user).param("request",draft.request()).query(this::row).optional().orElse(null);
        if(previous!=null){Redemption r=previous.item();if(!r.rewardId().equals(draft.reward())||previous.requestedVersion()!=draft.version()||!r.path().equals(draft.path())||!r.broadcastId().equals(draft.broadcast())||!r.note().equals(draft.note()))throw new ProductProblem(409,"REDEMPTION_REQUEST_CONFLICT","이미 다른 교환 신청에 사용한 요청이에요.");return receipt(user,previous,false);}
        Channel channel=byPath(draft.path(),true);Broadcast current=points.ready(draft.path(),draft.broadcast());if(channel==null||current==null)throw unavailable();Reward reward=findReward(draft.reward(),channel.id(),true);
        if(reward.version()!=draft.version())throw conflict();if(!reward.enabled())throw new ProductProblem(409,"REWARD_DISABLED","현재 신청할 수 없는 보상이에요.");
        String eligibility=eligibility(user,channel,System.currentTimeMillis());if("blocked".equals(eligibility))throw new ProductProblem(403,"REWARD_PARTICIPATION_BLOCKED","이 채널에서는 보상을 신청할 수 없어요.");if("followers_only".equals(eligibility))throw new ProductProblem(403,"REWARD_FOLLOW_REQUIRED","채널을 팔로우한 뒤 보상을 신청해 주세요.");
        boolean once=reward.limit().equals("once_per_broadcast");if(once&&sql.sql("SELECT EXISTS(SELECT 1 FROM product_redemptions WHERE user_id=:user AND reward_id=:reward AND broadcast_instance_id=:instance)").param("user",user).param("reward",reward.id()).param("instance",current.instanceId).query(Boolean.class).single())throw new ProductProblem(409,"REWARD_ALREADY_REDEEMED","이번 방송에서 이미 신청한 보상이에요.");
        // A non-key channel lock coordinates policy/price edits without blocking wallet FK KEY SHARE locks.
        points.lock(channel.id(),user);Broadcast latest=registry.get(draft.broadcast());if(latest==null||!latest.path.equals(draft.path())||!latest.instanceId.equals(current.instanceId))throw unavailable();
        UUID id=UUID.randomUUID();long now=System.currentTimeMillis();sql.sql("INSERT INTO product_redemptions(id,channel_id,reward_id,user_id,client_request_id,requested_reward_version,reward_name,points,once_per_broadcast,broadcast_id,path,broadcast_instance_id,note,created_at_ms,updated_at_ms) VALUES(:id,:channel,:reward,:user,:request,:version,:name,:points,:once,:broadcast,:path,:instance,:note,:at,:at)")
                .param("id",id).param("channel",channel.id()).param("reward",reward.id()).param("user",user).param("request",draft.request()).param("version",draft.version()).param("name",reward.name()).param("points",reward.points()).param("once",once).param("broadcast",draft.broadcast()).param("path",draft.path()).param("instance",current.instanceId).param("note",draft.note()).param("at",now).update();
        points.change(channel.id(),user,-reward.points(),"redemption",reward.name(),id,now);return receipt(user,find(id,null,false),true);
    }

    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ)
    public RedemptionPage redemptions(UUID user,String status,String q,String from,String to,String cursor,int limit){
        Channel own=owned(user,false);if(!List.of("all","pending","processing","completed","rejected","canceled").contains(status))throw filter();Search search=search(q,from,to,cursor,limit);
        String statement=REDEMPTIONS+" WHERE r.channel_id=:channel"+(status.equals("all")?"":" AND r.status=:status")+conditions(search,"r.reward_name || ' ' || a.display_name || ' ' || uc.handle || ' ' || r.note || ' ' || r.reason","r.")+" ORDER BY r.created_at_ms DESC,r.id DESC LIMIT :limit";
        var request=bind(sql.sql(statement).param("channel",own.id()),search,limit);if(!status.equals("all"))request.param("status",status);List<Row> rows=request.query(this::row).list();boolean more=rows.size()>limit;List<Row> page=more?rows.subList(0,limit):rows;Row last=more?page.getLast():null;return new RedemptionPage(user,page.stream().map(Row::item).toList(),last==null?null:ProductNotifications.encode(last.item().createdAtMs(),last.item().id()),System.currentTimeMillis());
    }
    @Transactional(readOnly=true,timeout=3) public ManagedRedemption redemption(UUID user,String id){Channel own=owned(user,false);return new ManagedRedemption(user,find(uuid(id),own.id(),false).item(),System.currentTimeMillis());}
    @Transactional(timeout=3) public ManagedRedemption review(UUID user,String id,JsonNode input){
        Channel own=owned(user,false);Row row=find(uuid(id),own.id(),true);if(input.size()!=3||!input.path("status").isString()||!input.path("reason").isString())throw redemptionInput();int version=version(input,"version",true);String status=input.path("status").asString(),reason=text(input.path("reason").asString(),500,true,true);
        if(!List.of("processing","completed","rejected","canceled").contains(status)||((status.equals("rejected")||status.equals("canceled"))&&reason.isBlank()))throw redemptionInput();check(row,version);
        if(row.item().status().equals("processing")&&status.equals("processing"))throw new ProductProblem(409,"REDEMPTION_INVALID_TRANSITION","현재 상태에서 선택한 상태로 변경할 수 없어요.");
        change(row,status,reason);return new ManagedRedemption(user,find(row.item().id(),own.id(),false).item(),System.currentTimeMillis());
    }
    @Transactional(timeout=3) public Submitted cancel(UUID user,String id,JsonNode input){
        if(input.size()!=1)throw redemptionInput();int version=version(input,"version",true);Row row=sql.sql(REDEMPTIONS+" WHERE r.id=:id AND r.user_id=:user FOR UPDATE OF r").param("id",uuid(id)).param("user",user).query(this::row).optional().orElseThrow(ChannelRewards::missingRedemption);check(row,version);if(!row.item().status().equals("pending"))throw new ProductProblem(409,"REDEMPTION_INVALID_TRANSITION","처리가 시작된 신청은 직접 취소할 수 없어요.");change(row,"canceled","신청자가 취소했어요.");return receipt(user,find(row.item().id(),null,false),false).result();
    }
    private void check(Row row,int version){if(row.item().version()!=version)throw new ProductProblem(409,"REDEMPTION_CONFLICT","다른 화면에서 신청이 바뀌었어요. 최신 내용을 불러와 주세요.");if(!List.of("pending","processing").contains(row.item().status()))throw new ProductProblem(409,"REDEMPTION_ALREADY_CLOSED","이미 처리가 끝난 신청이에요.");}
    private void change(Row row,String status,String reason){long now=System.currentTimeMillis();if(status.equals("rejected")||status.equals("canceled"))points.change(row.item().channelId(),row.user(),row.item().points(),"refund",row.item().rewardName(),row.item().id(),now);sql.sql("UPDATE product_redemptions SET status=:status,reason=:reason,version=version+1,updated_at_ms=:at WHERE id=:id").param("status",status).param("reason",reason).param("at",now).param("id",row.item().id()).update();}
    private RedemptionSaved receipt(UUID user,Row row,boolean created){return new RedemptionSaved(created,new Submitted(user,own(row),points.balance(row.item().channelId(),user),System.currentTimeMillis()));}
    private OwnRedemption own(Row row){return new OwnRedemption(row.item(),row.request());}
    private String eligibility(UUID user,Channel channel,long now){if(user==null)return "login_required";if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:user AND (expires_at_ms IS NULL OR expires_at_ms>:now))").param("channel",channel.id()).param("user",user).param("now",now).query(Boolean.class).single())return "blocked";if(!channel.owner().equals(user)&&sql.sql("SELECT coalesce((SELECT followers_only FROM product_chat_settings WHERE channel_id=:channel),false) AND NOT EXISTS(SELECT 1 FROM product_follows WHERE channel_id=:channel AND user_id=:user)").param("channel",channel.id()).param("user",user).query(Boolean.class).single())return "followers_only";return null;}
    private void accountLock(UUID user){if(sql.sql("SELECT id FROM product_accounts WHERE id=:user FOR NO KEY UPDATE").param("user",user).query(UUID.class).optional().isEmpty())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");}
    private Channel owned(UUID user,boolean lock){return sql.sql("SELECT id,owner_id,stream_path FROM product_channels WHERE owner_id=:user"+(lock?" FOR NO KEY UPDATE":"")).param("user",user).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("stream_path"))).optional().orElseThrow(()->new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요."));}
    private Channel byPath(String path,boolean lock){return sql.sql("SELECT id,owner_id,stream_path FROM product_channels WHERE stream_path=:path"+(lock?" FOR NO KEY UPDATE":"")).param("path",path).query((r,i)->new Channel(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("stream_path"))).optional().orElse(null);}
    private Reward findReward(UUID id,UUID channel,boolean lock){return sql.sql("SELECT * FROM product_rewards WHERE id=:id AND channel_id=:channel"+(lock?" FOR UPDATE":"")).param("id",id).param("channel",channel).query(this::reward).optional().orElseThrow(()->new ProductProblem(404,"REWARD_NOT_FOUND","보상을 찾을 수 없어요."));}
    private Row find(UUID id,UUID channel,boolean lock){var request=sql.sql(REDEMPTIONS+" WHERE r.id=:id"+(channel==null?"":" AND r.channel_id=:channel")+(lock?" FOR UPDATE OF r":"")).param("id",id);if(channel!=null)request.param("channel",channel);return request.query(this::row).optional().orElseThrow(ChannelRewards::missingRedemption);}
    private Reward reward(ResultSet r,int i)throws SQLException{return new Reward(r.getObject("id",UUID.class),r.getObject("channel_id",UUID.class),r.getString("name"),r.getInt("points"),r.getString("redemption_limit"),r.getBoolean("enabled"),r.getInt("version"),r.getLong("created_at_ms"),r.getLong("updated_at_ms"));}
    private Row row(ResultSet r,int i)throws SQLException{return new Row(new Redemption(r.getObject("id",UUID.class),r.getObject("channel_id",UUID.class),r.getObject("reward_id",UUID.class),r.getString("reward_name"),r.getInt("points"),r.getString("broadcast_id"),r.getString("path"),new User(r.getObject("user_channel",UUID.class),r.getString("user_handle"),r.getString("user_name")),r.getString("note"),r.getString("reason"),r.getString("status"),r.getInt("version"),r.getLong("created_at_ms"),r.getLong("updated_at_ms")),r.getObject("user_id",UUID.class),r.getObject("client_request_id",UUID.class),r.getInt("requested_reward_version"),r.getObject("broadcast_instance_id",UUID.class));}
    private record Search(String q,Long from,Long to,ProductNotifications.Cursor cursor) {}
    private static Search search(String q,String from,String to,String cursor,int limit){bounds(limit);if(Accounts.length(q)>120||q.codePoints().anyMatch(Character::isISOControl))throw filter();Long start,end;try{start=ChannelPolls.day(from,false);end=ChannelPolls.day(to,true);}catch(ProductProblem failure){throw filter();}if(start!=null&&end!=null&&start>=end)throw filter();return new Search(q.strip(),start,end,cursor(cursor));}
    private static String conditions(Search search,String content,String alias){return(search.q().isBlank()?"":" AND position(lower(:query) IN lower("+content+"))>0")+(search.from()==null?"":" AND "+alias+"created_at_ms>=:from")+(search.to()==null?"":" AND "+alias+"created_at_ms<:to")+(search.cursor()==null?"":" AND ("+alias+"created_at_ms,"+alias+"id)<(:at,:id)");}
    private static JdbcClient.StatementSpec bind(JdbcClient.StatementSpec request,Search search,int limit){request.param("limit",limit+1);if(!search.q().isBlank())request.param("query",search.q());if(search.from()!=null)request.param("from",search.from());if(search.to()!=null)request.param("to",search.to());if(search.cursor()!=null)request.param("at",search.cursor().at()).param("id",search.cursor().id());return request;}
    static Draft draft(JsonNode input,boolean create){if(input.size()!=5||!input.path("name").isString()||!input.path("points").isIntegralNumber()||!input.path("points").canConvertToInt()||!input.path("limit").isString()||!input.path("enabled").isBoolean()||(create?!input.path("clientRequestId").isString():!input.has("version")))throw invalid();String name=text(input.path("name").asString(),40,false,false),limit=input.path("limit").asString();int points=input.path("points").intValue();if(points<1||points>1000000||!List.of("once_per_broadcast","unlimited").contains(limit))throw invalid();if(create)uuid(input.path("clientRequestId").asString());else version(input,"version",false);return new Draft(name,points,limit,input.path("enabled").booleanValue());}
    private static Request request(UUID reward,JsonNode input){try{if(input.size()!=5||!input.path("path").isString()||!input.path("broadcastId").isString()||!input.path("note").isString()||!input.path("clientRequestId").isString())throw redemptionInput();String path=input.path("path").asString(),broadcast=input.path("broadcastId").asString();key(path,broadcast);return new Request(reward,version(input,"rewardVersion",true),path,broadcast,text(input.path("note").asString(),500,true,true),uuid(input.path("clientRequestId").asString()));}catch(ProductProblem failure){throw redemptionInput();}}
    static String text(String raw,int maximum,boolean blank,boolean multiline){String value=Normalizer.normalize(raw.replace("\r\n","\n").replace('\r','\n'),Normalizer.Form.NFC).strip();if(Accounts.length(value)>maximum||(!blank&&ChatModeration.comparable(value).isBlank())||value.codePoints().anyMatch(c->Character.isISOControl(c)&&(!multiline||(c!='\n'&&c!='\t'))))throw multiline?redemptionInput():invalid();return value;}
    static int version(JsonNode input,String field,boolean redemption){if(!input.path(field).isIntegralNumber()||!input.path(field).canConvertToInt()||input.path(field).intValue()<0)throw redemption?redemptionInput():invalid();return input.path(field).intValue();}
    static ProductNotifications.Cursor cursor(String value){try{return ProductNotifications.decode(value);}catch(ProductProblem failure){throw new ProductProblem(400,"INVALID_REWARD_CURSOR","목록을 새로 불러와 주세요.");}}
    static UUID uuid(String value){if(!value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return UUID.fromString(value);}
    static void key(String path,String broadcast){if(!path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")||!broadcast.matches("[0-9a-f]{32}"))throw invalid();}
    static void bounds(int limit){if(limit<1||limit>100)throw filter();}
    static ProductProblem filter(){return new ProductProblem(400,"INVALID_REWARD_FILTER","검색 조건을 확인해 주세요.");}
    private static ProductProblem invalid(){return new ProductProblem(400,"INVALID_REWARD_INPUT","보상 입력을 확인해 주세요.");}
    private static ProductProblem redemptionInput(){return new ProductProblem(400,"INVALID_REDEMPTION_INPUT","교환 신청 내용을 확인해 주세요.");}
    private static ProductProblem conflict(){return new ProductProblem(409,"REWARD_CONFLICT","보상 설정이 바뀌었어요. 최신 내용을 확인해 주세요.");}
    private static ProductProblem unavailable(){return new ProductProblem(409,"REWARD_BROADCAST_UNAVAILABLE","현재 방송에서만 보상을 신청할 수 있어요.");}
    private static ProductProblem missingRedemption(){return new ProductProblem(404,"REDEMPTION_NOT_FOUND","교환 신청을 찾을 수 없어요.");}
}
