package frame.api.account;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** One API instance, one billing worker; no provider request is made while a database transaction is open. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class MembershipWorker {
    private static final Logger log=LoggerFactory.getLogger(MembershipWorker.class);
    private final Memberships memberships;
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-memberships").factory());
    private boolean unavailable;
    public MembershipWorker(Memberships memberships){this.memberships=memberships;}
    @EventListener(ApplicationReadyEvent.class) public void start(){worker.scheduleWithFixedDelay(this::reconcile,0,1,TimeUnit.SECONDS);}
    void reconcile(){try{memberships.processOne();unavailable=false;}catch(RuntimeException error){if(!unavailable)log.warn("Product membership processing is temporarily unavailable; payment results remain unconfirmed");unavailable=true;}}
    @PreDestroy public void stop(){worker.shutdownNow();}
}
