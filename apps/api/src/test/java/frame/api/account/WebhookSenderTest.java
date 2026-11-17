package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpServer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class WebhookSenderTest {
    private static final UUID EVENT=UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final byte[] BODY=("{\"id\":\""+EVENT+"\",\"event\":\"webhook.test\"}").getBytes(StandardCharsets.UTF_8);
    private static byte[] key(){byte[] key=new byte[32];Arrays.fill(key,(byte)7);return key;}

    @Test void registrationAllowsPublicHttpsOnlyAndPreservesRawPathWithoutDoubleEncoding() {
        try(var sender=new SenderFixture("")) {
            assertEquals("https://hooks.example.com/",sender.value.canonicalUrl("HTTPS://HOOKS.example.com:443"));
            assertEquals("https://hooks.example.com/a%2Fb?q=x%2Fy",sender.value.canonicalUrl("https://hooks.example.com/a%2Fb?q=x%2Fy"));
            for(String url:new String[]{"http://hooks.example.com/","https://user:pass@hooks.example.com/","https://hooks.example.com/#fragment",
                    "https://127.0.0.1/","https://localhost/","https://[::1]/","https://169.254.169.254/latest/meta-data/","https://100.64.0.1/",
                    "https://192.0.2.1/","https://198.18.0.1/","https://[2001:db8::1]/","https://[64:ff9b::7f00:1]/","https://[::ffff:127.0.0.1]/",
                    "https://2130706433/","https://0177.0.0.1/","https://hooks.example.com:22/","https://hooks.example.com/%0d%0aX:bad"}) {
                ProductProblem problem=assertThrows(ProductProblem.class,()->sender.value.canonicalUrl(url),url);
                assertEquals("INVALID_WEBHOOK_URL",problem.code);
            }
        }
    }
    @Test void mixedOrReboundDnsCannotReachAPrivateAddressAndValidatedAddressesStayPinned() throws Exception {
        AtomicInteger lookups=new AtomicInteger();
        WebhookSender.Lookup lookup=host->{int attempt=lookups.incrementAndGet();return new InetAddress[]{InetAddress.getByName(attempt==1?"8.8.8.8":"127.0.0.1")};};
        try(var sender=new SenderFixture(new WebhookSender("",lookup))) {
            URI uri=URI.create(sender.value.canonicalUrl("https://hooks.example.com/"));
            InetAddress[] pinned=sender.value.resolveForDelivery(uri);
            var resolver=WebhookSender.pinnedResolver(uri.getHost(),pinned);
            assertEquals("8.8.8.8",resolver.resolve(uri.getHost())[0].getHostAddress());
            assertEquals("8.8.8.8",resolver.resolve(uri.getHost(),443).getFirst().getAddress().getHostAddress());
            assertEquals(1,lookups.get(),"The transport resolver never asks DNS a second time");
            assertThrows(java.net.UnknownHostException.class,()->resolver.resolve("different.example.com"));
            assertThrows(WebhookSender.BlockedTarget.class,()->sender.value.resolveForDelivery(uri));
        }
        try(var sender=new SenderFixture(new WebhookSender("",host->new InetAddress[]{InetAddress.getByName("1.1.1.1"),InetAddress.getByName("10.0.0.1")}))) {
            assertEquals("TARGET_BLOCKED",sender.value.send("https://hooks.example.com/",key(),EVENT,"webhook.test",1700000000,BODY).errorCode());
        }
    }
    @Test void realPostUsesExactBodyAndKnownHmacWithoutFollowingRedirectsOrReadingRemoteBodies() throws Exception {
        AtomicReference<String> mode=new AtomicReference<>("success"),signature=new AtomicReference<>(),received=new AtomicReference<>();
        AtomicInteger requests=new AtomicInteger(),redirected=new AtomicInteger();
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        var executor=Executors.newVirtualThreadPerTaskExecutor();server.setExecutor(executor);
        server.createContext("/trap",exchange->{redirected.incrementAndGet();exchange.sendResponseHeaders(204,-1);exchange.close();});
        server.createContext("/hook",exchange->{
            try {
                requests.incrementAndGet();signature.set(exchange.getRequestHeaders().getFirst("X-Frame-Signature"));
                received.set(new String(exchange.getRequestBody().readNBytes(65537),StandardCharsets.UTF_8));
                assertEquals(EVENT.toString(),exchange.getRequestHeaders().getFirst("X-Frame-Event-Id"));
                assertEquals("webhook.test",exchange.getRequestHeaders().getFirst("X-Frame-Event"));
                assertEquals("1700000000",exchange.getRequestHeaders().getFirst("X-Frame-Timestamp"));
                assertNull(exchange.getRequestHeaders().getFirst("Cookie"));assertNull(exchange.getRequestHeaders().getFirst("Authorization"));
                if(mode.get().equals("redirect")) { exchange.getResponseHeaders().add("Location","http://127.0.0.1:"+server.getAddress().getPort()+"/trap");exchange.sendResponseHeaders(302,-1); }
                else if(mode.get().equals("invalid")) exchange.sendResponseHeaders(600,-1);
                else if(mode.get().equals("slow")) { try { Thread.sleep(3500); } catch(InterruptedException interrupted){Thread.currentThread().interrupt();} exchange.sendResponseHeaders(204,-1); }
                else if(mode.get().equals("body")) { exchange.sendResponseHeaders(200,1_000_000);exchange.getResponseBody().write(1);exchange.getResponseBody().flush();try{Thread.sleep(3500);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();} }
                else exchange.sendResponseHeaders(204,-1);
            } finally { exchange.close(); }
        });
        server.start();String url="http://127.0.0.1:"+server.getAddress().getPort()+"/hook";
        try(var sender=new SenderFixture(url)) {
            assertEquals(url,sender.value.canonicalUrl(url));
            assertThrows(ProductProblem.class,()->sender.value.canonicalUrl(url+"?alternate=1"));
            assertThrows(ProductProblem.class,()->sender.value.canonicalUrl(url.replace("/hook","/trap")));
            var result=sender.value.send(url,key(),EVENT,"webhook.test",1700000000,BODY);
            assertEquals(204,result.httpStatus());assertNull(result.errorCode());
            assertEquals(new String(BODY,StandardCharsets.UTF_8),received.get());
            assertEquals("sha256=cf21d8b8d3264805c73f786c9a6dedb8ce1c802b3f9f8d94398d3f66279f0113",signature.get());
            mode.set("redirect");result=sender.value.send(url,key(),EVENT,"webhook.test",1700000000,BODY);
            assertEquals(302,result.httpStatus());assertEquals("HTTP_ERROR",result.errorCode());assertEquals(0,redirected.get());
            mode.set("body");long before=System.nanoTime();result=sender.value.send(url,key(),EVENT,"webhook.test",1700000000,BODY);
            assertEquals(200,result.httpStatus());assertNull(result.errorCode());assertTrue(System.nanoTime()-before<2_000_000_000L,"A declared large/dripping body is not consumed");
            mode.set("invalid");result=sender.value.send(url,key(),EVENT,"webhook.test",1700000000,BODY);
            assertNull(result.httpStatus());assertEquals("INVALID_RESPONSE",result.errorCode(),"Nonstandard statuses cannot poison persisted delivery results");
            mode.set("slow");result=sender.value.send(url,key(),EVENT,"webhook.test",1700000000,BODY);
            assertEquals("TIMEOUT",result.errorCode());assertEquals(5,requests.get(),"There are no automatic HTTP retries");
        } finally { server.stop(0);executor.shutdownNow(); }
    }
    private static final class SenderFixture implements AutoCloseable {
        final WebhookSender value;
        SenderFixture(String trusted){this(new WebhookSender(trusted));}
        SenderFixture(WebhookSender value){this.value=value;}
        @Override public void close(){value.close();}
    }
}
