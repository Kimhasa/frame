package frame.api.account;

import frame.api.broadcast.BroadcastRegistry;
import frame.api.mediamtx.MediaMtxPaths;
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

/** Product database work stays off the media scheduler and registry publishing thread. */
@Component
@ConditionalOnProperty(name = "frame.product.enabled", havingValue = "true")
public class NotificationReconciler {
    private static final Logger log = LoggerFactory.getLogger(NotificationReconciler.class);
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("product-notifications").factory());
    private final ProductNotifications notifications;
    private final BroadcastRegistry broadcasts;
    private final MediaMtxPaths media;
    private boolean unavailable;
    public NotificationReconciler(ProductNotifications notifications, BroadcastRegistry broadcasts, MediaMtxPaths media) { this.notifications = notifications; this.broadcasts = broadcasts; this.media = media; }
    @EventListener(ApplicationReadyEvent.class) public void start() { worker.scheduleWithFixedDelay(this::reconcile, 5, 5, TimeUnit.SECONDS); }
    void reconcile() {
        if (!ProductNotifications.fresh(media)) return;
        var paths = media.last();
        try {
            for (var broadcast : broadcasts.all()) notifications.live(broadcast, paths.get(broadcast.path));
            unavailable = false;
        } catch (RuntimeException failure) {
            if (!unavailable) log.warn("Product live notifications are temporarily unavailable; media continues independently");
            unavailable = true; // No exception or metadata payload is logged, and the bounded worker retries next time.
        }
    }
    @PreDestroy public void stop() { worker.shutdownNow(); }
}
