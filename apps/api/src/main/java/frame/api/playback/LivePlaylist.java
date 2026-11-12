package frame.api.playback;

import frame.api.broadcast.Broadcast;
import frame.api.mediamtx.MediaPath;
import frame.api.quality.Renditions;
import frame.api.web.JsNumbers;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The multivariant live.m3u8 the relay writes itself (relay.mjs liveMaster; the app's Streamer::HlsMultivariant): per
 * quality (source first, then the lower qualities high to low) an AAC rendition group and the video playlist, URIs relative
 * to /{path}/ (or the broadcast prefix). BANDWIDTH: the configured rate (the sender's announced bitrate, the ladder's rate) +
 * AAC. AVERAGE-BANDWIDTH: what the path really averaged since it became ready (a quality that has not run yet uses the
 * source's measured share of its rate). CODECS: the real SPS from MediaMTX, else High at the level for WxH@fps.
 * ?q= limits the list to one quality (Safari's native player, manual choice). No viewer-specific data in it.
 */
final class LivePlaylist {
    private static final int AAC_BPS = 128_000;

    /**
     * The HLS audio of a broadcast. The app publishes Opus first (WebRTC) and AAC-LC second (HLS, recording): MediaMTX names
     * the track playlists in publish order (video1, audio2 = Opus, audio3 = AAC). A sender without AAC (an older app) falls
     * back to the relay's Opus -> AAC transcode path <path>/aac (RELAY_HLS_AAC) for the source quality only.
     */
    record Audio(String kind, String track, String prefix) {
        boolean present() { return !kind.equals("none"); }
    }

    private record Entry(String name, String prefix, String measured, int width, int height, double mbps, MediaPath props) {}

    private LivePlaylist() {}

    static Audio audio(LiveMedia.State s, boolean hlsAac) {
        MediaPath m = s.ready() ? s.p() : s.entry().seen;
        List<String> tracks = m == null ? List.of() : m.tracks();
        int aac = tracks.indexOf("MPEG-4 Audio");
        if (aac >= 0) return new Audio("aac", "audio" + (aac + 1) + "_stream.m3u8", "");
        if (tracks.contains("Opus") && hlsAac) return new Audio("transcode", "audio2_stream.m3u8", "aac/");
        return new Audio("none", null, "");
    }

    /** The source's configured rate: the sender's announced bitrate, else what the relay measured, else 8 Mbps. */
    static double sourceMbps(Broadcast entry, MediaPath seen) {
        if (entry.bitrate != null) return entry.bitrate;
        return seen != null && seen.mbps() > 0 ? Math.round(seen.mbps() * 10) / 10.0 : 8;
    }

    /**
     * The playlist, or "" when {@code quality} names a quality this broadcast does not have.
     * @param qualities  the broadcast's lower qualities (Renditions.of)
     * @param ladder     those the relay's own ladder encodes (Renditions.ladder)
     * @param failing    the ladder keeps failing before it publishes: list the source path itself so viewers keep playing
     */
    static String master(LiveMedia.State s, String quality, List<Renditions.Quality> qualities, List<Renditions.Quality> ladder, boolean failing, boolean hlsAac) {
        Broadcast entry = s.entry();
        Map<String, MediaPath> paths = s.paths();
        String path = entry.path;
        MediaPath seen = s.ready() ? s.p() : entry.seen;
        Audio audio = audio(s, hlsAac);
        boolean withAudio = audio.present();
        double fps = entry.fps, sourceMbps = sourceMbps(entry, seen);
        Set<String> own = new HashSet<>();
        for (Renditions.Quality q : ladder) own.add(q.name());
        boolean down = !own.isEmpty() && failing;
        boolean viaLadder = !audio.kind().equals("transcode") && !own.isEmpty() && !down;
        List<Entry> list = new ArrayList<>();
        // A player asking for one relay quality while the ladder is down (Safari's manual choice) gets the source instead of
        // a 404 that would end its playback while the source plays fine.
        if (quality.isEmpty() || quality.equals("source") || (down && own.contains(quality)))
            list.add(new Entry("source", viaLadder ? "src/" : audio.prefix(), path, entry.width > 0 ? entry.width : seen == null ? 0 : seen.width(),
                    entry.height > 0 ? entry.height : seen == null ? 0 : seen.height(), sourceMbps, seen));
        if (!audio.kind().equals("transcode")) {
            for (Renditions.Quality r : qualities) {
                if ((!quality.isEmpty() && !quality.equals(r.name())) || (down && own.contains(r.name()))) continue;
                MediaPath rp = paths.get(path + "/" + r.name());
                list.add(new Entry(r.name(), r.name() + "/", path + "/" + r.name(), r.width(), r.height(), r.mbps(), rp != null && rp.ready() ? rp : null));
            }
        }
        if (list.isEmpty()) return "";
        long audioTracks = seen == null ? 0 : seen.tracks().stream().filter(t -> t.equals("Opus") || t.equals("MPEG-4 Audio")).count();
        double audioBps = audioTracks * 128_000.0;
        double sourceVideo = measuredVideo(paths, path, audioBps);
        double ratio = sourceVideo > 0 && sourceMbps > 0 ? Math.min(1, sourceVideo / (sourceMbps * 1e6)) : 0;
        List<String> out = new ArrayList<>(List.of("#EXTM3U", "#EXT-X-VERSION:9", "#EXT-X-INDEPENDENT-SEGMENTS"));
        for (Entry e : list) {
            double peak = e.mbps() * 1e6 + (withAudio ? AAC_BPS : 0);
            double video = measuredVideo(paths, e.measured(), audioBps);
            if (video <= 0 && ratio > 0) video = e.mbps() * 1e6 * ratio;
            double average = video > 0 ? Math.min(peak, video + (withAudio ? AAC_BPS : 0)) : peak;
            String codec = avcCodec(e.props());
            if (codec.isEmpty()) codec = String.format(Locale.ROOT, "avc1.6400%02x", avcLevelIdc(e.width(), e.height(), fps, e.mbps()));
            String group = "aac-" + e.name();
            if (withAudio)
                out.add("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"" + group + "\",NAME=\"audio\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"2\",URI=\"" + e.prefix() + "hls/" + audio.track() + "\"");
            List<String> attrs = new ArrayList<>(List.of("BANDWIDTH=" + Math.round(peak), "AVERAGE-BANDWIDTH=" + Math.round(average)));
            if (e.width() > 0 && e.height() > 0) attrs.add("RESOLUTION=" + e.width() + "x" + e.height());
            if (fps > 0) attrs.add("FRAME-RATE=" + JsNumbers.toFixed(fps, 3));
            attrs.add("CODECS=\"" + codec + (withAudio ? ",mp4a.40.2" : "") + "\"");
            if (withAudio) attrs.add("AUDIO=\"" + group + "\"");
            out.add("#EXT-X-STREAM-INF:" + String.join(",", attrs));
            out.add(e.prefix() + "hls/video1_stream.m3u8");
        }
        return String.join("\n", out) + "\n";
    }

    // What the path really averaged since it became ready, without its audio tracks (0 when not measured yet).
    private static double measuredVideo(Map<String, MediaPath> paths, String name, double audioBps) {
        MediaPath m = paths.get(name);
        return m != null && m.ready() && m.avgMbps() > 0 ? Math.max(0, m.avgMbps() * 1e6 - audioBps) : 0;
    }

    private static final Map<String, Integer> PROFILES = Map.of("Baseline", 66, "Constrained Baseline", 66, "Main", 77, "Extended", 88,
            "High", 100, "High 10", 110, "High 4:2:2", 122, "High 4:4:4", 244);

    /** "avc1.PPCCLL" from MediaMTX's codecProps of the H.264 track ({profile:"High", level:"4.2"}), or "". */
    static String avcCodec(MediaPath p) {
        if (p == null || p.profile() == null || p.level() == null) return "";
        Integer profile = PROFILES.get(p.profile());
        double level;
        try { level = Double.parseDouble(p.level()); } catch (NumberFormatException e) { return ""; }
        if (profile == null || !(level > 0)) return "";
        return String.format(Locale.ROOT, "avc1.%02x%02x%02x", profile, p.profile().equals("Constrained Baseline") ? 0x40 : 0, Math.round(level * 10));
    }

    // H.264 level_idc for a High-profile stream of this size, rate and bitrate (ITU-T H.264 Table A-1, MaxBR x1.25 for High).
    private static final int[][] LEVELS = {{10, 1485, 99, 64}, {11, 3000, 396, 192}, {12, 6000, 396, 384}, {13, 11880, 396, 768}, {20, 11880, 396, 2000},
            {21, 19800, 792, 4000}, {22, 20250, 1620, 4000}, {30, 40500, 1620, 10000}, {31, 108000, 3600, 14000}, {32, 216000, 5120, 20000},
            {40, 245760, 8192, 20000}, {41, 245760, 8192, 50000}, {42, 522240, 8704, 50000}, {50, 589824, 22080, 135000}, {51, 983040, 36864, 240000},
            {52, 2073600, 36864, 240000}, {60, 4177920, 139264, 240000}, {61, 8355840, 139264, 480000}, {62, 16711680, 139264, 800000}};

    static int avcLevelIdc(int width, int height, double fps, double mbps) {
        long fs = (long) Math.ceil(width / 16.0) * (long) Math.ceil(height / 16.0);
        for (int[] l : LEVELS) if (fs <= l[2] && fs * (fps > 0 ? fps : 30) <= l[1] && mbps * 1000 <= l[3] * 1.25) return l[0];
        return 62;
    }
}
