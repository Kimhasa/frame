package frame.api.account;

import frame.api.broadcast.BroadcastRegistry;
import frame.api.dvr.RecordedAssetProbe;
import frame.api.mediamtx.MediaMtxPaths;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** Proof is deliberately narrower than a broadcast: only consecutive fresh server observations form a window. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class RecordingCollector {
    private static final Logger log=LoggerFactory.getLogger(RecordingCollector.class);
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-recordings").factory());
    private final ChannelRecordings catalog;
    private final RecordedAssetProbe probe;
    private final BroadcastRegistry registry;
    private final MediaMtxPaths media;
    private boolean initialized,continuous,unavailable;
    public RecordingCollector(ChannelRecordings catalog,RecordedAssetProbe probe,BroadcastRegistry registry,MediaMtxPaths media){this.catalog=catalog;this.probe=probe;this.registry=registry;this.media=media;}
    @EventListener(ApplicationReadyEvent.class) public void start(){worker.scheduleWithFixedDelay(this::reconcile,0,2,TimeUnit.SECONDS);}
    void reconcile(){
        try{
            if(!initialized){catalog.recover();initialized=true;}
            if(!probe.enabled()){continuous=false;catalog.availability(true);return;}
            List<ChannelRecordings.Observation> observations=new ArrayList<>();
            boolean fresh=false;
            if(probe.enabled()){
                var paths=media.list();fresh=ProductNotifications.fresh(media);
                if(fresh)for(var broadcast:registry.all()){
                    var source=paths.get(broadcast.path);
                    if(registry.get(broadcast.id)==broadcast&&AnalyticsCollector.observed(broadcast,source))observations.add(new ChannelRecordings.Observation(broadcast.instanceId,broadcast.id,broadcast.path,ProductNotifications.source(source),broadcast.title));
                }
            }
            long now=System.currentTimeMillis();
            var windows=catalog.observe(observations,now,continuous&&fresh);
            long budget=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(1500);
            int paths=0;
            for(var window:windows){
                if(++paths>16||System.nanoTime()>budget)throw new IOException("Recording discovery budget exceeded");
                List<String> names=new ArrayList<>();
                try(var entries=Files.newDirectoryStream(probe.directory(window.path()))){int count=0;for(var entry:entries){if(++count>2048)throw new IOException("Recording directory budget exceeded");String name=entry.getFileName().toString();if(RecordedAssetProbe.timestamp(name)!=null)names.add(name);}}
                catch(NoSuchFileException absent){continue;}
                names.sort(Comparator.naturalOrder());
                var known=catalog.known(window.path(),window.start());
                for(String name:names){if(known.contains(name))continue;if(System.nanoTime()>budget)throw new IOException("Recording discovery budget exceeded");Long at=RecordedAssetProbe.timestamp(name);if(at!=null&&at>=window.start()&&at<=now)catalog.discover(window,name,at,now);}
            }
            // Fair oldest-check-first rotation bounds scans independently of directory/catalog growth.
            for(var file:catalog.inspect(24)){
                if(System.nanoTime()>budget)break;
                try{var info=probe.info(file.window().path(),file.name());catalog.inspected(file,info,false,System.currentTimeMillis());}
                catch(NoSuchFileException absent){catalog.inspected(file,null,true,System.currentTimeMillis());}
            }
            continuous=fresh;catalog.availability(true);unavailable=false;
        }catch(RuntimeException|IOException failure){
            continuous=false;catalog.availability(false);
            if(!unavailable)log.warn("Private recording catalog is temporarily unavailable; media recording continues independently");
            unavailable=true;
        }
    }
    @PreDestroy public void stop(){worker.shutdownNow();}
}
