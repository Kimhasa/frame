package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.playback.PlaybackController;
import frame.api.playback.ViewerSessions;
import frame.api.web.ClientAddress;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** Channel-scoped, non-cash balances. All mutations lock the same wallet row. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChannelPoints {
    public record Ledger(UUID id,String kind,long delta,long balanceAfter,String label,UUID redemptionId,long createdAtMs) {}
    public record Page(UUID userId,UUID channelId,long balance,List<Ledger> items,String nextCursor,long serverNowMs) {}
    public record Watch(UUID userId,UUID channelId,long balance,int pendingWatchMs,long creditedPoints,long acceptedMs,String reason,long serverNowMs) {}
    record Wallet(long balance,int pending,UUID visit,UUID instance,UUID process,String session,long sequence,Long at) {}
    record Pulse(String path,String broadcast,String session,UUID visit,long sequence,int eligible,boolean watching) {}
    static final long MAX_BALANCE=9000000000000L;
    private final UUID process=UUID.randomUUID();
    private final JdbcClient sql;private final BroadcastRegistry registry;private final MediaMtxPaths media;private final ViewerSessions sessions;private final ClientAddress client;
    public ChannelPoints(JdbcClient sql,BroadcastRegistry registry,MediaMtxPaths media,ViewerSessions sessions,ClientAddress client){this.sql=sql;this.registry=registry;this.media=media;this.sessions=sessions;this.client=client;}

    @Transactional(readOnly=true,timeout=3,isolation=Isolation.REPEATABLE_READ)
    public Page ledger(UUID user,String rawChannel,String cursor,int limit){
        UUID channel=ChannelRewards.uuid(rawChannel);ChannelRewards.bounds(limit);
        if(!sql.sql("SELECT EXISTS(SELECT 1 FROM product_channels WHERE id=:id)").param("id",channel).query(Boolean.class).single())throw new ProductProblem(404,"POINTS_CHANNEL_NOT_FOUND","채널을 찾을 수 없어요.");
        var after=ChannelRewards.cursor(cursor);String statement="SELECT * FROM product_point_ledger WHERE channel_id=:channel AND user_id=:user"+(after==null?"":" AND (created_at_ms,id)<(:at,:id)")+" ORDER BY created_at_ms DESC,id DESC LIMIT :limit";
        var request=sql.sql(statement).param("channel",channel).param("user",user).param("limit",limit+1);if(after!=null)request.param("at",after.at()).param("id",after.id());
        List<Ledger> rows=request.query((r,i)->new Ledger(r.getObject("id",UUID.class),r.getString("kind"),r.getLong("delta"),r.getLong("balance_after"),r.getString("label"),r.getObject("redemption_id",UUID.class),r.getLong("created_at_ms"))).list();boolean more=rows.size()>limit;List<Ledger> page=more?rows.subList(0,limit):rows;Ledger last=more?page.getLast():null;
        return new Page(user,channel,balance(channel,user),page,last==null?null:ProductNotifications.encode(last.createdAtMs(),last.id()),System.currentTimeMillis());
    }

    @Transactional(timeout=4)
    public Watch watch(UUID user,JsonNode input,HttpServletRequest request){
        Pulse pulse=pulse(input);UUID channel=sql.sql("SELECT id FROM product_channels WHERE stream_path=:path").param("path",pulse.path()).query(UUID.class).optional().orElse(null);
        long now=System.currentTimeMillis();if(channel==null)return new Watch(user,null,0,0,0,0,"broadcast_unavailable",now);
        Broadcast broadcast=ready(pulse.path(),pulse.broadcast());String ip=client.ip(request),key=PlaybackController.hlsKey(request,ip);
        boolean admitted=sessions.valid(pulse.path(),pulse.session(),key,ip);
        Wallet wallet=lock(channel,user);now=System.currentTimeMillis();
        boolean same=pulse.visit().equals(wallet.visit());
        if(same&&pulse.sequence()<=wallet.sequence())return result(user,channel,wallet,0,0,null,now);
        String refusal=broadcast==null?"broadcast_unavailable":!admitted?"session_unavailable":null;
        Broadcast latest=registry.get(pulse.broadcast());if(broadcast!=null&&(latest==null||!latest.path.equals(pulse.path())||!latest.instanceId.equals(broadcast.instanceId)))refusal="broadcast_unavailable";
        if(refusal!=null||!pulse.watching()){
            if(same)anchor(channel,user,pulse,wallet.instance(),null);
            return result(user,channel,wallet,0,0,refusal==null?"stopped":refusal,now);
        }
        boolean continuous=wallet.at()!=null&&process.equals(wallet.process())&&broadcast.instanceId.equals(wallet.instance())&&now>=wallet.at()&&now-wallet.at()<=25000;
        if(continuous&&!same)return result(user,channel,wallet,0,0,"watching_elsewhere",now);
        if(!continuous||!same||!pulse.session().equals(wallet.session())){anchor(channel,user,pulse,broadcast.instanceId,now);return result(user,channel,wallet,0,0,"baseline",now);}
        long accepted=Math.min(Math.min(now-wallet.at(),pulse.eligible()),20000);int accumulated=wallet.pending()+(int)accepted;long credit=(accumulated/60000)*10L;int pending=accumulated%60000;
        if(wallet.balance()+credit>MAX_BALANCE)throw new ProductProblem(409,"POINTS_BALANCE_LIMIT","보유할 수 있는 포인트 한도에 도달했어요.");
        sql.sql("UPDATE product_point_wallets SET balance=:balance,pending_watch_ms=:pending,watch_at_ms=:at,watch_sequence=:sequence WHERE channel_id=:channel AND user_id=:user").param("balance",wallet.balance()+credit).param("pending",pending).param("at",now).param("sequence",pulse.sequence()).param("channel",channel).param("user",user).update();
        if(credit>0)entry(channel,user,credit,"watch","방송 시청 적립",null,wallet.balance()+credit,now);
        return new Watch(user,channel,wallet.balance()+credit,pending,credit,accepted,null,now);
    }
    private Watch result(UUID user,UUID channel,Wallet wallet,long credit,long accepted,String reason,long now){return new Watch(user,channel,wallet.balance(),wallet.pending(),credit,accepted,reason,now);}
    private void anchor(UUID channel,UUID user,Pulse pulse,UUID instance,Long at){sql.sql("UPDATE product_point_wallets SET watch_visit=:visit,watch_instance=:instance,watch_process=:process,watch_session=:session,watch_sequence=:sequence,watch_at_ms=:at WHERE channel_id=:channel AND user_id=:user").param("visit",pulse.visit()).param("instance",instance,java.sql.Types.OTHER).param("process",process).param("session",pulse.session()).param("sequence",pulse.sequence()).param("at",at,java.sql.Types.BIGINT).param("channel",channel).param("user",user).update();}
    Wallet lock(UUID channel,UUID user){
        sql.sql("INSERT INTO product_point_wallets(channel_id,user_id) VALUES(:channel,:user) ON CONFLICT DO NOTHING").param("channel",channel).param("user",user).update();
        return sql.sql("SELECT * FROM product_point_wallets WHERE channel_id=:channel AND user_id=:user FOR UPDATE").param("channel",channel).param("user",user).query((r,i)->new Wallet(r.getLong("balance"),r.getInt("pending_watch_ms"),r.getObject("watch_visit",UUID.class),r.getObject("watch_instance",UUID.class),r.getObject("watch_process",UUID.class),r.getString("watch_session"),r.getLong("watch_sequence"),r.getObject("watch_at_ms",Long.class))).single();
    }
    long balance(UUID channel,UUID user){if(user==null)return 0;return sql.sql("SELECT balance FROM product_point_wallets WHERE channel_id=:channel AND user_id=:user").param("channel",channel).param("user",user).query(Long.class).optional().orElse(0L);}
    long change(UUID channel,UUID user,long delta,String kind,String label,UUID redemption,long now){Wallet wallet=lock(channel,user);long balance=wallet.balance()+delta;if(balance<0)throw new ProductProblem(409,"POINTS_INSUFFICIENT","포인트가 부족해요.");if(balance>MAX_BALANCE)throw new ProductProblem(409,"POINTS_BALANCE_LIMIT","보유할 수 있는 포인트 한도에 도달했어요.");sql.sql("UPDATE product_point_wallets SET balance=:balance WHERE channel_id=:channel AND user_id=:user").param("balance",balance).param("channel",channel).param("user",user).update();entry(channel,user,delta,kind,label,redemption,balance,now);return balance;}
    private void entry(UUID channel,UUID user,long delta,String kind,String label,UUID redemption,long balance,long now){sql.sql("INSERT INTO product_point_ledger(id,channel_id,user_id,kind,delta,balance_after,label,redemption_id,created_at_ms) VALUES(:id,:channel,:user,:kind,:delta,:balance,:label,:redemption,:at)").param("id",UUID.randomUUID()).param("channel",channel).param("user",user).param("kind",kind).param("delta",delta).param("balance",balance).param("label",label).param("redemption",redemption,java.sql.Types.OTHER).param("at",now).update();}
    Broadcast ready(String path,String id){media.list();if(!ProductNotifications.fresh(media))return null;Broadcast current=registry.get(id);var source=media.last().get(path);return current!=null&&current.path.equals(path)&&source!=null&&source.ready()&&current.seen!=null&&current.lastReadyMs>0&&ProductNotifications.source(source).equals(ProductNotifications.source(current.seen))?current:null;}
    static Pulse pulse(JsonNode input){try{if(input.size()!=7||!input.path("path").isString()||!input.path("broadcastId").isString()||!input.path("viewerSessionId").isString()||!input.path("visitId").isString()||!input.path("sequence").isIntegralNumber()||!input.path("sequence").canConvertToLong()||!input.path("eligibleMs").isIntegralNumber()||!input.path("eligibleMs").canConvertToInt()||!input.path("watching").isBoolean())throw invalid();String path=input.path("path").asString(),broadcast=input.path("broadcastId").asString(),session=input.path("viewerSessionId").asString();ChannelRewards.key(path,broadcast);long sequence=input.path("sequence").longValue();int eligible=input.path("eligibleMs").intValue();if(!session.matches("[0-9a-f]{32}")||sequence<0||sequence>9007199254740991L||eligible<0||eligible>20000)throw invalid();return new Pulse(path,broadcast,session,ChannelRewards.uuid(input.path("visitId").asString()),sequence,eligible,input.path("watching").booleanValue());}catch(ProductProblem failure){throw invalid();}}
    private static ProductProblem invalid(){return new ProductProblem(400,"INVALID_POINTS_INPUT","시청 적립 요청을 확인해 주세요.");}
}
