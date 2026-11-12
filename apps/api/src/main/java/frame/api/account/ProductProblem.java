package frame.api.account;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.json.JsonMapper;

public final class ProductProblem extends RuntimeException {
    final int status;
    final String code;
    private final Integer retryAfterSeconds;
    public ProductProblem(int status, String code, String detail) { this(status, code, detail, null); }
    ProductProblem(int status, String code, String detail, Integer retryAfterSeconds) { super(detail); this.status = status; this.code = code; this.retryAfterSeconds = retryAfterSeconds; }
    public Map<String, Object> body() { return Map.of("type", "about:blank", "title", getMessage(), "status", status, "code", code, "detail", getMessage()); }
    public ResponseEntity<Object> response() {
        var response = ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).header("Cache-Control", "no-store");
        if (retryAfterSeconds != null) response.header("Retry-After", retryAfterSeconds.toString());
        return response.body(body());
    }
    public void write(HttpServletResponse response, JsonMapper json) throws IOException {
        response.setStatus(status); response.setContentType("application/problem+json;charset=UTF-8"); response.setHeader("Cache-Control", "no-store");
        if (retryAfterSeconds != null) response.setHeader("Retry-After", retryAfterSeconds.toString());
        response.getOutputStream().write(json.writeValueAsBytes(body()));
    }
}
