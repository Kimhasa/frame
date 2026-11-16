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

/** One bounded local copier. No HTTP request, DB transaction or media scheduler waits for the copy. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class VodPublisher {
    private static final Logger log=LoggerFactory.getLogger(VodPublisher.class);
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-vod-publisher").factory());
    private final ProductVods vods;
    private final VodFiles files;
    private boolean initialized,unavailable;
    public VodPublisher(ProductVods vods,VodFiles files){this.vods=vods;this.files=files;}
    @EventListener(ApplicationReadyEvent.class) public void start(){worker.scheduleWithFixedDelay(this::reconcile,0,1,TimeUnit.SECONDS);}
    void reconcile(){
        ProductVods.Work work=null;
        try{
            if(!initialized){for(var id:vods.recover())try{files.discardPart(id);}catch(Exception ignored){}initialized=true;}
            work=vods.next();if(work==null)return;
            if(work.recording()==null)throw new IllegalStateException("Source recording unavailable");
            var source=vods.source(work.owner(),work.recording());
            var copy=files.copy(work.id(),source);
            // The source may have been hidden or changed while copying. A failed recheck never publishes the copy.
            var checked=vods.source(work.owner(),work.recording());
            if(!sameSource(source,checked))throw new IllegalStateException("Source recording changed");
            vods.finished(work.id(),copy);unavailable=false;
        }catch(Exception failure){
            if(work!=null){
                try{files.discardPart(work.id());}catch(Exception ignored){}
                try{vods.failed(work.id());}catch(RuntimeException ignored){}
            }
            if(!unavailable)log.warn("VOD preparation is temporarily unavailable; live media continues independently");
            unavailable=true;
        }
    }
    static boolean sameSource(ChannelRecordings.Asset before,ChannelRecordings.Asset after){
        // The observed end of an active recording window advances; asset() independently rechecks containment.
        return before.id().equals(after.id())&&before.path().equals(after.path())&&before.name().equals(after.name())
                &&before.size()==after.size()&&before.modified()==after.modified()&&java.util.Objects.equals(before.key(),after.key())
                &&before.recorded()==after.recorded()&&before.windowStart()==after.windowStart();
    }
    @PreDestroy public void stop(){worker.shutdownNow();}
}
