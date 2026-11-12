package frame.api.mediamtx;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * A MediaMTX request with a deadline for the whole exchange, body included. The JDK client's {@code HttpRequest.timeout}
 * stops at the response headers and the client has no read timeout, so a MediaMTX that stalls mid-body would hold the
 * caller forever (the Node relay's sockets time out after their idle limit).
 */
public final class Deadline {
    private Deadline() {}

    public static <T> HttpResponse<T> send(HttpClient http, HttpRequest req, HttpResponse.BodyHandler<T> body, Duration limit) throws Exception {
        CompletableFuture<HttpResponse<T>> exchange = http.sendAsync(req, body);
        try {
            return exchange.get(limit.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            exchange.cancel(true);
            throw new HttpTimeoutException("MediaMTX did not answer within " + limit.toMillis() + " ms");
        } catch (ExecutionException e) {
            throw e.getCause() instanceof Exception cause ? cause : e;
        } catch (InterruptedException e) {
            exchange.cancel(true);
            throw e;
        }
    }
}
