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

/** A single local encoder; no media scheduler, request or DB transaction waits for FFmpeg. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ClipPublisher {
    private static final Logger log=LoggerFactory.getLogger(ClipPublisher.class);
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-clip-publisher").factory());
    private final ProductClips clips;private final ClipFiles files;private boolean initialized,unavailable;
    public ClipPublisher(ProductClips clips,ClipFiles files){this.clips=clips;this.files=files;}
    @EventListener(ApplicationReadyEvent.class) public void start(){worker.scheduleWithFixedDelay(this::reconcile,0,1,TimeUnit.SECONDS);}
    void reconcile(){ProductClips.Work work=null;
        try{
            if(!initialized){for(var id:clips.recover())try{files.discardPart(id);}catch(Exception ignored){}initialized=true;}
            work=clips.next();if(work==null)return;var source=clips.source(work);
            var encoded=files.encode(work.id(),source,work.start(),work.end());
            if(!source.equals(clips.source(work)))throw new IllegalStateException("Source VOD changed");
            clips.finished(work.id(),encoded);unavailable=false;
        }catch(Exception failure){
            if(work!=null){try{files.discardPart(work.id());}catch(Exception ignored){}try{clips.failed(work.id());}catch(RuntimeException ignored){}}
            if(!unavailable)log.warn("Clip preparation is temporarily unavailable; live media continues independently");unavailable=true;
            if(failure instanceof InterruptedException)Thread.currentThread().interrupt();
        }
    }
    @PreDestroy public void stop(){worker.shutdownNow();files.stop();}
}
