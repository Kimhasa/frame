package frame.api.account;

import frame.api.broadcast.BroadcastRegistry;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Commits observed expiry before a later stale/invalid command is rejected. No worker or queue is needed. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class MissionExpiry {
    private record Candidate(UUID id,String broadcast,String path,UUID instance,long deadline,int version) {}
    private final JdbcClient sql;
    private final BroadcastRegistry registry;
    public MissionExpiry(JdbcClient sql,BroadcastRegistry registry){this.sql=sql;this.registry=registry;}

    @Transactional(propagation=Propagation.REQUIRES_NEW,timeout=3)
    public void channel(UUID channel){expire("channel_id=:scope",channel,null,null);}

    @Transactional(propagation=Propagation.REQUIRES_NEW,timeout=3)
    public void mine(UUID author,String path,String broadcast){expire("author_id=:scope AND path=:path AND broadcast_id=:broadcast",author,path,broadcast);}

    private void expire(String scope,UUID id,String path,String broadcast){
        var request=sql.sql("SELECT id,broadcast_id,path,broadcast_instance_id,deadline_at_ms,version FROM product_missions WHERE "+scope+" AND status IN ('received','running') ORDER BY id FOR UPDATE").param("scope",id);
        if(path!=null)request.param("path",path).param("broadcast",broadcast);
        var rows=request.query((r,i)->new Candidate(r.getObject("id",UUID.class),r.getString("broadcast_id"),r.getString("path"),r.getObject("broadcast_instance_id",UUID.class),r.getLong("deadline_at_ms"),r.getInt("version"))).list();
        for(Candidate row:rows){
            long now=System.currentTimeMillis();var current=registry.get(row.broadcast());
            String reason=reason(row.deadline(),current!=null&&current.path.equals(row.path())&&current.instanceId.equals(row.instance()),now);
            if(reason==null)continue;
            expireOne(sql,row.id(),row.version(),reason,row.deadline()<=now?row.deadline():now);
        }
    }

    static String reason(long deadline,boolean active,long now){return deadline<=now?"미션 진행 기한이 지났어요.":!active?"방송이 종료되어 미션 진행 기한이 끝났어요.":null;}
    static void expireOne(JdbcClient sql,UUID id,int version,String reason,long at){
        sql.sql("UPDATE product_missions SET status='expired',reason=:reason,updated_at_ms=:at,version=version+1 WHERE id=:id").param("reason",reason).param("at",at).param("id",id).update();
        history(sql,id,version+1,"expired",reason,"system",at);
    }

    static void history(JdbcClient sql,UUID mission,int version,String status,String reason,String actor,long now){
        sql.sql("INSERT INTO product_mission_history(id,mission_id,version,status,reason,actor,created_at_ms) VALUES(:id,:mission,:version,:status,:reason,:actor,:at)")
                .param("id",UUID.randomUUID()).param("mission",mission).param("version",version).param("status",status).param("reason",reason).param("actor",actor).param("at",now).update();
    }
}
