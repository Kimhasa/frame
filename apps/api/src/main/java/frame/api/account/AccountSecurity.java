package frame.api.account;

import frame.api.web.ClientAddress;
import frame.api.web.RateLimit;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.web.servlet.DelegatingFilterProxyRegistrationBean;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.dao.DataAccessException;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ProductProperties.class)
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class AccountSecurity {
    static final String REMEMBER = "frame.product.remember";
    static final String LOGIN_AT = "frame.product.loginAt";
    static final int SHORT_SECONDS = 12 * 3600, LONG_SECONDS = 30 * 24 * 3600;
    @Bean static BeanPostProcessor productSessionMapping() {
        return new BeanPostProcessor() {
            @Override public Object postProcessBeforeInitialization(Object bean, String name) {
                if (name.equals("sessionRepositoryFilterRegistration") && bean instanceof DelegatingFilterProxyRegistrationBean registration)
                    registration.setUrlPatterns(java.util.List.of("/api/v1/*"));
                return bean;
            }
        };
    }
    @Bean FilterRegistrationBean<OncePerRequestFilter> productSessionAvailability(JsonMapper json) {
        OncePerRequestFilter filter = new OncePerRequestFilter() {
            @Override protected boolean shouldNotFilterAsyncDispatch() { return false; }
            @Override protected boolean shouldNotFilterErrorDispatch() { return false; }
            @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws IOException, ServletException {
                try { chain.doFilter(request, response); }
                catch (DataAccessException failure) {
                    SecurityContextHolder.clearContext();
                    if (response.isCommitted()) { frame.api.web.Replies.abort(request, response); return; }
                    response.resetBuffer();
                    new ProductProblem(503, "PRODUCT_UNAVAILABLE", "계정 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요.").write(response, json);
                }
            }
        };
        FilterRegistrationBean<OncePerRequestFilter> registration = new FilterRegistrationBean<>(filter);
        registration.setName("productSessionAvailability"); registration.setUrlPatterns(java.util.List.of("/api/v1/*"));
        registration.setDispatcherTypes(jakarta.servlet.DispatcherType.REQUEST, jakarta.servlet.DispatcherType.ASYNC, jakarta.servlet.DispatcherType.ERROR);
        registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER - 1);
        return registration;
    }
    @Bean PasswordEncoder productPasswords() {
        // JDK-provided PBKDF2 supports the complete 10..128-character input without bcrypt's byte truncation limit.
        return new DelegatingPasswordEncoder("pbkdf2@SpringSecurity_v5_8", java.util.Map.of("pbkdf2@SpringSecurity_v5_8", Pbkdf2PasswordEncoder.defaultsForSpringSecurity_v5_8()));
    }
    @Bean UserDetailsService productUsers(AccountRepository accounts) {
        return email -> accounts.email(email).map(account -> User.withUsername(account.id().toString()).password(account.passwordHash()).roles("USER").build())
                .orElseThrow(() -> new UsernameNotFoundException("Account not found"));
    }
    @Bean HttpSessionSecurityContextRepository productContexts() { return new HttpSessionSecurityContextRepository(); }
    @Bean HttpSessionCsrfTokenRepository productCsrf() { return new HttpSessionCsrfTokenRepository(); }
    @Bean CookieSerializer cookieSerializer(ProductProperties props) {
        DefaultCookieSerializer delegate = new DefaultCookieSerializer();
        delegate.setCookieName("FRAME_SESSION"); delegate.setCookiePath("/"); delegate.setUseHttpOnlyCookie(true); delegate.setSameSite("Lax");
        if (props.cookieSecure()) delegate.setUseSecureCookie(true);
        return new CookieSerializer() {
            @Override public java.util.List<String> readCookieValues(HttpServletRequest request) { return delegate.readCookieValues(request); }
            @Override public void writeCookieValue(CookieValue value) {
                var session = value.getRequest().getSession(false);
                if (session != null && !value.getCookieValue().isEmpty() && Boolean.TRUE.equals(session.getAttribute(REMEMBER))) value.setCookieMaxAge(LONG_SECONDS);
                delegate.writeCookieValue(value);
            }
        };
    }
    @Bean SecurityFilterChain productSecurity(HttpSecurity http, ProductProperties props, HttpSessionCsrfTokenRepository csrf,
                                              HttpSessionSecurityContextRepository contexts, JsonMapper json, ClientAddress client) throws Exception {
        http.securityMatcher("/api/v1/**")
                .authorizeHttpRequests(auth -> auth.requestMatchers(org.springframework.http.HttpMethod.GET, "/api/v1/session", "/api/v1/policies", "/api/v1/channels", "/api/v1/channels/*", "/api/v1/channels/*/schedule", "/api/v1/channel-ids/*", "/api/v1/polls/current", "/api/v1/questions/current", "/api/v1/rewards/current").permitAll()
                        .requestMatchers(org.springframework.http.HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login").permitAll().anyRequest().authenticated())
                .csrf(config -> config.csrfTokenRepository(csrf).csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
                .securityContext(config -> config.securityContextRepository(contexts))
                .sessionManagement(config -> config.sessionFixation(fixation -> fixation.changeSessionId()))
                .requestCache(AbstractHttpConfigurer::disable).httpBasic(AbstractHttpConfigurer::disable).formLogin(AbstractHttpConfigurer::disable).logout(AbstractHttpConfigurer::disable)
                .exceptionHandling(errors -> errors.authenticationEntryPoint((request, response, failure) -> new ProductProblem(401, "UNAUTHENTICATED", "로그인이 필요해요.").write(response, json))
                        .accessDeniedHandler((request, response, failure) -> new ProductProblem(403, failure instanceof CsrfException ? "CSRF_INVALID" : "FORBIDDEN", failure instanceof CsrfException ? "화면을 새로고침한 뒤 다시 시도해 주세요." : "이 요청에 대한 권한이 없어요.").write(response, json)))
                .addFilterBefore(new ProductGuard(props, client, json), CsrfFilter.class);
        return http.build();
    }
    private static final class ProductGuard extends OncePerRequestFilter {
        private final ProductProperties props;
        private final ClientAddress client;
        private final JsonMapper json;
        private final RateLimit sessions = new RateLimit(120, 2);
        ProductGuard(ProductProperties props, ClientAddress client, JsonMapper json) { this.props = props; this.client = client; this.json = json; }
        @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws IOException, ServletException {
            String origin = request.getHeader("Origin");
            if (origin != null && !origin.equals(props.publicOrigin())) { new ProductProblem(403, "ORIGIN_FORBIDDEN", "이 출처의 요청은 허용하지 않아요.").write(response, json); return; }
            if (request.getRequestURI().equals("/api/v1/session") && sessions.take(client.ip(request)) > 0) { response.setHeader("Retry-After", "1"); new ProductProblem(429, "RATE_LIMITED", "잠시 후 다시 시도해 주세요.").write(response, json); return; }
            var session = request.getSession(false);
            if (session != null && session.getAttribute(LOGIN_AT) instanceof Long at) {
                long lifetime = Boolean.TRUE.equals(session.getAttribute(REMEMBER)) ? LONG_SECONDS : SHORT_SECONDS;
                if (System.currentTimeMillis() - at >= lifetime * 1000) { session.invalidate(); org.springframework.security.core.context.SecurityContextHolder.clearContext(); }
            }
            response.setHeader("Cache-Control", "no-store");
            chain.doFilter(request, response);
        }
    }
}
