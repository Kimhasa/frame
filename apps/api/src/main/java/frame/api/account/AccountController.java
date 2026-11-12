package frame.api.account;

import frame.api.web.ClientAddress;
import frame.api.web.RateLimit;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@RestController
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class AccountController {
    private final Accounts accounts;
    private final JsonMapper json;
    private final ClientAddress client;
    private final HttpSessionCsrfTokenRepository csrf;
    private final HttpSessionSecurityContextRepository contexts;
    private final RateLimit loginRate = new RateLimit(15, 0.25), registerRate = new RateLimit(8, 0.02), proofRate = new RateLimit(8, 0.1);
    public AccountController(Accounts accounts, JsonMapper json, ClientAddress client, HttpSessionCsrfTokenRepository csrf, HttpSessionSecurityContextRepository contexts) {
        this.accounts = accounts; this.json = json; this.client = client; this.csrf = csrf; this.contexts = contexts;
    }
    @GetMapping("/api/v1/session") public ResponseEntity<Object> session(HttpServletRequest request, HttpServletResponse response) {
        try { return ok(200, sessionBody(request, response)); }
        catch (ProductProblem failure) {
            // A removed account must not leave a valid Redis session trapping every bootstrap retry in 401.
            if (failure.status == 401 && failure.code.equals("UNAUTHENTICATED")) {
                var session = request.getSession(false); if (session != null) session.invalidate();
                SecurityContextHolder.clearContext();
            }
            throw failure;
        }
    }
    @GetMapping("/api/v1/policies") public ResponseEntity<Object> policies() { return ok(200, ProductPolicies.documents()); }
    @PostMapping("/api/v1/auth/register") public ResponseEntity<Object> register(HttpServletRequest request, HttpServletResponse response) {
        limited(registerRate, client.ip(request));
        if (viewer() != null) throw new ProductProblem(409, "ALREADY_AUTHENTICATED", "이미 로그인되어 있어요.");
        var account = accounts.register(body(request)); authenticate(account.id(), false, request, response); return ok(201, sessionBody(request, response));
    }
    @PostMapping("/api/v1/auth/login") public ResponseEntity<Object> login(HttpServletRequest request, HttpServletResponse response) {
        limited(loginRate, client.ip(request)); JsonNode value = body(request);
        if (value.has("remember") && !value.path("remember").isBoolean()) throw new ProductProblem(400, "INVALID_INPUT", "로그인 설정을 확인해 주세요.");
        var account = accounts.login(value); authenticate(account.id(), value.path("remember").isBoolean() && value.path("remember").booleanValue(), request, response); return ok(200, sessionBody(request, response));
    }
    @PostMapping("/api/v1/auth/logout") public ResponseEntity<Object> logout(HttpServletRequest request, HttpServletResponse response) {
        var session = request.getSession(false); if (session != null) session.invalidate(); SecurityContextHolder.clearContext();
        return ResponseEntity.noContent().header("Cache-Control", "no-store").build();
    }
    @GetMapping("/api/v1/channels/{handle}") public ResponseEntity<Object> channel(@PathVariable String handle) { return ok(200, accounts.channel(handle, viewer())); }
    @GetMapping("/api/v1/channel-ids/{channelId}") public ResponseEntity<Object> channelId(@PathVariable String channelId) { return ok(200, accounts.channel(id(channelId), viewer())); }
    @GetMapping("/api/v1/channels") public ResponseEntity<Object> directory(@RequestParam(defaultValue = "") String query, @RequestParam(defaultValue = "50") int limit) { return ok(200, accounts.directory(query, limit, viewer())); }
    @GetMapping("/api/v1/me/follows") public ResponseEntity<Object> follows() { return ok(200, accounts.follows(required())); }
    @PutMapping("/api/v1/me/follows/{channelId}") public ResponseEntity<Object> follow(@PathVariable String channelId, HttpServletRequest request) { return ok(200, accounts.follow(required(), id(channelId), body(request))); }
    @DeleteMapping("/api/v1/me/follows/{channelId}") public ResponseEntity<Object> unfollow(@PathVariable String channelId) { return ok(200, accounts.unfollow(required(), id(channelId))); }
    @PatchMapping("/api/v1/me/channel") public ResponseEntity<Object> editChannel(HttpServletRequest request) { return ok(200, accounts.editChannel(required(), body(request))); }
    @PatchMapping("/api/v1/me/profile") public ResponseEntity<Object> profile(HttpServletRequest request, HttpServletResponse response) { accounts.profile(required(), body(request)); return ok(200, sessionBody(request, response)); }
    @PostMapping("/api/v1/me/channel/connection") public ResponseEntity<Object> connect(HttpServletRequest request) { UUID user = required(); limited(proofRate, user.toString()); return ok(200, accounts.connect(user, body(request))); }
    @GetMapping("/api/v1/studio") public ResponseEntity<Object> studio() { return ok(200, accounts.studio(required())); }
    @PutMapping("/api/v1/studio") public ResponseEntity<Object> studio(HttpServletRequest request) { return ok(200, accounts.editStudio(required(), body(request))); }
    @PatchMapping("/api/v1/studio") public ResponseEntity<Object> patchStudio(HttpServletRequest request) { return studio(request); }
    @RequestMapping("/api/v1/{*unmatched}") public ResponseEntity<Object> unavailable() { throw new ProductProblem(404, "NOT_FOUND", "요청한 기능을 찾을 수 없어요."); }
    private Map<String, Object> sessionBody(HttpServletRequest request, HttpServletResponse response) {
        UUID user = viewer(); Map<String, Object> out = new LinkedHashMap<>(); out.put("user", user == null ? null : accounts.user(user)); out.put("channel", user == null ? null : accounts.own(user));
        out.put("csrfToken", csrf.loadDeferredToken(request, response).get().getToken()); return out;
    }
    private void authenticate(UUID user, boolean remember, HttpServletRequest request, HttpServletResponse response) {
        request.getSession(); request.changeSessionId();
        var session = request.getSession(); session.setAttribute(AccountSecurity.REMEMBER, remember); session.setAttribute(AccountSecurity.LOGIN_AT, System.currentTimeMillis());
        session.setMaxInactiveInterval(remember ? AccountSecurity.LONG_SECONDS : AccountSecurity.SHORT_SECONDS);
        var context = SecurityContextHolder.createEmptyContext(); context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(user.toString(), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
        SecurityContextHolder.setContext(context); contexts.saveContext(context, request, response);
        csrf.saveToken(csrf.generateToken(request), request, response);
    }
    private JsonNode body(HttpServletRequest request) {
        return ProductRequests.body(request, json);
    }
    static UUID viewer() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated() || !(authentication.getPrincipal() instanceof String principal) || principal.equals("anonymousUser")) return null;
        try { return UUID.fromString(principal); } catch (IllegalArgumentException failure) { return null; }
    }
    private UUID required() { UUID user = viewer(); if (user == null) throw new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요."); return user; }
    private static UUID id(String value) {
        if (!value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw new ProductProblem(400, "INVALID_CHANNEL_ID", "채널 주소를 확인해 주세요.");
        return UUID.fromString(value);
    }
    private void limited(RateLimit rate, String key) { if (rate.take(key) > 0) throw new ProductProblem(429, "RATE_LIMITED", "잠시 후 다시 시도해 주세요."); }
    private static ResponseEntity<Object> ok(int status, Object body) { return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control", "no-store").body(body); }
}
