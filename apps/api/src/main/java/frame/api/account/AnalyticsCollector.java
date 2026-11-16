package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import frame.api.playback.Audience;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** A single product worker; registry/media request threads never wait for analytics database work. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class AnalyticsCollector {
    private static final Logger log=LoggerFactory.getLogger(AnalyticsCollector.class);
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-analytics").factory());
    private final ChannelAnalytics analytics;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths media;
    private final Audience audience;
    private boolean initialized,continuous,unavailable;
    public AnalyticsCollector(ChannelAnalytics analytics,BroadcastRegistry registry,MediaMtxPaths media,Audience audience){this.analytics=analytics;this.registry=registry;this.media=media;this.audience=audience;}
    @EventListener(ApplicationReadyEvent.class) public void start(){worker.scheduleWithFixedDelay(this::reconcile,0,5,TimeUnit.SECONDS);}
    void reconcile(){
        try{
            if(!initialized){analytics.recover();initialized=true;}
            Map<String,MediaPath> paths=media.list();
            if(!ProductNotifications.fresh(media)){continuous=false;return;}
            long now=System.currentTimeMillis();
            List<ChannelAnalytics.Observation> observations=new ArrayList<>();
            var active=new HashMap<UUID,String>();
            for(Broadcast broadcast:registry.all()){
                if(registry.get(broadcast.id)!=broadcast)continue;
                MediaPath source=paths.get(broadcast.path);
                active.put(broadcast.instanceId,source!=null&&source.ready()?ProductNotifications.source(source):"");
                if(!observed(broadcast,source))continue;
                long viewers=audience.hls(broadcast.path);
                for(var entry:paths.entrySet())if(entry.getKey().equals(broadcast.path)||entry.getKey().startsWith(broadcast.path+"/"))viewers+=entry.getValue().webrtcReaders();
                observations.add(new ChannelAnalytics.Observation(broadcast.instanceId,broadcast.id,broadcast.path,
                        broadcast.title.replace('\0','\uFFFD'),ProductNotifications.source(source),(int)Math.min(Integer.MAX_VALUE,Math.max(0,viewers))));
            }
            analytics.sample(observations,active,now,continuous);
            continuous=true;unavailable=false;
        }catch(RuntimeException failure){
            continuous=false;
            if(!unavailable)log.warn("Product analytics collection is temporarily unavailable; media continues independently");
            unavailable=true;
        }
    }
    // A restarted API can register a new broadcast while MediaMTX keeps the same, much older RTMP publisher.
    // Analytics starts at its own first observation; the notification-only source/start-age cutoff must not apply.
    static boolean observed(Broadcast broadcast,MediaPath source){
        return source!=null&&source.ready()&&source.readyMs()>0&&source.sourceType()!=null&&!source.sourceType().isBlank()
                &&broadcast.seen!=null&&broadcast.lastReadyMs>0&&ProductNotifications.source(source).equals(ProductNotifications.source(broadcast.seen));
    }
    @PreDestroy public void stop(){worker.shutdownNow();}
}
