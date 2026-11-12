package frame.api.broadcast;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;

/**
 * The broadcast item of an announcement (contract v1, native/src/directory.cpp BroadcastItem plus the relay extras
 * bitrate, audio, renditions, sentAtMs). The core fields must be valid; an invalid extra is dropped and named in
 * {@code ignored} instead of refusing the whole announcement, so a newer sender still gets listed. host/port are ignored:
 * viewers use the relay's own public address.
 */
public record Announcement(String id, String title, String publisher, String path, int width, int height, double fps, long startedAtMs,
                           Double bitrate, String audio, List<Rendition> renditions, Long sentAtMs) {

    /** A lower quality the sender itself encodes. */
    public record Rendition(String name, int width, int height, Double mbps, Double fps, String codec) {}

    /** Either an announcement (with the extras that were dropped) or the reason it was refused. */
    public record Parsed(Announcement item, List<String> ignored, String error) {}

    public static final Pattern ID = Pattern.compile("^[0-9a-f]{32}$");
    public static final Pattern PATH = Pattern.compile("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$");
    private static final Pattern QUALITY = Pattern.compile("^(240|360|480|720|1080|1440)p$");
    private static final Pattern CODEC = Pattern.compile("^(H\\.264|H\\.265|AV1|VP9)$");
    private static final Set<String> AUDIO = Set.of("none", "system", "mic", "mix");

    public static Parsed parse(JsonNode item) {
        if (item == null || !item.isObject()) return error("unsupported message");
        String id = str(item, "id"), title = str(item, "title"), publisher = str(item, "publisher"), path = str(item, "path");
        if (!ID.matcher(id).matches() || !PATH.matcher(path).matches()) return error("invalid broadcast");
        if (title.isEmpty() || bytes(title) > 200 || bytes(publisher) > 100) return error("invalid title");
        Long width = integer(item.get("width"), 0, 8192), height = integer(item.get("height"), 0, 8192);
        if (width == null || height == null) return error("invalid format");
        Double fps = number(item.get("fps"), 0, 240, 0);
        if (fps == null) return error("invalid format");
        Long started = integer(item.get("startedAtMs"), 0, 9_007_199_254_740_991L);
        if (started == null) return error("invalid format");

        List<String> ignored = new ArrayList<>();
        Double bitrate = null;
        if (item.has("bitrate")) { bitrate = number(item.get("bitrate"), 0.1, 200, null); if (bitrate == null) ignored.add("bitrate"); }
        String audio = null;
        if (item.has("audio")) {
            JsonNode a = item.get("audio");
            if (a.isString() && AUDIO.contains(a.asString())) audio = a.asString(); else ignored.add("audio");
        }
        List<Rendition> renditions = null;
        if (item.has("renditions")) {
            renditions = renditions(item.get("renditions"));
            if (renditions == null) ignored.add("renditions");
        }
        Long sentAt = null;
        if (item.has("sentAtMs")) { sentAt = integer(item.get("sentAtMs"), 1, 9_007_199_254_740_991L); if (sentAt == null) ignored.add("sentAtMs"); }
        return new Parsed(new Announcement(id, title, publisher, path, width.intValue(), height.intValue(), fps, started, bitrate, audio, renditions, sentAt), ignored, null);
    }

    private static List<Rendition> renditions(JsonNode list) {
        if (list == null || !list.isArray() || list.size() > 6) return null;
        Map<String, Rendition> out = new LinkedHashMap<>();
        for (JsonNode r : list) {
            Rendition parsed = rendition(r);
            if (parsed == null) return null;
            out.put(parsed.name(), parsed);
        }
        return List.copyOf(out.values());
    }

    // Plain "720p" strings (older senders) are accepted with only the name known.
    private static Rendition rendition(JsonNode r) {
        if (r.isString()) return QUALITY.matcher(r.asString()).matches() ? new Rendition(r.asString(), 0, Integer.parseInt(r.asString().replace("p", "")), null, null, null) : null;
        if (!r.isObject() || !r.path("name").isString() || !QUALITY.matcher(r.path("name").asString()).matches()) return null;
        String name = r.path("name").asString();
        Long h = integer(r.get("height"), 1, 8192), w = integer(r.get("width"), 1, 8192);
        Double mbps = number(r.get("mbps"), 0.05, 200, null), fps = number(r.get("fps"), 1, 240, null);
        String codec = r.path("codec").isString() && CODEC.matcher(r.path("codec").asString()).matches() ? r.path("codec").asString() : null;
        return new Rendition(name, w == null ? 0 : w.intValue(), h == null || !r.has("height") ? Integer.parseInt(name.replace("p", "")) : h.intValue(), mbps, fps, codec);
    }

    private static Parsed error(String reason) { return new Parsed(null, List.of(), reason); }

    private static String str(JsonNode o, String k) { JsonNode v = o.get(k); return v != null && v.isString() ? v.asString() : ""; }

    private static int bytes(String s) { return s.getBytes(StandardCharsets.UTF_8).length; }

    // A JSON number that is a whole number in [min, max] (JavaScript's Number.isInteger: 1280.0 counts); absent -> 0.
    private static Long integer(JsonNode v, long min, long max) {
        if (v == null || v.isNull()) return min <= 0 ? 0L : null;
        if (!v.isNumber()) return null;
        double d = v.doubleValue();
        if (Double.isNaN(d) || d != Math.rint(d) || d < min || d > max) return null;
        return v.isIntegralNumber() && v.canConvertToLong() ? v.longValue() : (long) d;
    }

    // A finite JSON number in [min, max]; absent -> fallback (null: required to be present by the caller's has()).
    private static Double number(JsonNode v, double min, double max, Integer fallback) {
        if (v == null || v.isNull()) return fallback == null ? null : fallback.doubleValue();
        if (!v.isNumber()) return null;
        double d = v.doubleValue();
        return Double.isFinite(d) && d >= min && d <= max ? d : null;
    }
}
