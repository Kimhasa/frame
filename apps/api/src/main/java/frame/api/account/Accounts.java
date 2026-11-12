package frame.api.account;

import frame.api.FrameProperties;
import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import frame.api.obs.ObsBroadcasts;
import frame.api.obs.ObsProperties;
import frame.api.playback.Audience;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.HexFormat;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

@Service
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class Accounts {
    private static final Set<String> RESERVED = Set.of("api", "admin", "auth", "studio", "login", "register", "settings", "me", "live", "watch", "following", "vod", "clips", "assets", "_frame", "support", "help", "system", "frame", "payments", "session", "channels", "thumbnails");
    private static final Set<String> CATEGORIES = Set.of("개발·작업", "게임", "일상·이야기", "디자인·창작", "지식·탐색");
    private static final SecureRandom HANDLE_RANDOM = new SecureRandom();
    private final AccountRepository repository;
    private final PasswordEncoder passwords;
    private final String dummyPassword;
    private final PublisherTokens tokens;
    private final FrameProperties frame;
    private final ObsBroadcasts obs;
    private final ObsProperties obsProps;
    private final BroadcastRegistry broadcasts;
    private final Audience audience;
    public Accounts(AccountRepository repository, PasswordEncoder passwords, PublisherTokens tokens, FrameProperties frame, ObsBroadcasts obs,
                    ObsProperties obsProps, BroadcastRegistry broadcasts, Audience audience) {
        this.repository = repository; this.passwords = passwords; this.dummyPassword = passwords.encode(UUID.randomUUID().toString());
        this.tokens = tokens; this.frame = frame; this.obs = obs; this.obsProps = obsProps; this.broadcasts = broadcasts; this.audience = audience;
    }
    @Transactional public AccountRepository.Account register(JsonNode value) {
        ProductPolicies.requireConsent(value);
        String email = email(text(value, "email")), password = password(text(value, "password")), name = name(text(value, "displayName"));
        String handle = !value.has("handle") || value.path("handle").isNull() ? null : handle(text(value, "handle"));
        UUID user = UUID.randomUUID(), channel = UUID.randomUUID();
        try {
            repository.insertAccount(user, email, passwords.encode(password), name, ProductPolicies.TERMS_VERSION, ProductPolicies.PRIVACY_VERSION);
            if (handle != null) repository.insertChannel(channel, user, handle, name);
            else {
                boolean inserted = false;
                for (int attempt = 0; attempt < 5; attempt++) {
                    byte[] random = new byte[10]; HANDLE_RANDOM.nextBytes(random);
                    if (repository.insertChannelIfAvailable(channel, user, "ch-" + HexFormat.of().formatHex(random), name)) { inserted = true; break; }
                }
                if (!inserted) throw new ProductProblem(503, "CHANNEL_CREATION_UNAVAILABLE", "채널을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
            }
        }
        catch (DuplicateKeyException failure) { throw new ProductProblem(409, "ACCOUNT_EXISTS", "이미 사용 중인 이메일 또는 채널 주소예요."); }
        return repository.account(user).orElseThrow();
    }
    public AccountRepository.Account login(JsonNode value) {
        String email = email(text(value, "email")), password = text(value, "password");
        if (length(password) > 128 || length(password) < 1) throw new ProductProblem(401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해 주세요.");
        var account = repository.email(email);
        boolean matches = passwords.matches(password, account.map(AccountRepository.Account::passwordHash).orElse(dummyPassword));
        if (account.isEmpty() || !matches) throw new ProductProblem(401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해 주세요.");
        return account.get();
    }
    public Map<String, Object> user(UUID id) { var account = repository.account(id).orElseThrow(() -> new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요.")); return Map.of("id", id.toString(), "email", account.email(), "displayName", account.displayName(), "isOperator", account.isOperator()); }
    public Map<String, Object> own(UUID user) { return view(repository.own(user)); }
    public Map<String, Object> channel(String handle, UUID viewer) { return view(repository.channelByHandle(handle.toLowerCase(Locale.ROOT), viewer).orElseThrow(() -> new ProductProblem(404, "CHANNEL_NOT_FOUND", "채널을 찾을 수 없어요."))); }
    public Map<String, Object> channel(UUID id, UUID viewer) { return view(repository.channel(id, viewer).orElseThrow(() -> new ProductProblem(404, "CHANNEL_NOT_FOUND", "채널을 찾을 수 없어요."))); }
    public Map<String, Object> directory(String query, int limit, UUID viewer) { if (length(query) > 120 || query.codePoints().anyMatch(Character::isISOControl) || limit < 1 || limit > 50) throw new ProductProblem(400, "INVALID_QUERY", "검색 조건을 확인해 주세요."); return page(repository.directory(query.trim(), limit, viewer)); }
    public Map<String, Object> follows(UUID viewer) { return page(repository.follows(viewer)); }
    @Transactional public Map<String, Object> follow(UUID user, UUID channelId, JsonNode value) {
        var target = repository.channel(channelId, user).orElseThrow(() -> new ProductProblem(404, "CHANNEL_NOT_FOUND", "채널을 찾을 수 없어요."));
        if (target.ownerId().equals(user)) throw new ProductProblem(400, "SELF_FOLLOW_NOT_ALLOWED", "내 채널은 팔로우할 수 없어요.");
        Boolean notifications = null;
        if (value.has("notificationsOn")) { if (!value.path("notificationsOn").isBoolean()) throw new ProductProblem(400, "INVALID_NOTIFICATIONS", "알림 설정을 확인해 주세요."); notifications = value.path("notificationsOn").booleanValue(); }
        repository.follow(user, channelId, notifications); return view(repository.channel(channelId, user).orElseThrow());
    }
    @Transactional public Map<String, Object> unfollow(UUID user, UUID channelId) { if (repository.channel(channelId, user).isEmpty()) throw new ProductProblem(404, "CHANNEL_NOT_FOUND", "채널을 찾을 수 없어요."); repository.unfollow(user, channelId); return view(repository.channel(channelId, user).orElseThrow()); }
    @Transactional public void profile(UUID user, JsonNode value) { repository.profile(user, name(text(value, "displayName"))); }
    @Transactional public Map<String, Object> editChannel(UUID user, JsonNode value) {
        var own = repository.lockedOwn(user);
        String name = name(text(value, "displayName")), description = bounded(text(value, "description"), 500), notice = bounded(text(value, "notice"), 1000), category = text(value, "category");
        if (!CATEGORIES.contains(category)) throw new ProductProblem(400, "INVALID_CATEGORY", "카테고리를 확인해 주세요.");
        String banner = value.has("bannerPreset") ? value.path("bannerPreset").isNull() ? null : text(value, "bannerPreset") : own.bannerPreset();
        if (banner != null && !Set.of("studio", "forest", "city").contains(banner)) throw new ProductProblem(400, "INVALID_BANNER", "배너 설정을 확인해 주세요.");
        String handle = value.has("handle") ? handle(text(value, "handle")) : own.handle();
        String country = value.has("countryCode") ? ChannelProfile.country(value.path("countryCode")) : own.countryCode();
        List<ChannelProfile.Link> links = value.has("links") ? ChannelProfile.links(value.path("links")) : own.links();
        repository.editChannel(own, handle, name, description, notice, category, banner, country, links); return view(repository.own(user));
    }
    @Transactional public Map<String, Object> connect(UUID user, JsonNode value) {
        String key = text(value, "streamKey");
        if (key.length() > 1024) throw proofError();
        int split = key.indexOf('?');
        if (split < 1) throw proofError();
        String path = key.substring(0, split), publisher = null, credential = null;
        try {
            for (String pair : key.substring(split + 1).split("&")) {
                String[] item = pair.split("=", 2); if (item.length != 2) throw proofError();
                String field = URLDecoder.decode(item[0], StandardCharsets.UTF_8), content = URLDecoder.decode(item[1], StandardCharsets.UTF_8);
                if (field.equals("user") && publisher == null) publisher = content;
                else if (field.equals("pass") && credential == null) credential = content;
                else throw proofError();
            }
        } catch (IllegalArgumentException failure) { throw proofError(); }
        int owner = credential == null ? -1 : tokens.indexOf("Bearer " + credential);
        if (!ObsBroadcasts.PATH.matcher(path).matches() || !path.equals(publisher) || owner < 0 || tokens.explicitOwner(path) != owner) throw proofError();
        try { if (!repository.connect(user, path)) throw new ProductProblem(409, "CHANNEL_ALREADY_CONNECTED", "이 채널은 이미 다른 송출 경로에 연결되어 있어요."); }
        catch (DuplicateKeyException failure) { throw new ProductProblem(409, "STREAM_ALREADY_CONNECTED", "이미 다른 채널에 연결된 송출 경로예요."); }
        return view(repository.own(user));
    }
    public Map<String, Object> studio(UUID user) {
        var channel = connected(user);
        String token = configuredToken(channel.streamPath());
        var state = obs.status(channel.streamPath());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", channel.streamPath()); out.put("state", state.state()); out.put("broadcastId", state.broadcastId()); out.put("mediaReady", state.mediaReady());
        out.put("title", state.metadata().title()); out.put("publisher", state.metadata().publisher()); out.putAll(obs.metrics(channel.streamPath()));
        out.put("serverUrl", obsProps.serverUrl()); out.put("streamKey", channel.streamPath() + "?user=" + channel.streamPath() + "&pass=" + URLEncoder.encode(token, StandardCharsets.UTF_8));
        return out;
    }
    public Map<String, Object> editStudio(UUID user, JsonNode value) {
        var channel = connected(user); configuredToken(channel.streamPath());
        String title = bounded(text(value, "title"), 100), publisher = value.has("publisher") ? bounded(text(value, "publisher"), 30) : channel.displayName();
        if (title.isBlank() || title.getBytes(StandardCharsets.UTF_8).length > 200 || publisher.getBytes(StandardCharsets.UTF_8).length > 100) throw new ProductProblem(400, "INVALID_BROADCAST_INFO", "방송 제목과 채널 이름을 확인해 주세요.");
        obs.update(channel.streamPath(), new ObsBroadcasts.Metadata(title, publisher)); return studio(user);
    }
    private AccountRepository.Channel connected(UUID user) {
        var channel = repository.own(user);
        if (!obsProps.enabled() || channel.streamPath() == null || tokens.explicitOwner(channel.streamPath()) < 0) throw new ProductProblem(403, "CHANNEL_NOT_CONNECTED", "아직 내 채널에 연결된 송출 정보가 없어요.");
        return channel;
    }
    private String configuredToken(String path) {
        int owner = tokens.explicitOwner(path);
        List<String> entries = new ArrayList<>();
        if (frame.publisherTokens() != null) entries.addAll(List.of(frame.publisherTokens().split(",")));
        if (frame.publisherTokensFile() != null && !frame.publisherTokensFile().isBlank()) try { entries.addAll(Files.readAllLines(Path.of(frame.publisherTokensFile()), StandardCharsets.UTF_8)); } catch (java.io.IOException failure) { throw new ProductProblem(503, "STUDIO_UNAVAILABLE", "송출 정보를 연결할 수 없어요."); }
        for (String entry : entries) {
            String[] parts = entry.replace("\uFEFF", "").strip().split("\\s+");
            if (parts.length >= 2 && !parts[0].startsWith("#") && tokens.indexOf("Bearer " + parts[0]) == owner) return parts[0];
        }
        throw new ProductProblem(503, "STUDIO_UNAVAILABLE", "송출 정보를 연결할 수 없어요.");
    }
    private Map<String, Object> page(List<AccountRepository.Channel> rows) { Map<String, Object> page = new LinkedHashMap<>(); page.put("items", rows.stream().map(this::view).toList()); page.put("nextCursor", null); return page; }
    private Map<String, Object> view(AccountRepository.Channel c) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", c.id().toString()); out.put("handle", c.handle()); out.put("displayName", c.displayName()); out.put("description", c.description()); out.put("notice", c.notice()); out.put("category", c.category());
        out.put("avatarUrl", null); out.put("bannerUrl", null); out.put("bannerPreset", c.bannerPreset()); out.put("followerCount", c.followerCount()); out.put("following", c.following()); out.put("notificationsOn", c.notificationsOn());
        out.put("createdAtMs", c.createdAtMs()); out.put("countryCode", c.countryCode()); out.put("links", c.links()); out.put("videoCount", null); out.put("totalViewCount", null);
        Broadcast live = c.streamPath() == null ? null : broadcasts.byPath(c.streamPath());
        if (live == null) out.put("liveBroadcast", null);
        else {
            Map<String, Object> broadcast = new LinkedHashMap<>(); broadcast.put("id", live.id); broadcast.put("path", live.path); broadcast.put("title", live.title); broadcast.put("publisher", c.displayName());
            broadcast.put("thumbnailUrl", "/thumbnails/" + live.id + ".jpg"); broadcast.put("avatarUrl", null); broadcast.put("category", c.category()); broadcast.put("viewerCount", audience.hls(live.path)); broadcast.put("startedAtMs", live.startedAtRelayMs);
            if (live.width > 0 && live.height > 0) broadcast.put("sourceVideo", Map.of("width", live.width, "height", live.height)); out.put("liveBroadcast", broadcast);
        }
        return out;
    }
    static String text(JsonNode value, String field) { if (!value.path(field).isString()) throw new ProductProblem(400, "INVALID_INPUT", "입력 내용을 확인해 주세요."); return value.path(field).asString(); }
    static int length(String value) { return value.codePointCount(0, value.length()); }
    static String handle(String value) {
        value = value.trim();
        if (!value.matches("[A-Za-z][A-Za-z0-9_-]{2,23}") || RESERVED.contains(value.toLowerCase(Locale.ROOT))) throw new ProductProblem(400, "INVALID_HANDLE", "채널 주소는 영문 소문자로 시작하는 3~24자의 영문·숫자·밑줄·하이픈으로 입력해 주세요.");
        return value.toLowerCase(Locale.ROOT);
    }
    static String name(String value) { value = value.trim(); if (length(value) < 1 || length(value) > 30 || value.codePoints().anyMatch(Character::isISOControl)) throw new ProductProblem(400, "INVALID_DISPLAY_NAME", "이름은 1~30자로 입력해 주세요."); return value; }
    private static String email(String value) { value = value.trim().toLowerCase(Locale.ROOT); if (value.length() > 254 || value.codePoints().anyMatch(Character::isISOControl) || !value.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) throw new ProductProblem(400, "INVALID_EMAIL", "이메일 주소를 확인해 주세요."); return value; }
    private static String password(String value) { if (length(value) < 10 || length(value) > 128 || value.indexOf('\0') >= 0) throw new ProductProblem(400, "INVALID_PASSWORD", "비밀번호는 10~128자로 입력해 주세요."); return value; }
    private static String bounded(String value, int max) { value = value.trim(); if (length(value) > max || value.indexOf('\0') >= 0) throw new ProductProblem(400, "INVALID_INPUT", "입력 내용의 길이를 확인해 주세요."); return value; }
    private static ProductProblem proofError() { return new ProductProblem(403, "INVALID_STREAM_PROOF", "송출 키를 확인해 주세요."); }
}
