package frame.api.account;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.json.JsonMapper;

@Repository
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class AccountRepository {
    public record Account(UUID id, String email, String passwordHash, String displayName, boolean isOperator) {
        @Override public String toString() { return "Account[id=" + id + "]"; }
    }
    public record Channel(UUID id, UUID ownerId, String handle, String displayName, String description, String notice,
                          String category, String bannerPreset, String streamPath, long followerCount, boolean following, boolean notificationsOn,
                          long createdAtMs, String countryCode, List<ChannelProfile.Link> links) {}
    private static final UUID ANONYMOUS = new UUID(0, 0);
    private static final String CHANNEL = """
            SELECT c.*, (SELECT count(*) FROM product_follows f WHERE f.channel_id=c.id) AS follower_count,
              EXISTS(SELECT 1 FROM product_follows f WHERE f.channel_id=c.id AND f.user_id=:viewer) AS following,
              EXISTS(SELECT 1 FROM product_follows f WHERE f.channel_id=c.id AND f.user_id=:viewer AND f.notifications_on) AS notifications_on
            FROM product_channels c
            """;
    private final JdbcClient sql;
    private final JsonMapper json;
    public AccountRepository(JdbcClient sql, JsonMapper json) { this.sql = sql; this.json = json; }
    public Optional<Account> account(UUID id) { return sql.sql("SELECT * FROM product_accounts WHERE id=:id").param("id", id).query(this::accountRow).optional(); }
    public Optional<Account> email(String email) { return sql.sql("SELECT * FROM product_accounts WHERE email=:email").param("email", email).query(this::accountRow).optional(); }
    public void insertAccount(UUID id, String email, String hash, String name, String termsVersion, String privacyVersion) {
        sql.sql("INSERT INTO product_accounts(id,email,password_hash,display_name,terms_version,privacy_version,consented_at) VALUES(:id,:email,:hash,:name,:terms,:privacy,current_timestamp)")
                .param("id", id).param("email", email).param("hash", hash).param("name", name).param("terms", termsVersion).param("privacy", privacyVersion).update();
    }
    public void insertChannel(UUID id, UUID owner, String handle, String name) {
        if (!insertChannelIfAvailable(id, owner, handle, name)) throw unavailableHandle();
    }
    /** A generated-handle collision must not abort PostgreSQL's enclosing account/consent transaction. */
    public boolean insertChannelIfAvailable(UUID id, UUID owner, String handle, String name) {
        if (!reserveHandle(id, handle)) return false;
        sql.sql("INSERT INTO product_channels(id,owner_id,handle,display_name) VALUES(:id,:owner,:handle,:name)")
                .param("id", id).param("owner", owner).param("handle", handle).param("name", name).update();
        sql.sql("INSERT INTO product_chat_settings(channel_id,updated_at_ms) VALUES(:channel,:at)").param("channel",id).param("at",System.currentTimeMillis()).update();
        return true;
    }
    public Optional<Channel> channelByHandle(String handle, UUID viewer) { return sql.sql(CHANNEL + " WHERE c.handle=:handle OR EXISTS(SELECT 1 FROM product_channel_handles h WHERE h.handle=:handle AND h.channel_id=c.id)").param("handle", handle).param("viewer", viewer(viewer)).query(this::channelRow).optional(); }
    public Optional<Channel> channel(UUID id, UUID viewer) { return sql.sql(CHANNEL + " WHERE c.id=:id").param("id", id).param("viewer", viewer(viewer)).query(this::channelRow).optional(); }
    public Channel own(UUID owner) { return sql.sql(CHANNEL + " WHERE c.owner_id=:owner").param("owner", owner).param("viewer", owner).query(this::channelRow).single(); }
    public Channel lockedOwn(UUID owner) {
        sql.sql("SELECT id FROM product_channels WHERE owner_id=:owner FOR UPDATE").param("owner", owner).query(UUID.class).single();
        return own(owner);
    }
    public List<Channel> directory(String query, int limit, UUID viewer) { return sql.sql(CHANNEL + " WHERE position(lower(:query) IN lower(c.display_name || ' ' || c.handle)) > 0 ORDER BY c.created_at DESC,c.id DESC LIMIT :limit").param("query", query).param("limit", limit).param("viewer", viewer(viewer)).query(this::channelRow).list(); }
    public List<Channel> follows(UUID viewer) { return sql.sql(CHANNEL + " WHERE EXISTS(SELECT 1 FROM product_follows own WHERE own.channel_id=c.id AND own.user_id=:viewer) ORDER BY c.display_name,c.id LIMIT 200").param("viewer", viewer).query(this::channelRow).list(); }
    public void follow(UUID user, UUID channel, Boolean notifications) {
        sql.sql("""
                INSERT INTO product_follows(user_id,channel_id,notifications_on,notifications_enabled_at) VALUES(:user,:channel,:initial,CASE WHEN :initial THEN clock_timestamp() ELSE NULL END)
                ON CONFLICT(user_id,channel_id) DO UPDATE SET
                  notifications_on=coalesce(:changed,product_follows.notifications_on),
                  notifications_enabled_at=CASE WHEN :changed IS NULL THEN product_follows.notifications_enabled_at WHEN :changed=false THEN NULL
                    WHEN product_follows.notifications_on THEN product_follows.notifications_enabled_at ELSE clock_timestamp() END
                """)
                .param("user", user).param("channel", channel).param("initial", Boolean.TRUE.equals(notifications)).param("changed", notifications, java.sql.Types.BOOLEAN).update();
    }
    public void unfollow(UUID user, UUID channel) { sql.sql("DELETE FROM product_follows WHERE user_id=:user AND channel_id=:channel").param("user", user).param("channel", channel).update(); }
    public void profile(UUID user, String name) { sql.sql("UPDATE product_accounts SET display_name=:name WHERE id=:id").param("name", name).param("id", user).update(); }
    public void editChannel(Channel own, String handle, String name, String description, String notice, String category, String banner, String country, List<ChannelProfile.Link> links) {
        // Keep the current reservation too; no old name is ever released when a channel is renamed.
        if (!reserveHandle(own.id(), own.handle()) || !reserveHandle(own.id(), handle)) throw unavailableHandle();
        sql.sql("UPDATE product_channels SET handle=:handle,display_name=:name,description=:description,notice=:notice,category=:category,banner_preset=:banner,country_code=:country,links=CAST(:links AS jsonb) WHERE id=:id")
                .param("handle", handle).param("name", name).param("description", description).param("notice", notice).param("category", category).param("banner", banner, java.sql.Types.VARCHAR)
                .param("country", country, java.sql.Types.VARCHAR).param("links", json.writeValueAsString(links)).param("id", own.id()).update();
    }
    private boolean reserveHandle(UUID channel, String handle) {
        int inserted = sql.sql("INSERT INTO product_channel_handles(handle,channel_id) VALUES(:handle,:channel) ON CONFLICT(handle) DO NOTHING")
                .param("handle", handle).param("channel", channel).update();
        return inserted == 1 || sql.sql("SELECT EXISTS(SELECT 1 FROM product_channel_handles WHERE handle=:handle AND channel_id=:channel)")
                .param("handle", handle).param("channel", channel).query(Boolean.class).single();
    }
    private static ProductProblem unavailableHandle() { return new ProductProblem(409, "HANDLE_UNAVAILABLE", "이미 사용 중이거나 이전에 사용된 채널 주소예요."); }
    public boolean connect(UUID owner, String path) { return sql.sql("UPDATE product_channels SET notification_live_after_ms=CASE WHEN stream_path IS NULL THEN (extract(epoch FROM clock_timestamp()) * 1000)::bigint ELSE notification_live_after_ms END,stream_path=:path WHERE owner_id=:owner AND (stream_path IS NULL OR stream_path=:path)").param("path", path).param("owner", owner).update() == 1; }
    private UUID viewer(UUID id) { return id == null ? ANONYMOUS : id; }
    private Account accountRow(ResultSet r, int row) throws SQLException { return new Account(r.getObject("id", UUID.class), r.getString("email"), r.getString("password_hash"), r.getString("display_name"), r.getBoolean("is_operator")); }
    private Channel channelRow(ResultSet r, int row) throws SQLException { return new Channel(r.getObject("id", UUID.class), r.getObject("owner_id", UUID.class), r.getString("handle"), r.getString("display_name"), r.getString("description"), r.getString("notice"), r.getString("category"), r.getString("banner_preset"), r.getString("stream_path"), r.getLong("follower_count"), r.getBoolean("following"), r.getBoolean("notifications_on"), r.getTimestamp("created_at").toInstant().toEpochMilli(), r.getString("country_code"), ChannelProfile.links(json.readTree(r.getString("links")))); }
}
