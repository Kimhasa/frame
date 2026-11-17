package frame.api.account;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The same bounded JSON body contract for product account and schedule writes. */
final class ProductRequests {
    private ProductRequests() {}
    static JsonNode body(HttpServletRequest request, JsonMapper json) {
        return body(request,json,8192);
    }
    static JsonNode body(HttpServletRequest request,JsonMapper json,int limit){
        if(limit!=8192&&limit!=16384&&limit!=65536)throw new IllegalArgumentException("Unsupported product body limit");
        if (request.getContentType() == null || !request.getContentType().toLowerCase(java.util.Locale.ROOT).matches("application/json(?:\\s*;.*)?")) throw new ProductProblem(415, "JSON_REQUIRED", "JSON 형식으로 요청해 주세요.");
        if (request.getContentLengthLong() > limit) throw new ProductProblem(413, "BODY_TOO_LARGE", "요청 내용이 너무 길어요.");
        try {
            byte[] bytes = request.getInputStream().readNBytes(limit+1); if (bytes.length > limit) throw new ProductProblem(413, "BODY_TOO_LARGE", "요청 내용이 너무 길어요.");
            JsonNode value = json.readTree(bytes); if (value == null || !value.isObject()) throw new ProductProblem(400, "INVALID_JSON", "입력 내용을 확인해 주세요."); return value;
        } catch (ProductProblem failure) { throw failure; }
        catch (IOException | RuntimeException failure) { throw new ProductProblem(400, "INVALID_JSON", "입력 내용을 확인해 주세요."); }
    }
}
