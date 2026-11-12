package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import frame.api.web.ClientAddress;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import tools.jackson.databind.json.JsonMapper;

class AccountSessionRecoveryTest {
    private final Accounts accounts = mock(Accounts.class);
    private final AccountController controller = new AccountController(accounts, JsonMapper.builder().build(), mock(ClientAddress.class),
            new HttpSessionCsrfTokenRepository(), new HttpSessionSecurityContextRepository());

    @AfterEach void clearContext() { SecurityContextHolder.clearContext(); }

    @Test void removedAccountInvalidatesOnlyItsBootstrapSessionThenAllowsAnonymousRetry() {
        UUID user = authenticate();
        var request = new MockHttpServletRequest();
        var previous = (MockHttpSession) request.getSession();
        when(accounts.user(user)).thenThrow(new ProductProblem(401, "UNAUTHENTICATED", "다시 로그인해 주세요."));

        ProductProblem failure = assertThrows(ProductProblem.class, () -> controller.session(request, new MockHttpServletResponse()));
        assertEquals(401, failure.status); assertEquals("UNAUTHENTICATED", failure.code);
        assertTrue(previous.isInvalid()); assertNull(SecurityContextHolder.getContext().getAuthentication());

        var retry = controller.session(request, new MockHttpServletResponse());
        assertEquals(200, retry.getStatusCode().value());
        var body = (Map<?, ?>) retry.getBody(); assertNotNull(body);
        assertNull(body.get("user")); assertNull(body.get("channel"));
        assertFalse(((String) body.get("csrfToken")).isBlank());
        assertNotEquals(previous.getId(), request.getSession().getId());
        verify(accounts, times(1)).user(user);
    }

    @Test void validAccountKeepsItsAuthenticatedSession() {
        UUID user = authenticate();
        var request = new MockHttpServletRequest(); var previous = (MockHttpSession) request.getSession();
        when(accounts.user(user)).thenReturn(Map.of("id", user.toString(), "email", "valid@example.test", "displayName", "정상 계정"));
        when(accounts.own(user)).thenReturn(Map.of("id", UUID.randomUUID().toString()));

        var result = controller.session(request, new MockHttpServletResponse());
        assertEquals(200, result.getStatusCode().value()); assertFalse(previous.isInvalid());
        assertEquals(user.toString(), SecurityContextHolder.getContext().getAuthentication().getPrincipal());
        assertSame(previous, request.getSession(false));
    }

    @Test void transientAccountFailureDoesNotDiscardAuthentication() {
        UUID user = authenticate();
        var request = new MockHttpServletRequest(); var previous = (MockHttpSession) request.getSession();
        when(accounts.user(user)).thenThrow(new ProductProblem(503, "PRODUCT_UNAVAILABLE", "잠시 후 다시 시도해 주세요."));

        var failure = assertThrows(ProductProblem.class, () -> controller.session(request, new MockHttpServletResponse()));
        assertEquals(503, failure.status); assertFalse(previous.isInvalid());
        assertEquals(user.toString(), SecurityContextHolder.getContext().getAuthentication().getPrincipal());
        assertSame(previous, request.getSession(false));
    }

    private static UUID authenticate() {
        UUID user = UUID.randomUUID();
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(user.toString(), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
        SecurityContextHolder.setContext(context); return user;
    }
}
