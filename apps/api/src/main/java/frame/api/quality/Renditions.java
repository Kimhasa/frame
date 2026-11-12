package frame.api.quality;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.broadcast.Broadcast;
import frame.api.mediamtx.MediaPath;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * The lower qualities this relay really serves for a broadcast (relay.mjs renditions/ladderList):
 * <ul>
 *   <li>renditions the sender itself publishes to the relay (announced and receiving over RTSPS): the sender's description;</li>
 *   <li>otherwise the relay's own ladder (RELAY_RENDITIONS): scale=-2:H, the configured bitrate, the source frame rate, H.264.</li>
 * </ul>
 */
@Component
public class Renditions {
    /** One quality as /info and live.m3u8 describe it. */
    public record Quality(String name, int width, int height, double mbps, double fps, String codec) {}

    private final List<FrameProperties.Quality.Rendition> configured;

    public Renditions(FrameProperties props) {
        this.configured = props.quality().list();
    }

    public List<FrameProperties.Quality.Rendition> configured() { return configured; }

    /** Width FFmpeg gives for scale=-2:H: 1280x720 -> 480p is 854 (the sender's own encoder computes 852 and announces that). */
    public static int scaledWidth(int srcW, int srcH, int h) {
        return srcW > 0 && srcH > 0 ? (int) Math.round((double) h * srcW / (srcH * 2.0)) * 2 : 0;
    }

    /** Highest first. */
    public List<Quality> of(Broadcast entry, MediaPath p, Map<String, MediaPath> paths) {
        MediaPath seen = entry.seen;
        int width = entry.width > 0 ? entry.width : p != null && p.width() > 0 ? p.width() : seen != null ? seen.width() : 0;
        int height = entry.height > 0 ? entry.height : p != null && p.height() > 0 ? p.height() : seen != null ? seen.height() : 0;
        if (height <= 0) return List.of();
        Map<String, Quality> out = new LinkedHashMap<>();
        for (FrameProperties.Quality.Rendition r : configured)
            if (r.height() < height) out.put(r.name(), new Quality(r.name(), scaledWidth(width, height, r.height()), r.height(), r.mbps(), entry.fps, "H.264"));
        List<Announcement.Rendition> own = entry.renditions;
        if (own != null) for (Announcement.Rendition r : own) {
            // Only a path the sender itself publishes (RTSPS from outside); the same path fed by the relay's own encoder
            // (plain RTSP on loopback) keeps the relay encoder's description.
            MediaPath rp = paths.get(entry.path + "/" + r.name());
            if (r.height() >= height || rp == null || !rp.ready() || !"rtspsSession".equals(rp.sourceType())) continue;
            Quality relay = out.get(r.name());
            double mbps = r.mbps() != null ? r.mbps() : relay != null ? relay.mbps() : 0;
            out.put(r.name(), new Quality(r.name(), r.width() > 0 ? r.width() : scaledWidth(width, height, r.height()), r.height(), mbps,
                    r.fps() != null ? r.fps() : entry.fps, r.codec() != null ? r.codec() : "H.264"));
        }
        List<Quality> list = new ArrayList<>(out.values());
        list.sort(Comparator.comparingInt(Quality::height).reversed());
        return list;
    }

    /** The qualities the relay's own ladder encodes for the broadcast (all of the above but those the sender publishes). */
    public List<Quality> ladder(Broadcast entry, MediaPath p, Map<String, MediaPath> paths) {
        List<Quality> out = new ArrayList<>();
        for (Quality q : of(entry, p, paths)) {
            MediaPath rp = paths.get(entry.path + "/" + q.name());
            if (rp == null || !"rtspsSession".equals(rp.sourceType())) out.add(q);
        }
        return out;
    }
}
