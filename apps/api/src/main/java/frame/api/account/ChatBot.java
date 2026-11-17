package frame.api.account;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Owner-written exact commands only. Bot replies do not create accounts, sessions, or viewer activity. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChatBot {
    public record Command(UUID id, String command, String response, boolean enabled, int cooldownSeconds) {}
    public record Settings(UUID userId, UUID channelId, int version, long updatedAtMs, boolean enabled, List<Command> commands) {}
    public record Configuration(UUID channelId, int version, boolean enabled, List<Command> commands) {}
    private final JdbcClient sql;
    private final JsonMapper json;
    public ChatBot(JdbcClient sql, JsonMapper json) { this.sql=sql; this.json=json; }

    private UUID channel(UUID user, boolean lock) {
        return sql.sql("SELECT id FROM product_channels WHERE owner_id=:user"+(lock?" FOR UPDATE":"")).param("user",user)
                .query(UUID.class).optional().orElseThrow(()->new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요."));
    }
    public Settings settings(UUID user) { return settings(user,channel(user,false)); }
    private Settings settings(UUID user, UUID channel) {
        return sql.sql("SELECT * FROM product_chat_bot_settings WHERE channel_id=:channel").param("channel",channel)
                .query((r,i)->new Settings(user,channel,r.getInt("version"),r.getLong("updated_at_ms"),r.getBoolean("enabled"),commands(json.readTree(r.getString("commands")))))
                .optional().orElseGet(()->new Settings(user,channel,0,0,false,List.of()));
    }
    @Transactional public Settings update(UUID user, JsonNode input) {
        if(input.size()!=3 || !input.path("version").isIntegralNumber() || !input.path("version").canConvertToInt() || input.path("version").intValue()<0 || !input.path("enabled").isBoolean()) throw invalid();
        List<Command> commands=commands(input.path("commands"));
        UUID channel=channel(user,true); Settings current=settings(user,channel);
        if(current.version()!=input.path("version").intValue()) throw new ProductProblem(409,"CHAT_BOT_SETTINGS_CONFLICT","다른 화면에서 챗봇 설정이 바뀌었어요. 최신 설정을 불러와 주세요.");
        sql.sql("""
                INSERT INTO product_chat_bot_settings(channel_id,enabled,commands,version,updated_at_ms)
                VALUES(:channel,:enabled,CAST(:commands AS jsonb),1,:at)
                ON CONFLICT(channel_id) DO UPDATE SET enabled=excluded.enabled,commands=excluded.commands,version=product_chat_bot_settings.version+1,updated_at_ms=excluded.updated_at_ms
                """).param("channel",channel).param("enabled",input.path("enabled").booleanValue()).param("commands",json.writeValueAsString(commands)).param("at",System.currentTimeMillis()).update();
        return settings(user,channel);
    }

    /** Always reads the latest saved configuration; called outside ChatHub's fan-out lock. */
    @Transactional(readOnly=true,timeout=3) public Configuration configuration(String path) {
        return sql.sql("""
                SELECT c.id,b.version,b.enabled,b.commands FROM product_channels c
                LEFT JOIN product_chat_bot_settings b ON b.channel_id=c.id WHERE c.stream_path=:path
                """).param("path",path).query((r,i)->new Configuration(r.getObject("id",UUID.class),r.getInt("version"),r.getBoolean("enabled"),r.getString("commands")==null?List.of():commands(json.readTree(r.getString("commands")))))
                .optional().orElse(null);
    }

    public static String matchingCommand(String text) {
        String command=Normalizer.normalize(text,Normalizer.Form.NFC).strip().toLowerCase(Locale.ROOT);
        return command.matches("![a-z0-9_가-힣]{1,20}")?command:null;
    }
    static List<Command> commands(JsonNode input) {
        if(!input.isArray() || input.size()>20) throw invalidCommands();
        List<Command> result=new ArrayList<>(); Set<UUID> ids=new HashSet<>(); Set<String> names=new HashSet<>();
        for(JsonNode item:input) {
            if(!item.isObject() || item.size()!=5 || !item.path("id").isString() || !item.path("command").isString() || !item.path("response").isString() || !item.path("enabled").isBoolean()
                    || !item.path("cooldownSeconds").isIntegralNumber() || !item.path("cooldownSeconds").canConvertToInt() || item.path("cooldownSeconds").intValue()<5 || item.path("cooldownSeconds").intValue()>3600) throw invalidCommands();
            String rawId=item.path("id").asString();
            if(!rawId.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw invalidCommands();
            UUID id=UUID.fromString(rawId); String command=matchingCommand(item.path("command").asString());
            if(command==null || !ids.add(id) || !names.add(command)) throw invalidCommands();
            String response=response(item.path("response").asString());
            result.add(new Command(id,command,response,item.path("enabled").booleanValue(),item.path("cooldownSeconds").intValue()));
        }
        return List.copyOf(result);
    }
    static String response(String input) {
        // ECMAScript whitespace, shared with the editor; the reply remains one plain-text chat message.
        String value=Normalizer.normalize(input,Normalizer.Form.NFC).replaceAll("[\\x09-\\x0d\\x20\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+"," ").strip();
        int length=value.codePointCount(0,value.length());
        if(length<1 || length>500 || value.codePoints().anyMatch(c->Character.isISOControl(c)||Character.getType(c)==Character.FORMAT||Character.getType(c)==Character.SURROGATE))
            throw new ProductProblem(400,"INVALID_CHAT_BOT_RESPONSE","자동 응답은 보낼 수 있는 문자로 1~500자까지 입력해 주세요.");
        return value;
    }
    private static ProductProblem invalidCommands() { return new ProductProblem(400,"INVALID_CHAT_BOT_COMMANDS","명령어는 중복 없이 20개까지, ! 뒤에 영문·숫자·밑줄·한글 1~20자와 대기 시간 5~3600초를 입력해 주세요."); }
    private static ProductProblem invalid() { return new ProductProblem(400,"INVALID_CHAT_BOT_INPUT","챗봇 설정을 확인해 주세요."); }
}
