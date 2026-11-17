package frame.api.account;

import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.hc.client5.http.DnsResolver;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.config.ConnectionConfig;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.config.TlsConfig;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.ManagedHttpClientConnectionFactory;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManagerBuilder;
import org.apache.hc.client5.http.protocol.HttpClientContext;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.http.config.Http1Config;
import org.apache.hc.core5.http.io.entity.ByteArrayEntity;
import org.apache.hc.core5.util.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** One bounded POST, with validated addresses pinned to the original TLS host. No cookies, proxy, redirects or retries. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class WebhookSender {
    public record Result(Integer httpStatus, String errorCode) {}
    @FunctionalInterface interface Lookup { InetAddress[] resolve(String host) throws UnknownHostException; }
    private final String localTestUrl;
    private final Lookup lookup;
    private final Set<HttpPost> activeRequests=ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed=new AtomicBoolean();
    private final ThreadPoolExecutor dns = new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(1),
            task -> { Thread thread=new Thread(task,"webhook-dns");thread.setDaemon(true);return thread; },new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService deadline = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread=new Thread(task,"webhook-deadline");thread.setDaemon(true);return thread;
    });

    @Autowired public WebhookSender(@Value("${frame.product.webhook-local-test-url:${FRAME_PRODUCT_WEBHOOK_LOCAL_TEST_URL:}}") String localTestUrl) {
        this(localTestUrl,InetAddress::getAllByName);
    }
    WebhookSender(String localTestUrl, Lookup lookup) {
        this.lookup=lookup;
        this.localTestUrl=localTestUrl==null||localTestUrl.isBlank()?null:trustedLocal(localTestUrl);
    }
    @PreDestroy public void close() { closed.set(true);activeRequests.forEach(HttpPost::cancel);dns.shutdownNow();deadline.shutdownNow(); }

    private static String trustedLocal(String input) {
        try {
            URI uri=new URI(input.strip());
            if(!"http".equals(uri.getScheme())||!"127.0.0.1".equals(uri.getHost())||uri.getPort()<1024||uri.getPort()>65535
                    ||uri.getRawUserInfo()!=null||uri.getRawFragment()!=null||uri.getRawQuery()!=null||uri.getRawPath()==null||!uri.getRawPath().startsWith("/")
                    ||uri.getRawPath().isEmpty()||input.length()>2048||input.codePoints().anyMatch(Character::isISOControl)) throw new IllegalArgumentException();
            return uri.normalize().toASCIIString();
        } catch(Exception invalid) { throw new IllegalArgumentException("Trusted local webhook endpoint configuration is invalid"); }
    }
    public String canonicalUrl(String input) {
        if(input==null||input.length()>2048||input.codePoints().anyMatch(Character::isISOControl))throw invalidUrl();
        try {
            URI uri=new URI(input.strip()).normalize();
            String host=uri.getHost();
            if(host==null||uri.getRawUserInfo()!=null||uri.getRawFragment()!=null||uri.getRawAuthority().contains("%")
                    ||uri.isOpaque()||uri.toString().matches("(?is).*%0[ad].*"))throw invalidUrl();
            String path=uri.getRawPath()==null||uri.getRawPath().isEmpty()?"/":uri.getRawPath();
            host=host.toLowerCase(Locale.ROOT);
            String canonical=uri.getScheme().toLowerCase(Locale.ROOT)+"://"+host+(uri.getPort()<0||uri.getPort()==443&&"https".equalsIgnoreCase(uri.getScheme())?"":":"+uri.getPort())+path
                    +(uri.getRawQuery()==null?"":"?"+uri.getRawQuery());
            if(canonical.equals(localTestUrl))return canonical;
            if(!"https".equalsIgnoreCase(uri.getScheme())||(uri.getPort()!=-1&&uri.getPort()!=443))throw invalidUrl();
            String bare=bareHost(host);
            if(bare.contains(":")) { if(!publicAddress(InetAddress.getByName(bare)))throw invalidUrl(); }
            else if(bare.matches("[0-9.]+")) {
                if(!bare.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")||!publicAddress(InetAddress.getByName(bare)))throw invalidUrl();
                for(String part:bare.split("\\."))if(part.length()>1&&part.startsWith("0"))throw invalidUrl();
            } else {
                if(bare.length()>253||!bare.contains(".")||bare.endsWith(".")||bare.matches("(?i).*(?:\\.localhost|\\.local|\\.internal|\\.invalid|\\.test)$"))throw invalidUrl();
                for(String label:bare.split("\\."))if(!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"))throw invalidUrl();
            }
            return canonical;
        } catch(ProductProblem failure) { throw failure; }
        catch(Exception failure) { throw invalidUrl(); }
    }
    private static ProductProblem invalidUrl() {
        return new ProductProblem(400,"INVALID_WEBHOOK_URL","사용자 정보나 # 없이 공개 HTTPS(443) 주소를 입력해 주세요. 내부 주소에는 전송할 수 없어요.");
    }
    private static String bareHost(String host) { return host.startsWith("[")&&host.endsWith("]")?host.substring(1,host.length()-1):host; }

    static boolean publicAddress(InetAddress address) {
        if(address.isAnyLocalAddress()||address.isLoopbackAddress()||address.isLinkLocalAddress()||address.isSiteLocalAddress()||address.isMulticastAddress())return false;
        byte[] bytes=address.getAddress();
        int a=bytes[0]&255,b=bytes[1]&255;
        if(bytes.length==4) {
            int c=bytes[2]&255;
            return !(a==0||a==10||a==127||a>=224||a==100&&b>=64&&b<=127||a==169&&b==254||a==172&&b>=16&&b<=31
                    ||a==192&&(b==168||b==0&&(c==0||c==2)||b==88&&c==99)||a==198&&(b==18||b==19||b==51&&c==100)||a==203&&b==0&&c==113);
        }
        // Allow ordinary global unicast only, excluding documentation and transition/tunnel ranges.
        return bytes.length==16&&(a&0xe0)==0x20&&!(a==0x20&&b==0x01&&((bytes[2]&255)<2||bytes[2]==0x0d&&(bytes[3]&255)==0xb8))
                &&!(a==0x20&&b==0x02)&&!(a==0x3f&&b==0xff&&(bytes[2]&0xf0)==0);
    }
    InetAddress[] resolveForDelivery(URI uri) throws Exception {
        if(uri.toASCIIString().equals(localTestUrl))return new InetAddress[]{InetAddress.getByAddress(new byte[]{127,0,0,1})};
        dns.purge();
        Future<InetAddress[]> future=dns.submit(()->lookup.resolve(bareHost(uri.getHost())));
        InetAddress[] addresses;
        try { addresses=future.get(1500,TimeUnit.MILLISECONDS); }
        finally { if(!future.isDone())future.cancel(true); }
        if(addresses==null||addresses.length==0)throw new UnknownHostException();
        for(InetAddress address:addresses)if(address==null||!publicAddress(address))throw new BlockedTarget();
        return Arrays.copyOf(addresses,Math.min(4,addresses.length));
    }
    static DnsResolver pinnedResolver(String host, InetAddress[] addresses) {
        String expected=bareHost(host).toLowerCase(Locale.ROOT);InetAddress[] pinned=addresses.clone();
        return new DnsResolver() {
            @Override public InetAddress[] resolve(String requested) throws UnknownHostException {
                if(!bareHost(requested).equalsIgnoreCase(expected))throw new UnknownHostException();return pinned.clone();
            }
            @Override public String resolveCanonicalHostname(String requested) throws UnknownHostException {
                if(!bareHost(requested).equalsIgnoreCase(expected))throw new UnknownHostException();return expected;
            }
        };
    }
    static String signature(byte[] secret,long timestamp,byte[] body) throws GeneralSecurityException {
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret,"HmacSHA256"));
        mac.update((timestamp+".").getBytes(StandardCharsets.US_ASCII));return "sha256="+HexFormat.of().formatHex(mac.doFinal(body));
    }
    public Result send(String url,byte[] secret,UUID eventId,String event,long timestampSeconds,byte[] body) {
        long started=System.nanoTime();
        if(closed.get())return new Result(null,"INTERRUPTED");
        if(secret==null||secret.length!=32||eventId==null||timestampSeconds<=0||body==null||body.length>65536
                ||event==null||!Set.of("webhook.test","broadcast.started","broadcast.ended").contains(event))return new Result(null,"INVALID_PAYLOAD");
        HttpPost post=null;java.util.concurrent.ScheduledFuture<?> alarm=null;AtomicBoolean expired=new AtomicBoolean();
        try {
            URI uri=URI.create(canonicalUrl(url));InetAddress[] addresses=resolveForDelivery(uri);
            if(closed.get())return new Result(null,"INTERRUPTED");
            var manager=PoolingHttpClientConnectionManagerBuilder.create().setDnsResolver(pinnedResolver(uri.getHost(),addresses))
                    .setMaxConnTotal(1).setMaxConnPerRoute(1)
                    .setConnectionFactory(ManagedHttpClientConnectionFactory.builder().http1Config(Http1Config.custom().setMaxLineLength(8192).setMaxHeaderCount(64).build()).build())
                    .setDefaultConnectionConfig(ConnectionConfig.custom().setConnectTimeout(Timeout.ofMilliseconds(1500)).setSocketTimeout(Timeout.ofSeconds(2)).build())
                    .setDefaultTlsConfig(TlsConfig.custom().setHandshakeTimeout(Timeout.ofMilliseconds(1500)).build()).build();
            try(var client=HttpClients.custom().setConnectionManager(manager).disableRedirectHandling().disableAutomaticRetries().disableCookieManagement().disableContentCompression()
                    .setConnectionReuseStrategy((request,response,context)->false).setUserAgent("FRAME-Webhooks/1.0").build()) {
                post=new HttpPost(uri);HttpPost active=post;activeRequests.add(post);
                post.setConfig(RequestConfig.custom().setRedirectsEnabled(false).setConnectionRequestTimeout(Timeout.ofMilliseconds(300)).setResponseTimeout(Timeout.ofSeconds(2)).build());
                post.setHeader("Connection","close");post.setHeader("X-Frame-Event-Id",eventId.toString());post.setHeader("X-Frame-Event",event);
                post.setHeader("X-Frame-Timestamp",Long.toString(timestampSeconds));post.setHeader("X-Frame-Signature",signature(secret,timestampSeconds,body));
                post.setEntity(new ByteArrayEntity(body,ContentType.APPLICATION_JSON));
                long remaining=Math.max(1,5000-TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started));
                alarm=deadline.schedule(()->{expired.set(true);active.cancel();},remaining,TimeUnit.MILLISECONDS);
                var response=client.executeOpen(null,post,HttpClientContext.create());
                int status=response.getCode();post.cancel(); // Never read, store, decompress, or drain an untrusted response body.
                try { response.close(); } catch(IOException discardedBody) { /* Headers already determine this one-attempt result. */ }
                if(status<100||status>599)return new Result(null,"INVALID_RESPONSE");
                return new Result(status,status>=200&&status<300?null:"HTTP_ERROR");
            }
        } catch(ProductProblem|BlockedTarget failure) { return new Result(null,"TARGET_BLOCKED"); }
        catch(TimeoutException|SocketTimeoutException failure) { return new Result(null,"TIMEOUT"); }
        catch(ExecutionException|UnknownHostException failure) { return new Result(null,"DNS_FAILED"); }
        catch(InterruptedException failure) { Thread.currentThread().interrupt();return new Result(null,"INTERRUPTED"); }
        catch(Exception failure) { return new Result(null,expired.get()?"TIMEOUT":"NETWORK_ERROR"); }
        finally { if(alarm!=null)alarm.cancel(false);if(post!=null){activeRequests.remove(post);post.cancel();} }
    }
    static final class BlockedTarget extends IOException {}
}
