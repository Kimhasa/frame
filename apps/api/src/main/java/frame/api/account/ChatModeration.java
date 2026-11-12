package frame.api.account;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ChatModeration {
    public record Policy(boolean slowMode, int slowSeconds, boolean followersOnly, boolean blockLinks) {}
    public record Settings(UUID userId, UUID channelId, int version, long updatedAtMs, boolean slowMode, int slowSeconds, boolean followersOnly, boolean blockLinks, List<String> bannedWords) { public Policy policy() { return new Policy(slowMode, slowSeconds, followersOnly, blockLinks); } }
    public record Block(UUID id, UUID targetChannelId, String displayName, String handle, String reason, long createdAtMs, Long expiresAtMs, int version) {}
    public record Blocks(UUID userId, List<Block> items, String nextCursor) {}
    public record Created(UUID userId, Block item) {}
    public record Owner(UUID userId) {}
    public record PolicyChanged(String path, Policy policy) {}
    public record BlockChanged(String path, UUID userId, boolean blocked, Long expiresAtMs) {}
    public record Decision(String displayName, UUID authorChannelId, String authorHandle, boolean isOwner, Policy policy, String code, String error, Long retryAfterMs, Long expiresAtMs) {}
    private record Channel(UUID id, String path) {}
    private static final Pattern LINK = Pattern.compile("(?i)(?:https?://|www\\.|[\\p{L}\\p{N}-]+\\.[a-z]{2,24}\\b|[a-z0-9-]+\\.[\\p{L}]{2,63}\\b)",Pattern.UNICODE_CHARACTER_CLASS);
    private final JdbcClient sql;
    private final JsonMapper json;
    private final ApplicationEventPublisher events;
    private final ConcurrentHashMap<String, Long> lastSent = new ConcurrentHashMap<>();
    public ChatModeration(JdbcClient sql, JsonMapper json, ApplicationEventPublisher events) { this.sql = sql; this.json = json; this.events = events; }
    private Channel channel(UUID user, boolean lock) {
        return sql.sql("SELECT id,stream_path FROM product_channels WHERE owner_id=:user" + (lock ? " FOR UPDATE" : "")).param("user", user)
                .query((r, i) -> new Channel(r.getObject("id", UUID.class), r.getString("stream_path"))).optional().orElseThrow(() -> new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요."));
    }
    public Settings settings(UUID user) { return settings(user, channel(user, false).id()); }
    private Settings settings(UUID user, UUID channel) {
        return sql.sql("SELECT * FROM product_chat_settings WHERE channel_id=:channel").param("channel", channel).query((r, i) -> new Settings(user, channel, r.getInt("version"), r.getLong("updated_at_ms"), r.getBoolean("slow_mode"), r.getInt("slow_seconds"), r.getBoolean("followers_only"), r.getBoolean("block_links"), words(json.readTree(r.getString("banned_words")))))
                .optional().orElseGet(() -> new Settings(user, channel, 0, 0, false, 5, false, false, List.of()));
    }
    @Transactional public Settings update(UUID user, JsonNode input) {
        Channel channel = channel(user, true); Settings current = settings(user, channel.id());
        if (input.size()!=6 || !input.path("version").isIntegralNumber() || !input.path("version").canConvertToInt() || input.path("version").intValue()<0
                || !input.path("slowMode").isBoolean() || !input.path("followersOnly").isBoolean() || !input.path("blockLinks").isBoolean() || !input.path("slowSeconds").isIntegralNumber() || !input.path("slowSeconds").canConvertToInt()
                || input.path("slowSeconds").intValue()<1 || input.path("slowSeconds").intValue()>120) throw invalid();
        List<String> words = words(input.path("bannedWords"));
        if (current.version()!=input.path("version").intValue()) throw new ProductProblem(409, "CHAT_SETTINGS_CONFLICT", "다른 화면에서 설정이 바뀌었어요. 최신 설정을 불러와 주세요.");
        sql.sql("""
                INSERT INTO product_chat_settings(channel_id,slow_mode,slow_seconds,followers_only,block_links,banned_words,version,updated_at_ms)
                VALUES(:channel,:slow,:seconds,:followers,:links,CAST(:words AS jsonb),1,:at)
                ON CONFLICT(channel_id) DO UPDATE SET slow_mode=excluded.slow_mode,slow_seconds=excluded.slow_seconds,followers_only=excluded.followers_only,block_links=excluded.block_links,banned_words=excluded.banned_words,version=product_chat_settings.version+1,updated_at_ms=excluded.updated_at_ms
                """).param("channel", channel.id()).param("slow", input.path("slowMode").booleanValue()).param("seconds", input.path("slowSeconds").intValue()).param("followers", input.path("followersOnly").booleanValue()).param("links", input.path("blockLinks").booleanValue())
                .param("words", json.writeValueAsString(words)).param("at", System.currentTimeMillis()).update();
        Settings result = settings(user, channel.id()); events.publishEvent(new PolicyChanged(channel.path(), result.policy())); return result;
    }
    public Blocks blocks(UUID user, String status, String query, String cursor, int limit) {
        Channel channel = channel(user, false);
        if (!Set.of("active","all","expired").contains(status) || Accounts.length(query)>120 || query.codePoints().anyMatch(Character::isISOControl) || limit<1 || limit>100) throw invalid();
        ProductNotifications.Cursor after;
        try { after = ProductNotifications.decode(cursor); } catch (ProductProblem failure) { throw new ProductProblem(400,"INVALID_CHAT_CURSOR","차단 목록을 새로 불러와 주세요."); }
        String statement = "SELECT b.*,c.display_name,c.handle FROM product_chat_blocks b JOIN product_channels c ON c.id=b.target_channel_id WHERE b.channel_id=:channel";
        if (!status.equals("all")) statement += status.equals("active") ? " AND (b.expires_at_ms IS NULL OR b.expires_at_ms>:now)" : " AND b.expires_at_ms<=:now";
        if (!query.isBlank()) statement += " AND position(lower(:query) IN lower(c.display_name || ' ' || c.handle || ' ' || b.reason))>0";
        if (after!=null) statement += " AND (b.created_at_ms,b.id)<(:at,:id)";
        var request = sql.sql(statement + " ORDER BY b.created_at_ms DESC,b.id DESC LIMIT :limit").param("channel",channel.id()).param("limit",limit+1);
        if (!status.equals("all")) request.param("now",System.currentTimeMillis());
        if (!query.isBlank()) request.param("query",query.strip());
        if (after!=null) request.param("at",after.at()).param("id",after.id());
        List<Block> rows=request.query(this::block).list(); boolean more=rows.size()>limit; List<Block> page=more?List.copyOf(rows.subList(0,limit)):rows;
        Block last=more?page.getLast():null; return new Blocks(user,page,last==null?null:ProductNotifications.encode(last.createdAtMs(),last.id()));
    }
    @Transactional public Created create(UUID user, JsonNode input) {
        Channel own=channel(user,true);
        if (input.size()!=3 || !input.path("targetChannelId").isString() || !input.has("durationSeconds") || !input.path("reason").isString()) throw invalid();
        UUID target=id(input.path("targetChannelId").asString());
        Long duration=null;
        if (!input.path("durationSeconds").isNull()) {
            if (!input.path("durationSeconds").isIntegralNumber() || !input.path("durationSeconds").canConvertToLong() || !Set.of(600L,3600L).contains(input.path("durationSeconds").longValue())) throw invalid();
            duration=input.path("durationSeconds").longValue();
        }
        String reason=input.path("reason").asString().strip(); if (Accounts.length(reason)<1 || Accounts.length(reason)>200 || reason.codePoints().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\r'&&c!='\t')) throw invalid();
        UUID blocked=sql.sql("SELECT owner_id FROM product_channels WHERE id=:id").param("id",target).query(UUID.class).optional().orElseThrow(()->new ProductProblem(404,"CHANNEL_NOT_FOUND","채널을 찾을 수 없어요."));
        if (blocked.equals(user)) throw new ProductProblem(400,"SELF_BLOCK_NOT_ALLOWED","내 계정은 차단할 수 없어요.");
        long now=System.currentTimeMillis();
        if (sql.sql("SELECT EXISTS(SELECT 1 FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:blocked AND (expires_at_ms IS NULL OR expires_at_ms>:now))").param("channel",own.id()).param("blocked",blocked).param("now",now).query(Boolean.class).single()) throw new ProductProblem(409,"CHAT_BLOCK_EXISTS","이미 차단된 계정이에요.");
        if (sql.sql("SELECT count(*) FROM product_chat_blocks WHERE channel_id=:channel AND (expires_at_ms IS NULL OR expires_at_ms>:now)").param("channel",own.id()).param("now",now).query(Integer.class).single()>=200) throw new ProductProblem(409,"CHAT_BLOCK_LIMIT","차단 계정은 200개까지 관리할 수 있어요.");
        sql.sql("DELETE FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:blocked").param("channel",own.id()).param("blocked",blocked).update();
        UUID id=UUID.randomUUID(); Long expires=duration==null?null:now+duration*1000;
        sql.sql("INSERT INTO product_chat_blocks(id,channel_id,blocked_user_id,target_channel_id,reason,created_at_ms,expires_at_ms) VALUES(:id,:channel,:blocked,:target,:reason,:at,:expires)")
                .param("id",id).param("channel",own.id()).param("blocked",blocked).param("target",target).param("reason",reason).param("at",now).param("expires",expires,java.sql.Types.BIGINT).update();
        events.publishEvent(new BlockChanged(own.path(),blocked,true,expires));
        return new Created(user,find(own.id(),id));
    }
    @Transactional public Owner remove(UUID user, String rawId, int version) {
        Channel own=channel(user,true); UUID id=id(rawId); if (version<0) throw invalid(); Block block=find(own.id(),id);
        if (block.version()!=version) throw new ProductProblem(409,"CHAT_BLOCK_CONFLICT","차단 정보가 바뀌었어요. 최신 목록을 불러와 주세요.");
        UUID blocked=sql.sql("SELECT blocked_user_id FROM product_chat_blocks WHERE id=:id AND channel_id=:channel").param("id",id).param("channel",own.id()).query(UUID.class).single();
        sql.sql("DELETE FROM product_chat_blocks WHERE id=:id AND channel_id=:channel").param("id",id).param("channel",own.id()).update();
        events.publishEvent(new BlockChanged(own.path(),blocked,false,null)); return new Owner(user);
    }
    private Block find(UUID channel, UUID id) { return sql.sql("SELECT b.*,c.display_name,c.handle FROM product_chat_blocks b JOIN product_channels c ON c.id=b.target_channel_id WHERE b.channel_id=:channel AND b.id=:id").param("channel",channel).param("id",id).query(this::block).optional().orElseThrow(()->new ProductProblem(404,"CHAT_BLOCK_NOT_FOUND","차단 정보를 찾을 수 없어요.")); }
    private Block block(ResultSet r,int index)throws SQLException { return new Block(r.getObject("id",UUID.class),r.getObject("target_channel_id",UUID.class),r.getString("display_name"),r.getString("handle"),r.getString("reason"),r.getLong("created_at_ms"),r.getObject("expires_at_ms",Long.class),r.getInt("version")); }
    @Transactional(readOnly=true,timeout=3) public Decision check(UUID user,String path,String text) {
        var sender=sql.sql("SELECT a.display_name,c.id,c.handle FROM product_accounts a JOIN product_channels c ON c.owner_id=a.id WHERE a.id=:user").param("user",user)
                .query((r,i)->new Object[]{r.getString("display_name"),r.getObject("id",UUID.class),r.getString("handle")}).optional().orElse(null);
        if(sender==null) return refused("CHAT_SESSION_EXPIRED","다시 로그인해 주세요.");
        var channel=sql.sql("SELECT id,owner_id FROM product_channels WHERE stream_path=:path").param("path",path).query((r,i)->new UUID[]{r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class)}).optional().orElse(null);
        if(channel==null) return refused("CHAT_CHANNEL_UNAVAILABLE","이 방송은 채팅을 준비하고 있어요.");
        Settings settings=settings(channel[1],channel[0]); boolean owner=channel[1].equals(user); String code=null,error=null; Long retry=null,expires=null;
        var block=sql.sql("SELECT id,expires_at_ms FROM product_chat_blocks WHERE channel_id=:channel AND blocked_user_id=:user AND (expires_at_ms IS NULL OR expires_at_ms>:now)").param("channel",channel[0]).param("user",user).param("now",System.currentTimeMillis())
                .query((r,i)->new Object[]{r.getObject("id",UUID.class),r.getObject("expires_at_ms",Long.class)}).optional().orElse(null);
        if(block!=null){code="CHAT_BLOCKED";error="이 채널에서는 채팅을 보낼 수 없어요.";expires=(Long)block[1];retry=expires==null?null:Math.max(1,expires-System.currentTimeMillis());}
        else if(text!=null){
            String compared=comparable(text);
            if(settings.blockLinks()&&LINK.matcher(compared).find()){code="CHAT_LINK_BLOCKED";error="이 채널에서는 링크를 보낼 수 없어요.";}
            else if(settings.bannedWords().stream().anyMatch(word->compared.contains(comparable(word)))){code="CHAT_WORD_BLOCKED";error="이 채널에서 허용하지 않는 표현이 포함돼 있어요.";}
            else if(!owner&&settings.followersOnly()&&!sql.sql("SELECT EXISTS(SELECT 1 FROM product_follows WHERE user_id=:user AND channel_id=:channel)").param("user",user).param("channel",channel[0]).query(Boolean.class).single()){code="CHAT_FOLLOW_REQUIRED";error="채널을 팔로우한 뒤 채팅에 참여해 주세요.";}
            else if(!owner&&settings.slowMode()){
                long now=System.currentTimeMillis(),interval=settings.slowSeconds()*1000L; String key=channel[0]+":"+user;
                long[] wait={0}; lastSent.compute(key,(ignored,previous)->{if(previous!=null&&now-previous<interval){wait[0]=interval-(now-previous);return previous;}return now;});
                if(wait[0]>0){code="CHAT_SLOW_MODE";error="잠시 후 다음 메시지를 보내 주세요.";retry=wait[0];}
                if(lastSent.size()>10000) lastSent.entrySet().removeIf(e->now-e.getValue()>180000);
            }
        }
        return new Decision((String)sender[0],(UUID)sender[1],(String)sender[2],owner,settings.policy(),code,error,retry,expires);
    }
    private static Decision refused(String code,String error){return new Decision("",null,null,false,null,code,error,null,null);}
    static List<String> words(JsonNode input){
        if(!input.isArray()||input.size()>100)throw new ProductProblem(400,"INVALID_BANNED_WORDS","금칙어는 100개까지, 각 1~30자로 입력해 주세요.");
        List<String> words=new ArrayList<>(); Set<String> seen=new LinkedHashSet<>();
        for(JsonNode word:input){if(!word.isString())throw invalid();String value=word.asString().strip();if(Accounts.length(value)<1||Accounts.length(value)>30||value.codePoints().anyMatch(Character::isISOControl)||comparable(value).isBlank())throw new ProductProblem(400,"INVALID_BANNED_WORDS","금칙어는 100개까지, 각 1~30자로 입력해 주세요.");if(seen.add(comparable(value)))words.add(value);}
        return List.copyOf(words);
    }
    static String comparable(String text){String normalized=Normalizer.normalize(text,Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);StringBuilder value=new StringBuilder();normalized.codePoints().filter(c->Character.getType(c)!=Character.FORMAT).forEach(value::appendCodePoint);return value.toString();}
    static boolean containsLink(String text){return LINK.matcher(comparable(text)).find();}
    static boolean containsWord(List<String> words,String text){String value=comparable(text);return words.stream().anyMatch(word->value.contains(comparable(word)));}
    static UUID id(String value){if(!value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();return UUID.fromString(value);}
    static ProductProblem invalid(){return new ProductProblem(400,"INVALID_CHAT_INPUT","채팅 관리 입력을 확인해 주세요.");}
}
