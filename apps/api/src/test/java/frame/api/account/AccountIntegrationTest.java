package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import frame.api.FrameApiApplication;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Opt-in, real PostgreSQL and authenticated Redis; never the product database or actual publisher credentials. */
@EnabledIfEnvironmentVariable(named = "FRAME_PRODUCT_TEST_CONFIG", matches = ".+")
class AccountIntegrationTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String ORIGIN = "http://127.0.0.1:5360", TOKEN = "product-verification-only-publisher-token-1234567890";
    @org.junit.jupiter.api.io.TempDir Path vodDirectory;
    @org.junit.jupiter.api.io.TempDir Path clipDirectory;
    @Test void realCookiesCsrfAccountsFollowsAndOwnedStudioSurviveServerRestart() throws Exception {
        JsonNode privateConfig = JSON.readTree(Files.readAllBytes(Path.of(System.getenv("FRAME_PRODUCT_TEST_CONFIG"))));
        String database = privateConfig.path("verifyDbUrl").asString();
        assertTrue(verificationDatabase("jdbc:postgresql://127.0.0.1:15432/frame_product_verify"));
        assertTrue(verificationDatabase("jdbc:postgresql://127.0.0.1:25432/frame_product_verify"));
        assertFalse(verificationDatabase("jdbc:postgresql://127.0.0.1:15432/frame_product"));
        assertFalse(verificationDatabase("jdbc:postgresql://127.0.0.1:25432/frame_product"));
        assertFalse(verificationDatabase("jdbc:postgresql://remote.example:25432/frame_product_verify"));
        assertFalse(verificationDatabase("jdbc:postgresql://127.0.0.1:5432/frame_product_verify"));
        assertFalse(verificationDatabase("jdbc:postgresql://127.0.0.1:25432/frame_product_verify?currentSchema=public"));
        if (!verificationDatabase(database)) throw new IllegalStateException("Only the isolated loopback verification database is allowed");
        String schema = "verify_" + UUID.randomUUID().toString().replace("-", ""), namespace = "frame:product:verify:" + schema + ":sessions";
        String username = privateConfig.path("dbUsername").asString(), password = privateConfig.path("dbPassword").asString();
        try (var connection = DriverManager.getConnection(database, username, password); var statement = connection.createStatement()) { statement.execute("CREATE SCHEMA " + schema); }
        var mediaState = new java.util.concurrent.atomic.AtomicReference<>("{\"items\":[]}");
        var mediaStub = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        mediaStub.createContext("/v3/paths/list", exchange -> {
            byte[] body = mediaState.get().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, body.length); exchange.getResponseBody().write(body); exchange.close();
        });
        mediaStub.start();
        Map<String, Object> properties = new HashMap<>();
        properties.put("frame.product.enabled", "true"); properties.put("server.port", "0"); properties.put("frame.product.public-origin", ORIGIN);
        properties.put("frame.product.cookie-secure", "false"); properties.put("spring.datasource.url", database + "?currentSchema=" + schema);
        properties.put("spring.datasource.username", username); properties.put("spring.datasource.password", password);
        properties.put("spring.datasource.hikari.maximum-pool-size", "2");
        properties.put("spring.flyway.schemas", schema); properties.put("spring.flyway.default-schema", schema);
        properties.put("spring.data.redis.host", privateConfig.path("redisHost").asString()); properties.put("spring.data.redis.port", privateConfig.path("redisPort").intValue());
        properties.put("spring.data.redis.password", privateConfig.path("redisPassword").asString()); properties.put("spring.session.redis.namespace", namespace);
        properties.put("frame.mediamtx.api", "http://127.0.0.1:" + mediaStub.getAddress().getPort()); properties.put("frame.obs.enabled", "true");
        properties.put("frame.publisher-tokens", TOKEN + " obs-verify history-unlinked"); properties.put("frame.publisher-tokens-file", "");
        properties.put("frame.payments.enabled", "false");
        properties.put("frame.quality.renditions", "");
        properties.put("frame.dvr.record-dir", "");
        properties.put("frame.product.vod-dir", vodDirectory.toString());
        properties.put("frame.product.clip-dir", clipDirectory.toString());
        ConfigurableApplicationContext app = null;
        try {
            app = start(properties);
            assertEquals(java.util.Set.of("/api/v1/*"), java.util.Set.copyOf(app.getBean("sessionRepositoryFilterRegistration", org.springframework.boot.web.servlet.DelegatingFilterProxyRegistrationBean.class).getUrlPatterns()));
            String base = base(app);
            Browser a = new Browser(base), b = new Browser(base), anonymous = new Browser(base);
            var policies = anonymous.get("/api/v1/policies"); assertEquals(200, policies.status());
            assertEquals(ProductPolicies.TERMS_VERSION, policies.json().path("terms").path("version").asString());
            assertEquals(ProductPolicies.PRIVACY_VERSION, policies.json().path("privacy").path("version").asString());
            assertTrue(policies.json().path("terms").path("required").booleanValue()); assertTrue(policies.json().path("privacy").path("required").booleanValue());
            assertEquals(3, policies.json().path("terms").path("sections").size()); assertEquals(4, policies.json().path("privacy").path("sections").size());
            Browser consents = new Browser(base); consents.clientIp = "198.51.100.20"; consents.get("/api/v1/session");
            Map<String, Object> consentPayload = new HashMap<>(signup("consent@example.test", "consent-room", "동의 확인", "a-password-long-enough"));
            consentPayload.remove("termsAccepted"); consentPayload.remove("privacyAccepted");
            var missingConsent = consents.write("POST", "/api/v1/auth/register", consentPayload); assertEquals(400, missingConsent.status()); assertEquals("CONSENT_REQUIRED", missingConsent.code());
            consentPayload.put("termsAccepted", true); consentPayload.put("privacyAccepted", false);
            var falseConsent = consents.write("POST", "/api/v1/auth/register", consentPayload); assertEquals(400, falseConsent.status()); assertEquals("CONSENT_REQUIRED", falseConsent.code());
            consentPayload.put("privacyAccepted", "true");
            assertEquals("CONSENT_REQUIRED", consents.write("POST", "/api/v1/auth/register", consentPayload).code());
            consentPayload.put("privacyAccepted", true); consentPayload.put("termsVersion", "2025-01-01");
            var staleConsent = consents.write("POST", "/api/v1/auth/register", consentPayload); assertEquals(400, staleConsent.status()); assertEquals("CONSENT_VERSION_CHANGED", staleConsent.code());
            consentPayload.remove("termsVersion");
            assertEquals("CONSENT_VERSION_CHANGED", consents.write("POST", "/api/v1/auth/register", consentPayload).code());
            consentPayload.put("termsVersion", ProductPolicies.TERMS_VERSION); consentPayload.put("privacyVersion", "2025-01-01");
            assertEquals("CONSENT_VERSION_CHANGED", consents.write("POST", "/api/v1/auth/register", consentPayload).code());
            JdbcClient sql = app.getBean(JdbcClient.class);
            assertEquals(0, sql.sql("SELECT count(*) FROM product_accounts").query(Integer.class).single()); assertEquals(0, sql.sql("SELECT count(*) FROM product_channels").query(Integer.class).single());
            var guest = a.get("/api/v1/session"); assertEquals(200, guest.status()); assertTrue(guest.json().path("user").isNull()); assertTrue(guest.json().path("channel").isNull());
            assertFalse(a.csrf.isBlank()); assertTrue(guest.raw().headers().allValues("set-cookie").stream().anyMatch(value -> value.contains("HttpOnly") && value.contains("SameSite=Lax") && value.contains("Path=/")));
            assertTrue(guest.raw().headers().firstValue("Access-Control-Allow-Origin").isEmpty());
            String anonymousCookie = a.cookie();
            var missingCsrf = a.send("POST", "/api/v1/auth/register", signup("owner@example.test", "spring-owner", "개발하는 봄", "a-password-long-enough"), false, ORIGIN); assertEquals(403, missingCsrf.status()); assertEquals("CSRF_INVALID", missingCsrf.code());
            var crossOrigin = a.send("POST", "/api/v1/auth/register", signup("owner@example.test", "spring-owner", "개발하는 봄", "a-password-long-enough"), true, "https://outside.invalid"); assertEquals(403, crossOrigin.status()); assertEquals("ORIGIN_FORBIDDEN", crossOrigin.code());
            Map<String, Object> attemptedOperatorSignup = new HashMap<>(signup("Owner@example.test", "spring-owner", "개발하는 봄", "a-password-long-enough")); attemptedOperatorSignup.put("isOperator", true); attemptedOperatorSignup.put("roles", java.util.List.of("ROLE_ADMIN"));
            var registered = a.write("POST", "/api/v1/auth/register", attemptedOperatorSignup); assertEquals(201, registered.status()); assertFalse(registered.json().path("user").path("isOperator").booleanValue());
            assertNotEquals(anonymousCookie, a.cookie()); String ownerId = registered.json().path("user").path("id").asString(); String channelId = registered.json().path("channel").path("id").asString();
            assertEquals("owner@example.test", registered.json().path("user").path("email").asString()); assertTrue(registered.json().path("channel").path("liveBroadcast").isNull()); assertEquals(0, registered.json().path("channel").path("followerCount").longValue());
            assertEquals("spring-owner", registered.json().path("channel").path("handle").asString());
            String storedHash = sql.sql("SELECT password_hash FROM product_accounts WHERE id=:id").param("id", UUID.fromString(ownerId)).query(String.class).single(); assertTrue(storedHash.startsWith("{pbkdf2@SpringSecurity_v5_8}")); assertFalse(storedHash.contains("a-password-long-enough"));
            assertEquals(ProductPolicies.TERMS_VERSION, sql.sql("SELECT terms_version FROM product_accounts WHERE id=:id").param("id", UUID.fromString(ownerId)).query(String.class).single());
            assertEquals(ProductPolicies.PRIVACY_VERSION, sql.sql("SELECT privacy_version FROM product_accounts WHERE id=:id").param("id", UUID.fromString(ownerId)).query(String.class).single());
            assertTrue(sql.sql("SELECT consented_at <= current_timestamp AND consented_at > current_timestamp - interval '1 minute' FROM product_accounts WHERE id=:id").param("id", UUID.fromString(ownerId)).query(Boolean.class).single());
            assertEquals(403, a.get("/api/v1/studio").status()); assertEquals("CHANNEL_NOT_CONNECTED", a.get("/api/v1/studio").code());
            assertEquals(401, a.get("/api/obs/obs-verify").status());
            assertEquals(404, a.get("/api/v1/payments/orders").status()); assertEquals("NOT_FOUND", a.get("/api/v1/payments/orders").code());
            assertEquals(400, a.get("/api/v1/channels?limit=invalid").status());
            assertEquals(400, a.write("PATCH", "/api/v1/me/channel", Map.of("displayName", "봄", "description", "", "notice", "", "category", "unknown")).status());
            assertEquals(400, a.write("PATCH", "/api/v1/me/profile", Map.of("displayName", "a".repeat(31))).status());
            assertEquals(401, anonymous.get("/api/v1/me/follows").status());
            assertEquals(400, a.write("PUT", "/api/v1/me/follows/" + channelId, Map.of()).status());
            b.get("/api/v1/session"); String widePassword = "가".repeat(128);
            var second = b.write("POST", "/api/v1/auth/register", signup("viewer@example.test", "viewer-room", "작은여백", widePassword)); assertEquals(201, second.status());
            String secondChannel = second.json().path("channel").path("id").asString();
            assertEquals(200, b.write("PUT", "/api/v1/me/follows/" + channelId, Map.of()).status());
            var followed = b.write("PUT", "/api/v1/me/follows/" + channelId, Map.of("notificationsOn", true)); assertEquals(1, followed.json().path("followerCount").longValue()); assertTrue(followed.json().path("following").booleanValue()); assertTrue(followed.json().path("notificationsOn").booleanValue());
            assertEquals(1, b.get("/api/v1/me/follows").json().path("items").size());
            var publicChannel = anonymous.get("/api/v1/channels/spring-owner"); assertEquals(1, publicChannel.json().path("followerCount").longValue()); assertFalse(publicChannel.json().path("following").booleanValue()); assertFalse(publicChannel.raw().body().contains(TOKEN)); assertFalse(publicChannel.raw().body().contains("streamPath"));
            var updated = b.write("PATCH", "/api/v1/me/profile", Map.of("displayName", "바뀐 이름")); assertEquals("바뀐 이름", updated.json().path("user").path("displayName").asString()); assertEquals("작은여백", updated.json().path("channel").path("displayName").asString());
            var edited = b.write("PATCH", "/api/v1/me/channel", Map.of("displayName", "여백의 작업실", "description", "매일 조금씩 만들어요.", "notice", "화요일 저녁에 만나요.", "category", "디자인·창작", "bannerPreset", "forest", "ownerId", ownerId)); assertEquals(200, edited.status()); assertEquals("forest", edited.json().path("bannerPreset").asString());
            assertEquals("개발하는 봄", a.get("/api/v1/channels/spring-owner").json().path("displayName").asString());
            assertEquals(200, b.write("DELETE", "/api/v1/me/follows/" + channelId, null).status()); assertEquals(0, b.write("DELETE", "/api/v1/me/follows/" + channelId, null).json().path("followerCount").longValue());
            assertEquals(200, b.write("PUT", "/api/v1/me/follows/" + channelId, Map.of("notificationsOn", true)).status());
            assertEquals(403, b.write("POST", "/api/v1/me/channel/connection", Map.of("streamKey", "obs-verify?user=obs-verify&pass=wrong")).status());
            String proof = "obs-verify?user=obs-verify&pass=" + TOKEN;
            assertEquals(200, a.write("POST", "/api/v1/me/channel/connection", Map.of("streamKey", proof)).status());
            var ownStudio = a.get("/api/v1/studio"); assertEquals(200, ownStudio.status()); assertEquals(proof, ownStudio.json().path("streamKey").asString());
            assertEquals(409, b.write("POST", "/api/v1/me/channel/connection", Map.of("streamKey", proof)).status()); assertEquals(403, b.get("/api/v1/studio").status());
            assertEquals(200, a.write("PUT", "/api/v1/studio", Map.of("title", "내 방송 제목", "publisher", "개발하는 봄")).status()); assertEquals("내 방송 제목", a.get("/api/v1/studio").json().path("title").asString());
            assertEquals(403, b.write("PUT", "/api/v1/studio", Map.of("title", "남의 방송", "publisher", "다른 이름", "path", "obs-verify")).status());
            assertEquals(204, b.write("POST", "/api/v1/auth/logout", null).status()); b.get("/api/v1/session");
            var badLogin = b.write("POST", "/api/v1/auth/login", Map.of("email", "viewer@example.test", "password", "wrong-password", "remember", false)); assertEquals(401, badLogin.status()); assertEquals("INVALID_CREDENTIALS", badLogin.code());
            var logged = b.write("POST", "/api/v1/auth/login", Map.of("email", "VIEWER@example.test", "password", widePassword, "remember", true)); assertEquals(200, logged.status()); assertTrue(logged.raw().headers().allValues("set-cookie").stream().anyMatch(value -> value.contains("Max-Age=2592000")));
            Browser duplicate = new Browser(base); duplicate.get("/api/v1/session");
            assertEquals(409, duplicate.write("POST", "/api/v1/auth/register", signup("another@example.test", "spring-owner", "중복 주소", "another-password")).status());
            assertEquals(2, sql.sql("SELECT count(*) FROM product_accounts").query(Integer.class).single());
            assertEquals(0, sql.sql("SELECT count(*) FROM product_accounts WHERE email='another@example.test'").query(Integer.class).single());
            assertEquals(409, duplicate.write("POST", "/api/v1/auth/register", signup("OWNER@EXAMPLE.TEST", "other-channel", "중복 이메일", "another-password")).status());
            assertEquals(2, sql.sql("SELECT count(*) FROM product_accounts").query(Integer.class).single());
            assertEquals(400, duplicate.write("POST", "/api/v1/auth/register", signup("another@example.test", "admin", "예약 주소", "another-password")).status());
            var controlEmail = duplicate.write("POST", "/api/v1/auth/register", signup("bad\u0000address@example.test", "valid-room", "이메일 확인", "another-password")); assertEquals(400, controlEmail.status()); assertEquals("INVALID_EMAIL", controlEmail.code());
            assertEquals(2, a.get("/api/v1/channels?limit=50").json().path("items").size());
            assertEquals(1, a.get("/api/v1/channels?query=여백&limit=50").json().path("items").size());
            assertEquals(200, a.get("/api/v1/channels?query=" + "q".repeat(120)).status());
            assertEquals(400, a.get("/api/v1/channels?query=" + "q".repeat(121)).status());
            assertEquals(400, a.get("/api/v1/channels?query=bad%00query").status());
            Browser autoOne = new Browser(base), autoTwo = new Browser(base); autoOne.clientIp = "198.51.100.21"; autoTwo.clientIp = "198.51.100.22";
            autoOne.get("/api/v1/session"); autoTwo.get("/api/v1/session");
            Map<String, Object> firstAutoSignup = new HashMap<>(signup("private.name+one@example.test", "unused", "자동 가입 하나", "a-password-long-enough")); firstAutoSignup.remove("handle");
            Map<String, Object> secondAutoSignup = new HashMap<>(signup("private.name+two@example.test", "unused", "자동 가입 둘", "a-password-long-enough")); secondAutoSignup.put("handle", null);
            var generatedOne = autoOne.write("POST", "/api/v1/auth/register", firstAutoSignup);
            var generatedTwo = autoTwo.write("POST", "/api/v1/auth/register", secondAutoSignup);
            assertEquals(201, generatedOne.status()); assertEquals(201, generatedTwo.status());
            String firstHandle = generatedOne.json().path("channel").path("handle").asString(), secondHandle = generatedTwo.json().path("channel").path("handle").asString();
            assertTrue(firstHandle.matches("ch-[0-9a-f]{20}")); assertTrue(secondHandle.matches("ch-[0-9a-f]{20}")); assertNotEquals(firstHandle, secondHandle);
            assertFalse(firstHandle.contains("private")); assertFalse(secondHandle.contains("example"));
            assertEquals(firstHandle, autoOne.get("/api/v1/session").json().path("channel").path("handle").asString());
            assertEquals("자동 가입 하나", anonymous.get("/api/v1/channels/" + firstHandle).json().path("displayName").asString());
            assertTrue(sql.sql("SELECT terms_version IS NOT NULL AND privacy_version IS NOT NULL AND consented_at IS NOT NULL FROM product_accounts WHERE email='private.name+one@example.test'").query(Boolean.class).single());
            // PostgreSQL collision handling leaves the transaction usable for another candidate; nothing leaks from rollback.
            var transaction = new org.springframework.transaction.support.TransactionTemplate(app.getBean(org.springframework.transaction.PlatformTransactionManager.class));
            var repository = app.getBean(AccountRepository.class); UUID retryUser = UUID.randomUUID(), retryChannel = UUID.randomUUID();
            transaction.execute(status -> {
                repository.insertAccount(retryUser, "collision@example.test", storedHash, "충돌 검사", ProductPolicies.TERMS_VERSION, ProductPolicies.PRIVACY_VERSION);
                assertFalse(repository.insertChannelIfAvailable(retryChannel, retryUser, "spring-owner", "충돌 검사"));
                assertTrue(repository.insertChannelIfAvailable(retryChannel, retryUser, "retry-collision-room", "충돌 검사"));
                status.setRollbackOnly(); return null;
            });
            assertEquals(0, sql.sql("SELECT count(*) FROM product_accounts WHERE id=:id").param("id", retryUser).query(Integer.class).single());
            assertEquals(0, sql.sql("SELECT count(*) FROM product_channels WHERE id=:id").param("id", retryChannel).query(Integer.class).single());
            assertEquals("spring-owner", a.get("/api/v1/session").json().path("channel").path("handle").asString());
            // A pre-consent account remains usable and its agreement fields stay unrecorded after login.
            UUID legacyUser = UUID.randomUUID();
            sql.sql("INSERT INTO product_accounts(id,email,password_hash,display_name) VALUES(:id,'legacy@example.test',:hash,'기존 회원')").param("id", legacyUser).param("hash", storedHash).update();
            sql.sql("INSERT INTO product_channels(id,owner_id,handle,display_name) VALUES(:id,:owner,'legacy-room','기존 채널')").param("id", UUID.randomUUID()).param("owner", legacyUser).update();
            Browser legacy = new Browser(base); legacy.get("/api/v1/session");
            assertEquals(200, legacy.write("POST", "/api/v1/auth/login", Map.of("email", "legacy@example.test", "password", "a-password-long-enough", "remember", false)).status());
            assertTrue(sql.sql("SELECT terms_version IS NULL AND privacy_version IS NULL AND consented_at IS NULL FROM product_accounts WHERE id=:id").param("id", legacyUser).query(Boolean.class).single());
            // An old authenticated cookie whose user no longer exists must recover; policies remain public throughout.
            Browser orphan = new Browser(base); orphan.get("/api/v1/session"); String orphanCookie = orphan.cookie();
            String orphanId = new String(java.util.Base64.getDecoder().decode(orphanCookie.substring("FRAME_SESSION=".length()).replace("\"", "")), java.nio.charset.StandardCharsets.UTF_8);
            @SuppressWarnings("unchecked") var orphanSessions = (org.springframework.session.SessionRepository<org.springframework.session.Session>) app.getBean(org.springframework.session.SessionRepository.class);
            var orphanSession = orphanSessions.findById(orphanId); assertNotNull(orphanSession);
            var orphanContext = org.springframework.security.core.context.SecurityContextHolder.createEmptyContext();
            orphanContext.setAuthentication(org.springframework.security.authentication.UsernamePasswordAuthenticationToken.authenticated(UUID.randomUUID().toString(), null,
                    java.util.List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_USER"))));
            orphanSession.setAttribute(org.springframework.security.web.context.HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, orphanContext);
            orphanSession.setAttribute(AccountSecurity.LOGIN_AT, System.currentTimeMillis()); orphanSessions.save(orphanSession);
            assertEquals(200, orphan.get("/api/v1/policies").status());
            var orphanRejected = orphan.get("/api/v1/session"); assertEquals(401, orphanRejected.status()); assertEquals("UNAUTHENTICATED", orphanRejected.code()); assertNotEquals(orphanCookie, orphan.cookie());
            var recovered = orphan.get("/api/v1/session"); assertEquals(200, recovered.status()); assertTrue(recovered.json().path("user").isNull()); assertTrue(recovered.json().path("channel").isNull()); assertFalse(orphan.csrf.isBlank());
            assertEquals(200, orphan.get("/api/v1/policies").status());
            assertEquals(200, anonymous.get("/api/broadcasts").status()); assertTrue(anonymous.get("/api/broadcasts").raw().headers().allValues("set-cookie").isEmpty());
            String savedAnalytics=analytics(a,b,anonymous,sql,app,UUID.fromString(ownerId),UUID.fromString(channelId));
            String savedRecording=recordings(a,b,anonymous,sql,app,UUID.fromString(channelId));
            VodState savedVod=vods(a,b,anonymous,sql,app,UUID.fromString(channelId),UUID.fromString(savedRecording),vodDirectory);
            ClipState savedClip=clips(a,b,anonymous,sql,app,UUID.fromString(channelId),savedVod.id(),vodDirectory,clipDirectory);
            String savedSchedule = schedules(a, b, anonymous, sql, UUID.fromString(channelId));
            String savedHistory = histories(a, b, anonymous, sql, app.getBean(frame.api.broadcast.BroadcastRegistry.class), UUID.fromString(ownerId));
            channelProfiles(a, b, anonymous, sql, app.getBean(Accounts.class), UUID.fromString(channelId), UUID.fromString(secondChannel));
            ArchivedHistoryState savedArchivedHistory = archivedHistory(a, b, anonymous, sql, app, savedVod.id(), savedClip.id(), vodDirectory, clipDirectory);
            String managedReport = reportManagement(a, b, anonymous, sql, UUID.fromString(ownerId), UUID.fromString(channelId));
            String savedNotification = notifications(a, b, anonymous, sql, app, mediaState, UUID.fromString(channelId), UUID.fromString(ownerId));
            chatModeration(a,b,anonymous,sql,app,UUID.fromString(ownerId),UUID.fromString(channelId),UUID.fromString(secondChannel));
            String savedPoll=polls(a,b,anonymous,sql,app,UUID.fromString(ownerId),UUID.fromString(channelId));
            String savedQuestion=questions(a,b,anonymous,sql,app,UUID.fromString(ownerId),UUID.fromString(channelId));
            RewardState savedReward=rewards(a,b,anonymous,sql,app,UUID.fromString(ownerId),UUID.fromString(channelId));
            MissionState savedMission=missions(a,anonymous,sql,app,UUID.fromString(ownerId),UUID.fromString(channelId));
            // The same browser cookie authenticates after a fresh application instance; no fake in-memory account cache.
            app.close(); app = null; app = start(properties); a.base = base(app); b.base = base(app); savedMission.author().base=base(app);
            assertEquals("바뀐 이름", b.get("/api/v1/session").json().path("user").path("displayName").asString()); assertEquals(1, b.get("/api/v1/me/follows").json().path("items").size());
            assertEquals(200, a.get("/api/v1/studio").status());
            long analyticsUntil=System.nanoTime()+java.time.Duration.ofSeconds(8).toNanos();
            while(System.nanoTime()<analyticsUntil&&a.get("/api/v1/me/analytics?q=analytics-preserved").json().path("items").get(0).path("status").asString().equals("live"))Thread.sleep(50);
            var restoredAnalytics=a.get("/api/v1/me/analytics?q=analytics-preserved").json().path("items").get(0);
            assertEquals(savedAnalytics,restoredAnalytics.path("id").asString());assertEquals("interrupted",restoredAnalytics.path("status").asString());assertEquals("server_restart",restoredAnalytics.path("endReason").asString());
            assertEquals(10000,restoredAnalytics.path("broadcastDurationMs").longValue());assertEquals(restoredAnalytics.path("lastObservedAtMs").longValue(),restoredAnalytics.path("endedAtMs").longValue());
            var restoredRecording=a.get("/api/v1/me/recordings/"+savedRecording);assertEquals(200,restoredRecording.status());assertEquals("ready",restoredRecording.json().path("item").path("status").asString());assertEquals(2,restoredRecording.json().path("item").path("version").longValue());assertFalse(restoredRecording.json().path("item").path("readyPlayable").asBoolean());
            var restoredVod=a.get("/api/v1/me/vods/"+savedVod.id());assertEquals(200,restoredVod.status());assertEquals("ready",restoredVod.json().path("item").path("status").asString());assertTrue(restoredVod.json().path("item").path("published").asBoolean());
            assertEquals(200,new Browser(base(app)).get("/api/v1/vods/"+savedVod.id()).status());
            long vodUntil=System.nanoTime()+java.time.Duration.ofSeconds(5).toNanos();while(System.nanoTime()<vodUntil&&a.get("/api/v1/me/vods/"+savedVod.interrupted()).json().path("item").path("status").asString().equals("preparing"))Thread.sleep(25);
            var interruptedVod=a.get("/api/v1/me/vods/"+savedVod.interrupted()).json().path("item");assertEquals("failed",interruptedVod.path("status").asString());assertFalse(interruptedVod.path("published").asBoolean());assertTrue(interruptedVod.path("reason").asString().contains("다시 시작"));assertEquals(404,new Browser(base(app)).get("/api/v1/vods/"+savedVod.interrupted()).status());
            assertEquals(200,new Browser(base(app)).get("/api/v1/clips/"+savedClip.id()).status());assertTrue(a.get("/api/v1/me/clips/"+savedClip.id()).json().path("item").path("published").asBoolean());
            long clipUntil=System.nanoTime()+java.time.Duration.ofSeconds(5).toNanos();while(System.nanoTime()<clipUntil&&a.get("/api/v1/me/clips/"+savedClip.interrupted()).json().path("item").path("status").asString().equals("preparing"))Thread.sleep(25);
            var interruptedClip=a.get("/api/v1/me/clips/"+savedClip.interrupted()).json().path("item");assertEquals("failed",interruptedClip.path("status").asString());assertTrue(interruptedClip.path("reason").asString().contains("다시 시작"));assertEquals(404,new Browser(base(app)).get("/api/v1/clips/"+savedClip.interrupted()).status());
            assertTrue(a.get("/api/v1/me/schedules").json().path("items").valueStream().anyMatch(item -> item.path("id").asString().equals(savedSchedule)));
            JsonNode restoredHistory = a.get("/api/v1/me/history").json().path("items");
            assertEquals(3, restoredHistory.size());
            JsonNode restoredLiveHistory = restoredHistory.valueStream().filter(item -> item.path("id").asString().equals(savedHistory)).findFirst().orElseThrow();
            assertEquals(savedArchivedHistory.vod(), a.get("/api/v1/me/history/media/vod/" + savedVod.id()).json().path("item").path("id").asString());
            var restoredClipHistory = a.get("/api/v1/me/history/media/clip/" + savedClip.id()).json().path("item");
            assertEquals(savedArchivedHistory.clip(), restoredClipHistory.path("id").asString()); assertEquals(1700, restoredClipHistory.path("positionMs").longValue()); assertFalse(restoredClipHistory.path("completed").asBoolean());
            JsonNode restoredProfile = a.get("/api/v1/channel-ids/" + channelId).json();
            assertEquals("KR", restoredProfile.path("countryCode").asString()); assertEquals(2, restoredProfile.path("links").size());
            assertEquals("spring-owner", a.get("/api/v1/channels/spring-updated").json().path("handle").asString());
            assertEquals("REPORT_ALREADY_RECEIVED", b.write("POST", "/api/v1/channels/" + channelId + "/reports", Map.of("reason", "harassment")).code());
            assertTrue(a.get("/api/v1/session").json().path("user").path("isOperator").booleanValue());
            var restoredReview = a.get("/api/v1/admin/reports/" + managedReport); assertEquals(200, restoredReview.status());
            assertEquals("resolved", restoredReview.json().path("status").asString()); assertEquals(2, restoredReview.json().path("version").intValue());
            assertEquals("검토를 마쳤어요.", restoredReview.json().path("reviewNote").asString()); assertEquals(ownerId, restoredReview.json().path("reviewedBy").path("id").asString());
            var restoredNotifications = b.get("/api/v1/me/notifications").json().path("items"); assertEquals(1, restoredNotifications.size());
            assertEquals(savedNotification, restoredNotifications.get(0).path("id").asString()); assertFalse(restoredNotifications.get(0).path("target").path("available").booleanValue());
            assertTrue(a.get("/api/v1/me/chat/settings").json().path("blockLinks").booleanValue());
            assertTrue(a.get("/api/v1/me/chat/blocks?status=all").json().path("items").size()>0);
            var restoredPoll=a.get("/api/v1/me/polls/"+savedPoll).json().path("poll");assertEquals("closed",restoredPoll.path("status").asString());assertEquals("broadcast_ended",restoredPoll.path("closeReason").asString());assertEquals(1,restoredPoll.path("totalVotes").longValue());assertFalse(restoredPoll.path("myOptionId").isNull());
            var restoredQuestion=a.get("/api/v1/me/questions/"+savedQuestion).json().path("item");assertEquals("재시작 뒤에도 보존할 답변",restoredQuestion.path("answer").asString());assertFalse(restoredQuestion.path("pinned").booleanValue());assertFalse(restoredQuestion.path("broadcastActive").booleanValue());assertFalse(restoredQuestion.has("clientRequestId"));
            var restoredOwn=b.get("/api/v1/questions/current?path=obs-verify&broadcastId="+"7".repeat(32)).json();assertTrue(restoredOwn.path("pinned").isNull());assertTrue(restoredOwn.path("mine").valueStream().anyMatch(item->item.path("id").asString().equals(savedQuestion)&&item.path("answer").asString().equals("재시작 뒤에도 보존할 답변")&&item.has("clientRequestId")));
            var restoredReward=a.get("/api/v1/me/redemptions/"+savedReward.id()).json().path("item");assertEquals("completed",restoredReward.path("status").asString());assertEquals(savedReward.balance(),b.get("/api/v1/me/points?channelId="+channelId).json().path("balance").longValue());
            var restoredMission=a.get("/api/v1/me/missions/"+savedMission.id()).json().path("item");assertEquals("expired",restoredMission.path("status").asString());assertEquals(3,restoredMission.path("history").size());assertEquals("system",restoredMission.path("history").get(2).path("actor").asString());assertFalse(restoredMission.path("broadcastActive").booleanValue());
            assertEquals("completed",a.get("/api/v1/me/missions/"+savedMission.completedId()).json().path("item").path("status").asString());
            var restoredMissions=savedMission.author().get("/api/v1/missions/current?path=obs-verify&broadcastId="+savedMission.broadcast()).json();assertEquals(1,restoredMissions.path("mine").size());assertEquals(savedMission.id(),restoredMissions.path("mine").get(0).path("id").asString());assertFalse(restoredMissions.path("canSubmit").booleanValue());assertEquals(200,savedMission.author().write("POST","/api/v1/missions",savedMission.body()).status());
            assertEquals("재시작 보존", restoredLiveHistory.path("title").asString()); assertFalse(restoredLiveHistory.path("available").booleanValue());
            String oldCookie = a.cookie(); assertEquals(204, a.write("POST", "/api/v1/auth/logout", null).status());
            HttpResponse<String> replay = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(a.base + "/api/v1/me/follows")).header("Cookie", oldCookie).GET().build(), HttpResponse.BodyHandlers.ofString()); assertEquals(401, replay.statusCode());
            assertTrue(a.get("/api/v1/session").json().path("user").isNull());
            assertEquals(secondChannel, b.get("/api/v1/session").json().path("channel").path("id").asString());
            // The absolute login deadline is enforced even though Redis has renewed its idle expiry.
            String cookieValue = b.cookie().substring("FRAME_SESSION=".length()).replace("\"", "");
            String sessionId = new String(java.util.Base64.getDecoder().decode(cookieValue), java.nio.charset.StandardCharsets.UTF_8);
            @SuppressWarnings("unchecked") org.springframework.session.SessionRepository<org.springframework.session.Session> sessions = (org.springframework.session.SessionRepository<org.springframework.session.Session>) app.getBean(org.springframework.session.SessionRepository.class);
            var expiring = sessions.findById(sessionId); assertNotNull(expiring); expiring.setAttribute(AccountSecurity.LOGIN_AT, System.currentTimeMillis() - AccountSecurity.LONG_SECONDS * 1000L - 1000); sessions.save(expiring);
            assertEquals(401, b.get("/api/v1/me/follows").status());
            b.get("/api/v1/session");
            assertEquals(200, b.write("POST", "/api/v1/auth/login", Map.of("email", "viewer@example.test", "password", widePassword, "remember", true)).status());
            String validCookie = b.cookie(); assertFalse(b.get("/api/v1/session").json().path("user").isNull());
            app.close(); app = null;
            Map<String, Object> unavailableRedis = new HashMap<>(properties);
            unavailableRedis.put("spring.data.redis.port", 16380); unavailableRedis.put("spring.data.redis.connect-timeout", "500ms"); unavailableRedis.put("spring.data.redis.timeout", "500ms");
            app = start(unavailableRedis); String unavailableBase = base(app);
            HttpClient outage = HttpClient.newHttpClient();
            for (String path : new String[] {"/api/v1/session", "/api/v1/me/follows", "/api/v1/studio"}) {
                long began = System.nanoTime();
                var failed = outage.send(HttpRequest.newBuilder(URI.create(unavailableBase + path)).timeout(java.time.Duration.ofSeconds(5)).header("Cookie", validCookie).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(503, failed.statusCode(), path); assertEquals("PRODUCT_UNAVAILABLE", JSON.readTree(failed.body()).path("code").asString()); assertFalse(failed.body().contains("viewer@example.test"));
                assertTrue((System.nanoTime() - began) / 1_000_000 < 4500, "Redis failure must be bounded");
            }
            var anonymousFailure = outage.send(HttpRequest.newBuilder(URI.create(unavailableBase + "/api/v1/session")).timeout(java.time.Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(503, anonymousFailure.statusCode()); assertEquals("PRODUCT_UNAVAILABLE", JSON.readTree(anonymousFailure.body()).path("code").asString());
            assertFalse(anonymousFailure.body().contains("csrfToken"));
            var publicPoll=outage.send(HttpRequest.newBuilder(URI.create(unavailableBase+"/api/v1/polls/current?path=obs-verify&broadcastId="+"6".repeat(32))).timeout(java.time.Duration.ofSeconds(5)).GET().build(),HttpResponse.BodyHandlers.ofString());
            assertEquals(200,publicPoll.statusCode());assertTrue(JSON.readTree(publicPoll.body()).path("userId").isNull());assertTrue(JSON.readTree(publicPoll.body()).path("poll").path("myOptionId").isNull());
            var publicQuestions=outage.send(HttpRequest.newBuilder(URI.create(unavailableBase+"/api/v1/questions/current?path=obs-verify&broadcastId="+"7".repeat(32))).timeout(java.time.Duration.ofSeconds(5)).GET().build(),HttpResponse.BodyHandlers.ofString());
            assertEquals(200,publicQuestions.statusCode());assertTrue(JSON.readTree(publicQuestions.body()).path("userId").isNull());assertEquals(0,JSON.readTree(publicQuestions.body()).path("mine").size());assertTrue(JSON.readTree(publicQuestions.body()).path("pinned").isNull());
            var publicRewards=outage.send(HttpRequest.newBuilder(URI.create(unavailableBase+"/api/v1/rewards/current?path=obs-verify&broadcastId="+"4".repeat(32))).timeout(java.time.Duration.ofSeconds(5)).GET().build(),HttpResponse.BodyHandlers.ofString());assertEquals(200,publicRewards.statusCode());assertTrue(JSON.readTree(publicRewards.body()).path("balance").isNull());assertEquals(0,JSON.readTree(publicRewards.body()).path("mine").size());
            var publicMissions=outage.send(HttpRequest.newBuilder(URI.create(unavailableBase+"/api/v1/missions/current?path=obs-verify&broadcastId="+"6".repeat(32))).timeout(java.time.Duration.ofSeconds(5)).GET().build(),HttpResponse.BodyHandlers.ofString());assertEquals(200,publicMissions.statusCode());assertTrue(JSON.readTree(publicMissions.body()).path("userId").isNull());assertEquals(0,JSON.readTree(publicMissions.body()).path("mine").size());
            for (String path : new String[] {"/healthz", "/api/broadcasts"}) {
                var unaffected = outage.send(HttpRequest.newBuilder(URI.create(unavailableBase + path)).header("Cookie", validCookie).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(200, unaffected.statusCode(), "Product Redis must not affect the media relay: " + path); assertTrue(unaffected.headers().allValues("set-cookie").isEmpty());
            }
        } finally {
            if (app != null) app.close();
            mediaStub.stop(0);
            var redisConfig = new org.springframework.data.redis.connection.RedisStandaloneConfiguration(privateConfig.path("redisHost").asString(), privateConfig.path("redisPort").intValue());
            redisConfig.setPassword(privateConfig.path("redisPassword").asString());
            var cleanupConnection = new org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory(redisConfig);
            cleanupConnection.afterPropertiesSet();
            try {
                var redis = new org.springframework.data.redis.core.StringRedisTemplate(cleanupConnection);
                try (var scan = redis.scan(org.springframework.data.redis.core.ScanOptions.scanOptions().match(namespace + ":*").count(100).build())) {
                    java.util.List<String> keys = new java.util.ArrayList<>(); scan.forEachRemaining(keys::add); if (!keys.isEmpty()) redis.unlink(keys);
                }
            } finally { cleanupConnection.destroy(); }
            // Only this generated schema in the hard-checked verification database is removed.
            try (var connection = DriverManager.getConnection(database, username, password); var statement = connection.createStatement()) { statement.execute("DROP SCHEMA " + schema + " CASCADE"); }
        }
    }
    private record ClipState(UUID id,UUID interrupted){}
    /** Synthetic media distinguishes DB/auth/lifecycle checks from the real FFmpeg+decoded-video e2e. */
    private static ClipState clips(Browser owner,Browser other,Browser anonymous,JdbcClient sql,ConfigurableApplicationContext app,UUID channel,UUID source,Path vodDirectory,Path clipDirectory)throws Exception{
        app.getBean(ClipPublisher.class).stop();ProductClips service=app.getBean(ProductClips.class);String own="/api/v1/me/clips",pub="/api/v1/clips";
        sql.sql("UPDATE product_vods SET duration_ms=12000 WHERE id=:id").param("id",source).update();
        UUID request=UUID.randomUUID();var body=Map.of("sourceVodId",source.toString(),"clientRequestId",request.toString(),"startMs",2000,"endMs",8000,"title","clip-preserved","description","original clip request");
        assertEquals(401,anonymous.get(own).status());assertEquals(403,owner.send("POST",own,body,false,ORIGIN).status());assertEquals(403,owner.send("POST",own,body,true,"https://outside.invalid").status());assertEquals(404,other.write("POST",own,body).status());
        assertEquals(400,owner.write("POST",own,Map.of("sourceVodId",source.toString(),"clientRequestId",UUID.randomUUID().toString(),"startMs",0,"endMs",4999,"title","bad range","description","")).status());
        var created=owner.write("POST",own,body);assertEquals(202,created.status());var initial=created.json().path("item");UUID id=UUID.fromString(initial.path("id").asString());assertEquals("preparing",initial.path("status").asString());assertFalse(initial.path("published").asBoolean());assertEquals(0,initial.path("sizeBytes").longValue());
        assertEquals(id.toString(),owner.get(own+"/by-request/"+request).json().path("item").path("id").asString());assertTrue(other.get(own+"/by-request/"+request).json().path("item").isNull());assertEquals(200,owner.write("POST",own,body).status());
        assertEquals(409,owner.write("POST",own,Map.of("sourceVodId",source.toString(),"clientRequestId",request.toString(),"startMs",2000,"endMs",9000,"title","clip-preserved","description","original clip request")).status());
        assertEquals(404,other.get(own+"/"+id).status());owner.expectedUserId=UUID.randomUUID().toString();assertEquals("SESSION_CHANGED",owner.get(own).code());owner.expectedUserId=null;
        var edited=owner.write("PATCH",own+"/"+id,Map.of("version",0,"title","edited while preparing","description","retained input","visibility","private"));assertEquals(200,edited.status());
        byte[] bytes="synthetic archived clip bytes for HTTP contract".getBytes(java.nio.charset.StandardCharsets.UTF_8);Path archive=clipDirectory.resolve(id+".mp4");Files.write(archive,bytes);var attributes=Files.readAttributes(archive,java.nio.file.attribute.BasicFileAttributes.class);String hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var info=new ClipFiles.Info(bytes.length,6000,attributes.lastModifiedTime().toMillis(),String.valueOf(attributes.fileKey()),hash);service.finished(id,info);
        var current=owner.get(own+"/"+id).json().path("item");assertEquals("ready",current.path("status").asString());assertEquals("private",current.path("visibility").asString());assertEquals("edited while preparing",current.path("title").asString());assertEquals(1,current.path("version").longValue());assertFalse(current.path("published").asBoolean());assertEquals(404,anonymous.get(pub+"/"+id).status());
        // An immutable request receipt still resolves after editable metadata changes.
        assertEquals(id.toString(),owner.write("POST",own,body).json().path("item").path("id").asString());
        assertEquals(200,owner.write("PATCH",own+"/"+id,Map.of("version",1,"title","clip-preserved","description","public description","visibility","public")).status());
        var publicItem=anonymous.get(pub+"/"+id);assertEquals(200,publicItem.status());assertFalse(publicItem.json().path("item").has("clientRequestId"));assertFalse(publicItem.json().path("item").has("source_key"));assertEquals(1,anonymous.get(pub+"?channel=spring-owner").json().path("items").size());assertEquals(400,anonymous.get(pub+"?cursor=broken").status());
        try(var http=HttpClient.newHttpClient()){
            var part=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).header("Range","bytes=2-7").GET().build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(206,part.statusCode());assertArrayEquals(java.util.Arrays.copyOfRange(bytes,2,8),part.body());assertTrue(part.headers().firstValue("cache-control").orElse("").contains("no-store"));
            var head=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).method("HEAD",HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(200,head.statusCode());assertEquals(0,head.body().length);assertEquals(Integer.toString(bytes.length),head.headers().firstValue("content-length").orElse(""));
        }
        Path original=vodDirectory.resolve(source+".mp4"),held=vodDirectory.resolve(source+".clip-held");Files.move(original,held);
        try{assertEquals(200,anonymous.get(pub+"/"+id).status());assertEquals(200,anonymous.get(pub+"/"+id+"/media").status());assertTrue(owner.get(own+"/"+id).json().path("item").path("sourcePublished").asBoolean());}
        finally{Files.move(held,original);}
        sql.sql("UPDATE product_vods SET visibility='private' WHERE id=:id").param("id",source).update();
        assertEquals(404,anonymous.get(pub+"/"+id).status());assertEquals(404,anonymous.get(pub+"/"+id+"/media").status());assertEquals(0,anonymous.get(pub).json().path("items").size());var sourcePrivate=owner.get(own+"/"+id).json().path("item");assertFalse(sourcePrivate.path("published").asBoolean());assertTrue(sourcePrivate.path("available").asBoolean());assertFalse(sourcePrivate.path("sourcePublished").asBoolean());
        Path clipHeld=clipDirectory.resolve(id+".held");Files.move(archive,clipHeld);
        try{assertEquals(200,owner.write("PATCH",own+"/"+id,Map.of("version",2,"title","clip-preserved","description","public description","visibility","private")).status());}
        finally{Files.move(clipHeld,archive);}
        assertEquals(409,owner.write("PATCH",own+"/"+id,Map.of("version",2,"title","stale","description","","visibility","public")).status());
        sql.sql("UPDATE product_vods SET visibility='public' WHERE id=:id").param("id",source).update();assertEquals(404,anonymous.get(pub+"/"+id).status());
        assertEquals(200,owner.write("PATCH",own+"/"+id,Map.of("version",3,"title","clip-preserved","description","public description","visibility","public")).status());
        sql.sql("UPDATE product_clips SET status='failed',reason='preparation_failed' WHERE id=:id").param("id",id).update();
        var retried=owner.write("POST",own+"/"+id+"/retry",Map.of("version",4));assertEquals(202,retried.status());assertEquals("preparing",retried.json().path("item").path("status").asString());assertEquals(0,retried.json().path("item").path("sizeBytes").longValue());service.finished(id,info);
        UUID interruptedRequest=UUID.randomUUID();var pending=owner.write("POST",own,Map.of("sourceVodId",source.toString(),"clientRequestId",interruptedRequest.toString(),"startMs",0,"endMs",6000,"title","interrupted clip","description",""));assertEquals(202,pending.status());UUID interrupted=UUID.fromString(pending.json().path("item").path("id").asString());
        return new ClipState(id,interrupted);
    }
    private record VodState(UUID id,UUID interrupted){}
    /** Synthetic archive bytes verify auth, range, metadata and DB recovery; media e2e validates real MP4 publishing/decoding. */
    private static VodState vods(Browser owner,Browser other,Browser anonymous,JdbcClient sql,ConfigurableApplicationContext app,UUID channel,UUID recording,Path directory)throws Exception{
        app.getBean(VodPublisher.class).stop();var files=app.getBean(VodFiles.class);var service=app.getBean(ProductVods.class);
        String own="/api/v1/me/vods",pub="/api/v1/vods";UUID id=UUID.randomUUID();byte[] bytes="synthetic archive bytes for range and authorization checks".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Path archive=directory.resolve(id+".mp4");Files.write(archive,bytes);var info=files.inspect(id);String hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));long now=System.currentTimeMillis();
        sql.sql("""
                INSERT INTO product_vods(id,channel_id,recording_id,title,description,status,visibility,duration_ms,size_bytes,archive_modified_ms,archive_key,archive_sha256,published_at_ms,created_at_ms,updated_at_ms)
                VALUES(:id,:channel,:recording,'vod-preserved','saved description','ready','public',3000,:size,:modified,:key,:hash,:now,:now,:now)
                """).param("id",id).param("channel",channel).param("recording",recording).param("size",bytes.length).param("modified",info.modified()).param("key",info.key()).param("hash",hash).param("now",now).update();
        assertEquals(401,anonymous.get(own).status());assertEquals(401,anonymous.get(own+"/"+id).status());assertEquals(404,other.get(own+"/"+id).status());
        assertTrue(other.get(own+"/by-recording/"+recording).json().path("item").isNull());assertEquals(0,other.get(own).json().path("items").size());
        assertEquals(400,owner.get(own+"?status=unknown").status());assertEquals(400,owner.get(pub+"?limit=0").status());assertEquals(400,anonymous.get(pub+"?cursor=broken").status());
        owner.expectedUserId=UUID.randomUUID().toString();assertEquals("SESSION_CHANGED",owner.get(own).code());owner.expectedUserId=null;
        var view=anonymous.get(pub+"/"+id);assertEquals(200,view.status());assertEquals("vod-preserved",view.json().path("item").path("title").asString());assertFalse(view.json().path("item").has("recordingId"));assertFalse(view.json().path("item").has("archive_key"));assertTrue(view.raw().headers().firstValue("cache-control").orElse("").contains("no-store"));
        assertEquals(id.toString(),anonymous.get(pub).json().path("items").get(0).path("id").asString());assertEquals(1,anonymous.get(pub+"?channel=spring-owner").json().path("items").size());assertEquals(0,anonymous.get(pub+"?q=nonexistent").json().path("items").size());
        try(var http=HttpClient.newHttpClient()){
            var full=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).GET().build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(200,full.statusCode());assertArrayEquals(bytes,full.body());assertEquals("video/mp4",full.headers().firstValue("content-type").orElse(""));assertTrue(full.headers().firstValue("cache-control").orElse("").contains("no-store"));
            var head=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).method("HEAD",HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(200,head.statusCode());assertEquals(0,head.body().length);assertEquals(Integer.toString(bytes.length),head.headers().firstValue("content-length").orElse(""));
            var part=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).header("Range","bytes=2-7").GET().build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(206,part.statusCode());assertArrayEquals(java.util.Arrays.copyOfRange(bytes,2,8),part.body());assertEquals("bytes 2-7/"+bytes.length,part.headers().firstValue("content-range").orElse(""));
            var suffix=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).header("Range","bytes=-3").GET().build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(206,suffix.statusCode());assertArrayEquals(java.util.Arrays.copyOfRange(bytes,bytes.length-3,bytes.length),suffix.body());
            var invalid=http.send(HttpRequest.newBuilder(URI.create(owner.base+pub+"/"+id+"/media")).header("Range","bytes="+bytes.length+"-").GET().build(),HttpResponse.BodyHandlers.ofByteArray());assertEquals(416,invalid.statusCode());assertEquals("bytes */"+bytes.length,invalid.headers().firstValue("content-range").orElse(""));
        }
        var body=Map.of("version",0,"title","vod-preserved","description","saved description","visibility","private");
        assertEquals(403,owner.send("PATCH",own+"/"+id,body,false,ORIGIN).status());assertEquals(403,owner.send("PATCH",own+"/"+id,body,true,"https://outside.invalid").status());assertEquals(404,other.write("PATCH",own+"/"+id,body).status());
        assertEquals(400,owner.write("PATCH",own+"/"+id,Map.of("version",0,"title","","description","","visibility","public")).status());
        var hidden=owner.write("PATCH",own+"/"+id,body);assertEquals(200,hidden.status());assertEquals(1,hidden.json().path("item").path("version").longValue());assertFalse(hidden.json().path("item").path("published").asBoolean());
        assertEquals(404,anonymous.get(pub+"/"+id).status());assertEquals(404,anonymous.get(pub+"/"+id+"/media").status());assertEquals(0,anonymous.get(pub).json().path("items").size());assertTrue(Files.exists(archive));assertEquals("VOD_CONFLICT",owner.write("PATCH",own+"/"+id,body).code());
        assertEquals(200,owner.write("PATCH",own+"/"+id,Map.of("version",1,"title","vod-preserved","description","saved description","visibility","public")).status());
        // Raw data is unavailable in this fixture; an archived copy must remain manageable independently.
        assertFalse(owner.get("/api/v1/me/recordings/"+recording).json().path("item").path("readyPlayable").asBoolean());assertEquals(id.toString(),owner.get(own+"/by-recording/"+recording).json().path("item").path("id").asString());
        assertEquals(2,owner.write("PATCH",own+"/"+id,Map.of("version",2,"title","vod-preserved","description","saved description","visibility","public")).json().path("item").path("version").longValue());
        Path held=directory.resolve(id+".held");Files.move(archive,held);
        try{
            assertEquals(404,anonymous.get(pub+"/"+id).status());assertEquals(404,anonymous.get(pub+"/"+id+"/media").status());assertFalse(owner.get(own+"/"+id).json().path("item").path("available").asBoolean());
            assertEquals("VOD_ARCHIVE_UNAVAILABLE",owner.write("PATCH",own+"/"+id,Map.of("version",2,"title","vod-preserved","description","saved description","visibility","public")).code());
            assertEquals(200,owner.write("PATCH",own+"/"+id,Map.of("version",2,"title","vod-preserved","description","saved description","visibility","private")).status());
        }finally{Files.move(held,archive);}
        assertEquals(200,owner.write("PATCH",own+"/"+id,Map.of("version",3,"title","vod-preserved","description","saved description","visibility","public")).status());assertArrayEquals(bytes,Files.readAllBytes(archive));
        var receipt=Map.of("recordingId",recording.toString(),"title","vod-preserved","description","saved description");assertEquals(200,owner.write("POST",own,receipt).status());assertEquals("VOD_ALREADY_EXISTS",owner.write("POST",own,Map.of("recordingId",recording.toString(),"title","different","description","saved description")).code());
        assertEquals(1,sql.sql("SELECT count(*) FROM product_vods WHERE recording_id=:recording").param("recording",recording).query(Integer.class).single());assertEquals("VOD_NOT_FAILED",owner.write("POST",own+"/"+id+"/retry",Map.of("version",4)).code());
        // A reverified source may have different metadata after a failed attempt. Retry persists that snapshot.
        UUID ownerId=UUID.fromString(owner.get("/api/v1/session").json().path("user").path("id").asString());var refreshedSource=org.mockito.Mockito.mock(ChannelRecordings.class);
        org.mockito.Mockito.when(refreshedSource.asset(ownerId,recording)).thenReturn(new ChannelRecordings.Asset(recording,"obs-verify","fixture.mp4",bytes.length+1,20,"refreshed-source",2000,1000,7000));
        org.mockito.Mockito.when(refreshedSource.detail(ownerId,recording)).thenReturn(new ChannelRecordings.Detail(ownerId,new ChannelRecordings.Item(recording,"source","source.mp4",2000,4000L,(long)bytes.length+1,"ready",3,false,true,now,"a".repeat(32),null),now));
        sql.sql("UPDATE product_vods SET status='failed',reason='preparation_failed' WHERE id=:id").param("id",id).update();
        var refreshed=new ProductVods(sql,refreshedSource,files).retry(ownerId,id,JSON.valueToTree(Map.of("version",4))).item();assertEquals("preparing",refreshed.status());assertEquals(bytes.length+1,refreshed.sizeBytes());assertEquals(4000,refreshed.durationMs());assertEquals(5,refreshed.version());
        sql.sql("UPDATE product_vods SET status='ready',reason=NULL,size_bytes=:size,duration_ms=3000 WHERE id=:id").param("size",bytes.length).param("id",id).update();
        // Copier completion must preserve metadata/visibility/version edited while preparing.
        UUID completed=UUID.randomUUID();sql.sql("INSERT INTO product_vods(id,channel_id,title,description,status,visibility,duration_ms,size_bytes,created_at_ms,updated_at_ms,version) VALUES(:id,:channel,'edited during copy','private decision','preparing','private',3000,:size,:now,:now,7)").param("id",completed).param("channel",channel).param("size",bytes.length).param("now",now).update();
        service.finished(completed,new VodFiles.Info(info.size(),info.modified(),info.key(),hash));var completedItem=owner.get(own+"/"+completed).json().path("item");assertEquals("edited during copy",completedItem.path("title").asString());assertEquals("private",completedItem.path("visibility").asString());assertEquals(7,completedItem.path("version").longValue());assertTrue(completedItem.path("publishedAtMs").isNull());assertEquals(404,anonymous.get(pub+"/"+completed).status());
        sql.sql("DELETE FROM product_vods WHERE id=:id").param("id",completed).update();
        UUID interrupted=UUID.randomUUID();sql.sql("INSERT INTO product_vods(id,channel_id,title,status,visibility,duration_ms,size_bytes,created_at_ms,updated_at_ms) VALUES(:id,:channel,'interrupted preparation','preparing','private',3000,10,:now,:now)").param("id",interrupted).param("channel",channel).param("now",now).update();
        assertEquals(404,anonymous.get(pub+"/"+interrupted).status());assertEquals(404,anonymous.get(pub+"/"+interrupted+"/media").status());
        return new VodState(id,interrupted);
    }
    /** Controlled metadata/window time fixtures; actual MP4 transfer and decoding are verified separately. */
    private static String recordings(Browser owner,Browser other,Browser anonymous,JdbcClient sql,ConfigurableApplicationContext app,UUID channel)throws Exception{
        app.getBean(RecordingCollector.class).stop();app.getBean(RecordingCollector.class).reconcile();ChannelRecordings service=app.getBean(ChannelRecordings.class);String route="/api/v1/me/recordings";
        assertEquals(401,anonymous.get(route).status());assertEquals(400,owner.get(route+"?status=unknown").status());assertEquals(400,owner.get(route+"?limit=0").status());assertEquals(400,owner.get(route+"?cursor=invalid").status());
        owner.expectedUserId=UUID.randomUUID().toString();assertEquals("SESSION_CHANGED",owner.get(route).code());owner.expectedUserId=null;
        long start=System.currentTimeMillis()-120000;UUID instance=UUID.randomUUID();String source="a".repeat(64);
        var observation=new ChannelRecordings.Observation(instance,"a".repeat(32),"obs-verify",source,"녹화 검증\0 방송");
        var windows=service.observe(java.util.List.of(observation),start,false);for(int step=1;step<=4;step++)windows=service.observe(java.util.List.of(observation),start+step*5000,true);var window=windows.getFirst();
        var formatter=java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd_HH-mm-ss-SSSSSSxx").withZone(java.time.ZoneOffset.UTC);
        String old=formatter.format(java.time.Instant.ofEpochMilli(start-1000))+".mp4";service.discover(window,old,start-1000,start+25000);assertEquals(0,service.inspect(50).size());
        for(long offset:new long[]{5000,10000,19500}){long at=start+offset;service.discover(window,formatter.format(java.time.Instant.ofEpochMilli(at))+".mp4",at,start+25000);}
        for(var row:service.inspect(50))service.inspected(row,new frame.api.dvr.RecordedAssetProbe.Info(100,start+1000,"controlled-key",3000L,true,false),false,start+30000);
        app.getBean(RecordingCollector.class).reconcile();assertEquals(2,sql.sql("SELECT count(*) FROM product_recording_files WHERE status='ready'").query(Integer.class).single());
        var listed=owner.get(route);assertEquals(200,listed.status());assertTrue(listed.raw().headers().firstValue("cache-control").orElse("").contains("no-store"));assertEquals(3,listed.json().path("items").size());assertEquals(2,owner.get(route+"?status=ready").json().path("items").size());assertEquals(1,owner.get(route+"?status=ambiguous").json().path("items").size());
        assertFalse(listed.json().path("collectionEnabled").asBoolean());assertEquals(6,listed.json().path("retentionHours").intValue());assertEquals(300,listed.json().path("storage").path("knownSizeBytes").longValue());
        var item=owner.get(route+"?status=ready").json().path("items").get(0);String id=item.path("id").asString();assertEquals("녹화 검증� 방송",item.path("title").asString());assertFalse(item.path("readyPlayable").asBoolean());
        String display=java.net.URLEncoder.encode(item.path("displayName").asString(),java.nio.charset.StandardCharsets.UTF_8);assertEquals(1,owner.get(route+"?q="+display).json().path("items").size());
        assertEquals(0,other.get(route).json().path("items").size());assertEquals(404,other.get(route+"/"+id).status());assertEquals(404,other.write("PATCH",route+"/"+id,Map.of("version",0,"hidden",true)).status());
        assertEquals(0,owner.write("PATCH",route+"/"+id,Map.of("version",0,"hidden",false)).json().path("item").path("version").longValue());
        assertEquals(400,owner.write("PATCH",route+"/"+id,Map.of("version",0,"hidden","yes")).status());
        var hidden=owner.write("PATCH",route+"/"+id,Map.of("version",0,"hidden",true));assertEquals(200,hidden.status());assertEquals(1,hidden.json().path("item").path("version").longValue());assertEquals(1,owner.get(route+"?status=hidden").json().path("items").size());assertEquals(2,owner.get(route).json().path("items").size());
        assertEquals("RECORDING_CONFLICT",owner.write("PATCH",route+"/"+id,Map.of("version",0,"hidden",false)).code());
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){var one=pool.submit(()->owner.write("PATCH",route+"/"+id,Map.of("version",1,"hidden",false)));var two=pool.submit(()->owner.write("PATCH",route+"/"+id,Map.of("version",1,"hidden",false)));assertEquals(java.util.Set.of(200,409),java.util.Set.of(one.get().status(),two.get().status()));}
        var page=owner.get(route+"?limit=1").json();String cursor=page.path("nextCursor").asString();assertFalse(cursor.isEmpty());assertNotEquals(page.path("items").get(0).path("id").asString(),owner.get(route+"?limit=1&cursor="+cursor).json().path("items").get(0).path("id").asString());assertEquals("INVALID_RECORDING_CURSOR",other.get(route+"?limit=1&cursor="+cursor).code());assertEquals("INVALID_RECORDING_CURSOR",owner.get(route+"?limit=1&q=changed&cursor="+cursor).code());
        var row=service.inspect(50).stream().filter(value->value.id().toString().equals(id)).findFirst().orElseThrow();service.inspected(row,null,true,start+40000);assertEquals("missing",owner.get(route+"/"+id).json().path("item").path("status").asString());assertEquals(2,owner.get(route+"/"+id).json().path("item").path("version").longValue());
        service.inspected(row,new frame.api.dvr.RecordedAssetProbe.Info(100,start+1000,"controlled-key",3000L,true,false),false,start+45000);assertEquals("ready",owner.get(route+"/"+id).json().path("item").path("status").asString());
        service.availability(false);assertEquals("RECORDINGS_UNAVAILABLE",owner.get(route).code());service.availability(true);
        long vanishedAt=start+19700;String vanishedName=formatter.format(java.time.Instant.ofEpochMilli(vanishedAt))+".mp4";service.discover(window,vanishedName,vanishedAt,start+25000);var vanished=service.inspect(50).stream().filter(value->value.name().equals(vanishedName)).findFirst().orElseThrow();assertNull(vanished.size());assertNull(vanished.modified());service.inspected(vanished,null,true,start+45000);var vanishedResult=owner.get(route+"/"+vanished.id()).json().path("item");assertEquals("missing",vanishedResult.path("status").asString());assertTrue(vanishedResult.path("sizeBytes").isNull());
        sql.sql("UPDATE product_channels SET notification_live_after_ms=notification_live_after_ms+1 WHERE id=:id").param("id",channel).update();service.observe(java.util.List.of(observation),start+25000,true);assertEquals("ownership_changed",sql.sql("SELECT reason FROM product_recording_windows WHERE id=:id").param("id",window.id()).query(String.class).single());
        var unfinished=service.inspect(50).stream().filter(value->value.status().equals("ambiguous")).findFirst().orElseThrow();service.inspected(unfinished,new frame.api.dvr.RecordedAssetProbe.Info(100,start+1000,"controlled-prefix",null,false,false),false,start+45000);var unfinishedResult=owner.get(route+"/"+unfinished.id()).json().path("item");assertEquals("ambiguous",unfinishedResult.path("status").asString());assertTrue(unfinishedResult.path("reason").asString().contains("최종 저장"));
        assertEquals(4,sql.sql("SELECT count(*) FROM product_recording_files").query(Integer.class).single());return id;
    }
    private static String analytics(Browser owner,Browser other,Browser anonymous,JdbcClient sql,ConfigurableApplicationContext app,UUID ownerId,UUID channel)throws Exception{
        // Controlled observation clock fixture; the separate media e2e verifies the actual worker and RTMP source.
        app.getBean(AnalyticsCollector.class).stop();
        assertEquals(401,anonymous.get("/api/v1/me/analytics").status());
        assertEquals(400,owner.get("/api/v1/me/analytics?period=31").status());assertEquals(400,owner.get("/api/v1/me/analytics?limit=0").status());
        owner.expectedUserId=UUID.randomUUID().toString();assertEquals("SESSION_CHANGED",owner.get("/api/v1/me/analytics").code());owner.expectedUserId=null;
        ChannelAnalytics service=app.getBean(ChannelAnalytics.class);UUID first=UUID.randomUUID();String source="a".repeat(64);
        long midnight=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Seoul")).atStartOfDay(java.time.ZoneId.of("Asia/Seoul")).toInstant().toEpochMilli();
        long start=midnight-2000;String title="analytics-preserved\0 제목";
        var observation=new ChannelAnalytics.Observation(first,"1".repeat(32),"obs-verify",title,source,2);
        service.sample(java.util.List.of(observation),Map.of(first,source),start,false);
        var point=owner.get("/api/v1/me/analytics?q=analytics-preserved");assertEquals(200,point.status());assertTrue(point.raw().headers().firstValue("cache-control").orElse("").contains("no-store"));
        assertEquals(ownerId.toString(),point.json().path("userId").asString());assertEquals(ownerId.toString(),point.raw().headers().firstValue("x-frame-user-id").orElse(""));
        assertTrue(point.json().path("summary").path("averageConcurrent").isNull());assertEquals(2,point.json().path("summary").path("peakConcurrent").intValue());
        service.sample(java.util.List.of(new ChannelAnalytics.Observation(first,"1".repeat(32),"obs-verify",title,source,4)),Map.of(first,source),midnight+3000,true);
        var page=owner.get("/api/v1/me/analytics?q=analytics-preserved").json();assertEquals(5000,page.path("summary").path("broadcastDurationMs").longValue());assertEquals(2.0,page.path("summary").path("averageConcurrent").doubleValue());
        assertEquals(5000,page.path("daily").valueStream().mapToLong(day->day.path("broadcastDurationMs").longValue()).sum());
        String today=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Seoul")).toString();
        var todayOnly=owner.get("/api/v1/me/analytics?q=analytics-preserved&from="+today+"&to="+today).json();
        assertEquals(3000,todayOnly.path("summary").path("broadcastDurationMs").longValue());assertEquals(3000,todayOnly.path("items").get(0).path("broadcastDurationMs").longValue());
        assertEquals(1,todayOnly.path("daily").size());assertEquals(1,todayOnly.path("summary").path("broadcastCount").longValue());
        service.sample(java.util.List.of(observation),Map.of(first,source),midnight+23000,true); // long gap: zero inferred time
        service.sample(java.util.List.of(observation),Map.of(first,source),midnight+28000,false); // failed collector tick: zero inferred time
        service.sample(java.util.List.of(),Map.of(first,""),midnight+33000,true); // brief OBS disconnection, same broadcast
        String nextSource="b".repeat(64);
        service.sample(java.util.List.of(new ChannelAnalytics.Observation(first,"1".repeat(32),"obs-verify",title,nextSource,1)),Map.of(first,nextSource),midnight+38000,true);
        assertEquals(5000,owner.get("/api/v1/me/analytics?q=analytics-preserved").json().path("summary").path("observedDurationMs").longValue());
        service.sample(java.util.List.of(new ChannelAnalytics.Observation(first,"1".repeat(32),"obs-verify",title,nextSource,0)),Map.of(first,nextSource),midnight+43000,true);
        var resumed=owner.get("/api/v1/me/analytics?q=analytics-preserved").json();assertEquals(10000,resumed.path("summary").path("observedDurationMs").longValue());assertEquals(1.5,resumed.path("summary").path("averageConcurrent").doubleValue());assertEquals(4,resumed.path("summary").path("peakConcurrent").intValue());
        assertEquals("analytics-preserved� 제목",resumed.path("items").get(0).path("title").asString());assertEquals("live",resumed.path("items").get(0).path("status").asString());
        assertFalse(resumed.toString().contains("source_session"));assertFalse(resumed.toString().contains("sourceSession"));assertFalse(resumed.toString().contains("email"));
        var privateOther=other.get("/api/v1/me/analytics").json();assertEquals(0,privateOther.path("items").size());assertTrue(privateOther.path("collectionStartedAtMs").isNull());assertTrue(privateOther.path("summary").path("peakConcurrent").isNull());
        assertTrue(owner.get("/api/v1/me/analytics?q=does-not-exist").json().path("summary").path("averageConcurrent").isNull());
        assertEquals(0,owner.get("/api/v1/me/analytics?q=does-not-exist").json().path("summary").path("broadcastCount").longValue());
        UUID zero=UUID.randomUUID();var zeroObservation=new ChannelAnalytics.Observation(zero,"2".repeat(32),"obs-verify","analytics-zero",source,0);
        service.sample(java.util.List.of(zeroObservation),Map.of(first,nextSource,zero,source),midnight+50000,true);
        service.sample(java.util.List.of(zeroObservation),Map.of(first,nextSource,zero,source),midnight+55000,true);
        var zeroPage=owner.get("/api/v1/me/analytics?q=analytics-zero").json();assertEquals(0.0,zeroPage.path("summary").path("averageConcurrent").doubleValue());assertFalse(zeroPage.path("summary").path("averageConcurrent").isNull());assertEquals(0,zeroPage.path("summary").path("peakConcurrent").intValue());
        String replacement="c".repeat(64);var changedSource=new ChannelAnalytics.Observation(zero,"2".repeat(32),"obs-verify","analytics-zero",replacement,0);
        service.sample(java.util.List.of(changedSource),Map.of(first,nextSource,zero,replacement),midnight+60000,true);
        assertEquals(5000,owner.get("/api/v1/me/analytics?q=analytics-zero").json().path("summary").path("observedDurationMs").longValue());
        service.sample(java.util.List.of(changedSource),Map.of(first,nextSource,zero,replacement),midnight+65000,true);
        service.sample(java.util.List.of(),Map.of(first,nextSource),midnight+70000,true);
        service.sample(java.util.List.of(changedSource),Map.of(first,nextSource,zero,replacement),midnight+75000,true);
        assertEquals("ended",owner.get("/api/v1/me/analytics?q=analytics-zero").json().path("items").get(0).path("status").asString());
        assertEquals(10000,owner.get("/api/v1/me/analytics?q=analytics-zero").json().path("summary").path("observedDurationMs").longValue());
        var firstPage=owner.get("/api/v1/me/analytics?q=analytics-&limit=1").json();String next=firstPage.path("nextCursor").asString();assertFalse(next.isEmpty());
        var secondPage=owner.get("/api/v1/me/analytics?q=analytics-&limit=1&cursor="+next).json();assertEquals(1,secondPage.path("items").size());assertNotEquals(firstPage.path("items").get(0).path("id").asString(),secondPage.path("items").get(0).path("id").asString());
        assertEquals("INVALID_ANALYTICS_CURSOR",other.get("/api/v1/me/analytics?q=analytics-&limit=1&cursor="+next).code());
        assertEquals("INVALID_ANALYTICS_CURSOR",owner.get("/api/v1/me/analytics?q=changed&limit=1&cursor="+next).code());
        return first.toString();
    }
    private record MissionState(String id,String completedId,String broadcast,Map<String,Object> body,Browser author) {}
    private static MissionState missions(Browser owner,Browser guest,JdbcClient sql,ConfigurableApplicationContext app,UUID ownerId,UUID channel)throws Exception{
        Browser author=new Browser(owner.base);author.clientIp="198.51.100.80";author.get("/api/v1/session");assertEquals(201,author.write("POST","/api/v1/auth/register",signup("mission-viewer@example.test","mission-viewer-room","미션 전용 시청자","a-password-long-enough")).status());
        var originalPolicy=owner.get("/api/v1/me/chat/settings").json();
        String managed="/api/v1/me/missions",submit="/api/v1/missions",broadcast=UUID.randomUUID().toString().replace("-",""),stream="obs-verify",current="/api/v1/missions/current?path="+stream+"&broadcastId="+broadcast;
        var registry=app.getBean(frame.api.broadcast.BroadcastRegistry.class);var media=app.getBean(frame.api.mediamtx.MediaMtxPaths.class);var previous=registry.byPath(stream);if(previous!=null)assertEquals(204,registry.announce(JSON.valueToTree(Map.of("v",1,"type","bye","id",previous.id)),0).status());announceHistory(registry,broadcast,stream,"무료 미션 방송","server");registry.get(broadcast).observe(media.list().get(stream),false);
        UUID authorId=UUID.fromString(author.get("/api/v1/session").json().path("user").path("id").asString());long oldPoints=author.get("/api/v1/me/points?channelId="+channel).json().path("balance").longValue();int oldLedger=sql.sql("SELECT count(*) FROM product_point_ledger").query(Integer.class).single();
        assertEquals(401,guest.get(managed).status());assertEquals(401,guest.write("POST",submit,missionDraft(broadcast,"제안",UUID.randomUUID())).status());assertEquals(200,guest.get(current).status());assertEquals(0,guest.get(current).json().path("mine").size());assertEquals("login_required",guest.get(current).json().path("reason").asString());
        assertEquals("INVALID_MISSION_FILTER",owner.get(managed+"?status=unknown").code());assertEquals("INVALID_MISSION_FILTER",owner.get(managed+"?limit=101").code());assertEquals("INVALID_MISSION_CURSOR",owner.get(managed+"?cursor=not-a-cursor").code());assertEquals("INVALID_MISSION_FILTER",owner.get(managed+"?from=2026-02-30").code());
        var draft=missionDraft(broadcast," 가 무료 미션 ",UUID.randomUUID());assertEquals(403,author.send("POST",submit,draft,false,ORIGIN).status());assertEquals(403,author.send("POST",submit,draft,true,"https://outside.invalid").status());
        author.expectedUserId=ownerId.toString();assertEquals("SESSION_CHANGED",author.get(current).code());assertEquals("SESSION_CHANGED",author.write("POST",submit,draft).code());author.expectedUserId=null;
        var paid=new HashMap<>(draft);paid.put("amount",1000);assertEquals("INVALID_MISSION_INPUT",author.write("POST",submit,paid).code());
        assertEquals("MISSION_WORD_BLOCKED",author.write("POST",submit,missionDraft(broadcast,"금칙어 포함 제안",UUID.randomUUID())).code());assertEquals("MISSION_LINK_BLOCKED",author.write("POST",submit,missionDraft(broadcast,"https://example.test",UUID.randomUUID())).code());assertEquals(0,sql.sql("SELECT count(*) FROM product_missions").query(Integer.class).single());
        int policyVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(policyVersion,true,120,true,true,java.util.List.of("금칙어")));author.write("DELETE","/api/v1/me/follows/"+channel,null);assertEquals("followers_only",author.get(current).json().path("reason").asString());assertEquals("MISSION_FOLLOW_REQUIRED",author.write("POST",submit,draft).code());author.write("PUT","/api/v1/me/follows/"+channel,Map.of("notificationsOn",true));
        Browser restricted=new Browser(owner.base);restricted.clientIp="198.51.100.81";restricted.get("/api/v1/session");assertEquals(201,restricted.write("POST","/api/v1/auth/register",signup("mission-policy@example.test","mission-policy-room","미션 정책 확인","a-password-long-enough")).status());UUID restrictedChannel=UUID.fromString(restricted.get("/api/v1/session").json().path("channel").path("id").asString());String block=owner.write("POST","/api/v1/me/chat/blocks",chatBlock(restrictedChannel,600L,"미션에 공개하지 않을 운영 사유")).json().path("item").path("id").asString();var denied=restricted.write("POST",submit,draft);assertEquals("MISSION_PARTICIPATION_BLOCKED",denied.code());assertFalse(denied.raw().body().contains("운영 사유"));owner.write("DELETE","/api/v1/me/chat/blocks/"+block+"?version=0",null);
        var created=author.write("POST",submit,draft);assertEquals(201,created.status());var first=created.json().path("item");String one=first.path("id").asString();assertEquals("가 무료 미션",first.path("title").asString());assertEquals(15,first.path("durationMinutes").intValue());assertEquals(900000,first.path("deadlineAtMs").longValue()-first.path("createdAtMs").longValue());assertEquals(1,first.path("history").size());assertEquals("viewer",first.path("history").get(0).path("actor").asString());assertTrue(first.has("clientRequestId"));
        assertEquals(200,author.write("POST",submit,draft).status());var changed=new HashMap<>(draft);changed.put("description","변경된 본문");assertEquals("MISSION_REQUEST_CONFLICT",author.write("POST",submit,changed).code());assertEquals(404,author.get(managed+"/"+one).status());assertEquals(404,author.write("PATCH",managed+"/"+one,Map.of("version",0,"status","running","reason","")).status());
        var privateOwner=owner.get(managed+"/"+one).json().path("item");assertFalse(privateOwner.has("clientRequestId"));assertFalse(privateOwner.has("authorId"));assertEquals(3,privateOwner.path("author").size());assertFalse(privateOwner.toString().contains("@example.test"));assertEquals(0,owner.get(current).json().path("mine").size());assertEquals(0,guest.get(current).json().path("mine").size());
        assertEquals("INVALID_MISSION_INPUT",owner.write("PATCH",managed+"/"+one,Map.of("version",0,"status","completed","reason","")).code());assertEquals("MISSION_INVALID_TRANSITION",owner.write("PATCH",managed+"/"+one,Map.of("version",0,"status","completed","reason","접수에서 바로 완료할 수 없음")).code());
        var running=owner.write("PATCH",managed+"/"+one,Map.of("version",0,"status","running","reason","함께 진행해요"));assertEquals(200,running.status());assertEquals(first.path("deadlineAtMs").longValue(),running.json().path("item").path("deadlineAtMs").longValue());assertEquals("MISSION_CONFLICT",author.write("POST",submit+"/"+one+"/cancel",Map.of("version",0)).code());assertEquals("MISSION_INVALID_TRANSITION",author.write("POST",submit+"/"+one+"/cancel",Map.of("version",1)).code());
        var completed=owner.write("PATCH",managed+"/"+one,Map.of("version",1,"status","completed","reason","제안한 기능을 완성했어요."));assertEquals(200,completed.status());assertEquals(3,completed.json().path("item").path("history").size());assertEquals("MISSION_ALREADY_CLOSED",owner.write("PATCH",managed+"/"+one,Map.of("version",2,"status","running","reason","")).code());
        Map<String,Object> sameRequest=missionDraft(broadcast,"동시에 보내도 하나인 제안",UUID.randomUUID());String two;
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){var left=pool.submit(()->author.write("POST",submit,sameRequest));var right=pool.submit(()->author.write("POST",submit,sameRequest));Result l=left.get(),r=right.get();assertEquals(java.util.Set.of(200,201),java.util.Set.of(l.status(),r.status()));two=l.json().path("item").path("id").asString();assertEquals(two,r.json().path("item").path("id").asString());}
        assertEquals(200,author.write("POST",submit+"/"+two+"/cancel",Map.of("version",0)).status());assertEquals("canceled",author.write("POST",submit,sameRequest).json().path("item").path("status").asString());
        var third=author.write("POST",submit,missionDraft(broadcast,"수락과 취소가 경합하는 제안",UUID.randomUUID()));assertEquals(201,third.status());String three=third.json().path("item").path("id").asString();
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){var left=pool.submit(()->owner.write("PATCH",managed+"/"+three,Map.of("version",0,"status","running","reason","")));var right=pool.submit(()->author.write("POST",submit+"/"+three+"/cancel",Map.of("version",0)));assertEquals(java.util.Set.of(200,409),java.util.Set.of(left.get().status(),right.get().status()));}
        var currentThird=owner.get(managed+"/"+three).json().path("item");if(currentThird.path("status").asString().equals("running"))assertEquals(200,owner.write("PATCH",managed+"/"+three,Map.of("version",1,"status","failed","reason","기한 안에 목표를 완성하지 못했어요.")).status());
        var rate=author.write("POST",submit,missionDraft(broadcast,"분당 한도",UUID.randomUUID()));assertEquals(429,rate.status());assertEquals("MISSION_RATE_LIMITED",rate.code());assertTrue(Integer.parseInt(rate.raw().headers().firstValue("Retry-After").orElse("0"))>0);assertEquals("rate_limited",author.get(current).json().path("reason").asString());assertEquals(200,author.write("POST",submit,draft).status());
        var page=author.get(current+"&limit=1").json();String cursor=page.path("nextCursor").asString();assertFalse(cursor.isBlank());var next=author.get(current+"&limit=1&cursor="+java.net.URLEncoder.encode(cursor,java.nio.charset.StandardCharsets.UTF_8)).json();assertNotEquals(page.path("mine").get(0).path("id").asString(),next.path("mine").get(0).path("id").asString());assertEquals(1,owner.get(managed+"?status=completed").json().path("items").size());
        // A two-connection pool must not deadlock while concurrent reads commit observed expiry.
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){var readers=new java.util.ArrayList<java.util.concurrent.Future<Result>>();for(int i=0;i<6;i++)readers.add(pool.submit(()->owner.get(managed)));for(var reader:readers)assertEquals(200,reader.get(10,java.util.concurrent.TimeUnit.SECONDS).status());}
        // Shift only this verification author's stored rows/history together; no real-time expiry claim.
        sql.sql("UPDATE product_mission_history SET created_at_ms=created_at_ms-61000 WHERE mission_id IN (SELECT id FROM product_missions WHERE author_id=:author)").param("author",authorId).update();sql.sql("UPDATE product_missions SET created_at_ms=created_at_ms-61000,updated_at_ms=updated_at_ms-61000,deadline_at_ms=deadline_at_ms-61000 WHERE author_id=:author").param("author",authorId).update();assertTrue(author.get(current).json().path("canSubmit").booleanValue());
        var timed=author.write("POST",submit,missionDraft(broadcast,"만료를 기록할 제안",UUID.randomUUID()));assertEquals(201,timed.status());UUID timedId=UUID.fromString(timed.json().path("item").path("id").asString());
        sql.sql("UPDATE product_mission_history SET created_at_ms=created_at_ms-901000 WHERE mission_id=:id").param("id",timedId).update();sql.sql("UPDATE product_missions SET created_at_ms=created_at_ms-901000,updated_at_ms=updated_at_ms-901000,deadline_at_ms=deadline_at_ms-901000 WHERE id=:id").param("id",timedId).update();
        assertEquals("MISSION_EXPIRED",owner.write("PATCH",managed+"/"+timedId,Map.of("version",0,"status","running","reason","")).code());assertEquals("expired",sql.sql("SELECT status FROM product_missions WHERE id=:id").param("id",timedId).query(String.class).single());assertEquals(2,sql.sql("SELECT count(*) FROM product_mission_history WHERE mission_id=:id").param("id",timedId).query(Integer.class).single());assertTrue(sql.sql("SELECT updated_at_ms=deadline_at_ms FROM product_missions WHERE id=:id").param("id",timedId).query(Boolean.class).single());
        var endBody=missionDraft(broadcast,"방송 종료로 만료되는 제안",UUID.randomUUID());var end=author.write("POST",submit,endBody);assertEquals(201,end.status());String endedId=end.json().path("item").path("id").asString();String replacement=UUID.randomUUID().toString().replace("-","");assertEquals(204,registry.announce(JSON.valueToTree(Map.of("v",1,"type","bye","id",broadcast)),0).status());announceHistory(registry,replacement,stream,"다음 무료 미션 방송","server");registry.get(replacement).observe(media.list().get(stream),false);
        assertEquals("MISSION_BROADCAST_UNAVAILABLE",author.write("POST",submit,missionDraft(broadcast,"이전 방송 새 제안",UUID.randomUUID())).code());assertEquals("expired",owner.get(managed+"/"+endedId).json().path("item").path("status").asString());assertEquals(200,author.write("POST",submit,endBody).status());assertEquals(0,author.get("/api/v1/missions/current?path="+stream+"&broadcastId="+replacement).json().path("mine").size());
        var savedBody=missionDraft(replacement,"재시작 뒤에도 남는 진행 미션",UUID.randomUUID());var saved=author.write("POST",submit,savedBody);assertEquals(201,saved.status());String savedId=saved.json().path("item").path("id").asString();assertEquals(200,owner.write("PATCH",managed+"/"+savedId,Map.of("version",0,"status","running","reason","진행 중 서버 재시작 검사")).status());
        assertEquals(oldPoints,author.get("/api/v1/me/points?channelId="+channel).json().path("balance").longValue());assertEquals(oldLedger,sql.sql("SELECT count(*) FROM product_point_ledger").query(Integer.class).single());policyVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();assertEquals(200,owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(policyVersion,originalPolicy.path("slowMode").booleanValue(),originalPolicy.path("slowSeconds").intValue(),originalPolicy.path("followersOnly").booleanValue(),originalPolicy.path("blockLinks").booleanValue(),originalPolicy.path("bannedWords").valueStream().map(JsonNode::asString).toList())).status());
        return new MissionState(savedId,one,replacement,savedBody,author);
    }
    private static Map<String,Object> missionDraft(String broadcast,String title,UUID request){return Map.of("path","obs-verify","broadcastId",broadcast,"title",title,"description","함께 진행할 무료 미션이에요.\n다음 줄 설명","durationMinutes",15,"clientRequestId",request.toString());}
    private record RewardState(String id,long balance) {}
    private static RewardState rewards(Browser owner,Browser member,Browser guest,JdbcClient sql,ConfigurableApplicationContext app,UUID ownerId,UUID channel)throws Exception{
        String rewards="/api/v1/me/rewards",requests="/api/v1/me/redemptions",broadcast="7".repeat(32),points="/api/v1/me/points?channelId="+channel,current="/api/v1/rewards/current?path=obs-verify&broadcastId="+broadcast;
        var registry=app.getBean(frame.api.broadcast.BroadcastRegistry.class);var media=app.getBean(frame.api.mediamtx.MediaMtxPaths.class);announceHistory(registry,broadcast,"obs-verify","실제 보상 방송","server");registry.get(broadcast).observe(media.list().get("obs-verify"),false);
        UUID memberId=UUID.fromString(member.get("/api/v1/session").json().path("user").path("id").asString()),requestId=UUID.randomUUID();
        var draft=rewardDraft(" 가 보상 ",1,"unlimited",true,requestId);assertEquals(401,guest.get(rewards).status());assertEquals(401,guest.get(points).status());assertEquals(403,owner.send("POST",rewards,draft,false,ORIGIN).status());assertEquals(403,owner.send("POST",rewards,draft,true,"https://outside.invalid").status());
        var created=owner.write("POST",rewards,draft);assertEquals(201,created.status());String id=created.json().path("item").path("id").asString();assertEquals("가 보상",created.json().path("item").path("name").asString());assertEquals(9,created.json().path("item").size());
        assertEquals(200,owner.write("POST",rewards,rewardDraft("가 보상",1,"unlimited",true,requestId)).status());assertEquals("REWARD_REQUEST_CONFLICT",owner.write("POST",rewards,rewardDraft("다른 보상",1,"unlimited",true,requestId)).code());
        assertEquals(404,member.get(rewards+"/"+id).status());assertEquals(404,member.write("PATCH",rewards+"/"+id,rewardEdit("남의 보상",1,"unlimited",true,0)).status());
        for(String filter:java.util.List.of("status=unknown","limit=0","limit=101","limit=invalid","from=2026-02-30","from=2026-11-12&to=2026-11-11"))assertEquals("INVALID_REWARD_FILTER",owner.get(rewards+"?"+filter).code());assertEquals("INVALID_REWARD_CURSOR",owner.get(rewards+"?cursor=bad").code());assertEquals("INVALID_REWARD_CURSOR",member.get(points+"&cursor=bad").code());
        var publicView=guest.get(current);assertEquals(200,publicView.status());assertTrue(publicView.json().path("userId").isNull());assertTrue(publicView.json().path("balance").isNull());assertEquals(0,publicView.json().path("mine").size());assertEquals(0,publicView.json().path("usedRewardIds").size());assertEquals("login_required",publicView.json().path("reason").asString());assertFalse(publicView.raw().body().contains("@example.test"));assertTrue(publicView.raw().headers().firstValue("Cache-Control").orElse("").contains("no-store"));
        var redeemDraft=redemptionDraft(broadcast,"금칙어 https://example.test 도 신청 메모에는 허용",0,UUID.randomUUID());String endpoint="/api/v1/rewards/"+id+"/redemptions";
        assertEquals(401,guest.write("POST",endpoint,redeemDraft).status());assertEquals("POINTS_INSUFFICIENT",member.write("POST",endpoint,redeemDraft).code());assertEquals(0,sql.sql("SELECT count(*) FROM product_redemptions").query(Integer.class).single());
        member.expectedUserId=ownerId.toString();assertEquals("SESSION_CHANGED",member.get(current).code());assertEquals("SESSION_CHANGED",member.get(points).code());assertEquals("SESSION_CHANGED",member.write("POST",endpoint,redeemDraft).code());member.expectedUserId=null;
        var viewer=member.write("POST","/obs-verify/b/"+broadcast+"/session",Map.of());assertEquals(200,viewer.status());String sid=viewer.json().path("sid").asString();assertTrue(sid.matches("[0-9a-f]{32}"));UUID visit=UUID.randomUUID();
        var baseline=member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,0,20000,true));assertEquals(200,baseline.status());assertEquals("baseline",baseline.json().path("reason").asString());assertEquals(0,baseline.json().path("acceptedMs").longValue());
        Thread.sleep(25);var capped=member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,1,20000,true));assertTrue(capped.json().path("acceptedMs").longValue()>0);assertTrue(capped.json().path("acceptedMs").longValue()<2000);assertEquals(0,capped.json().path("creditedPoints").longValue());
        // Controlled clock fixtures verify accounting boundaries, not a claim of sixty seconds of actual watching.
        sql.sql("UPDATE product_point_wallets SET pending_watch_ms=59999,watch_at_ms=:at WHERE channel_id=:channel AND user_id=:user").param("at",System.currentTimeMillis()-1000).param("channel",channel).param("user",memberId).update();
        var credit=member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,2,1000,true));assertEquals(10,credit.json().path("creditedPoints").longValue());assertEquals(10,credit.json().path("balance").longValue());
        var duplicate=member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,2,1000,true));assertEquals(0,duplicate.json().path("creditedPoints").longValue());assertEquals(0,duplicate.json().path("acceptedMs").longValue());assertEquals("watching_elsewhere",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,UUID.randomUUID(),0,20000,true)).json().path("reason").asString());
        assertEquals("stopped",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,3,20000,false)).json().path("reason").asString());assertEquals(0,member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,2,20000,true)).json().path("acceptedMs").longValue());assertEquals("baseline",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,4,20000,true)).json().path("reason").asString());
        sql.sql("UPDATE product_point_wallets SET watch_at_ms=:at WHERE channel_id=:channel AND user_id=:user").param("at",System.currentTimeMillis()-26000).param("channel",channel).param("user",memberId).update();assertEquals("baseline",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,5,20000,true)).json().path("reason").asString());
        sql.sql("UPDATE product_point_wallets SET watch_process=:process WHERE channel_id=:channel AND user_id=:user").param("process",UUID.randomUUID()).param("channel",channel).param("user",memberId).update();assertEquals("baseline",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,6,20000,true)).json().path("reason").asString());assertEquals("session_unavailable",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,"f".repeat(32),visit,7,20000,true)).json().path("reason").asString());
        assertEquals(10,member.get(points).json().path("balance").longValue());assertEquals(1,member.get(points).json().path("items").size());assertEquals(0,owner.get(points).json().path("balance").longValue());assertEquals(0,owner.get(points).json().path("items").size());
        UUID firstRequest=UUID.fromString((String)redeemDraft.get("clientRequestId"));var redeemed=member.write("POST",endpoint,redeemDraft);assertEquals(201,redeemed.status());String first=redeemed.json().path("item").path("id").asString();assertEquals(9,redeemed.json().path("balance").longValue());assertEquals(firstRequest.toString(),redeemed.json().path("item").path("clientRequestId").asString());assertFalse(owner.get(requests+"/"+first).json().path("item").has("clientRequestId"));
        assertEquals(200,owner.write("PATCH",rewards+"/"+id,rewardEdit("바뀐 보상",2,"unlimited",true,0)).status());assertEquals("REWARD_CONFLICT",member.write("POST",endpoint,redemptionDraft(broadcast,"가격 바뀜",0,UUID.randomUUID())).code());assertEquals(9,member.get(points).json().path("balance").longValue());
        var replay=member.write("POST",endpoint,redeemDraft);assertEquals(200,replay.status());assertEquals("가 보상",replay.json().path("item").path("rewardName").asString());assertEquals(1,replay.json().path("item").path("points").intValue());assertEquals(2,owner.write("POST",rewards,draft).json().path("item").path("points").intValue());
        assertEquals("REDEMPTION_REQUEST_CONFLICT",member.write("POST",endpoint,redemptionDraft(broadcast,"수정한 메모",0,firstRequest)).code());assertEquals("REWARD_CONFLICT",owner.write("PATCH",rewards+"/"+id,rewardEdit("덮어쓰면 안 됨",10,"unlimited",true,0)).code());
        assertEquals(200,owner.write("PATCH",rewards+"/"+id,rewardEdit("바뀐 보상",2,"unlimited",false,1)).status());assertEquals("REWARD_DISABLED",member.write("POST",endpoint,redemptionDraft(broadcast,"비활성",2,UUID.randomUUID())).code());assertEquals(0,guest.get(current).json().path("rewards").size());assertEquals(200,owner.write("PATCH",rewards+"/"+id,rewardEdit("바뀐 보상",2,"unlimited",true,2)).status());
        int policyVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(policyVersion,true,120,true,true,java.util.List.of("금칙어")));member.write("DELETE","/api/v1/me/follows/"+channel,null);assertEquals("followers_only",member.get(current).json().path("reason").asString());assertEquals("REWARD_FOLLOW_REQUIRED",member.write("POST",endpoint,redemptionDraft(broadcast,"팔로우 전",3,UUID.randomUUID())).code());member.write("PUT","/api/v1/me/follows/"+channel,Map.of("notificationsOn",true));
        Browser third=new Browser(owner.base);third.get("/api/v1/session");third.write("POST","/api/v1/auth/login",Map.of("email","late-notification@example.test","password","a-password-long-enough"));UUID thirdChannel=UUID.fromString(third.get("/api/v1/session").json().path("channel").path("id").asString());String block=owner.write("POST","/api/v1/me/chat/blocks",chatBlock(thirdChannel,600L,"교환에는 숨길 사유")).json().path("item").path("id").asString();assertEquals("blocked",third.get(current).json().path("reason").asString());var denied=third.write("POST",endpoint,redemptionDraft(broadcast,"차단 전",3,UUID.randomUUID()));assertEquals("REWARD_PARTICIPATION_BLOCKED",denied.code());assertFalse(denied.raw().body().contains("교환에는 숨길 사유"));owner.write("DELETE","/api/v1/me/chat/blocks/"+block+"?version=0",null);
        var once=owner.write("POST",rewards,rewardDraft("한 방송 한 번",5,"once_per_broadcast",true,UUID.randomUUID()));String onceId=once.json().path("item").path("id").asString();String onceEndpoint="/api/v1/rewards/"+onceId+"/redemptions";var onceRedemption=member.write("POST",onceEndpoint,redemptionDraft(broadcast,"",0,UUID.randomUUID()));assertEquals(201,onceRedemption.status());String onceRequestId=onceRedemption.json().path("item").path("id").asString();assertEquals(200,member.write("POST","/api/v1/redemptions/"+onceRequestId+"/cancel",Map.of("version",0)).status());assertEquals(9,member.get(points).json().path("balance").longValue());assertEquals("REWARD_ALREADY_REDEEMED",member.write("POST",onceEndpoint,redemptionDraft(broadcast,"재신청 금지",0,UUID.randomUUID())).code());assertTrue(member.get(current+"&limit=1").json().path("usedRewardIds").valueStream().anyMatch(value->value.asString().equals(onceId)));assertEquals("REDEMPTION_ALREADY_CLOSED",member.write("POST","/api/v1/redemptions/"+onceRequestId+"/cancel",Map.of("version",1)).code());
        assertEquals(404,owner.write("POST","/api/v1/redemptions/"+first+"/cancel",Map.of("version",0)).status());assertEquals(404,member.get(requests+"/"+first).status());assertEquals(200,owner.write("PATCH",requests+"/"+first,Map.of("version",0,"status","processing","reason","")).status());assertEquals("REDEMPTION_CONFLICT",owner.write("PATCH",requests+"/"+first,Map.of("version",0,"status","completed","reason","")).code());assertEquals("REDEMPTION_INVALID_TRANSITION",member.write("POST","/api/v1/redemptions/"+first+"/cancel",Map.of("version",1)).code());assertEquals(200,owner.write("PATCH",requests+"/"+first,Map.of("version",1,"status","completed","reason","실제 처리 완료")).status());assertEquals("REDEMPTION_ALREADY_CLOSED",owner.write("PATCH",requests+"/"+first,Map.of("version",2,"status","rejected","reason","다시 환불 금지")).code());
        UUID parallel=UUID.randomUUID();String parallelId;
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var left=pool.submit(()->member.write("POST",endpoint,redemptionDraft(broadcast,"동일 신청 동시 재시도",3,parallel)));var right=pool.submit(()->member.write("POST",endpoint,redemptionDraft(broadcast,"동일 신청 동시 재시도",3,parallel)));Result l=left.get(),r=right.get();assertEquals(java.util.Set.of(200,201),java.util.Set.of(l.status(),r.status()));parallelId=l.json().path("item").path("id").asString();assertEquals(parallelId,r.json().path("item").path("id").asString());
        }
        assertEquals(7,member.get(points).json().path("balance").longValue());
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var left=pool.submit(()->member.write("POST","/api/v1/redemptions/"+parallelId+"/cancel",Map.of("version",0)));var right=pool.submit(()->owner.write("PATCH",requests+"/"+parallelId,Map.of("version",0,"status","rejected","reason","중복 환불 금지")));assertEquals(java.util.Set.of(200,409),java.util.Set.of(left.get().status(),right.get().status()));
        }
        assertEquals(9,member.get(points).json().path("balance").longValue());assertEquals(1,sql.sql("SELECT count(*) FROM product_point_ledger WHERE redemption_id=:id AND kind='refund'").param("id",UUID.fromString(parallelId)).query(Integer.class).single());
        // Spend normally down to a concurrent insufficient-balance boundary; preserve the complete ledger sum.
        assertEquals(200,owner.write("PATCH",rewards+"/"+id,rewardEdit("바뀐 보상",7,"unlimited",true,3)).status());assertEquals(201,member.write("POST",endpoint,redemptionDraft(broadcast,"잔액 경계 준비",4,UUID.randomUUID())).status());assertEquals(200,owner.write("PATCH",rewards+"/"+id,rewardEdit("바뀐 보상",2,"unlimited",true,4)).status());
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var left=pool.submit(()->member.write("POST",endpoint,redemptionDraft(broadcast,"잔액 경합 하나",5,UUID.randomUUID())));var right=pool.submit(()->member.write("POST",endpoint,redemptionDraft(broadcast,"잔액 경합 둘",5,UUID.randomUUID())));Result l=left.get(),r=right.get();assertEquals(java.util.Set.of(201,409),java.util.Set.of(l.status(),r.status()));assertEquals("POINTS_INSUFFICIENT",l.status()==409?l.code():r.code());
        }
        assertEquals(0,member.get(points).json().path("balance").longValue());assertEquals(0,sql.sql("SELECT sum(delta) FROM product_point_ledger WHERE channel_id=:channel AND user_id=:user").param("channel",channel).param("user",memberId).query(Long.class).single());assertTrue(member.get(points+"&limit=1").json().path("nextCursor").isString());assertEquals(1,owner.get(requests+"?status=completed").json().path("items").size());assertEquals(0,third.get(current).json().path("mine").size());assertFalse(guest.get(current).raw().body().contains("금칙어 https://"));
        sql.sql("INSERT INTO product_rewards(id,channel_id,client_request_id,create_payload,name,points,redemption_limit,enabled,created_at_ms,updated_at_ms) SELECT gen_random_uuid(),:channel,gen_random_uuid(),'{}','cap-fixture-'||n,1,'unlimited',false,:at,:at FROM generate_series(1,48) n").param("channel",channel).param("at",System.currentTimeMillis()).update();assertEquals("REWARD_LIMIT_REACHED",owner.write("POST",rewards,rewardDraft("상한 초과",1,"unlimited",true,UUID.randomUUID())).code());assertEquals(200,owner.write("POST",rewards,draft).status());sql.sql("DELETE FROM product_rewards WHERE channel_id=:channel AND name LIKE 'cap-fixture-%'").param("channel",channel).update();
        String next="4".repeat(32);announceHistory(registry,next,"obs-verify","다음 보상 방송","server");registry.get(next).observe(media.list().get("obs-verify"),false);var past=member.get(current).json();assertEquals(0,past.path("rewards").size());assertEquals(channel.toString(),past.path("channelId").asString());assertTrue(past.path("mine").size()>0);assertEquals(0,past.path("balance").longValue());assertEquals("broadcast_unavailable",past.path("reason").asString());assertEquals(200,member.write("POST",endpoint,redeemDraft).status());assertEquals("REWARD_BROADCAST_UNAVAILABLE",member.write("POST",endpoint,redemptionDraft(broadcast,"종료 방송 신규 신청",3,UUID.randomUUID())).code());assertEquals("broadcast_unavailable",member.write("POST","/api/v1/points/watch",watchPulse(broadcast,sid,visit,8,20000,true)).json().path("reason").asString());assertEquals(0,member.get("/api/v1/rewards/current?path=obs-verify&broadcastId="+next).json().path("usedRewardIds").size());
        // A test-only future path ownership change must never mix the old private history with a new channel wallet.
        sql.sql("UPDATE product_channels SET stream_path='archived-rewards-path' WHERE id=:id").param("id",channel).update();sql.sql("UPDATE product_channels SET stream_path='obs-verify' WHERE id=:id").param("id",thirdChannel).update();
        try{var oldContext=member.get(current).json();assertEquals(channel.toString(),oldContext.path("channelId").asString());assertTrue(oldContext.path("mine").valueStream().allMatch(item->item.path("channelId").asString().equals(channel.toString())));var newContext=member.get("/api/v1/rewards/current?path=obs-verify&broadcastId="+next).json();assertEquals(thirdChannel.toString(),newContext.path("channelId").asString());assertEquals(0,newContext.path("mine").size());assertEquals(0,newContext.path("balance").longValue());}
        finally{sql.sql("UPDATE product_channels SET stream_path=NULL WHERE id=:id").param("id",thirdChannel).update();sql.sql("UPDATE product_channels SET stream_path='obs-verify' WHERE id=:id").param("id",channel).update();}
        policyVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(policyVersion,false,5,false,true,java.util.List.of("금칙어")));member.write("DELETE","/obs-verify/session/"+sid,null);
        return new RewardState(first,member.get(points).json().path("balance").longValue());
    }
    private static Map<String,Object> rewardDraft(String name,int points,String limit,boolean enabled,UUID request){return Map.of("name",name,"points",points,"limit",limit,"enabled",enabled,"clientRequestId",request);}
    private static Map<String,Object> rewardEdit(String name,int points,String limit,boolean enabled,int version){return Map.of("name",name,"points",points,"limit",limit,"enabled",enabled,"version",version);}
    private static Map<String,Object> redemptionDraft(String broadcast,String note,int version,UUID request){return Map.of("path","obs-verify","broadcastId",broadcast,"note",note,"rewardVersion",version,"clientRequestId",request.toString());}
    private static Map<String,Object> watchPulse(String broadcast,String sid,UUID visit,int sequence,int eligible,boolean watching){return Map.of("path","obs-verify","broadcastId",broadcast,"viewerSessionId",sid,"visitId",visit,"sequence",sequence,"eligibleMs",eligible,"watching",watching);}
    private static String questions(Browser owner,Browser author,Browser guest,JdbcClient sql,ConfigurableApplicationContext app,UUID ownerId,UUID channel)throws Exception{
        String managed="/api/v1/me/questions",submit="/api/v1/questions",broadcast="6".repeat(32),stream="obs-verify";
        var registry=app.getBean(frame.api.broadcast.BroadcastRegistry.class);var media=app.getBean(frame.api.mediamtx.MediaMtxPaths.class);
        announceHistory(registry,broadcast,stream,"실제 질문 방송","server");registry.get(broadcast).observe(media.list().get(stream),false);
        String current="/api/v1/questions/current?path="+stream+"&broadcastId="+broadcast;UUID request=UUID.randomUUID();
        Map<String,Object> firstDraft=questionDraft(broadcast,"  가\r\n첫 질문  ",request);
        assertEquals(401,guest.get(managed).status());assertEquals(401,guest.write("POST",submit,firstDraft).status());
        var publicEmpty=guest.get(current);assertEquals(200,publicEmpty.status());assertEquals(8,publicEmpty.json().size());assertTrue(publicEmpty.json().path("pinned").isNull());assertEquals(0,publicEmpty.json().path("mine").size());assertEquals("login_required",publicEmpty.json().path("reason").asString());assertTrue(publicEmpty.json().path("retryAfterMs").isNull());assertTrue(publicEmpty.raw().headers().firstValue("Cache-Control").orElse("").contains("no-store"));
        assertEquals(403,author.send("POST",submit,firstDraft,false,ORIGIN).status());assertEquals(403,author.send("POST",submit,firstDraft,true,"https://outside.invalid").status());
        author.expectedUserId=ownerId.toString();assertEquals("SESSION_CHANGED",author.get(current).code());assertEquals("SESSION_CHANGED",author.write("POST",submit,firstDraft).code());author.expectedUserId=null;
        for(String query:java.util.List.of("status=unknown","limit=0","limit=101","limit=invalid","from=2026-02-30","from=2026-11-12&to=2026-11-11"))assertEquals("INVALID_QUESTION_FILTER",owner.get(managed+"?"+query).code());
        assertEquals("INVALID_QUESTION_CURSOR",owner.get(managed+"?cursor=bad").code());assertEquals("INVALID_QUESTION_CURSOR",author.get(current+"&cursor=bad").code());
        var forged=new HashMap<>(firstDraft);forged.put("authorId",ownerId);assertEquals("INVALID_QUESTION_INPUT",author.write("POST",submit,forged).code());
        assertEquals("INVALID_QUESTION_INPUT",author.write("POST",submit,questionDraft(broadcast,"x".repeat(501),UUID.randomUUID())).code());
        Browser third=new Browser(owner.base);third.get("/api/v1/session");assertEquals(200,third.write("POST","/api/v1/auth/login",Map.of("email","late-notification@example.test","password","a-password-long-enough")).status());UUID thirdChannel=UUID.fromString(third.get("/api/v1/session").json().path("channel").path("id").asString());
        int policyVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();assertEquals(200,owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(policyVersion,true,120,true,true,java.util.List.of("금칙어"))).status());
        third.write("DELETE","/api/v1/me/follows/"+channel,null);assertEquals("followers_only",third.get(current).json().path("reason").asString());assertEquals("QUESTION_FOLLOW_REQUIRED",third.write("POST",submit,questionDraft(broadcast,"팔로우 전 질문",UUID.randomUUID())).code());
        third.write("PUT","/api/v1/me/follows/"+channel,Map.of("notificationsOn",false));var blocked=owner.write("POST","/api/v1/me/chat/blocks",chatBlock(thirdChannel,600L,"외부에 숨길 제한 사유"));String block=blocked.json().path("item").path("id").asString();assertEquals(201,blocked.status());
        assertEquals("blocked",third.get(current).json().path("reason").asString());var denied=third.write("POST",submit,questionDraft(broadcast,"차단 중 질문",UUID.randomUUID()));assertEquals("QUESTION_PARTICIPATION_BLOCKED",denied.code());assertFalse(denied.raw().body().contains("외부에 숨길 제한 사유"));
        assertEquals(200,owner.write("DELETE","/api/v1/me/chat/blocks/"+block+"?version=0",null).status());
        assertEquals("QUESTION_LINK_BLOCKED",third.write("POST",submit,questionDraft(broadcast,"example.한국 질문",UUID.randomUUID())).code());assertEquals("QUESTION_WORD_BLOCKED",third.write("POST",submit,questionDraft(broadcast,"금\u200b칙어 질문",UUID.randomUUID())).code());
        assertEquals(0,sql.sql("SELECT count(*) FROM product_questions").query(Integer.class).single());
        var first=author.write("POST",submit,firstDraft);assertEquals(201,first.status());String one=first.json().path("item").path("id").asString();UUID authorId=UUID.fromString(first.json().path("userId").asString());assertEquals("가\n첫 질문",first.json().path("item").path("text").asString());assertEquals(request.toString(),first.json().path("item").path("clientRequestId").asString());assertEquals(14,first.json().path("item").size());
        var replay=author.write("POST",submit,questionDraft(broadcast,"가\n첫 질문",request));assertEquals(200,replay.status());assertEquals(one,replay.json().path("item").path("id").asString());assertEquals("QUESTION_REQUEST_CONFLICT",author.write("POST",submit,questionDraft(broadcast,"다른 본문",request)).code());
        assertEquals(404,author.get(managed+"/"+one).status());assertEquals(404,author.write("PATCH",managed+"/"+one,Map.of("version",0,"answer","남의 답변")).status());
        var privateOwner=owner.get(managed+"/"+one).json().path("item");assertEquals(13,privateOwner.size());assertFalse(privateOwner.has("clientRequestId"));assertFalse(privateOwner.has("authorId"));assertEquals(3,privateOwner.path("author").size());
        assertEquals(0,third.get(current).json().path("mine").size());assertTrue(guest.get(current).json().path("pinned").isNull());
        assertEquals("INVALID_QUESTION_ANSWER",owner.write("PATCH",managed+"/"+one,Map.of("version",0,"answer","")).code());assertEquals("INVALID_QUESTION_INPUT",owner.write("PATCH",managed+"/"+one,Map.of("version",0)).code());
        var answered=owner.write("PATCH",managed+"/"+one,Map.of("version",0,"answer","답".repeat(1000)));assertEquals(200,answered.status());assertEquals(1000,answered.json().path("item").path("answer").asString().length());assertTrue(guest.get(current).json().path("pinned").isNull());assertEquals(1000,author.get(current).json().path("mine").get(0).path("answer").asString().length());
        assertEquals(200,owner.write("PATCH",managed+"/"+one,Map.of("version",1,"pinned",true)).status());var shared=guest.get(current).json().path("pinned");assertEquals(one,shared.path("id").asString());assertFalse(shared.has("clientRequestId"));assertFalse(shared.toString().contains("@example.test"));assertTrue(shared.path("pinned").booleanValue());
        String two=third.write("POST",submit,questionDraft(broadcast,"빠르게 보내는 두 번째 질문",UUID.randomUUID())).json().path("item").path("id").asString();UUID concurrentRequest=UUID.randomUUID();String three;
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var left=pool.submit(()->third.write("POST",submit,questionDraft(broadcast,"중복 전송은 하나의 질문",concurrentRequest)));var right=pool.submit(()->third.write("POST",submit,questionDraft(broadcast,"중복 전송은 하나의 질문",concurrentRequest)));Result l=left.get(),r=right.get();assertEquals(java.util.Set.of(200,201),java.util.Set.of(l.status(),r.status()));three=l.json().path("item").path("id").asString();assertEquals(three,r.json().path("item").path("id").asString());
        }
        assertEquals(200,owner.write("PATCH",managed+"/"+two,Map.of("version",0,"pinned",true)).status());assertTrue(guest.get(current).json().path("pinned").path("answer").isNull());assertEquals(two,guest.get(current).json().path("pinned").path("id").asString());assertEquals("QUESTION_CONFLICT",owner.write("PATCH",managed+"/"+one,Map.of("version",2,"answer","덮어쓰면 안 됨")).code());
        assertEquals(two,owner.get(managed+"?status=answered&q=not-found").json().path("pinnedQuestionId").asString());assertEquals(0,owner.get(managed+"?status=answered&q=not-found").json().path("items").size());
        assertEquals(200,owner.write("PATCH",managed+"/"+one,Map.of("version",3,"pinned",true)).status());
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var left=pool.submit(()->owner.write("PATCH",managed+"/"+one,Map.of("version",4,"answer","동시 답변 하나")));var right=pool.submit(()->owner.write("PATCH",managed+"/"+one,Map.of("version",4,"answer","동시 답변 둘")));assertEquals(java.util.Set.of(200,409),java.util.Set.of(left.get().status(),right.get().status()));
        }
        assertEquals(200,owner.write("PATCH",managed+"/"+one,Map.of("version",5,"pinned",false)).status());assertTrue(guest.get(current).json().path("pinned").isNull());
        assertEquals(201,author.write("POST",submit,questionDraft(broadcast,"질문 두 번째",UUID.randomUUID())).status());assertEquals(201,author.write("POST",submit,questionDraft(broadcast,"질문 세 번째",UUID.randomUUID())).status());
        var rate=author.write("POST",submit,questionDraft(broadcast,"할당 초과",UUID.randomUUID()));assertEquals(429,rate.status());assertEquals("QUESTION_RATE_LIMITED",rate.code());assertTrue(Integer.parseInt(rate.raw().headers().firstValue("Retry-After").orElse("0"))>0);var limited=author.get(current).json();assertEquals("rate_limited",limited.path("reason").asString());assertFalse(limited.path("canSubmit").booleanValue());assertTrue(limited.path("retryAfterMs").longValue()>0);assertEquals(200,author.write("POST",submit,firstDraft).status());
        assertEquals(3,sql.sql("SELECT count(*) FROM product_questions WHERE author_id=:author").param("author",authorId).query(Integer.class).single());
        sql.sql("UPDATE product_questions SET created_at_ms=:at WHERE author_id=:author").param("at",System.currentTimeMillis()-61000).param("author",authorId).update();assertTrue(author.get(current).json().path("canSubmit").booleanValue());
        // Equal-millisecond rows use UUID keyset ordering without duplicates or skipped private rows.
        var firstPage=author.get(current+"&limit=1").json();String cursor=firstPage.path("nextCursor").asString();assertFalse(cursor.isBlank());var secondPage=author.get(current+"&limit=1&cursor="+java.net.URLEncoder.encode(cursor,java.nio.charset.StandardCharsets.UTF_8)).json();assertNotEquals(firstPage.path("mine").get(0).path("id").asString(),secondPage.path("mine").get(0).path("id").asString());
        assertEquals(1,owner.get(managed+"?status=answered").json().path("items").size());assertTrue(owner.get(managed+"?q="+java.net.URLEncoder.encode("중복 전송",java.nio.charset.StandardCharsets.UTF_8)).json().path("items").size()>0);
        String today=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Seoul")).toString();assertEquals(200,owner.get(managed+"?from="+today+"&to="+today).status());
        // A replacement broadcast never publishes an old pin or accepts a new question under the old link.
        String next="7".repeat(32);announceHistory(registry,next,stream,"다음 질문 방송","server");registry.get(next).observe(media.list().get(stream),false);
        assertEquals("broadcast_unavailable",author.get(current).json().path("reason").asString());assertTrue(guest.get(current).json().path("pinned").isNull());assertEquals(3,author.get(current).json().path("mine").size());
        assertEquals("QUESTION_BROADCAST_UNAVAILABLE",author.write("POST",submit,questionDraft(broadcast,"종료된 방송 새 질문",UUID.randomUUID())).code());assertEquals(200,author.write("POST",submit,firstDraft).status());assertEquals(200,owner.write("PATCH",managed+"/"+one,Map.of("version",6,"answer","이전 방송에도 답변 가능")).status());assertEquals("QUESTION_BROADCAST_UNAVAILABLE",owner.write("PATCH",managed+"/"+one,Map.of("version",7,"pinned",true)).code());
        var beforeRestart=author.write("POST",submit,questionDraft(next,"같은 주소라도 인스턴스 구별",UUID.randomUUID()));assertEquals(201,beforeRestart.status());String prior=beforeRestart.json().path("item").path("id").asString();owner.write("PATCH",managed+"/"+prior,Map.of("version",0,"pinned",true));
        registry.announce(JSON.valueToTree(Map.of("v",1,"type","bye","id",next)),0);announceHistory(registry,next,stream,"같은 ID의 새 인스턴스","server");registry.get(next).observe(media.list().get(stream),false);String nextCurrent="/api/v1/questions/current?path="+stream+"&broadcastId="+next;
        assertTrue(guest.get(nextCurrent).json().path("pinned").isNull());assertFalse(owner.get(managed+"/"+prior).json().path("item").path("broadcastActive").booleanValue());assertEquals("QUESTION_BROADCAST_UNAVAILABLE",owner.write("PATCH",managed+"/"+prior,Map.of("version",1,"pinned",true)).code());
        var saved=author.write("POST",submit,questionDraft(next,"재시작해도 내 질문은 남아요",UUID.randomUUID()));assertEquals(201,saved.status());String savedId=saved.json().path("item").path("id").asString();assertEquals(200,owner.write("PATCH",managed+"/"+savedId,Map.of("version",0,"answer","재시작 뒤에도 보존할 답변","pinned",true)).status());assertEquals(savedId,guest.get(nextCurrent).json().path("pinned").path("id").asString());
        policyVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();assertEquals(200,owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(policyVersion,false,5,false,true,java.util.List.of("금칙어"))).status());
        return savedId;
    }
    private static Map<String,Object> questionDraft(String broadcast,String text,UUID request){return Map.of("path","obs-verify","broadcastId",broadcast,"text",text,"clientRequestId",request);}
    private static String polls(Browser owner,Browser voter,Browser guest,JdbcClient sql,ConfigurableApplicationContext app,UUID ownerId,UUID channel)throws Exception{
        String path="/api/v1/me/polls",broadcast="9".repeat(32),stream="obs-verify";
        var registry=app.getBean(frame.api.broadcast.BroadcastRegistry.class);var media=app.getBean(frame.api.mediamtx.MediaMtxPaths.class);
        announceHistory(registry,broadcast,stream,"실제 투표 방송","server");registry.get(broadcast).observe(media.list().get(stream),false);
        assertEquals(401,guest.get(path).status());assertEquals(401,guest.write("POST",path,pollDraft(broadcast)).status());
        var context=owner.get(path).json();assertEquals(ownerId.toString(),context.path("userId").asString());assertEquals(broadcast,context.path("currentBroadcast").path("id").asString());assertTrue(context.path("activePollId").isNull());assertTrue(context.path("serverNowMs").longValue()>0);
        assertEquals(403,owner.send("POST",path,pollDraft(broadcast),false,ORIGIN).status());assertEquals(403,owner.send("POST",path,pollDraft(broadcast),true,"https://outside.invalid").status());
        var duplicateOptions=new HashMap<>(pollDraft(broadcast));duplicateOptions.put("options",java.util.List.of("ＦＯＯ","foo"));assertEquals("DUPLICATE_POLL_OPTIONS",owner.write("POST",path,duplicateOptions).code());
        var invalid=new HashMap<>(pollDraft(broadcast));invalid.put("channelId",UUID.randomUUID());assertEquals(400,owner.write("POST",path,invalid).status());
        var wrong=new HashMap<>(pollDraft(broadcast));wrong.put("broadcastId","f".repeat(32));assertEquals("POLL_BROADCAST_UNAVAILABLE",owner.write("POST",path,wrong).code());
        Result first;
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var a=pool.submit(()->owner.write("POST",path,pollDraft(broadcast)));var b=pool.submit(()->owner.write("POST",path,pollDraft(broadcast)));var ra=a.get();var rb=b.get();assertEquals(java.util.Set.of(201,409),java.util.Set.of(ra.status(),rb.status()));first=ra.status()==201?ra:rb;assertEquals("POLL_ACTIVE_EXISTS",ra.status()==409?ra.code():rb.code());
        }
        String id=first.json().path("poll").path("id").asString();String firstOption=first.json().path("poll").path("options").get(0).path("id").asString(),secondOption=first.json().path("poll").path("options").get(1).path("id").asString();
        assertEquals(3,first.json().size());assertEquals(13,first.json().path("poll").size());assertEquals(0,first.json().path("poll").path("totalVotes").longValue());assertTrue(first.json().path("poll").path("closeReason").isNull());
        assertEquals(id,owner.get(path+"?q=not-found&status=closed").json().path("activePollId").asString());assertEquals(0,owner.get(path+"?q=not-found&status=closed").json().path("items").size());
        String today=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Seoul")).toString();assertEquals(1,owner.get(path+"?from="+today+"&to="+today).json().path("items").size());
        for(String query:java.util.List.of("status=unknown","limit=0","limit=101","limit=invalid","from=2026-02-30","from=2026-11-12&to=2026-11-11"))assertEquals("INVALID_POLL_FILTER",owner.get(path+"?"+query).code());
        assertEquals("INVALID_POLL_CURSOR",owner.get(path+"?cursor=invalid").code());assertEquals(404,voter.get(path+"/"+id).status());assertEquals(404,voter.write("POST",path+"/"+id+"/close",Map.of("version",0)).status());
        String current="/api/v1/polls/current?path="+stream+"&broadcastId="+broadcast;
        var publicPoll=guest.get(current);assertEquals(200,publicPoll.status());assertTrue(publicPoll.json().path("userId").isNull());assertFalse(publicPoll.json().path("canVote").booleanValue());assertEquals("login_required",publicPoll.json().path("reason").asString());assertTrue(publicPoll.raw().headers().firstValue("Cache-Control").orElse("").contains("no-store"));assertFalse(publicPoll.raw().body().contains(ownerId.toString()));assertFalse(publicPoll.raw().body().contains("@example.test"));assertFalse(publicPoll.json().path("poll").has("broadcastInstanceId"));
        voter.expectedUserId=ownerId.toString();assertEquals("SESSION_CHANGED",voter.get(current).code());assertEquals("SESSION_CHANGED",voter.write("POST","/api/v1/polls/"+id+"/votes",pollVote(firstOption,broadcast)).code());voter.expectedUserId=null;
        assertEquals(401,guest.write("POST","/api/v1/polls/"+id+"/votes",pollVote(firstOption,broadcast)).status());
        assertEquals("INVALID_POLL_OPTION",voter.write("POST","/api/v1/polls/"+id+"/votes",pollVote(UUID.randomUUID().toString(),broadcast)).code());
        var mismatch=new HashMap<>(pollVote(firstOption,broadcast));mismatch.put("path","other-path");assertEquals("POLL_BROADCAST_MISMATCH",voter.write("POST","/api/v1/polls/"+id+"/votes",mismatch).code());
        var voted=voter.write("POST","/api/v1/polls/"+id+"/votes",pollVote(firstOption,broadcast));assertEquals(200,voted.status());assertEquals(1,voted.json().path("poll").path("totalVotes").longValue());assertEquals(firstOption,voted.json().path("poll").path("myOptionId").asString());assertEquals(0,voted.json().path("poll").path("version").intValue());
        assertEquals(1,voter.write("POST","/api/v1/polls/"+id+"/votes",pollVote(firstOption,broadcast)).json().path("poll").path("totalVotes").longValue());assertEquals("POLL_ALREADY_VOTED",voter.write("POST","/api/v1/polls/"+id+"/votes",pollVote(secondOption,broadcast)).code());assertTrue(guest.get(current).json().path("poll").path("myOptionId").isNull());
        Browser third=new Browser(voter.base);third.get("/api/v1/session");assertEquals(200,third.write("POST","/api/v1/auth/login",Map.of("email","late-notification@example.test","password","a-password-long-enough")).status());UUID thirdChannel=UUID.fromString(third.get("/api/v1/session").json().path("channel").path("id").asString());
        var block=owner.write("POST","/api/v1/me/chat/blocks",chatBlock(thirdChannel,600L,"비공개 투표 제한"));String blockId=block.json().path("item").path("id").asString();
        assertEquals("blocked",third.get(current).json().path("reason").asString());var denied=third.write("POST","/api/v1/polls/"+id+"/votes",pollVote(secondOption,broadcast));assertEquals("POLL_PARTICIPATION_BLOCKED",denied.code());assertFalse(denied.raw().body().contains("비공개 투표 제한"));
        assertEquals(200,owner.write("DELETE","/api/v1/me/chat/blocks/"+blockId+"?version=0",null).status());
        int chatVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();assertEquals(200,owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(chatVersion,true,120,true,true,java.util.List.of("금칙어"))).status());
        third.write("DELETE","/api/v1/me/follows/"+channel,null);assertEquals("followers_only",third.get(current).json().path("reason").asString());assertEquals("POLL_FOLLOW_REQUIRED",third.write("POST","/api/v1/polls/"+id+"/votes",pollVote(secondOption,broadcast)).code());
        assertEquals(200,owner.write("POST","/api/v1/polls/"+id+"/votes",pollVote(firstOption,broadcast)).status());
        third.write("PUT","/api/v1/me/follows/"+channel,Map.of("notificationsOn",false));
        try(var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()){
            var a=pool.submit(()->third.write("POST","/api/v1/polls/"+id+"/votes",pollVote(secondOption,broadcast)));var b=pool.submit(()->third.write("POST","/api/v1/polls/"+id+"/votes",pollVote(secondOption,broadcast)));assertEquals(200,a.get().status());assertEquals(200,b.get().status());
        }
        assertEquals(3,guest.get(current).json().path("poll").path("totalVotes").longValue());assertEquals(3,sql.sql("SELECT count(*) FROM product_poll_votes WHERE poll_id=:id").param("id",UUID.fromString(id)).query(Integer.class).single());
        assertEquals("POLL_CONFLICT",owner.write("POST",path+"/"+id+"/close",Map.of("version",99)).code());var closed=owner.write("POST",path+"/"+id+"/close",Map.of("version",0));assertEquals(200,closed.status());assertEquals("manual",closed.json().path("poll").path("closeReason").asString());assertEquals(1,closed.json().path("poll").path("version").intValue());assertEquals("POLL_CLOSED",owner.write("POST",path+"/"+id+"/close",Map.of("version",1)).code());
        assertEquals(200,voter.write("POST","/api/v1/polls/"+id+"/votes",pollVote(firstOption,broadcast)).status());
        var second=owner.write("POST",path,pollDraft(broadcast));assertEquals(201,second.status());String secondId=second.json().path("poll").path("id").asString();assertEquals("INVALID_POLL_OPTION",voter.write("POST","/api/v1/polls/"+secondId+"/votes",pollVote(firstOption,broadcast)).code());
        sql.sql("UPDATE product_polls SET ends_at_ms=created_at_ms+1 WHERE id=:id").param("id",UUID.fromString(secondId)).update();Thread.sleep(5);assertEquals("expired",guest.get(current).json().path("poll").path("closeReason").asString());assertTrue(owner.get(path).json().path("activePollId").isNull());
        var thirdPoll=owner.write("POST",path,pollDraft(broadcast));assertEquals(201,thirdPoll.status());String thirdId=thirdPoll.json().path("poll").path("id").asString();
        String next="6".repeat(32);announceHistory(registry,next,stream,"다음 방송 투표","server");registry.get(next).observe(media.list().get(stream),false);
        assertEquals("broadcast_ended",owner.get(path+"/"+thirdId).json().path("poll").path("closeReason").asString());
        var fourth=owner.write("POST",path,pollDraft(next));assertEquals(201,fourth.status());String saved=fourth.json().path("poll").path("id").asString();assertEquals(thirdId,guest.get(current).json().path("poll").path("id").asString());assertEquals("closed",guest.get(current).json().path("poll").path("status").asString());
        String selected=fourth.json().path("poll").path("options").get(0).path("id").asString();assertEquals(200,owner.write("POST","/api/v1/polls/"+saved+"/votes",pollVote(selected,next)).status());
        chatVersion=owner.get("/api/v1/me/chat/settings").json().path("version").intValue();owner.write("PATCH","/api/v1/me/chat/settings",chatSettings(chatVersion,false,5,false,true,java.util.List.of("금칙어")));
        return saved;
    }
    private static Map<String,Object> pollDraft(String broadcast){return Map.of("question","실제 시청자 투표","options",java.util.List.of("금칙어","https://example.test"),"durationSeconds",60,"broadcastId",broadcast,"path","obs-verify");}
    private static Map<String,Object> pollVote(String option,String broadcast){return Map.of("optionId",option,"broadcastId",broadcast,"path","obs-verify");}
    private static void chatModeration(Browser owner,Browser sender,Browser guest,JdbcClient sql,ConfigurableApplicationContext app,UUID ownerId,UUID channel,UUID target)throws Exception{
        String settings="/api/v1/me/chat/settings",blocks="/api/v1/me/chat/blocks";var registry=app.getBean(frame.api.broadcast.BroadcastRegistry.class);
        String broadcast="9".repeat(32);announceHistory(registry,broadcast,"obs-verify","계정 채팅","server");
        assertEquals(401,guest.get(settings).status());assertEquals(401,guest.get(blocks).status());
        var initial=owner.get(settings).json();assertEquals(0,initial.path("version").intValue());assertFalse(initial.path("slowMode").booleanValue());assertEquals(ownerId.toString(),initial.path("userId").asString());assertEquals(channel.toString(),initial.path("channelId").asString());assertTrue(initial.path("updatedAtMs").longValue()>0);
        Map<String,Object> config=chatSettings(0,false,5,false,true,java.util.List.of("금칙어","ＦＯＯ"));
        assertEquals(403,owner.send("PATCH",settings,config,false,ORIGIN).status());assertEquals(403,owner.send("PATCH",settings,config,true,"https://outside.invalid").status());
        sender.expectedUserId=ownerId.toString();assertEquals("SESSION_CHANGED",sender.get(settings).code());assertEquals("SESSION_CHANGED",sender.write("POST","/api/v1/chat/tickets",Map.of("path","obs-verify","broadcastId",broadcast)).code());sender.expectedUserId=null;
        assertEquals(200,owner.write("PATCH",settings,config).status());assertEquals("CHAT_SETTINGS_CONFLICT",owner.write("PATCH",settings,config).code());
        for(Map<String,Object> invalid:java.util.List.of(chatSettings(1,false,0,false,true,java.util.List.of()),chatSettings(1,false,121,false,true,java.util.List.of()),chatSettings(1,false,5,false,true,java.util.List.of("a".repeat(31))),chatSettings(1,false,5,false,true,java.util.Collections.nCopies(101,"word"))))assertEquals(400,owner.write("PATCH",settings,invalid).status());
        // The settings endpoint alone accepts 16KB, including the largest ordinary UTF-8 word array.
        var maximum=new java.util.ArrayList<String>();for(int i=0;i<100;i++)maximum.add("🌱".repeat(27)+String.format("%03d",i));
        assertEquals(200,owner.write("PATCH",settings,chatSettings(1,false,5,false,true,maximum)).status());
        assertEquals(200,owner.write("PATCH",settings,chatSettings(2,false,5,false,true,java.util.List.of("금칙어","ＦＯＯ"))).status());
        assertEquals(0,sender.get(settings).json().path("version").intValue());
        var ticket=sender.write("POST","/api/v1/chat/tickets",Map.of("path","obs-verify","broadcastId",broadcast));assertEquals(200,ticket.status());assertEquals(4,ticket.json().size());
        String proof=ticket.json().path("ticket").asString();assertTrue(ticket.json().path("expiresAtMs").longValue()>System.currentTimeMillis());
        try(ChatWire anonymous=new ChatWire(owner.base,"obs-verify",ORIGIN);ChatWire member=new ChatWire(owner.base,"obs-verify",ORIGIN)){
            anonymous.send(Map.of("type","join","broadcastId",broadcast,"name","관리자","userId",ownerId));var readOnly=anonymous.type("state");assertFalse(readOnly.path("canSend").booleanValue());assertEquals("CHAT_LOGIN_REQUIRED",readOnly.path("code").asString());
            anonymous.send(Map.of("type","send","text","가짜 이름 송신","clientId","guest"));assertEquals("CHAT_LOGIN_REQUIRED",anonymous.ack("guest").path("code").asString());
            member.send(Map.of("type","join","broadcastId",broadcast,"ticket",proof,"name","개발하는 봄","userId",ownerId));var signed=member.type("state");assertTrue(signed.path("canSend").booleanValue());assertTrue(signed.path("authenticated").booleanValue());assertEquals("바뀐 이름",signed.path("displayName").asString());
            member.send(Map.of("type","send","text","서버 계정 이름","clientId","one"));assertTrue(member.ack("one").path("ok").booleanValue());var publicMessage=anonymous.type("message");assertEquals(target.toString(),publicMessage.path("authorChannelId").asString());assertEquals("viewer-room",publicMessage.path("authorHandle").asString());assertFalse(publicMessage.path("isOwner").booleanValue());assertFalse(publicMessage.has("authorId"));
            try(ChatWire replay=new ChatWire(owner.base,"obs-verify",ORIGIN)){replay.send(Map.of("type","join","broadcastId",broadcast,"ticket",proof));assertEquals("CHAT_AUTH_INVALID",replay.type("state").path("code").asString());}
            member.send(Map.of("type","send","text","https://example.test","clientId","link"));assertEquals("CHAT_LINK_BLOCKED",member.ack("link").path("code").asString());
            member.send(Map.of("type","send","text","f\u200bＯＯ","clientId","word"));assertEquals("CHAT_WORD_BLOCKED",member.ack("word").path("code").asString());
            member.send(Map.of("type","name","name","다른 사람"));assertEquals("CHAT_IDENTITY_FIXED",member.type("name").path("code").asString());
            assertEquals(200,owner.write("PATCH",settings,chatSettings(3,false,5,true,true,java.util.List.of("금칙어","ＦＯＯ"))).status());
            sender.write("DELETE","/api/v1/me/follows/"+channel,null);member.send(Map.of("type","send","text","팔로우 전","clientId","follow-no"));assertEquals("CHAT_FOLLOW_REQUIRED",member.ack("follow-no").path("code").asString());
            sender.write("PUT","/api/v1/me/follows/"+channel,Map.of("notificationsOn",true));member.send(Map.of("type","send","text","팔로우 후","clientId","follow-yes"));assertTrue(member.ack("follow-yes").path("ok").booleanValue());
            assertEquals(200,owner.write("PATCH",settings,chatSettings(4,true,120,false,true,java.util.List.of("금칙어"))).status());
            member.send(Map.of("type","send","text","첫 느린 채팅","clientId","slow-one"));assertTrue(member.ack("slow-one").path("ok").booleanValue());
            try(ChatWire second=new ChatWire(owner.base,"obs-verify",ORIGIN)){
                second.send(Map.of("type","join","broadcastId",broadcast,"ticket",sender.write("POST","/api/v1/chat/tickets",Map.of("path","obs-verify","broadcastId",broadcast)).json().path("ticket").asString()));second.type("state");
                second.send(Map.of("type","send","text","다른 탭도 같은 제한","clientId","slow-two"));var slow=second.ack("slow-two");assertEquals("CHAT_SLOW_MODE",slow.path("code").asString());assertTrue(slow.path("retryAfterMs").longValue()>0);
                assertEquals(200,owner.write("PATCH",settings,chatSettings(5,false,5,false,true,java.util.List.of("금칙어"))).status());
                assertEquals("SELF_BLOCK_NOT_ALLOWED",owner.write("POST",blocks,chatBlock(channel,600L,"자기 차단")).code());
                var blocked=owner.write("POST",blocks,chatBlock(target,600L,"비공개 운영 사유\n두 번째 줄"));assertEquals(201,blocked.status());String blockId=blocked.json().path("item").path("id").asString();assertEquals(ownerId.toString(),blocked.json().path("userId").asString());
                second.send(Map.of("type","send","text","차단 뒤 송신","clientId","block-no"));var denied=second.ack("block-no");assertEquals("CHAT_BLOCKED",denied.path("code").asString());assertFalse(denied.toString().contains("비공개 운영 사유"));
                assertEquals("CHAT_BLOCK_EXISTS",owner.write("POST",blocks,chatBlock(target,null,"중복")).code());
                assertEquals("CHAT_BLOCK_CONFLICT",owner.write("DELETE",blocks+"/"+blockId+"?version=1",null).code());assertEquals(404,sender.write("DELETE",blocks+"/"+blockId+"?version=0",null).status());
                assertEquals(1,owner.get(blocks+"?q="+java.net.URLEncoder.encode("두 번째 줄",java.nio.charset.StandardCharsets.UTF_8)).json().path("items").size());
                assertEquals(200,owner.write("DELETE",blocks+"/"+blockId+"?version=0",null).status());assertEquals(404,owner.write("DELETE",blocks+"/"+blockId+"?version=0",null).status());
                assertEquals(200,owner.write("PATCH",settings,chatSettings(6,false,5,false,true,java.util.List.of("금칙어"))).status());
                second.send(Map.of("type","send","text","해제 뒤 설정 변경","clientId","unblocked"));assertTrue(second.ack("unblocked").path("ok").booleanValue());
                var temporary=owner.write("POST",blocks,chatBlock(target,600L,"기간 만료 검사"));String expiredId=temporary.json().path("item").path("id").asString();
                sql.sql("UPDATE product_chat_blocks SET expires_at_ms=created_at_ms+1 WHERE id=:id").param("id",UUID.fromString(expiredId)).update();Thread.sleep(5);
                assertEquals(0,owner.get(blocks).json().path("items").size());assertEquals(1,owner.get(blocks+"?status=expired").json().path("items").size());
                second.send(Map.of("type","send","text","기간이 지난 뒤","clientId","expired-ok"));assertTrue(second.ack("expired-ok").path("ok").booleanValue());
                sender.write("POST","/api/v1/auth/logout",null);second.send(Map.of("type","send","text","로그아웃 뒤","clientId","logout"));assertEquals("CHAT_SESSION_EXPIRED",second.ack("logout").path("code").asString());
            }
        }
        sender.get("/api/v1/session");assertEquals(200,sender.write("POST","/api/v1/auth/login",Map.of("email","viewer@example.test","password","가".repeat(128),"remember",true)).status());
        // Unlinked native/legacy broadcasts never bypass account policy in product mode.
        announceHistory(registry,"8".repeat(32),"history-unlinked","연결되지 않은 방송","server");
        try(ChatWire unlinked=new ChatWire(owner.base,"history-unlinked",ORIGIN)){
            unlinked.send(Map.of("type","join","broadcastId","8".repeat(32),"ticket",sender.write("POST","/api/v1/chat/tickets",Map.of("path","history-unlinked","broadcastId","8".repeat(32))).json().path("ticket").asString()));assertEquals("CHAT_CHANNEL_UNAVAILABLE",unlinked.type("state").path("code").asString());
        }
        var wrong=java.net.http.HttpClient.newHttpClient().newWebSocketBuilder().header("Origin","https://outside.invalid").buildAsync(URI.create(owner.base.replace("http:","ws:")+"/obs-verify/chat"),new java.net.http.WebSocket.Listener(){});
        assertThrows(java.util.concurrent.CompletionException.class,wrong::join);
    }
    private static Map<String,Object> chatSettings(int version,boolean slow,int seconds,boolean followers,boolean links,java.util.List<String> words){return Map.of("version",version,"slowMode",slow,"slowSeconds",seconds,"followersOnly",followers,"blockLinks",links,"bannedWords",words);}
    private static Map<String,Object> chatBlock(UUID target,Long duration,String reason){Map<String,Object> value=new HashMap<>();value.put("targetChannelId",target);value.put("durationSeconds",duration);value.put("reason",reason);return value;}
    private static final class ChatWire implements AutoCloseable,java.net.http.WebSocket.Listener{
        private final java.util.concurrent.BlockingQueue<JsonNode> messages=new java.util.concurrent.LinkedBlockingQueue<>();private final StringBuilder text=new StringBuilder();private final java.net.http.WebSocket socket;
        ChatWire(String base,String path,String origin){socket=java.net.http.HttpClient.newHttpClient().newWebSocketBuilder().header("Origin",origin).buildAsync(URI.create(base.replace("http:","ws:")+"/"+path+"/chat"),this).join();}
        @Override public void onOpen(java.net.http.WebSocket socket){socket.request(1);}
        @Override public java.util.concurrent.CompletionStage<?> onText(java.net.http.WebSocket socket,CharSequence value,boolean last){text.append(value);if(last){messages.add(JSON.readTree(text.toString()));text.setLength(0);}socket.request(1);return null;}
        void send(Object value){socket.sendText(JSON.writeValueAsString(value),true).join();}
        JsonNode type(String type)throws Exception{return await(value->value.path("type").asString().equals(type));}
        JsonNode ack(String id)throws Exception{return await(value->value.path("type").asString().equals("ack")&&value.path("clientId").asString().equals(id));}
        JsonNode await(java.util.function.Predicate<JsonNode> wanted)throws Exception{long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);while(System.nanoTime()<until){JsonNode next=messages.poll(200,java.util.concurrent.TimeUnit.MILLISECONDS);if(next!=null&&wanted.test(next))return next;}throw new AssertionError("Expected chat frame was not received");}
        @Override public void close(){socket.abort();}
    }
    private static String notifications(Browser operator, Browser recipient, Browser anonymous, JdbcClient sql, ConfigurableApplicationContext app,
                                        java.util.concurrent.atomic.AtomicReference<String> mediaState, UUID channel, UUID operatorId) throws Exception {
        String path = "/api/v1/me/notifications";
        var service = app.getBean(ProductNotifications.class); var registry = app.getBean(frame.api.broadcast.BroadcastRegistry.class);
        var media = app.getBean(frame.api.mediamtx.MediaMtxPaths.class); var worker = app.getBean(NotificationReconciler.class);
        UUID user = UUID.fromString(recipient.get("/api/v1/session").json().path("user").path("id").asString());
        for (String endpoint : java.util.List.of(path, path + "/unread-count")) assertEquals(401, anonymous.get(endpoint).status());
        assertEquals(401, anonymous.write("POST", path + "/read-all", null).status()); assertEquals(401, anonymous.write("DELETE", path, null).status());
        var reportNotices = recipient.get(path).json(); assertEquals(user.toString(), reportNotices.path("userId").asString()); assertEquals(4, reportNotices.size());
        assertEquals(2, reportNotices.path("items").size()); assertEquals(2, reportNotices.path("unreadCount").longValue());
        for (JsonNode item : reportNotices.path("items")) {
            assertEquals(8, item.size()); assertEquals("report", item.path("kind").asString()); assertTrue(item.path("target").isNull()); assertTrue(item.path("readAtMs").isNull()); assertEquals(2, item.path("report").size());
            assertFalse(item.toString().contains("비공개 신고 내용")); assertFalse(item.toString().contains("검토를 마쳤어요.")); assertFalse(item.has("reviewedBy")); assertFalse(item.has("recipientId"));
        }
        assertEquals(0, operator.get(path).json().path("items").size());
        String foreign = reportNotices.path("items").get(0).path("id").asString();
        assertEquals("NOTIFICATION_NOT_FOUND", operator.write("PATCH", path + "/" + foreign + "/read", null).code()); assertEquals(404, operator.write("DELETE", path + "/" + foreign, null).status());
        assertEquals("INVALID_NOTIFICATION_ID", recipient.write("PATCH", path + "/1-1-1-1-1/read", null).code());
        assertEquals("INVALID_NOTIFICATION_FILTER", recipient.get(path + "?filter=unknown").code()); assertEquals("INVALID_NOTIFICATION_FILTER", recipient.get(path + "?kind=unknown").code());
        for (String limit : java.util.List.of("0", "101", "invalid")) assertEquals("INVALID_NOTIFICATION_FILTER", recipient.get(path + "?limit=" + limit).code());
        assertEquals("INVALID_NOTIFICATION_CURSOR", recipient.get(path + "?cursor=invalid").code());
        assertEquals(403, recipient.send("POST", path + "/read-all", null, false, ORIGIN).status()); assertEquals(403, recipient.send("DELETE", path, null, true, "https://outside.invalid").status());
        recipient.expectedUserId = operatorId.toString();
        for (String endpoint : java.util.List.of(path, path + "/unread-count")) assertEquals("SESSION_CHANGED", recipient.get(endpoint).code());
        assertEquals("SESSION_CHANGED", recipient.write("POST", path + "/read-all", null).code()); assertEquals("SESSION_CHANGED", recipient.write("DELETE", path, null).code());
        assertEquals("SESSION_CHANGED", recipient.write("PATCH", path + "/" + foreign + "/read", null).code()); assertEquals("SESSION_CHANGED", recipient.write("DELETE", path + "/" + foreign, null).code());
        recipient.expectedUserId = user.toString(); assertEquals(2, recipient.get(path + "/unread-count").json().path("unreadCount").longValue()); assertEquals(2, recipient.get(path).json().path("items").size());
        assertEquals(200, recipient.write("DELETE", path, null).status()); assertEquals(0, recipient.get(path).json().path("items").size());
        for (JsonNode item : reportNotices.path("items")) service.report(UUID.fromString(item.path("report").path("id").asString()));
        assertEquals(0, recipient.get(path).json().path("items").size()); // Durable markers survive deletion.
        UUID pendingReport = sql.sql("SELECT id FROM product_channel_reports WHERE channel_id=:channel AND reason='inappropriate' AND status='received' LIMIT 1").param("channel", channel).query(UUID.class).single();
        var transaction = new org.springframework.transaction.support.TransactionTemplate(app.getBean(org.springframework.transaction.PlatformTransactionManager.class));
        transaction.execute(status -> { app.getBean(ReportManagement.class).update(operatorId, pendingReport.toString(), JSON.valueToTree(Map.of("status", "resolved", "reviewNote", "비공개 운영자 메모", "version", 0))); status.setRollbackOnly(); return null; });
        assertEquals("received", sql.sql("SELECT status FROM product_channel_reports WHERE id=:id").param("id", pendingReport).query(String.class).single()); assertEquals(0, recipient.get(path).json().path("items").size());
        assertEquals(200, operator.write("PATCH", "/api/v1/admin/reports/" + pendingReport, Map.of("status", "resolved", "reviewNote", "비공개 운영자 메모", "version", 0)).status());
        var resultNotice = recipient.get(path).json().path("items").get(0); assertEquals(pendingReport.toString(), resultNotice.path("report").path("id").asString()); assertFalse(resultNotice.toString().contains("비공개 운영자 메모"));
        assertEquals(200, recipient.write("DELETE", path, null).status()); service.report(pendingReport); assertEquals(0, recipient.get(path).json().path("items").size());
        // A stream already running before feature/channel baseline is recorded but never delivered as a past start.
        notificationSource(registry, media, mediaState, "1".repeat(32), System.currentTimeMillis() - 60_000, "baseline", "기존 방송"); worker.reconcile();
        assertEquals(0, recipient.get(path + "?kind=live").json().path("items").size());
        notificationSource(registry, media, mediaState, "2".repeat(32), System.currentTimeMillis(), "first-source", "실제 방송\0제목"); worker.reconcile(); worker.reconcile();
        var first = recipient.get(path).json(); assertEquals(1, first.path("items").size()); var live = first.path("items").get(0);
        assertEquals("live", live.path("kind").asString()); assertTrue(live.path("report").isNull()); assertEquals("실제 방송�제목", live.path("body").asString());
        assertEquals(channel.toString(), live.path("target").path("channelId").asString()); assertTrue(live.path("target").path("available").booleanValue()); assertEquals(0, operator.get(path).json().path("items").size());
        var late = app.getBean(Accounts.class).register(JSON.valueToTree(signup("late-notification@example.test", "late-notification", "뒤늦은 팔로우", "a-password-long-enough")));
        Browser lateBrowser = new Browser(recipient.base); lateBrowser.get("/api/v1/session"); assertEquals(200, lateBrowser.write("POST", "/api/v1/auth/login", Map.of("email", "late-notification@example.test", "password", "a-password-long-enough")).status());
        assertEquals(200, lateBrowser.write("PUT", "/api/v1/me/follows/" + channel, Map.of("notificationsOn", true)).status()); worker.reconcile(); assertEquals(0, lateBrowser.get(path).json().path("items").size());
        String liveId = live.path("id").asString(); assertEquals(200, recipient.write("DELETE", path + "/" + liveId, null).status()); worker.reconcile(); assertEquals(0, recipient.get(path).json().path("items").size());
        long reconnectReady = System.currentTimeMillis();
        notificationSource(registry, media, mediaState, "2".repeat(32), reconnectReady, "short-reconnect", "재연결"); worker.reconcile();
        assertEquals(0, recipient.get(path).json().path("items").size()); assertEquals(0, lateBrowser.get(path).json().path("items").size());
        notificationSource(registry, media, mediaState, "5".repeat(32), reconnectReady, "short-reconnect", "API 재시작 뒤 같은 소스"); worker.reconcile();
        assertEquals(0, recipient.get(path).json().path("items").size());
        notificationSource(registry, media, mediaState, "5".repeat(32), System.currentTimeMillis(), "post-restart-reconnect", "복구 뒤 짧은 재연결"); worker.reconcile();
        assertEquals(0, recipient.get(path).json().path("items").size()); assertEquals(0, lateBrowser.get(path).json().path("items").size());
        long ready = System.currentTimeMillis(); Thread.sleep(5);
        recipient.write("PUT", "/api/v1/me/follows/" + channel, Map.of("notificationsOn", false)); recipient.write("PUT", "/api/v1/me/follows/" + channel, Map.of("notificationsOn", true));
        notificationSource(registry, media, mediaState, "3".repeat(32), ready, "second-source", "다음 방송"); worker.reconcile();
        assertEquals(0, recipient.get(path).json().path("items").size()); assertEquals(1, lateBrowser.get(path).json().path("items").size());
        // Equal-millisecond pagination uses PostgreSQL UUID order, and unread totals ignore the selected kind/filter.
        String[] ids = {"00000000-0000-0000-0000-000000000011", "7fffffff-0000-0000-0000-000000000011", "80000000-0000-0000-0000-000000000011", "ffffffff-0000-0000-0000-000000000011"};
        for (String id : ids) {
            sql.sql("INSERT INTO product_notification_events(event_key,created_at_ms) VALUES(:key,1794442212345)").param("key", "page:" + id).update();
            sql.sql("INSERT INTO product_notifications(id,recipient_id,event_key,kind,title,body,created_at_ms,report_id,report_status) VALUES(:id,:recipient,:event,'report','페이지 알림','일반 안내',1794442212345,:report,'resolved')")
                    .param("id", UUID.fromString(id)).param("recipient", user).param("event", "page:" + id).param("report", pendingReport).update();
        }
        var pageOne = recipient.get(path + "?limit=2&kind=report").json(); assertEquals(ids[3], pageOne.path("items").get(0).path("id").asString()); assertEquals(4, pageOne.path("unreadCount").longValue());
        var pageTwo = recipient.get(path + "?limit=2&kind=report&cursor=" + pageOne.path("nextCursor").asString()).json(); assertEquals(ids[1], pageTwo.path("items").get(0).path("id").asString()); assertTrue(pageTwo.path("nextCursor").isNull());
        var read = recipient.write("PATCH", path + "/" + ids[3] + "/read", null); assertEquals(200, read.status()); assertEquals(2, read.json().size()); assertEquals(user.toString(), read.json().path("userId").asString()); assertEquals(3, read.json().path("unreadCount").longValue());
        long readAt = sql.sql("SELECT read_at_ms FROM product_notifications WHERE id=:id").param("id", UUID.fromString(ids[3])).query(Long.class).single();
        recipient.write("PATCH", path + "/" + ids[3] + "/read", null); assertEquals(readAt, sql.sql("SELECT read_at_ms FROM product_notifications WHERE id=:id").param("id", UUID.fromString(ids[3])).query(Long.class).single());
        assertEquals(3, recipient.get(path + "?filter=unread").json().path("items").size()); assertEquals(0, recipient.write("POST", path + "/read-all", null).json().path("unreadCount").longValue());
        assertEquals(0, recipient.write("POST", path + "/read-all", null).json().path("unreadCount").longValue()); assertEquals(0, recipient.get(path + "?filter=unread").json().path("items").size());
        assertEquals(200, recipient.write("DELETE", path, null).status()); assertEquals(200, recipient.write("DELETE", path, null).status());
        notificationSource(registry, media, mediaState, "4".repeat(32), System.currentTimeMillis(), "restart-source", "재시작 보존 알림"); worker.reconcile();
        var saved = recipient.get(path).json().path("items"); assertEquals(1, saved.size()); assertEquals("재시작 보존 알림", saved.get(0).path("body").asString());
        assertEquals(1, recipient.get(path + "?kind=report").json().path("unreadCount").longValue()); assertEquals(0, recipient.get(path + "?kind=report").json().path("items").size());
        assertTrue(sql.sql("SELECT notifications_enabled_at IS NOT NULL FROM product_follows WHERE user_id=:user AND channel_id=:channel").param("user", late.id()).param("channel", channel).query(Boolean.class).single());
        recipient.expectedUserId = null;
        return saved.get(0).path("id").asString();
    }
    private static void notificationSource(frame.api.broadcast.BroadcastRegistry registry, frame.api.mediamtx.MediaMtxPaths media,
                                           java.util.concurrent.atomic.AtomicReference<String> state, String id, long ready, String source, String title) throws Exception {
        // Distinct OBS broadcasts end before a new source starts. A source change under the same ID is a reconnect.
        var previous=registry.byPath("obs-verify");if(previous!=null&&!previous.id.equals(id))registry.announce(JSON.valueToTree(Map.of("v",1,"type","bye","id",previous.id)),0);
        state.set(JSON.writeValueAsString(Map.of("items", java.util.List.of(Map.of("name", "obs-verify", "ready", true, "readyTime", java.time.Instant.ofEpochMilli(ready).toString(), "source", Map.of("type", "rtspSession", "id", source), "tracks", java.util.List.of("H264", "MPEG-4 Audio"))))));
        Thread.sleep(1050); var found = media.list().get("obs-verify"); assertNotNull(found);
        registry.announce(JSON.valueToTree(Map.of("v", 1, "type", "announce", "item", Map.of("id", id, "path", "obs-verify", "title", title, "publisher", "server", "startedAtMs", ready - 100, "width", 0, "height", 0, "fps", 0))), 0);registry.get(id).observe(found, false);
    }
    private static String reportManagement(Browser operator, Browser reporter, Browser anonymous, JdbcClient sql, UUID operatorId, UUID channel) throws Exception {
        String path = "/api/v1/admin/reports";
        String id = sql.sql("SELECT id FROM product_channel_reports WHERE channel_id=:channel AND reason='harassment' AND details='비공개 신고 내용'").param("channel", channel).query(UUID.class).single().toString();
        String detailPath = path + "/" + id;
        Map<String, Object> review = Map.of("status", "reviewing", "reviewNote", "검토 시작", "version", 0);
        assertEquals(401, anonymous.get(path).status()); assertEquals(401, anonymous.get(detailPath).status()); assertEquals(401, anonymous.write("PATCH", detailPath, review).status());
        assertEquals(0, sql.sql("SELECT count(*) FROM product_accounts WHERE is_operator").query(Integer.class).single());
        for (String denied : java.util.List.of(path, detailPath, path + "/not-a-uuid", path + "?cursor=malformed", path + "?limit=invalid")) {
            var response = reporter.get(denied); assertEquals(403, response.status()); assertEquals("OPERATOR_REQUIRED", response.code()); assertFalse(response.raw().body().contains("비공개 신고 내용"));
        }
        assertEquals("OPERATOR_REQUIRED", operator.write("PATCH", detailPath, review).code());
        assertEquals("OPERATOR_REQUIRED", reporter.write("PATCH", path + "/not-a-uuid", Map.of()).code());
        assertFalse(operator.get("/api/v1/session").json().path("user").path("isOperator").booleanValue());
        var attemptedEscalation = operator.write("PATCH", "/api/v1/me/profile", Map.of("displayName", "개발하는 봄", "isOperator", true, "roles", java.util.List.of("ROLE_ADMIN")));
        assertEquals(200, attemptedEscalation.status()); assertFalse(attemptedEscalation.json().path("user").path("isOperator").booleanValue());
        String cookie = operator.cookie();
        sql.sql("UPDATE product_accounts SET is_operator=true WHERE id=:id").param("id", operatorId).update();
        assertTrue(operator.get("/api/v1/session").json().path("user").path("isOperator").booleanValue()); assertEquals(cookie, operator.cookie());
        assertFalse(reporter.get("/api/v1/session").json().path("user").path("isOperator").booleanValue());
        var listing = operator.get(path); assertEquals(200, listing.status()); assertTrue(listing.raw().headers().firstValue("Cache-Control").orElse("").contains("no-store"));
        JsonNode item = listing.json().path("items").valueStream().filter(value -> value.path("id").asString().equals(id)).findFirst().orElseThrow();
        assertEquals(9, item.size()); assertEquals(3, item.path("channel").size()); assertEquals(2, item.path("reporter").size());
        assertEquals(channel.toString(), item.path("channel").path("id").asString()); assertEquals("received", item.path("status").asString()); assertEquals(0, item.path("version").intValue());
        assertEquals(item.path("createdAtMs").longValue(), item.path("updatedAtMs").longValue()); assertFalse(item.has("reviewNote")); assertFalse(item.has("reviewedBy"));
        for (String forbidden : java.util.List.of("@example.test", "password", "csrfToken", TOKEN, "FRAME_SESSION")) assertFalse(listing.raw().body().contains(forbidden));
        var original = operator.get(detailPath).json(); assertEquals(11, original.size()); assertEquals("", original.path("reviewNote").asString()); assertTrue(original.path("reviewedBy").isNull());
        assertEquals("비공개 신고 내용", original.path("details").asString());
        assertEquals(0, operator.get(path + "?status=resolved").json().path("items").size());
        assertTrue(operator.get(path + "?reason=harassment").json().path("items").valueStream().allMatch(value -> value.path("reason").asString().equals("harassment")));
        assertEquals(1, operator.get(path + "?q=" + java.net.URLEncoder.encode("비공개 신고 내용", java.nio.charset.StandardCharsets.UTF_8)).json().path("items").size());
        assertTrue(operator.get(path + "?q=SPRING-OWNER").json().path("items").size() > 0);
        assertEquals(0, operator.get(path + "?q=%25").json().path("items").size());
        for (String query : java.util.List.of("status=unknown", "reason=unknown", "limit=0", "limit=101", "limit=invalid", "q=%00")) assertEquals("INVALID_REPORT_FILTER", operator.get(path + "?" + query).code());
        assertEquals("INVALID_REPORT_CURSOR", operator.get(path + "?cursor=invalid").code());
        assertEquals("INVALID_REPORT_ID", operator.get(path + "/1-1-1-1-1").code()); assertEquals("REPORT_NOT_FOUND", operator.get(path + "/" + UUID.randomUUID()).code());
        UUID reporterId = UUID.fromString(original.path("reporter").path("id").asString());
        // Same DTO millisecond, different database microseconds, with UUIDs on both sides of Java's signed ordering.
        String[] pageIds = {"00000000-0000-0000-0000-000000000001", "7fffffff-0000-0000-0000-000000000001", "80000000-0000-0000-0000-000000000001", "ffffffff-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "7fffffff-0000-0000-0000-000000000002", "80000000-0000-0000-0000-000000000002", "ffffffff-0000-0000-0000-000000000002"};
        for (int index = 0; index < pageIds.length; index++) {
            var at = java.time.OffsetDateTime.parse(index < 4 ? "2026-11-01T01:02:03.123999Z" : "2026-11-01T01:02:03.123001Z");
            sql.sql("INSERT INTO product_channel_reports(id,channel_id,reporter_id,reason,details,created_at,updated_at) VALUES(:id,:channel,:reporter,'spam','management-page-fixture',:at,:at)")
                    .param("id", UUID.fromString(pageIds[index])).param("channel", channel).param("reporter", reporterId).param("at", at).update();
        }
        var expected = sql.sql("SELECT id FROM product_channel_reports WHERE details='management-page-fixture' ORDER BY created_at DESC,id DESC").query(UUID.class).list().stream().map(UUID::toString).toList();
        java.util.List<String> found = new java.util.ArrayList<>(); String cursor = "";
        do {
            var page = operator.get(path + "?q=management-page-fixture&limit=3&cursor=" + cursor).json();
            page.path("items").forEach(value -> found.add(value.path("id").asString())); cursor = page.path("nextCursor").isNull() ? "" : page.path("nextCursor").asString();
        } while (!cursor.isEmpty());
        assertEquals(expected, found); assertEquals(8, new java.util.HashSet<>(found).size());
        sql.sql("DELETE FROM product_channel_reports WHERE details='management-page-fixture'").update();
        assertEquals(403, operator.send("PATCH", detailPath, review, false, ORIGIN).status());
        assertEquals(403, operator.send("PATCH", detailPath, review, true, "https://outside.invalid").status());
        assertEquals("INVALID_REPORT_UPDATE", operator.write("PATCH", detailPath, Map.of("status", "received", "reviewNote", "되돌리기", "version", 0)).code());
        assertEquals("INVALID_REPORT_UPDATE", operator.write("PATCH", detailPath, Map.of("status", "reviewing", "reviewNote", "서버값 위조", "version", 0, "reviewedBy", operatorId)).code());
        assertEquals("INVALID_REVIEW_NOTE", operator.write("PATCH", detailPath, Map.of("status", "resolved", "reviewNote", " ", "version", 0)).code());
        assertEquals("INVALID_REVIEW_NOTE", operator.write("PATCH", detailPath, Map.of("status", "reviewing", "reviewNote", "a".repeat(1001), "version", 0)).code());
        assertEquals("INVALID_REPORT_UPDATE", operator.write("PATCH", detailPath, Map.of("status", "reviewing", "reviewNote", "노트", "version", "0")).code());
        assertEquals("BODY_TOO_LARGE", operator.write("PATCH", detailPath, Map.of("status", "reviewing", "reviewNote", "a".repeat(8192), "version", 0)).code());
        assertEquals(original, operator.get(detailPath).json());
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> operator.write("PATCH", detailPath, review));
            var second = pool.submit(() -> operator.write("PATCH", detailPath, Map.of("status", "reviewing", "reviewNote", "동시 검토", "version", 0)));
            var a = first.get(); var b = second.get(); assertEquals(java.util.Set.of(200, 409), java.util.Set.of(a.status(), b.status())); assertEquals("REPORT_CONFLICT", a.status() == 409 ? a.code() : b.code());
        }
        var reviewing = operator.get(detailPath).json(); assertEquals(1, reviewing.path("version").intValue()); assertEquals("reviewing", reviewing.path("status").asString());
        assertEquals(operatorId.toString(), reviewing.path("reviewedBy").path("id").asString()); assertTrue(reviewing.path("updatedAtMs").longValue() >= original.path("updatedAtMs").longValue());
        assertEquals("INVALID_REPORT_TRANSITION", operator.write("PATCH", detailPath, Map.of("status", "reviewing", "reviewNote", "같은 상태", "version", 1)).code());
        assertEquals("REPORT_CONFLICT", operator.write("PATCH", detailPath, Map.of("status", "resolved", "reviewNote", "오래된 상태", "version", 0)).code());
        var resolved = operator.write("PATCH", detailPath, Map.of("status", "resolved", "reviewNote", "검토를 마쳤어요.", "version", 1)); assertEquals(200, resolved.status());
        assertEquals(2, resolved.json().path("version").intValue()); assertEquals("resolved", resolved.json().path("status").asString());
        for (String field : java.util.List.of("id", "reason", "details", "createdAtMs", "channel", "reporter")) assertEquals(original.path(field), resolved.json().path(field));
        assertEquals("REPORT_ALREADY_CLOSED", operator.write("PATCH", detailPath, Map.of("status", "dismissed", "reviewNote", "종결 후 수정", "version", 2)).code());
        assertEquals(resolved.json(), operator.get(detailPath).json());
        assertEquals(1, operator.get(path + "?status=resolved").json().path("items").size());
        String dismissId = sql.sql("SELECT id FROM product_channel_reports WHERE channel_id=:channel AND reason='spam' ORDER BY id LIMIT 1").param("channel", channel).query(UUID.class).single().toString();
        assertEquals("dismissed", operator.write("PATCH", path + "/" + dismissId, Map.of("status", "dismissed", "reviewNote", "신고 사유에 해당하지 않아요.", "version", 0)).json().path("status").asString());
        assertEquals("REPORT_ALREADY_RECEIVED", reporter.write("POST", "/api/v1/channels/" + channel + "/reports", Map.of("reason", "harassment")).code());
        // Revocation is enforced for the current cookie on every endpoint, without logging out another account.
        sql.sql("UPDATE product_accounts SET is_operator=false WHERE id=:id").param("id", operatorId).update();
        assertFalse(operator.get("/api/v1/session").json().path("user").path("isOperator").booleanValue()); assertEquals(cookie, operator.cookie());
        assertEquals("OPERATOR_REQUIRED", operator.get(path).code()); assertEquals("OPERATOR_REQUIRED", operator.get(detailPath).code()); assertEquals("OPERATOR_REQUIRED", operator.write("PATCH", detailPath, review).code());
        assertEquals(resolved.json().path("reviewNote").asString(), sql.sql("SELECT review_note FROM product_channel_reports WHERE id=:id").param("id", UUID.fromString(id)).query(String.class).single());
        sql.sql("UPDATE product_accounts SET is_operator=true WHERE id=:id").param("id", operatorId).update();
        return id;
    }
    private static void channelProfiles(Browser owner, Browser other, Browser anonymous, JdbcClient sql, Accounts accounts, UUID channel, UUID otherChannel) throws Exception {
        String stable = "/api/v1/channel-ids/" + channel, patch = "/api/v1/me/channel", reports = "/api/v1/channels/" + channel + "/reports";
        JsonNode initial = anonymous.get(stable).json();
        long created = sql.sql("SELECT created_at FROM product_channels WHERE id=:channel").param("channel", channel).query(java.time.OffsetDateTime.class).single().toInstant().toEpochMilli();
        assertEquals(created, initial.path("createdAtMs").longValue()); assertTrue(created > 0); assertTrue(initial.path("countryCode").isNull());
        assertEquals(0, initial.path("links").size()); assertTrue(initial.path("videoCount").isNull()); assertTrue(initial.path("totalViewCount").isNull());
        assertFalse(initial.has("ownerId")); assertFalse(initial.has("email")); assertFalse(initial.has("reports"));
        assertEquals("INVALID_CHANNEL_ID", anonymous.get("/api/v1/channel-ids/1-1-1-1-1").code());
        assertEquals(404, anonymous.get("/api/v1/channel-ids/" + UUID.randomUUID()).status());
        assertEquals(401, anonymous.write("PATCH", patch, profile("anonymous", "guest-change")).status());
        assertEquals(403, owner.send("PATCH", patch, profile("missing-csrf", "missing-csrf"), false, ORIGIN).status());
        assertEquals(403, owner.send("PATCH", patch, profile("foreign-origin", "foreign-origin"), true, "https://outside.invalid").status());
        var links = java.util.List.of(Map.of("title", "작업 노트", "url", "https://example.test/notes"), Map.of("title", "작업실", "url", "https://example.test/studio"));
        Map<String, Object> body = new HashMap<>(profile("공개 프로필", " Spring-Updated ")); body.put("countryCode", "kr"); body.put("links", links);
        var changed = owner.write("PATCH", patch, body); assertEquals(200, changed.status()); assertEquals(channel.toString(), changed.json().path("id").asString());
        assertEquals("spring-updated", changed.json().path("handle").asString()); assertEquals(created, changed.json().path("createdAtMs").longValue());
        assertEquals("KR", changed.json().path("countryCode").asString()); assertEquals("작업 노트", changed.json().path("links").get(0).path("title").asString());
        assertEquals("spring-updated", anonymous.get("/api/v1/channels/SPRING-OWNER").json().path("handle").asString());
        assertEquals(channel.toString(), anonymous.get(stable).json().path("id").asString());
        assertEquals(200, anonymous.get("/api/v1/channels/spring-owner/schedule").status());
        assertEquals(anonymous.get("/api/v1/channels/spring-owner/schedule").json(), anonymous.get("/api/v1/channels/spring-updated/schedule").json());
        JsonNode otherBefore = other.get("/api/v1/session").json().path("channel");
        assertEquals("HANDLE_UNAVAILABLE", other.write("PATCH", patch, profile("타인 별칭 탈취", "SPRING-OWNER")).code());
        assertEquals(otherBefore, other.get("/api/v1/session").json().path("channel"));
        assertEquals("HANDLE_UNAVAILABLE", assertThrows(ProductProblem.class, () -> accounts.register(JSON.valueToTree(signup("reserved-alias@example.test", "spring-owner", "별칭 재등록", "a-password-long-enough")))).code);
        assertEquals(0, sql.sql("SELECT count(*) FROM product_accounts WHERE email='reserved-alias@example.test'").query(Integer.class).single());
        assertEquals(200, owner.write("PATCH", patch, profile("공개 프로필", "spring-owner")).status());
        assertEquals("spring-owner", anonymous.get("/api/v1/channels/spring-updated").json().path("handle").asString());
        // Omitting new optional fields preserves them for earlier clients; UUID, follows, history and creation time stay intact.
        Map<String, Object> legacy = new HashMap<>(profile("기존 클라이언트 저장", "spring-owner")); legacy.remove("handle");
        var legacySaved = owner.write("PATCH", patch, legacy); assertEquals(200, legacySaved.status());
        assertEquals("KR", legacySaved.json().path("countryCode").asString()); assertEquals(2, legacySaved.json().path("links").size());
        assertEquals(created, legacySaved.json().path("createdAtMs").longValue());
        assertEquals(1, sql.sql("SELECT count(*) FROM product_watch_history WHERE channel_id=:channel AND user_id=(SELECT owner_id FROM product_channels WHERE id=:channel)").param("channel", channel).query(Integer.class).single());
        for (Map.Entry<String, Object> invalid : java.util.List.<Map.Entry<String, Object>>of(Map.entry("handle", "@invalid"), Map.entry("handle", "ADMIN"), Map.entry("countryCode", "ZZ"), Map.entry("links", java.util.List.of(Map.of("title", "피싱", "url", "https://user:pass@example.test"))), Map.entry("links", java.util.Collections.nCopies(15, links.getFirst())))) {
            Map<String, Object> invalidBody = new HashMap<>(profile("저장되면 안 됨", "spring-owner")); invalidBody.put(invalid.getKey(), invalid.getValue());
            assertEquals(400, owner.write("PATCH", patch, invalidBody).status()); assertEquals("기존 클라이언트 저장", owner.get(stable).json().path("displayName").asString());
        }
        Map<String, Object> tooLarge = new HashMap<>(profile("큰 본문", "spring-owner")); tooLarge.put("ignored", "a".repeat(8192));
        var oversized = owner.write("PATCH", patch, tooLarge); assertEquals(413, oversized.status()); assertEquals("BODY_TOO_LARGE", oversized.code());
        Map<String, Object> clear = new HashMap<>(profile("비우기", "spring-owner")); clear.put("countryCode", null); clear.put("links", java.util.List.of());
        var cleared = owner.write("PATCH", patch, clear); assertEquals(200, cleared.status()); assertTrue(cleared.json().path("countryCode").isNull()); assertEquals(0, cleared.json().path("links").size());
        // Different owners compete for the same namespace; the loser must not partly save their profile.
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> owner.write("PATCH", patch, profile("이름 경합 A", "contested-profile")));
            var second = pool.submit(() -> other.write("PATCH", patch, profile("이름 경합 B", "CONTESTED-PROFILE")));
            var a = first.get(); var b = second.get(); assertEquals(java.util.Set.of(200, 409), java.util.Set.of(a.status(), b.status()));
            assertEquals("HANDLE_UNAVAILABLE", a.status() == 409 ? a.code() : b.code());
        }
        assertEquals(200, owner.write("PATCH", patch, profile("공개 프로필", "spring-owner")).status());
        assertEquals(200, other.write("PATCH", patch, profile(otherBefore.path("displayName").asString(), otherBefore.path("handle").asString())).status());
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> owner.write("PATCH", patch, profile("같은 소유자 동시 변경1", "same-owner-one")));
            var second = pool.submit(() -> owner.write("PATCH", patch, profile("같은 소유자 동시 변경2", "same-owner-two")));
            assertEquals(200, first.get().status()); assertEquals(200, second.get().status());
        }
        assertEquals(channel.toString(), anonymous.get("/api/v1/channels/same-owner-one").json().path("id").asString());
        assertEquals(channel.toString(), anonymous.get("/api/v1/channels/same-owner-two").json().path("id").asString());
        // Registration and rename use the very same unique reservation, including case folding.
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var registration = pool.submit(() -> { try { accounts.register(JSON.valueToTree(signup("rename-race@example.test", "registration-race", "등록 경쟁", "a-password-long-enough"))); return 201; } catch (ProductProblem problem) { return problem.status; } });
            var rename = pool.submit(() -> owner.write("PATCH", patch, profile("등록과 변경 경합", "REGISTRATION-RACE")));
            int registered = registration.get(), renamed = rename.get().status(); assertTrue((registered == 201 && renamed == 409) || (registered == 409 && renamed == 200));
        }
        body.put("handle", "spring-owner"); assertEquals(200, owner.write("PATCH", patch, body).status());
        // Reporter ownership, CSRF/origin, exact body validation and missing targets.
        assertEquals(401, anonymous.write("POST", reports, Map.of("reason", "spam")).status());
        assertEquals(403, other.send("POST", reports, Map.of("reason", "spam"), false, ORIGIN).status());
        assertEquals(403, other.send("POST", reports, Map.of("reason", "spam"), true, "https://outside.invalid").status());
        assertEquals("SELF_REPORT_NOT_ALLOWED", owner.write("POST", reports, Map.of("reason", "spam")).code());
        assertEquals("INVALID_CHANNEL_ID", other.write("POST", "/api/v1/channels/1-1-1-1-1/reports", Map.of("reason", "spam")).code());
        assertEquals(404, other.write("POST", "/api/v1/channels/" + UUID.randomUUID() + "/reports", Map.of("reason", "spam")).status());
        assertEquals("INVALID_REPORT_REASON", other.write("POST", reports, Map.of("reason", "spam", "reporterId", "forged")).code());
        assertEquals("INVALID_REPORT_DETAILS", other.write("POST", reports, Map.of("reason", "other")).code());
        assertEquals("INVALID_REPORT_DETAILS", other.write("POST", reports, Map.of("reason", "spam", "details", "a".repeat(1001))).code());
        var receipt = other.write("POST", reports, Map.of("reason", "harassment", "details", "비공개 신고 내용")); assertEquals(201, receipt.status());
        assertEquals(3, receipt.json().size()); assertEquals("received", receipt.json().path("status").asString()); assertTrue(receipt.json().path("createdAtMs").longValue() > 0);
        assertFalse(anonymous.get(stable).raw().body().contains("비공개 신고 내용"));
        var duplicate = other.write("POST", reports, Map.of("reason", "harassment", "details", "다른 내용이어도 동일 사유")); assertEquals(409, duplicate.status()); assertEquals("REPORT_ALREADY_RECEIVED", duplicate.code());
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> other.write("POST", reports, Map.of("reason", "spam")));
            var second = pool.submit(() -> other.write("POST", reports, Map.of("reason", "spam")));
            assertEquals(java.util.Set.of(201, 409), java.util.Set.of(first.get().status(), second.get().status()));
        }
        for (String reason : java.util.List.of("impersonation", "inappropriate", "other")) assertEquals(201, other.write("POST", reports, Map.of("reason", reason, "details", "설명")).status());
        UUID reporter = sql.sql("SELECT owner_id FROM product_channels WHERE id=:channel").param("channel", otherChannel).query(UUID.class).single();
        assertEquals(5, sql.sql("SELECT count(*) FROM product_channel_reports WHERE reporter_id=:reporter").param("reporter", reporter).query(Integer.class).single());
        UUID additionalTarget = sql.sql("SELECT id FROM product_channels WHERE id NOT IN (:ids) ORDER BY id LIMIT 1").param("ids", java.util.List.of(channel, otherChannel)).query(UUID.class).single();
        var limited = other.write("POST", "/api/v1/channels/" + additionalTarget + "/reports", Map.of("reason", "spam")); assertEquals(429, limited.status()); assertEquals("REPORT_RATE_LIMITED", limited.code());
        assertEquals("60", limited.raw().headers().firstValue("Retry-After").orElse(""));
        assertEquals(5, sql.sql("SELECT count(*) FROM product_channel_reports WHERE reporter_id=:reporter").param("reporter", reporter).query(Integer.class).single());
        assertEquals(201, owner.write("POST", "/api/v1/channels/" + otherChannel + "/reports", Map.of("reason", "spam")).status());
        UUID ownerId = sql.sql("SELECT owner_id FROM product_channels WHERE id=:channel").param("channel", channel).query(UUID.class).single();
        for (String reason : java.util.List.of("impersonation", "harassment", "other")) sql.sql("INSERT INTO product_channel_reports(id,channel_id,reporter_id,reason,details) VALUES(:id,:target,:reporter,:reason,'rate-fixture')")
                .param("id", UUID.randomUUID()).param("target", otherChannel).param("reporter", ownerId).param("reason", reason).update();
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> owner.write("POST", "/api/v1/channels/" + additionalTarget + "/reports", Map.of("reason", "spam")));
            var second = pool.submit(() -> owner.write("POST", "/api/v1/channels/" + otherChannel + "/reports", Map.of("reason", "inappropriate")));
            assertEquals(java.util.Set.of(201, 429), java.util.Set.of(first.get().status(), second.get().status()));
        }
        assertEquals(5, sql.sql("SELECT count(*) FROM product_channel_reports WHERE reporter_id=:reporter").param("reporter", ownerId).query(Integer.class).single());
        var deleted = accounts.register(JSON.valueToTree(signup("deleted-profile@example.test", "deleted-profile", "삭제 채널", "a-password-long-enough")));
        sql.sql("DELETE FROM product_accounts WHERE id=:id").param("id", deleted.id()).update();
        assertEquals(1, sql.sql("SELECT count(*) FROM product_channel_handles WHERE handle='deleted-profile' AND channel_id IS NULL").query(Integer.class).single());
        assertEquals(404, anonymous.get("/api/v1/channels/deleted-profile").status());
        assertEquals("HANDLE_UNAVAILABLE", assertThrows(ProductProblem.class, () -> accounts.register(JSON.valueToTree(signup("reassign-deleted@example.test", "deleted-profile", "재할당 금지", "a-password-long-enough")))).code);
        assertEquals(1, anonymous.get(stable).json().path("followerCount").longValue());
    }
    private static Map<String, Object> profile(String name, String handle) { return Map.of("displayName", name, "handle", handle, "description", "프로필 소개", "notice", "공지", "category", "개발·작업"); }
    private static String histories(Browser owner, Browser other, Browser anonymous, JdbcClient sql, frame.api.broadcast.BroadcastRegistry registry, UUID ownerId) throws Exception {
        final String path = "/api/v1/me/history", broadcastId = "d".repeat(32), stream = "obs-verify";
        final Map<String, Object> watched = Map.of("broadcastId", broadcastId, "path", stream);
        anonymous.get("/api/v1/session");
        assertEquals(401, anonymous.get(path).status());
        assertEquals(401, anonymous.write("POST", path, watched).status());
        assertEquals(401, anonymous.write("DELETE", path, null).status());
        assertEquals(403, owner.send("POST", path, watched, false, ORIGIN).status());
        assertEquals(403, owner.send("POST", path, watched, true, "https://untrusted.invalid").status());
        assertEquals(0, owner.get(path).json().path("items").size());
        assertTrue(owner.get(path).json().path("nextCursor").isNull());
        assertEquals("HISTORY_BROADCAST_NOT_FOUND", owner.write("POST", path, watched).code());
        announceHistory(registry, broadcastId, stream, "서버 제목", "Public Publisher");
        UUID firstInstance = registry.get(broadcastId).instanceId;
        assertEquals(400, owner.write("POST", path, Map.of("broadcastId", broadcastId, "path", stream, "title", "위조 제목")).status());
        assertEquals(400, owner.write("POST", path, Map.of("broadcastId", "bad", "path", stream)).status());
        assertEquals(404, owner.write("POST", path, Map.of("broadcastId", broadcastId, "path", "another-path")).status());
        assertEquals(204, owner.write("POST", path, watched).status());
        JsonNode first = owner.get(path).json().path("items").get(0);
        String id = first.path("id").asString();
        assertEquals("서버 제목", first.path("title").asString()); assertEquals("Public Publisher", first.path("publisher").asString());
        assertEquals("spring-owner", first.path("channelHandle").asString()); assertTrue(first.path("available").booleanValue());
        assertEquals("/thumbnails/" + broadcastId + ".jpg", first.path("thumbnailUrl").asString());
        assertEquals(15, first.size()); assertTrue(first.path("mediaId").isNull()); assertTrue(first.path("durationMs").isNull()); assertTrue(first.path("positionMs").isNull()); assertFalse(first.path("completed").asBoolean()); assertEquals(0, first.path("version").longValue());
        assertFalse(first.toString().contains(TOKEN)); assertFalse(first.has("userId")); assertFalse(first.has("broadcastInstanceId"));
        long recordedAt = first.path("watchedAtMs").longValue(); assertTrue(recordedAt <= System.currentTimeMillis() && recordedAt > System.currentTimeMillis() - 10000);
        Thread.sleep(2);
        assertEquals(204, owner.write("POST", path, watched).status());
        var repeated = owner.get(path).json().path("items"); assertEquals(1, repeated.size()); assertEquals(id, repeated.get(0).path("id").asString()); assertTrue(repeated.get(0).path("watchedAtMs").longValue() >= recordedAt);
        assertEquals(0, other.get(path).json().path("items").size());
        assertEquals(204, other.write("POST", path, watched).status());
        String foreign = other.get(path).json().path("items").get(0).path("id").asString();
        assertEquals(404, owner.write("DELETE", path + "/" + foreign, null).status());
        assertEquals(404, owner.write("POST", path + "/delete", Map.of("ids", java.util.List.of(id, foreign))).status());
        assertEquals(1, owner.get(path).json().path("items").size());
        assertEquals(1, other.get(path).json().path("items").size());
        assertEquals(400, owner.write("POST", path + "/delete", Map.of("ids", java.util.List.of())).status());
        assertEquals(400, owner.write("POST", path + "/delete", Map.of("ids", java.util.Collections.nCopies(201, id))).status());
        assertEquals(400, owner.write("DELETE", path + "/1-1-1-1-1", null).status());
        for (String query : new String[] { "?kind=unknown", "?limit=0", "?limit=101", "?limit=invalid", "?cursor=invalid", "?from=2026-02-30", "?from=2026-11-13&to=2026-11-12", "?q=%00" }) assertEquals(400, owner.get(path + query).status(), query);
        assertEquals(0, owner.get(path + "?kind=clip").json().path("items").size());
        assertEquals(0, owner.get(path + "?kind=vod").json().path("items").size());
        assertEquals(1, owner.get(path + "?q=public").json().path("items").size());
        assertEquals(0, owner.get(path + "?q=absent").json().path("items").size());
        assertEquals(1, owner.get(path + "?kind=live").json().path("items").size());
        assertEquals(204, registry.announce(JSON.valueToTree(Map.of("v", 1, "type", "bye", "id", broadcastId)), 0).status());
        JsonNode ended = owner.get(path).json().path("items").get(0); assertFalse(ended.path("available").booleanValue()); assertTrue(ended.path("thumbnailUrl").isNull()); assertEquals("서버 제목", ended.path("title").asString());
        assertEquals(404, owner.write("POST", path, watched).status());
        announceHistory(registry, broadcastId, stream, "새 인스턴스", "Another Publisher");
        assertNotEquals(firstInstance, registry.get(broadcastId).instanceId);
        JsonNode old = owner.get(path).json().path("items").get(0); assertFalse(old.path("available").booleanValue()); assertEquals("서버 제목", old.path("title").asString());
        assertEquals(204, owner.write("POST", path, watched).status());
        JsonNode reused = owner.get(path).json().path("items"); assertEquals(2, reused.size()); assertEquals(1, reused.valueStream().filter(item -> item.path("available").booleanValue()).count());
        assertTrue(reused.valueStream().anyMatch(item -> item.path("id").asString().equals(id) && item.path("title").asString().equals("서버 제목")));
        announceHistory(registry, "e".repeat(32), stream, "같은 경로 새 방송", "New Publisher");
        assertTrue(owner.get(path).json().path("items").valueStream().noneMatch(item -> item.path("available").booleanValue()));
        assertEquals(404, owner.write("POST", path, watched).status());
        String nulId = "f".repeat(32);
        announceHistory(registry, nulId, "history-unlinked", "제목\0문자", "");
        assertEquals(204, owner.write("POST", path, Map.of("broadcastId", nulId, "path", "history-unlinked")).status());
        JsonNode unlinked = owner.get(path + "?q=" + java.net.URLEncoder.encode("제목", java.nio.charset.StandardCharsets.UTF_8)).json().path("items");
        assertTrue(unlinked.valueStream().anyMatch(item -> item.path("title").asString().equals("제목�문자") && item.path("publisher").asString().isEmpty() && item.path("channelHandle").isNull()));
        long dayStart = java.time.Instant.parse("2026-11-11T15:00:00Z").toEpochMilli();
        String[] pageIds = { "00000000-0000-4000-8000-000000000001", "7fffffff-0000-4000-8000-000000000001", "80000000-0000-4000-8000-000000000001", "ffffffff-0000-4000-8000-000000000001" };
        for (int index = 0; index < pageIds.length; index++) {
            sql.sql("INSERT INTO product_watch_history(id,user_id,broadcast_id,path,broadcast_instance_id,title,publisher,watched_at_ms) VALUES(:id,:owner,:broadcast,'pagination',:instance,'page-fixture','server',:at)")
                    .param("id", UUID.fromString(pageIds[index])).param("owner", ownerId).param("broadcast", String.format("%032x", index + 1)).param("instance", UUID.randomUUID()).param("at", dayStart).update();
        }
        var firstPage = owner.get(path + "?q=page-fixture&limit=2").json(); assertEquals(2, firstPage.path("items").size()); assertEquals(pageIds[3], firstPage.path("items").get(0).path("id").asString());
        assertEquals(pageIds[2], firstPage.path("items").get(1).path("id").asString()); assertFalse(firstPage.path("nextCursor").isNull());
        var secondPage = owner.get(path + "?q=page-fixture&limit=2&cursor=" + firstPage.path("nextCursor").asString()).json();
        assertEquals(2, secondPage.path("items").size()); assertEquals(pageIds[1], secondPage.path("items").get(0).path("id").asString()); assertEquals(pageIds[0], secondPage.path("items").get(1).path("id").asString()); assertTrue(secondPage.path("nextCursor").isNull());
        assertEquals(4, owner.get(path + "?q=page-fixture&from=2026-11-12&to=2026-11-12").json().path("items").size());
        assertEquals(0, owner.get(path + "?q=page-fixture&to=2026-11-11").json().path("items").size());
        assertEquals(204, owner.write("POST", path + "/delete", Map.of("ids", java.util.List.of(pageIds[0], pageIds[1]))).status());
        assertEquals(2, owner.get(path + "?q=page-fixture").json().path("items").size());
        assertEquals(204, owner.write("DELETE", path + "/" + pageIds[2], null).status());
        assertEquals(404, owner.write("DELETE", path + "/" + pageIds[2], null).status());
        assertEquals(204, owner.write("DELETE", path, null).status()); assertEquals(0, owner.get(path).json().path("items").size()); assertEquals(1, other.get(path).json().path("items").size());
        announceHistory(registry, "e".repeat(32), stream, "재시작 보존", "Saved Publisher");
        assertEquals(204, owner.write("POST", path, Map.of("broadcastId", "e".repeat(32), "path", stream)).status());
        return owner.get(path).json().path("items").get(0).path("id").asString();
    }
    private record ArchivedHistoryState(String vod, String clip) {}
    private static ArchivedHistoryState archivedHistory(Browser owner, Browser viewer, Browser anonymous, JdbcClient sql,
            ConfigurableApplicationContext app, UUID vod, UUID clip, Path vodDirectory, Path clipDirectory) throws Exception {
        String history = "/api/v1/me/history", vodState = history + "/media/vod/" + vod, clipState = history + "/media/clip/" + clip;
        String viewerId = viewer.get("/api/v1/session").json().path("user").path("id").asString();
        viewer.expectedUserId = viewerId;
        assertEquals(401, anonymous.get(vodState).status());
        assertEquals(401, anonymous.write("PUT", vodState, progressBody(0, null, 0, 1200, false)).status());
        assertEquals(0, viewer.get(history + "?kind=vod").json().path("items").size());
        var empty = viewer.get(vodState);
        assertEquals(200, empty.status()); assertEquals(viewerId, empty.json().path("userId").asString()); assertTrue(empty.json().path("item").isNull());
        assertTrue(empty.raw().headers().firstValue("cache-control").orElse("").contains("no-store"));
        assertEquals(0, viewer.get(history + "?kind=vod").json().path("items").size(), "Reading detail and saved position must not create a watch");
        var initialBody = progressBody(empty.json(), 1200, false);
        assertEquals(403, viewer.send("PUT", vodState, initialBody, false, ORIGIN).status());
        assertEquals(403, viewer.send("PUT", vodState, initialBody, true, "https://outside.invalid").status());
        viewer.expectedUserId = UUID.randomUUID().toString();
        for (String route : java.util.List.of(history, vodState)) assertEquals("SESSION_CHANGED", viewer.get(route).code());
        assertEquals("SESSION_CHANGED", viewer.write("PUT", vodState, initialBody).code());
        assertEquals("SESSION_CHANGED", viewer.write("DELETE", history, null).code());
        assertEquals("SESSION_CHANGED", viewer.write("POST", history + "/delete", Map.of("ids", java.util.List.of(UUID.randomUUID().toString()))).code());
        assertEquals("SESSION_CHANGED", viewer.write("DELETE", history + "/" + UUID.randomUUID(), null).code());
        assertEquals("SESSION_CHANGED", viewer.write("POST", history, Map.of("broadcastId", "e".repeat(32), "path", "obs-verify")).code());
        viewer.expectedUserId = viewerId;
        for (String field : new String[] { "title", "durationMs", "channelId", "userId", "watchedAtMs" }) {
            var extra = new HashMap<>(initialBody); extra.put(field, "client supplied");
            assertEquals("INVALID_HISTORY_INPUT", viewer.write("PUT", vodState, extra).code());
        }
        assertEquals(400, viewer.get(history + "/media/live/" + vod).status());
        assertEquals(400, viewer.get(history + "/media/vod/not-a-uuid").status());
        assertEquals(404, viewer.get(history + "/media/vod/" + UUID.randomUUID()).status());
        assertEquals(400, viewer.write("PUT", vodState, progressBody(empty.json(), 12001, false)).status());
        assertEquals(400, viewer.write("PUT", vodState, progressBody(empty.json(), 0, true)).status());
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> viewer.write("PUT", vodState, initialBody));
            var second = pool.submit(() -> viewer.write("PUT", vodState, initialBody));
            assertEquals(java.util.Set.of(200, 409), java.util.Set.of(first.get().status(), second.get().status()));
        }
        var saved = viewer.get(vodState).json();
        assertEquals(0, saved.path("item").path("version").longValue()); assertEquals(1200, saved.path("item").path("positionMs").longValue());
        assertEquals("vod-preserved", saved.path("item").path("title").asString()); assertEquals(12000, saved.path("item").path("durationMs").longValue());
        assertEquals(vod.toString(), saved.path("item").path("mediaId").asString()); assertTrue(saved.path("item").path("broadcastId").isNull()); assertTrue(saved.path("item").path("path").isNull());
        assertFalse(saved.toString().contains("archive_key")); assertFalse(saved.toString().contains(vodDirectory.toString())); assertFalse(saved.toString().contains(TOKEN));
        assertTrue(owner.get(vodState).json().path("item").isNull(), "Positions are private to the viewer, even for the channel owner");
        var stale = progressBody(saved, 2200, false);
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> viewer.write("PUT", vodState, stale));
            var second = pool.submit(() -> viewer.write("PUT", vodState, stale));
            assertEquals(java.util.Set.of(200, 409), java.util.Set.of(first.get().status(), second.get().status()));
        }
        var advanced = viewer.get(vodState).json(); assertEquals(1, advanced.path("item").path("version").longValue());
        var completed = viewer.write("PUT", vodState, progressBody(advanced, 11000, true)); assertEquals(200, completed.status());
        assertTrue(completed.json().path("item").path("completed").asBoolean()); assertEquals(12000, completed.json().path("item").path("positionMs").longValue());
        var replay = viewer.write("PUT", vodState, progressBody(completed.json(), 1300, false)); assertEquals(200, replay.status());
        assertFalse(replay.json().path("item").path("completed").asBoolean()); assertEquals(1300, replay.json().path("item").path("positionMs").longValue());
        var clipEmpty = viewer.get(clipState).json(); assertTrue(clipEmpty.path("item").isNull());
        var savedClip = viewer.write("PUT", clipState, progressBody(clipEmpty, 1400, false)); assertEquals(200, savedClip.status());
        assertEquals(6000, savedClip.json().path("item").path("durationMs").longValue());
        assertEquals(1, viewer.get(history + "?kind=vod").json().path("items").size()); assertEquals(1, viewer.get(history + "?kind=clip").json().path("items").size());
        assertEquals(2, viewer.get(history + "?q=preserved").json().path("items").size());
        String today = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Seoul")).toString();
        assertEquals(2, viewer.get(history + "?q=preserved&from=" + today + "&to=" + today).json().path("items").size());
        var seen = new java.util.HashSet<String>(); String cursor = "";
        do {
            var page = viewer.get(history + "?limit=1" + (cursor.isEmpty() ? "" : "&cursor=" + cursor)).json();
            assertEquals(viewerId, page.path("userId").asString());
            for (JsonNode item : page.path("items")) assertTrue(seen.add(item.path("id").asString()), "Mixed-kind pages must not repeat rows");
            cursor = page.path("nextCursor").isNull() ? "" : page.path("nextCursor").asString();
        } while (!cursor.isEmpty());
        assertEquals(3, seen.size());
        // Withdrawing a parent also gates its clip. Private edits never replace the saved public snapshot.
        sql.sql("UPDATE product_vods SET visibility='private',title='private title must not leak' WHERE id=:id").param("id", vod).update();
        try {
            assertEquals(404, viewer.get(vodState).status()); assertEquals(404, viewer.get(clipState).status());
            assertEquals(404, viewer.write("PUT", vodState, progressBody(replay.json(), 2300, false)).status());
            assertEquals(404, viewer.write("PUT", clipState, progressBody(savedClip.json(), 2300, false)).status());
            var privateResponse = viewer.get(history + "?q=preserved"); assertEquals(200, privateResponse.status(), privateResponse.raw().body());
            var privateRows = privateResponse.json().path("items"); assertEquals(2, privateRows.size());
            assertTrue(privateRows.valueStream().noneMatch(item -> item.path("available").asBoolean())); assertFalse(privateRows.toString().contains("private title"));
        } finally { sql.sql("UPDATE product_vods SET visibility='public',title='vod-preserved' WHERE id=:id").param("id", vod).update(); }
        for (var media : java.util.List.of(new Object[] { vodDirectory, vod, vodState, "vod" }, new Object[] { clipDirectory, clip, clipState, "clip" })) {
            Path directory = (Path) media[0]; UUID id = (UUID) media[1]; String route = (String) media[2], kind = (String) media[3];
            Path archive = directory.resolve(id + ".mp4"), held = directory.resolve(id + ".history-held"); Files.move(archive, held);
            try {
                assertEquals(404, viewer.get(route).status());
                var unavailableResponse = viewer.get(history + "?kind=" + kind); assertEquals(200, unavailableResponse.status(), unavailableResponse.raw().body());
                assertFalse(unavailableResponse.json().path("items").get(0).path("available").asBoolean());
                if (kind.equals("vod")) assertEquals(200, viewer.get(clipState).status(), "An independently archived clip survives source file loss");
            } finally { Files.move(held, archive); }
        }
        String foreign = owner.get(history).json().path("items").get(0).path("id").asString();
        String vodHistory = replay.json().path("item").path("id").asString(), clipHistory = savedClip.json().path("item").path("id").asString();
        long epoch = replay.json().path("epoch").longValue();
        assertEquals(404, viewer.write("POST", history + "/delete", Map.of("ids", java.util.List.of(vodHistory, foreign))).status());
        assertEquals(epoch, viewer.get(vodState).json().path("epoch").longValue()); assertFalse(viewer.get(vodState).json().path("item").isNull());
        assertEquals(204, viewer.write("DELETE", history + "/" + vodHistory, null).status());
        assertEquals("HISTORY_CONFLICT", viewer.write("PUT", vodState, progressBody(replay.json(), 2300, false)).code());
        assertEquals("HISTORY_CONFLICT", viewer.write("PUT", vodState, initialBody).code(), "A delayed first save cannot recreate a deleted row");
        var deleted = viewer.get(vodState).json(); assertTrue(deleted.path("item").isNull()); assertEquals(epoch + 1, deleted.path("epoch").longValue());
        assertEquals(404, viewer.write("DELETE", history + "/" + vodHistory, null).status()); assertEquals(epoch + 1, viewer.get(vodState).json().path("epoch").longValue());
        assertEquals("HISTORY_CONFLICT", viewer.write("PUT", clipState, progressBody(savedClip.json(), 2300, false)).code(), "Deleting any row invalidates all mounted archived recorders");
        assertEquals(204, viewer.write("POST", history + "/delete", Map.of("ids", java.util.List.of(clipHistory))).status());
        UUID removedMedia = UUID.randomUUID(); Path removedArchive = vodDirectory.resolve(removedMedia + ".mp4");
        Files.copy(vodDirectory.resolve(vod + ".mp4"), removedArchive);
        var removedInfo = app.getBean(VodFiles.class).inspect(removedMedia);
        sql.sql("""
                INSERT INTO product_vods(id,channel_id,title,description,status,visibility,duration_ms,size_bytes,archive_modified_ms,archive_key,archive_sha256,published_at_ms,created_at_ms,updated_at_ms)
                SELECT :id,channel_id,title,description,status,visibility,duration_ms,size_bytes,:modified,:key,archive_sha256,published_at_ms,created_at_ms,updated_at_ms FROM product_vods WHERE id=:source
                """).param("id", removedMedia).param("modified", removedInfo.modified()).param("key", removedInfo.key()).param("source", vod).update();
        String removedRoute = history + "/media/vod/" + removedMedia;
        var removedSaved = viewer.write("PUT", removedRoute, progressBody(viewer.get(removedRoute).json(), 1500, false)); assertEquals(200, removedSaved.status());
        sql.sql("DELETE FROM product_vods WHERE id=:id").param("id", removedMedia).update(); Files.delete(removedArchive);
        assertEquals(404, viewer.get(removedRoute).status());
        var unavailable = viewer.get(history + "?kind=vod").json().path("items"); assertEquals(1, unavailable.size());
        assertEquals(removedSaved.json().path("item").path("id").asString(), unavailable.get(0).path("id").asString());
        assertFalse(unavailable.get(0).path("available").asBoolean()); assertEquals("vod-preserved", unavailable.get(0).path("title").asString()); assertEquals(1500, unavailable.get(0).path("positionMs").longValue());
        var beforeClear = viewer.get(vodState).json(); assertEquals(204, viewer.write("DELETE", history, null).status());
        var afterClear = viewer.get(vodState).json(); assertEquals(beforeClear.path("epoch").longValue() + 1, afterClear.path("epoch").longValue());
        assertEquals(204, viewer.write("DELETE", history, null).status());
        var afterEmptyClear = viewer.get(vodState).json(); assertEquals(afterClear.path("epoch").longValue() + 1, afterEmptyClear.path("epoch").longValue());
        assertEquals("HISTORY_CONFLICT", viewer.write("PUT", vodState, progressBody(afterClear, 1200, false)).code());
        assertEquals(0, viewer.get(history).json().path("items").size()); viewer.expectedUserId = null;
        // Fresh intentional visits can save again. Keep both positions for the existing application-restart check.
        var ownerVod = owner.write("PUT", vodState, progressBody(owner.get(vodState).json(), 1600, false)); assertEquals(200, ownerVod.status());
        var ownerClip = owner.write("PUT", clipState, progressBody(owner.get(clipState).json(), 1700, false)); assertEquals(200, ownerClip.status());
        return new ArchivedHistoryState(ownerVod.json().path("item").path("id").asString(), ownerClip.json().path("item").path("id").asString());
    }
    private static Map<String, Object> progressBody(JsonNode state, long position, boolean completed) {
        JsonNode item = state.path("item");
        return progressBody(state.path("epoch").longValue(), item.isNull() ? null : item.path("id").asString(), item.isNull() ? 0 : item.path("version").longValue(), position, completed);
    }
    private static Map<String, Object> progressBody(long epoch, String id, long version, long position, boolean completed) {
        var body = new HashMap<String, Object>(); body.put("epoch", epoch); body.put("id", id); body.put("version", version); body.put("positionMs", position); body.put("completed", completed); return body;
    }
    private static void announceHistory(frame.api.broadcast.BroadcastRegistry registry, String id, String path, String title, String publisher) {
        assertEquals(204, registry.announce(JSON.valueToTree(Map.of("v", 1, "type", "announce", "item", Map.of("id", id, "path", path, "title", title, "publisher", publisher, "width", 0, "height", 0, "fps", 0, "startedAtMs", System.currentTimeMillis()))), 0).status());
    }
    private static String schedules(Browser owner, Browser viewer, Browser anonymous, JdbcClient sql, UUID channel) throws Exception {
        final String path = "/api/v1/me/schedules";
        final long at = System.currentTimeMillis() + 2 * 86_400_000L;
        anonymous.get("/api/v1/session");
        assertEquals(401, anonymous.get(path).status());
        assertEquals(401, anonymous.write("POST", path, Map.of("title", "비로그인 예약", "at", at)).status());
        assertEquals(403, owner.send("POST", path, Map.of("title", "CSRF 확인", "at", at), false, ORIGIN).status());
        assertEquals(403, owner.send("POST", path, Map.of("title", "출처 확인", "at", at), true, "https://outside.invalid").status());
        assertEquals(404, anonymous.get("/api/v1/channels/no-such-channel/schedule").status());
        assertEquals(400, owner.write("POST", path, Map.of("title", "  ", "at", at)).status());
        assertEquals("INVALID_SCHEDULE_TIME", owner.write("POST", path, Map.of("title", "지난 시간", "at", at - 3 * 86_400_000L)).code());
        assertEquals("INVALID_SCHEDULE_TIME", owner.write("POST", path, Map.of("title", "문자열 시각", "at", Long.toString(at))).code());
        assertEquals("INVALID_SCHEDULE_INPUT", owner.write("POST", path, Map.of("title", "타인 채널 지정", "at", at, "channelId", channel)).code());
        var created = owner.write("POST", path, Map.of("title", "  첫 방송 🌱  ", "at", at));
        assertEquals(201, created.status());
        String id = created.json().path("id").asString(); assertDoesNotThrow(() -> UUID.fromString(id));
        assertEquals("첫 방송 🌱", created.json().path("title").asString()); assertEquals(at, created.json().path("at").longValue());
        assertEquals(1, owner.get(path).json().path("items").size()); assertEquals(0, viewer.get(path).json().path("items").size());
        var publicList = anonymous.get("/api/v1/channels/SPRING-OWNER/schedule");
        assertEquals(200, publicList.status()); assertEquals(id, publicList.json().path("items").get(0).path("id").asString());
        assertTrue(publicList.raw().headers().firstValue("cache-control").orElse("").contains("no-store"));
        assertFalse(publicList.json().path("items").get(0).has("channelId")); assertFalse(publicList.json().path("items").get(0).has("ownerId"));
        assertEquals("SCHEDULE_CONFLICT", owner.write("POST", path, Map.of("title", "동일 시간", "at", at)).code());
        assertEquals(404, viewer.write("PATCH", path + "/" + id, Map.of("title", "타인 수정", "at", at + 5000)).status());
        assertEquals(404, viewer.write("DELETE", path + "/" + id, null).status());
        assertEquals(201, viewer.write("POST", path, Map.of("title", "다른 채널은 같은 시간 가능", "at", at)).status());
        var second = owner.write("POST", path, Map.of("title", "두 번째", "at", at + 10000)); assertEquals(201, second.status());
        assertEquals("SCHEDULE_CONFLICT", owner.write("PATCH", path + "/" + id, Map.of("title", "시간 중복 수정", "at", at + 10000)).code());
        var changed = owner.write("PATCH", path + "/" + id, Map.of("title", "저장된 방송 제목", "at", at + 20000));
        assertEquals(200, changed.status()); assertEquals(id, changed.json().path("id").asString()); assertEquals(at + 20000, changed.json().path("at").longValue());
        assertEquals(204, owner.write("DELETE", path + "/" + second.json().path("id").asString(), null).status());
        assertEquals(404, owner.write("DELETE", path + "/" + second.json().path("id").asString(), null).status());
        UUID pastId = UUID.randomUUID();
        sql.sql("INSERT INTO product_broadcast_schedules(id,channel_id,title,starts_at) VALUES(:id,:channel,'지난 예약',current_timestamp - interval '1 day')").param("id", pastId).param("channel", channel).update();
        assertEquals(2, owner.get(path).json().path("items").size()); assertEquals(1, anonymous.get("/api/v1/channels/spring-owner/schedule").json().path("items").size());
        assertEquals("SCHEDULE_PAST", owner.write("PATCH", path + "/" + pastId, Map.of("title", "과거 수정", "at", at)).code());
        assertEquals("SCHEDULE_PAST", owner.write("DELETE", path + "/" + pastId, null).code());
        assertEquals(404, owner.write("PATCH", path + "/" + UUID.randomUUID(), Map.of("title", "없는 예약", "at", at)).status());
        assertEquals("INVALID_SCHEDULE_ID", owner.write("DELETE", path + "/not-a-uuid", null).code());
        // Concurrent requests must still create a single row at one time slot.
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> owner.write("POST", path, Map.of("title", "동시 예약 하나", "at", at + 30000)));
            var next = pool.submit(() -> owner.write("POST", path, Map.of("title", "동시 예약 둘", "at", at + 30000)));
            assertEquals(java.util.Set.of(201, 409), java.util.Set.of(first.get().status(), next.get().status()));
        }
        assertEquals(1, sql.sql("SELECT count(*) FROM product_broadcast_schedules WHERE channel_id=:channel AND starts_at=:at").param("channel", channel)
                .param("at", java.time.OffsetDateTime.ofInstant(java.time.Instant.ofEpochMilli(at + 30000), java.time.ZoneOffset.UTC)).query(Integer.class).single());
        // Bounded owner history must not hide upcoming entries behind a large past history.
        sql.sql("INSERT INTO product_broadcast_schedules(id,channel_id,title,starts_at) SELECT gen_random_uuid(),:channel,'limit-probe',current_timestamp + n * interval '1 minute' FROM generate_series(-150,150) n WHERE n<>0")
                .param("channel", channel).update();
        var bounded = owner.get(path).json().path("items"); assertEquals(200, bounded.size());
        long now = System.currentTimeMillis(); assertEquals(100, bounded.valueStream().filter(item -> item.path("at").longValue() > now).count());
        assertEquals(100, bounded.valueStream().filter(item -> item.path("at").longValue() <= now).count());
        sql.sql("DELETE FROM product_broadcast_schedules WHERE channel_id=:channel AND title='limit-probe'").param("channel", channel).update();
        // All future rows must remain manageable without pagination: cap at 100 under the owner channel lock.
        sql.sql("INSERT INTO product_broadcast_schedules(id,channel_id,title,starts_at) SELECT gen_random_uuid(),:channel,'cap-probe',current_timestamp + n * interval '1 minute' FROM generate_series(1,98) n")
                .param("channel", channel).update();
        var full = owner.write("POST", path, Map.of("title", "상한 초과", "at", at + 40000));
        assertEquals(409, full.status()); assertEquals("SCHEDULE_LIMIT", full.code());
        sql.sql("DELETE FROM product_broadcast_schedules WHERE id=(SELECT id FROM product_broadcast_schedules WHERE channel_id=:channel AND title='cap-probe' ORDER BY starts_at LIMIT 1)").param("channel", channel).update();
        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = pool.submit(() -> owner.write("POST", path, Map.of("title", "cap-api-one", "at", at + 40000)));
            var next = pool.submit(() -> owner.write("POST", path, Map.of("title", "cap-api-two", "at", at + 50000)));
            var firstResult = first.get(); var nextResult = next.get();
            assertEquals(java.util.Set.of(201, 409), java.util.Set.of(firstResult.status(), nextResult.status()));
            assertEquals("SCHEDULE_LIMIT", firstResult.status() == 409 ? firstResult.code() : nextResult.code());
        }
        assertEquals(100, owner.get(path).json().path("items").valueStream().filter(item -> item.path("at").longValue() > System.currentTimeMillis()).count());
        sql.sql("DELETE FROM product_broadcast_schedules WHERE channel_id=:channel AND title IN ('cap-probe','cap-api-one','cap-api-two')").param("channel", channel).update();
        var ordered = anonymous.get("/api/v1/channels/spring-owner/schedule").json().path("items");
        assertEquals(2, ordered.size()); assertTrue(ordered.get(0).path("at").longValue() < ordered.get(1).path("at").longValue());
        return id;
    }
    private static boolean verificationDatabase(String database) {
        if (database == null || !database.startsWith("jdbc:postgresql://")) return false;
        try {
            URI address = URI.create(database.substring(5));
            return "postgresql".equals(address.getScheme()) && "127.0.0.1".equals(address.getHost()) && (address.getPort() == 15432 || address.getPort() == 25432)
                    && address.getRawUserInfo() == null && address.getRawQuery() == null && address.getRawFragment() == null
                    && address.getPath().matches("/frame_product_verify(?:_[a-zA-Z0-9_]+)?");
        } catch (IllegalArgumentException failure) { return false; }
    }
    private static ConfigurableApplicationContext start(Map<String, Object> properties) { SpringApplication app = new SpringApplication(FrameApiApplication.class); app.addInitializers(context -> context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("isolated-product-verification", properties))); return app.run(); }
    private static String base(ConfigurableApplicationContext app) { return "http://127.0.0.1:" + app.getEnvironment().getProperty("local.server.port"); }
    private static Map<String, Object> signup(String email, String handle, String name, String password) { return Map.of("email", email, "handle", handle, "displayName", name, "password", password, "termsAccepted", true, "privacyAccepted", true, "termsVersion", ProductPolicies.TERMS_VERSION, "privacyVersion", ProductPolicies.PRIVACY_VERSION); }
    private record Result(HttpResponse<String> raw, JsonNode json) { int status() { return raw.statusCode(); } String code() { return json.path("code").asString(); } }
    private static final class Browser {
        String base, csrf = "", clientIp, expectedUserId;
        final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        final HttpClient http = HttpClient.newBuilder().cookieHandler(cookies).build();
        Browser(String base) { this.base = base; }
        String cookie() { return cookies.getCookieStore().getCookies().stream().filter(cookie -> cookie.getName().equals("FRAME_SESSION") && !cookie.hasExpired()).map(cookie -> cookie.getName() + "=" + cookie.getValue()).findFirst().orElse(""); }
        Result get(String path) throws Exception { return send("GET", path, null, false, ORIGIN); }
        Result write(String method, String path, Object value) throws Exception { return send(method, path, value, true, ORIGIN); }
        Result send(String method, String path, Object value, boolean includeCsrf, String origin) throws Exception {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path)).header("Origin", origin);
            if (clientIp != null) request.header("X-Forwarded-For", clientIp);
            if (expectedUserId != null) request.header("X-FRAME-USER-ID", expectedUserId);
            if (includeCsrf) request.header("X-CSRF-TOKEN", csrf);
            if (value != null) request.header("Content-Type", "application/json");
            request.method(method, value == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(value)));
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            JsonNode json; try { json = JSON.readTree(response.body()); } catch (RuntimeException ignored) { json = JSON.createObjectNode(); }
            if (json == null) json = JSON.createObjectNode();
            if (json.path("csrfToken").isString()) csrf = json.path("csrfToken").asString();
            return new Result(response, json);
        }
    }
}
