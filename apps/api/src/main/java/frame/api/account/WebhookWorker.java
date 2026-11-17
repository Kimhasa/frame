package frame.api.account;

import frame.api.broadcast.Broadcast;
import frame.api.broadcast.BroadcastEvents;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
import frame.api.mediamtx.MediaPath;
import jakarta.annotation.PreDestroy;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** One bounded hand-off and one sender thread. Network I/O is never inside a database transaction or registry lock. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class WebhookWorker {
    private static final Logger log=LoggerFactory.getLogger(WebhookWorker.class);
    private record Notice(UUID instance,boolean ended){}
    private record Observed(UUID instance,UUID channel,String path,String id,String title,long startedAtMs){}
    private record Completion(UUID id,WebhookSender.Result result){}
    private final ArrayBlockingQueue<Notice> notices=new ArrayBlockingQueue<>(256);
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-webhooks").factory());
    private final DeveloperSettings settings;private final WebhookSender sender;private final BroadcastRegistry registry;private final MediaMtxPaths media;
    private final Map<UUID,Observed> observed=new HashMap<>();
    private boolean initialized,unavailable;
    private Completion completion;
    public WebhookWorker(DeveloperSettings settings,WebhookSender sender,BroadcastRegistry registry,MediaMtxPaths media){this.settings=settings;this.sender=sender;this.registry=registry;this.media=media;}
    @EventListener(ApplicationReadyEvent.class) public void start(){worker.scheduleWithFixedDelay(this::reconcile,0,1,TimeUnit.SECONDS);}
    // Registry publishing and chat fan-out can call these: no database access, network access, waiting, or task growth.
    @EventListener public void started(BroadcastEvents.Started event){notices.offer(new Notice(event.broadcast().instanceId,false));}
    @EventListener public void ended(BroadcastEvents.Ended event){notices.offer(new Notice(event.broadcast().instanceId,true));}
    void reconcile(){
        try{
            if(!initialized){settings.recover();initialized=true;}
            if(completion!=null){settings.complete(completion.id(),completion.result());completion=null;}
            observe();DeveloperSettings.Job job=settings.claim();
            if(job!=null){WebhookSender.Result result;try{result=sender.send(job.url(),job.secret(),job.delivery().eventId(),job.delivery().event(),System.currentTimeMillis()/1000,job.body());}catch(RuntimeException failure){result=new WebhookSender.Result(null,"NETWORK_ERROR");}completion=new Completion(job.delivery().id(),result);settings.complete(completion.id(),completion.result());completion=null;}
            unavailable=false;
        }catch(RuntimeException failure){if(!unavailable)log.warn("Product webhook processing is temporarily unavailable; media continues independently");unavailable=true;}
    }
    private void observe(){
        long now=System.currentTimeMillis();Set<UUID> ended=new HashSet<>();Notice notice;while((notice=notices.poll())!=null)if(notice.ended())ended.add(notice.instance());
        var live=registry.all();Set<UUID> active=new HashSet<>();for(Broadcast broadcast:live)active.add(broadcast.instanceId);
        for(Observed previous:java.util.List.copyOf(observed.values()))if(ended.contains(previous.instance())||!active.contains(previous.instance())){
            settings.broadcastEvent(previous.path(),previous.channel(),previous.instance(),previous.id(),previous.title(),previous.startedAtMs(),"broadcast.ended",now);observed.remove(previous.instance());
        }
        Map<String,MediaPath> paths=media.list();if(!ProductNotifications.fresh(media))return;
        for(Broadcast broadcast:live){
            if(observed.containsKey(broadcast.instanceId)||registry.get(broadcast.id)!=broadcast||!ProductNotifications.consistent(broadcast,paths.get(broadcast.path)))continue;
            UUID channel=settings.broadcastEvent(broadcast.path,null,broadcast.instanceId,broadcast.id,broadcast.title,broadcast.startedAtRelayMs,"broadcast.started",now);
            if(channel!=null)observed.put(broadcast.instanceId,new Observed(broadcast.instanceId,channel,broadcast.path,broadcast.id,broadcast.title,broadcast.startedAtRelayMs));
        }
    }
    @PreDestroy public void stop(){worker.shutdownNow();}
}
