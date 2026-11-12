package frame.api.account;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice(basePackageClasses = AccountController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class ProductErrors {
    @ExceptionHandler(ProductProblem.class) public ResponseEntity<Object> refusal(ProductProblem failure) { return failure.response(); }
    @ExceptionHandler(MethodArgumentTypeMismatchException.class) public ResponseEntity<Object> argument() { return new ProductProblem(400, "INVALID_QUERY", "요청 조건을 확인해 주세요.").response(); }
    @ExceptionHandler(DataAccessException.class) public ResponseEntity<Object> database() { return new ProductProblem(503, "PRODUCT_UNAVAILABLE", "계정 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요.").response(); }
    @ExceptionHandler(RuntimeException.class) public ResponseEntity<Object> unexpected() { return new ProductProblem(500, "INTERNAL_ERROR", "요청을 처리하지 못했어요.").response(); }
}
