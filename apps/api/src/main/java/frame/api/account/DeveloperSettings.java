package frame.api.account;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Browser-only credential management. API key plaintext is never persisted. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class DeveloperSettings {
    public record Key(UUID id,String name,List<String> scopes,String prefix,String last4,long createdAtMs,Long lastUsedAtMs,Long revokedAtMs,int version,UUID clientRequestId) {}
    public record Webhook(UUID id,String name,String url,List<String> events,boolean enabled,long createdAtMs,long updatedAtMs,Long revokedAtMs,int version,UUID clientRequestId) {}
    public record Delivery(UUID id,UUID webhookId,String event,UUID eventId,UUID clientRequestId,String status,long createdAtMs,Long startedAtMs,Long completedAtMs,Integer httpStatus,String errorCode) {}
    public record Access(UUID ownerId,List<String> scopes) {}
    record Job(Delivery delivery,String url,byte[] secret,byte[] body) {}
    private static final Set<String> SCOPES=Set.of("broadcast:read","analytics:read","chat:manage");
    private static final Set<String> EVENTS=Set.of("broadcast.started","broadcast.ended");
    private static final SecureRandom RANDOM=new SecureRandom();
    private final JdbcClient sql; private final JsonMapper json; private final WebhookSender sender;
    public DeveloperSettings(JdbcClient sql,JsonMapper json,WebhookSender sender){this.sql=sql;this.json=json;this.sender=sender;}

    private void owner(UUID owner,boolean lock){
        if(lock)bounded();
        if(sql.sql("SELECT id FROM product_accounts WHERE id=:owner"+(lock?" FOR NO KEY UPDATE":"")).param("owner",owner).query(UUID.class).optional().isEmpty())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");
    }
    public Map<String,Object> keys(UUID owner){owner(owner,false);return result(owner,"items",sql.sql("SELECT * FROM product_api_keys WHERE owner_id=:owner ORDER BY (revoked_at_ms IS NULL) DESC,created_at_ms DESC,id DESC LIMIT 100").param("owner",owner).query(this::key).list());}
    @Transactional public Map<String,Object> issueKey(UUID owner,JsonNode input){
        exact(input,"name","scopes","clientRequestId");String name=name(input.path("name"));List<String> scopes=selections(input.path("scopes"),SCOPES);UUID request=id(input.path("clientRequestId"));owner(owner,true);
        if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_api_keys WHERE owner_id=:owner AND client_request_id=:request)").param("owner",owner).param("request",request).query(Boolean.class).single())throw issued();
        if(sql.sql("SELECT count(*) FROM product_api_keys WHERE owner_id=:owner AND revoked_at_ms IS NULL").param("owner",owner).query(Integer.class).single()>=5)throw limit("API 키");
        UUID id=UUID.randomUUID();String secret="frame_"+Base64.getUrlEncoder().withoutPadding().encodeToString(random());long now=System.currentTimeMillis();
        sql.sql("INSERT INTO product_api_keys(id,owner_id,name,scopes,token_hash,prefix,last4,client_request_id,created_at_ms) VALUES(:id,:owner,:name,CAST(:scopes AS jsonb),:hash,:prefix,:last4,:request,:now)")
                .param("id",id).param("owner",owner).param("name",name).param("scopes",json.writeValueAsString(scopes)).param("hash",hash(secret)).param("prefix",secret.substring(0,12)).param("last4",secret.substring(secret.length()-4)).param("request",request).param("now",now).update();
        var out=result(owner,"item",findKey(owner,id));out.put("secret",secret);return out;
    }
    public Map<String,Object> keyReceipt(UUID owner,UUID request){owner(owner,false);return result(owner,"item",sql.sql("SELECT * FROM product_api_keys WHERE owner_id=:owner AND client_request_id=:request").param("owner",owner).param("request",request).query(this::key).optional().orElseThrow(DeveloperSettings::missing));}
    @Transactional public Map<String,Object> revokeKey(UUID owner,UUID id,int version,UUID request){
        owner(owner,true);var saved=mutation(owner,"key",id,request,"revoke");if(saved!=null)return result(owner,"item",saved);Key current=findKey(owner,id);if(current.version()!=version||current.revokedAtMs()!=null)throw conflict();
        sql.sql("UPDATE product_api_keys SET revoked_at_ms=greatest(:now,created_at_ms),version=version+1 WHERE id=:id AND owner_id=:owner AND version=:version AND revoked_at_ms IS NULL").param("now",System.currentTimeMillis()).param("id",id).param("owner",owner).param("version",version).update();
        Key item=findKey(owner,id);saveMutation(owner,"key",id,request,"revoke",item);return result(owner,"item",item);
    }
    /** No token cache: every request observes committed revocation. Browser security contexts are never created. */
    @Transactional public Access authenticate(String authorization){
        if(authorization==null||!authorization.matches("Bearer frame_[A-Za-z0-9_-]{43}"))throw unauthorized();
        bounded();
        String digest=hash(authorization.substring(7));
        Access access=sql.sql("SELECT owner_id,scopes FROM product_api_keys WHERE token_hash=:hash AND revoked_at_ms IS NULL").param("hash",digest)
                .query((r,i)->new Access(r.getObject("owner_id",UUID.class),strings(json.readTree(r.getString("scopes"))))).optional().orElseThrow(DeveloperSettings::unauthorized);
        if(sql.sql("UPDATE product_api_keys SET last_used_at_ms=greatest(:now,created_at_ms,coalesce(last_used_at_ms,created_at_ms)) WHERE token_hash=:hash AND revoked_at_ms IS NULL").param("now",System.currentTimeMillis()).param("hash",digest).update()!=1)throw unauthorized();return access;
    }
    public Map<String,Object> webhooks(UUID owner){owner(owner,false);return result(owner,"items",sql.sql("SELECT * FROM product_webhooks WHERE owner_id=:owner ORDER BY (revoked_at_ms IS NULL) DESC,created_at_ms DESC,id DESC LIMIT 100").param("owner",owner).query(this::webhook).list());}
    @Transactional public Map<String,Object> issueWebhook(UUID owner,JsonNode input){
        exact(input,"name","url","events","enabled","clientRequestId");String name=name(input.path("name")),url=url(input.path("url"));List<String> events=selections(input.path("events"),EVENTS);boolean enabled=bool(input.path("enabled"));UUID request=id(input.path("clientRequestId"));owner(owner,true);
        if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_webhooks WHERE owner_id=:owner AND client_request_id=:request)").param("owner",owner).param("request",request).query(Boolean.class).single())throw issued();
        if(sql.sql("SELECT count(*) FROM product_webhooks WHERE owner_id=:owner AND revoked_at_ms IS NULL").param("owner",owner).query(Integer.class).single()>=5)throw limit("웹훅");
        UUID id=UUID.randomUUID();byte[] secret=random();long now=System.currentTimeMillis();
        sql.sql("INSERT INTO product_webhooks(id,owner_id,name,url,events,enabled,signing_secret,client_request_id,created_at_ms,updated_at_ms) VALUES(:id,:owner,:name,:url,CAST(:events AS jsonb),:enabled,:secret,:request,:now,:now)")
                .param("id",id).param("owner",owner).param("name",name).param("url",url).param("events",json.writeValueAsString(events)).param("enabled",enabled).param("secret",secret).param("request",request).param("now",now).update();
        var out=result(owner,"item",findWebhook(owner,id));out.put("signingSecret",HexFormat.of().formatHex(secret));return out;
    }
    public Map<String,Object> webhookReceipt(UUID owner,UUID request){owner(owner,false);return result(owner,"item",sql.sql("SELECT * FROM product_webhooks WHERE owner_id=:owner AND client_request_id=:request").param("owner",owner).param("request",request).query(this::webhook).optional().orElseThrow(DeveloperSettings::missing));}
    @Transactional public Map<String,Object> updateWebhook(UUID owner,UUID id,JsonNode input){
        exact(input,"name","url","events","enabled","version","clientRequestId");String name=name(input.path("name")),url=url(input.path("url"));List<String> events=selections(input.path("events"),EVENTS);boolean enabled=bool(input.path("enabled"));int version=version(input.path("version"));UUID request=id(input.path("clientRequestId"));owner(owner,true);
        var saved=mutation(owner,"webhook",id,request,"update");if(saved!=null)return result(owner,"item",saved);Webhook current=lockWebhook(owner,id);if(current.version()!=version||current.revokedAtMs()!=null)throw conflict();
        sql.sql("UPDATE product_webhooks SET name=:name,url=:url,events=CAST(:events AS jsonb),enabled=:enabled,version=version+1,updated_at_ms=greatest(:now,updated_at_ms) WHERE id=:id AND owner_id=:owner AND version=:version")
                .param("name",name).param("url",url).param("events",json.writeValueAsString(events)).param("enabled",enabled).param("now",System.currentTimeMillis()).param("id",id).param("owner",owner).param("version",version).update();
        if(!enabled)cancelPending(id);Webhook item=findWebhook(owner,id);saveMutation(owner,"webhook",id,request,"update",item);return result(owner,"item",item);
    }
    @Transactional public Map<String,Object> revokeWebhook(UUID owner,UUID id,int version,UUID request){
        owner(owner,true);var saved=mutation(owner,"webhook",id,request,"revoke");if(saved!=null)return result(owner,"item",saved);Webhook current=lockWebhook(owner,id);if(current.version()!=version||current.revokedAtMs()!=null)throw conflict();
        sql.sql("UPDATE product_webhooks SET revoked_at_ms=greatest(:now,created_at_ms),updated_at_ms=greatest(:now,updated_at_ms),enabled=false,version=version+1 WHERE id=:id AND owner_id=:owner AND version=:version").param("now",System.currentTimeMillis()).param("id",id).param("owner",owner).param("version",version).update();cancelPending(id);
        Webhook item=findWebhook(owner,id);saveMutation(owner,"webhook",id,request,"revoke",item);return result(owner,"item",item);
    }
    public Map<String,Object> mutationReceipt(UUID owner,String type,UUID id,UUID request){owner(owner,false);Object value=mutation(owner,type,id,request,null);if(value==null)throw missing();return result(owner,"item",value);}
    @Transactional public Map<String,Object> test(UUID owner,UUID webhook,JsonNode input){
        exact(input,"clientRequestId");UUID request=id(input.path("clientRequestId"));owner(owner,true);Webhook current=lockWebhook(owner,webhook);
        Delivery previous=testDelivery(owner,webhook,request);if(previous!=null)return result(owner,"item",previous);
        if(current.revokedAtMs()!=null||!current.enabled())throw new ProductProblem(409,"WEBHOOK_DISABLED","활성 웹훅에서 테스트를 보내 주세요.");queueRoom(owner);
        UUID event=UUID.randomUUID(),id=UUID.randomUUID();long now=System.currentTimeMillis();String payload=json.writeValueAsString(Map.of("id",event,"event","webhook.test","createdAtMs",now,"data",Map.of("message","Frame 웹훅 연결 테스트")));
        insertDelivery(id,owner,webhook,event,"webhook.test",request,payload,now);return result(owner,"item",findDelivery(owner,id));
    }
    public Map<String,Object> testReceipt(UUID owner,UUID webhook,UUID request){owner(owner,false);findWebhook(owner,webhook);Delivery item=testDelivery(owner,webhook,request);if(item==null)throw missing();return result(owner,"item",item);}
    public Map<String,Object> deliveries(UUID owner,UUID webhook){owner(owner,false);findWebhook(owner,webhook);return result(owner,"items",sql.sql("SELECT * FROM product_webhook_deliveries WHERE owner_id=:owner AND webhook_id=:webhook ORDER BY created_at_ms DESC,id DESC LIMIT 50").param("owner",owner).param("webhook",webhook).query(this::delivery).list());}
    private Delivery testDelivery(UUID owner,UUID webhook,UUID request){return sql.sql("SELECT * FROM product_webhook_deliveries WHERE owner_id=:owner AND webhook_id=:webhook AND client_request_id=:request").param("owner",owner).param("webhook",webhook).param("request",request).query(this::delivery).optional().orElse(null);}

    /** One attempt per delivery. A crashed in-flight request is ambiguous and never automatically repeated. */
    @Transactional public void recover(){bounded();sql.sql("UPDATE product_webhook_deliveries SET status='failed',error_code='PROCESS_RESTARTED',completed_at_ms=greatest(:now,created_at_ms,started_at_ms) WHERE status='inflight'").param("now",System.currentTimeMillis()).update();}
    @Transactional public Job claim(){
        bounded();
        UUID next=sql.sql("SELECT id FROM product_webhook_deliveries WHERE status='pending' ORDER BY created_at_ms,id LIMIT 1").query(UUID.class).optional().orElse(null);if(next==null)return null;
        var row=sql.sql("SELECT w.* FROM product_webhooks w JOIN product_webhook_deliveries d ON d.webhook_id=w.id WHERE d.id=:id FOR UPDATE OF w").param("id",next)
                .query((r,i)->new Object[]{r.getObject("owner_id",UUID.class),r.getString("url"),r.getBytes("signing_secret"),r.getBoolean("enabled"),r.getObject("revoked_at_ms",Long.class)}).optional().orElse(null);
        if(row==null)return null;
        if(!(boolean)row[3]||row[4]!=null){cancelPendingWebhookDelivery(next);return null;}
        if(sql.sql("UPDATE product_webhook_deliveries SET status='inflight',started_at_ms=greatest(:now,created_at_ms) WHERE id=:id AND status='pending'").param("now",System.currentTimeMillis()).param("id",next).update()!=1)return null;
        Delivery delivery=findDelivery((UUID)row[0],next);String body=sql.sql("SELECT payload FROM product_webhook_deliveries WHERE id=:id").param("id",next).query(String.class).single();return new Job(delivery,(String)row[1],(byte[])row[2],body.getBytes(StandardCharsets.UTF_8));
    }
    @Transactional public void complete(UUID id,WebhookSender.Result result){
        bounded();
        boolean success=result.errorCode()==null&&result.httpStatus()!=null&&result.httpStatus()>=200&&result.httpStatus()<300;
        sql.sql("UPDATE product_webhook_deliveries SET status=:status,completed_at_ms=greatest(:now,created_at_ms,started_at_ms),http_status=:http,error_code=:error WHERE id=:id AND status='inflight'")
                .param("status",success?"succeeded":"failed").param("now",System.currentTimeMillis()).param("http",result.httpStatus(),java.sql.Types.INTEGER).param("error",success?null:result.errorCode()==null?"HTTP_ERROR":result.errorCode(),java.sql.Types.VARCHAR).param("id",id).update();
    }
    /** Resolves ownership at observation time; only public channel and broadcast fields enter the payload. */
    @Transactional public UUID broadcastEvent(String path,UUID expectedChannel,UUID broadcastId,String senderId,String title,long startedAtMs,String event,long now){
        var channel=sql.sql("SELECT id,owner_id,handle,display_name FROM product_channels WHERE stream_path=:path").param("path",path).query((r,i)->new Object[]{r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),r.getString("handle"),r.getString("display_name")}).optional().orElse(null);
        if(channel==null||(expectedChannel!=null&&!expectedChannel.equals(channel[0])))return null;UUID owner=(UUID)channel[1];owner(owner,true);
        UUID eventId=UUID.nameUUIDFromBytes((broadcastId+":"+event).getBytes(StandardCharsets.UTF_8));
        String payload=json.writeValueAsString(Map.of("id",eventId,"event",event,"createdAtMs",now,"data",Map.of("channel",Map.of("id",channel[0],"handle",channel[2],"displayName",channel[3]),"broadcast",Map.of("id",senderId,"title",title.replace('\0','\uFFFD'),"startedAtMs",startedAtMs))));
        if(payload.getBytes(StandardCharsets.UTF_8).length>16384)return (UUID)channel[0];
        for(UUID webhook:sql.sql("SELECT id FROM product_webhooks WHERE owner_id=:owner AND revoked_at_ms IS NULL AND enabled AND events @> CAST(:event AS jsonb) ORDER BY id FOR UPDATE").param("owner",owner).param("event",json.writeValueAsString(List.of(event))).query(UUID.class).list()){
            if(sql.sql("SELECT count(*) FROM product_webhook_deliveries WHERE owner_id=:owner AND status IN ('pending','inflight')").param("owner",owner).query(Integer.class).single()>=100)break;
            insertDelivery(UUID.randomUUID(),owner,webhook,eventId,event,null,payload,now);
        }
        return (UUID)channel[0];
    }
    private void queueRoom(UUID owner){if(sql.sql("SELECT count(*) FROM product_webhook_deliveries WHERE owner_id=:owner AND status IN ('pending','inflight')").param("owner",owner).query(Integer.class).single()>=100)throw new ProductProblem(429,"WEBHOOK_QUEUE_FULL","대기 중인 전송이 많아요. 잠시 후 다시 시도해 주세요.");}
    private void insertDelivery(UUID id,UUID owner,UUID webhook,UUID event,String type,UUID request,String payload,long now){sql.sql("INSERT INTO product_webhook_deliveries(id,owner_id,webhook_id,event_id,event,client_request_id,payload,created_at_ms) VALUES(:id,:owner,:webhook,:event,:type,:request,:payload,:now) ON CONFLICT DO NOTHING")
            .param("id",id).param("owner",owner).param("webhook",webhook).param("event",event).param("type",type).param("request",request,java.sql.Types.OTHER).param("payload",payload).param("now",now).update();}
    private void cancelPending(UUID id){sql.sql("UPDATE product_webhook_deliveries SET status='cancelled',error_code='WEBHOOK_DISABLED',completed_at_ms=greatest(:now,created_at_ms) WHERE webhook_id=:id AND status='pending'").param("now",System.currentTimeMillis()).param("id",id).update();}
    private void cancelPendingWebhookDelivery(UUID id){sql.sql("UPDATE product_webhook_deliveries SET status='cancelled',error_code='WEBHOOK_DISABLED',completed_at_ms=greatest(:now,created_at_ms) WHERE id=:id AND status='pending'").param("now",System.currentTimeMillis()).param("id",id).update();}
    private Key findKey(UUID owner,UUID id){return sql.sql("SELECT * FROM product_api_keys WHERE owner_id=:owner AND id=:id").param("owner",owner).param("id",id).query(this::key).optional().orElseThrow(DeveloperSettings::missing);}
    private Webhook findWebhook(UUID owner,UUID id){return sql.sql("SELECT * FROM product_webhooks WHERE owner_id=:owner AND id=:id").param("owner",owner).param("id",id).query(this::webhook).optional().orElseThrow(DeveloperSettings::missing);}
    private Webhook lockWebhook(UUID owner,UUID id){return sql.sql("SELECT * FROM product_webhooks WHERE owner_id=:owner AND id=:id FOR UPDATE").param("owner",owner).param("id",id).query(this::webhook).optional().orElseThrow(DeveloperSettings::missing);}
    private Delivery findDelivery(UUID owner,UUID id){return sql.sql("SELECT * FROM product_webhook_deliveries WHERE owner_id=:owner AND id=:id").param("owner",owner).param("id",id).query(this::delivery).optional().orElseThrow(DeveloperSettings::missing);}
    private Object mutation(UUID owner,String type,UUID id,UUID request,String operation){return sql.sql("SELECT operation,response FROM product_developer_mutations WHERE owner_id=:owner AND resource_type=:type AND resource_id=:id AND request_id=:request").param("owner",owner).param("type",type).param("id",id).param("request",request).query((r,i)->{if(operation!=null&&!operation.equals(r.getString("operation")))throw conflict();return json.readTree(r.getString("response"));}).optional().orElse(null);}
    private void saveMutation(UUID owner,String type,UUID id,UUID request,String operation,Object item){sql.sql("INSERT INTO product_developer_mutations(owner_id,resource_type,resource_id,request_id,operation,response) VALUES(:owner,:type,:id,:request,:operation,CAST(:response AS jsonb))").param("owner",owner).param("type",type).param("id",id).param("request",request).param("operation",operation).param("response",json.writeValueAsString(item)).update();}
    private Key key(ResultSet r,int i)throws SQLException{return new Key(r.getObject("id",UUID.class),r.getString("name"),strings(json.readTree(r.getString("scopes"))),r.getString("prefix"),r.getString("last4"),r.getLong("created_at_ms"),r.getObject("last_used_at_ms",Long.class),r.getObject("revoked_at_ms",Long.class),r.getInt("version"),r.getObject("client_request_id",UUID.class));}
    private Webhook webhook(ResultSet r,int i)throws SQLException{return new Webhook(r.getObject("id",UUID.class),r.getString("name"),r.getString("url"),strings(json.readTree(r.getString("events"))),r.getBoolean("enabled"),r.getLong("created_at_ms"),r.getLong("updated_at_ms"),r.getObject("revoked_at_ms",Long.class),r.getInt("version"),r.getObject("client_request_id",UUID.class));}
    private Delivery delivery(ResultSet r,int i)throws SQLException{return new Delivery(r.getObject("id",UUID.class),r.getObject("webhook_id",UUID.class),r.getString("event"),r.getObject("event_id",UUID.class),r.getObject("client_request_id",UUID.class),r.getString("status"),r.getLong("created_at_ms"),r.getObject("started_at_ms",Long.class),r.getObject("completed_at_ms",Long.class),r.getObject("http_status",Integer.class),r.getString("error_code"));}
    static Map<String,Object> result(UUID owner,String field,Object value){var result=new LinkedHashMap<String,Object>();result.put("userId",owner);result.put(field,value);return result;}
    static void exact(JsonNode input,String... fields){if(input.size()!=fields.length)throw invalid();for(String field:fields)if(!input.has(field))throw invalid();}
    static UUID id(JsonNode input){if(!input.isString())throw invalid();return id(input.asString());}
    static UUID id(String input){try{if(!input.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return UUID.fromString(input);}catch(IllegalArgumentException failure){throw invalid();}}
    static int version(JsonNode input){if(!input.isIntegralNumber()||!input.canConvertToInt()||input.intValue()<1)throw invalid();return input.intValue();}
    static String name(JsonNode input){if(!input.isString())throw invalid();String name=Normalizer.normalize(input.asString(),Normalizer.Form.NFC).strip();if(name.codePointCount(0,name.length())<1||name.codePointCount(0,name.length())>40||name.codePoints().anyMatch(c->Character.isISOControl(c)||Character.getType(c)==Character.FORMAT||Character.getType(c)==Character.SURROGATE))throw new ProductProblem(400,"INVALID_DEVELOPER_NAME","이름은 1~40자로 입력해 주세요.");return name;}
    static List<String> selections(JsonNode input,Set<String> allowed){if(!input.isArray()||input.isEmpty()||input.size()>allowed.size())throw invalid();Set<String> result=new LinkedHashSet<>();for(JsonNode item:input)if(!item.isString()||!allowed.contains(item.asString())||!result.add(item.asString()))throw invalid();return List.copyOf(result);}
    private static List<String> strings(JsonNode input){List<String> result=new ArrayList<>();for(JsonNode item:input)result.add(item.asString());return List.copyOf(result);}
    private String url(JsonNode input){if(!input.isString())throw invalid();return sender.canonicalUrl(input.asString());}
    private static boolean bool(JsonNode input){if(!input.isBoolean())throw invalid();return input.booleanValue();}
    private void bounded(){sql.sql("SET LOCAL statement_timeout='1500ms'").update();sql.sql("SET LOCAL lock_timeout='1000ms'").update();}
    static byte[] random(){byte[] bytes=new byte[32];RANDOM.nextBytes(bytes);return bytes;}
    static String hash(String input){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));}catch(NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
    static ProductProblem invalid(){return new ProductProblem(400,"INVALID_DEVELOPER_INPUT","개발자 설정 입력을 확인해 주세요.");}
    private static ProductProblem missing(){return new ProductProblem(404,"DEVELOPER_NOT_FOUND","요청한 개발자 설정을 찾을 수 없어요.");}
    private static ProductProblem issued(){return new ProductProblem(409,"ISSUE_ALREADY_PROCESSED","이미 처리된 발급 요청이에요. 발급 내역을 확인해 주세요. 비밀 값은 다시 확인할 수 없어요.");}
    private static ProductProblem limit(String name){return new ProductProblem(409,"DEVELOPER_LIMIT",name+"는 활성 상태로 5개까지 등록할 수 있어요.");}
    private static ProductProblem conflict(){return new ProductProblem(409,"DEVELOPER_CONFLICT","다른 화면에서 설정이 바뀌었어요. 최신 목록을 불러와 주세요.");}
    static ProductProblem unauthorized(){return new ProductProblem(401,"INVALID_API_KEY","유효한 API 키가 필요해요.");}
}
