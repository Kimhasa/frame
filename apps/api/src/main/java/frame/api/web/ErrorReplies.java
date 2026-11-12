package frame.api.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Refusals Spring raises itself get the Node relay's plain answers (405 "Method not allowed", 404 "Not found", 500
 * "Internal error") instead of Boot's JSON error body, whose "error" key the React adapter would read as an error code.
 * An answer that fails after it started is not completed with an error text: its connection is aborted (Replies.abort).
 */
@RestControllerAdvice
public class ErrorReplies {
    private static final Logger log = LoggerFactory.getLogger(ErrorReplies.class);

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Object> method() {
        return Replies.text(405, "Method not allowed");
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Object> notFound() {
        return Replies.text(404, "Not found");
    }

    @ExceptionHandler(RuntimeException.class)
    public ResponseEntity<Object> internal(RuntimeException e, HttpServletRequest req, HttpServletResponse res) {
        if (LogOnce.allow("err " + e.getClass().getName())) log.error("request failed", e);
        // An answer already on its way (media, a playlist) cannot become a 500: appending the error text would corrupt it.
        if (res.isCommitted()) { Replies.abort(req, res); return null; }
        return Replies.text(500, "Internal error");
    }
}
