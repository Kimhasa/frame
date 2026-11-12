package frame.api.mediamtx;

import java.util.List;

/**
 * One MediaMTX path as the relay sees it (from /v3/paths/list).
 *
 * @param readyMs       when its current publisher session became ready (MediaMTX clock = this host), 0 if unknown
 * @param tracks        codec names in publish order ("H264", "Opus", "MPEG-4 Audio", ...)
 * @param profile       H.264 profile of the video track ("High"), or null
 * @param level         H.264 level ("4.2"), or null
 * @param sourceType    who publishes ("rtspsSession", "rtspSession", ...)
 * @param webrtcReaders readers that are WebRTC sessions (they count as viewers)
 * @param mbps          inbound rate, smoothed over the API refreshes
 * @param avgMbps       inbound average since ready (after 10 s), for HLS AVERAGE-BANDWIDTH
 * @param sourceId      internal MediaMTX publisher identity; empty when an older API omits it
 */
public record MediaPath(boolean ready, long readyMs, List<String> tracks, int width, int height, String profile, String level,
                        String sourceType, int readers, int webrtcReaders, long inboundBytes, double mbps, double avgMbps, String sourceId) {
    /** Older callers do not need the internal notification source identity. */
    public MediaPath(boolean ready, long readyMs, List<String> tracks, int width, int height, String profile, String level,
                     String sourceType, int readers, int webrtcReaders, long inboundBytes, double mbps, double avgMbps) {
        this(ready, readyMs, tracks, width, height, profile, level, sourceType, readers, webrtcReaders, inboundBytes, mbps, avgMbps, "");
    }
}
