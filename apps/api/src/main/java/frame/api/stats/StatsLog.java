package frame.api.stats;

import frame.api.FrameProperties;
import frame.api.web.Unicode;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * Anonymous playback reports from viewers (server/lib/stats.mjs), appended to one CSV per UTC day: stats-YYYY-MM-DD.csv in
 * RELAY_STATS_DIR (unset: received, not stored). No IP address, user agent or chat name is ever written; the session is the
 * random id each page makes for itself. Each daily file stops growing at RELAY_STATS_MAX_MB; files older than
 * RELAY_STATS_KEEP_DAYS are removed.
 */
@Component
public class StatsLog {
    private static final Logger log = LoggerFactory.getLogger(StatsLog.class);
    static final List<String> COLUMNS = List.of("time", "path", "session", "broadcast", "transport", "mode", "quality", "height", "fps", "loss_pct",
            "jitter_ms", "freezes", "mbps", "abr_switches", "last_switch", "event", "device");
    private static final Pattern FILE = Pattern.compile("^stats-(\\d{4}-\\d{2}-\\d{2})\\.csv$");
    private static final Pattern BROADCAST = Pattern.compile("^[0-9a-f]{32}$");
    private static final Pattern QUALITY = Pattern.compile("^(\\d{3,4}p|auto)$");
    private static final Pattern FORMULA = Pattern.compile("^[=+\\-@].*", Pattern.DOTALL);
    private static final Pattern QUOTE = Pattern.compile("[\",\\n\\r]");
    /** Date.toISOString(): always milliseconds. */
    private static final DateTimeFormatter ISO_MS = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);

    /** The CSV fields in COLUMNS order and the page's session, or why the report was refused. */
    public record Row(List<String> fields, String session, String error) {}

    private final Path dir;
    private final long maxBytes;
    private final long keepDays;
    private String day = "";
    private Path file;
    private long size;
    private boolean full;
    private volatile long written;

    public StatsLog(FrameProperties props) {
        String d = props.stats().dir() == null ? "" : props.stats().dir().trim();
        this.dir = d.isEmpty() ? null : Path.of(d).toAbsolutePath();
        this.maxBytes = props.stats().maxMb() * 1024 * 1024;
        this.keepDays = props.stats().keepDays();
    }

    public boolean enabled() { return dir != null; }

    public long written() { return written; }

    /** Appends one row (serialised); false when dropped at the daily cap. */
    public synchronized boolean append(List<String> fields) throws IOException {
        String line = line(fields);
        String today = fields.getFirst().substring(0, 10);
        if (!today.equals(day)) open(today);
        int bytes = line.getBytes(StandardCharsets.UTF_8).length;
        if (size + bytes > maxBytes) {
            if (!full) {
                full = true;
                log.warn("playback stats {} reached {} MB: further reports today are dropped", file, Math.round(maxBytes / 1048576.0));
            }
            return false;
        }
        Files.writeString(file, line, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        size += bytes;
        written++;
        return true;
    }

    private void open(String today) throws IOException {
        if (!Files.isDirectory(dir)) Files.createDirectories(dir);  // the folder usually exists already, under a read-only parent
        day = today;
        file = dir.resolve("stats-" + today + ".csv");
        full = false;
        size = Files.exists(file) ? Files.size(file) : 0;
        if (size == 0) {
            String head = String.join(",", COLUMNS) + "\n";
            Files.writeString(file, head, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            size = head.getBytes(StandardCharsets.UTF_8).length;
        }
        if (keepDays > 0) {
            String oldest = LocalDate.parse(today).minusDays(keepDays).toString();
            try (Stream<Path> list = Files.list(dir)) {
                for (Path p : list.toList()) {
                    Matcher m = FILE.matcher(p.getFileName().toString());
                    if (m.matches() && m.group(1).compareTo(oldest) < 0) { try { Files.deleteIfExists(p); } catch (IOException ignored) { } }
                }
            }
        }
    }

    // ---- one report ---------------------------------------------------------------------------------------------------

    /** The row of a report {@code body} (a JSON object) on {@code path}. */
    public static Row row(String path, JsonNode body, long now) {
        if (body == null || !body.isObject()) return new Row(null, null, "JSON object required");
        String session = word(body.get("sid"), 40);
        if (session.isEmpty()) return new Row(null, null, "sid required");
        String broadcast = text(body.get("broadcast"));
        if (!BROADCAST.matcher(broadcast).matches()) broadcast = "";
        String quality = text(body.get("quality"));
        if (!QUALITY.matcher(quality).matches()) quality = "";
        return new Row(List.of(ISO_MS.format(Instant.ofEpochMilli(now)), path, session, broadcast,
                word(body.get("transport"), 16), word(body.get("mode"), 16), quality,
                number(body.get("height"), 0, 8192, 0), number(body.get("fps"), 0, 1000, 1), number(body.get("lossPct"), 0, 100, 2),
                number(body.get("jitterMs"), 0, 600000, 0), number(body.get("freezes"), 0, 1e6, 0), number(body.get("mbps"), 0, 10000, 2),
                number(body.get("abrSwitches"), 0, 1e6, 0), clean(body.get("lastSwitch"), 120), clean(body.get("event"), 120), word(body.get("device"), 24)), session, null);
    }

    private static String text(JsonNode v) { return v != null && v.isString() ? v.asString() : ""; }

    private static String word(JsonNode v, int max) {
        String s = text(v);
        return s.matches("^[A-Za-z0-9][A-Za-z0-9_.:-]{0," + (max - 1) + "}$") ? s : "";
    }

    // A finite number in [min, max], rounded to `digits` and written without trailing zeros (JavaScript's String(+v.toFixed(d))).
    static String number(JsonNode v, double min, double max, int digits) {
        if (v == null || !v.isNumber()) return "";
        double d = v.doubleValue();
        if (!Double.isFinite(d) || d < min || d > max) return "";
        BigDecimal r = new BigDecimal(d).setScale(digits, RoundingMode.HALF_UP).stripTrailingZeros();
        return r.signum() == 0 ? "0" : r.toPlainString();
    }

    // Free text from the page: control and bidi-override characters removed, trimmed as JavaScript trims, length capped.
    static String clean(JsonNode v, int max) {
        if (v == null || !v.isString()) return "";
        String s = v.asString().replaceAll("[\\u0000-\\u001f\\u007f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", " ");
        int a = 0, b = s.length();
        while (a < b && jsSpace(s.charAt(a))) a++;
        while (b > a && jsSpace(s.charAt(b - 1))) b--;
        s = s.substring(a, b);
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static boolean jsSpace(char c) {
        return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a)
                || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    }

    // RFC 4180 quoting, and a leading ' on text that a spreadsheet would run as a formula (last_switch, event).
    static String line(List<String> fields) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < fields.size(); i++) {
            String v = fields.get(i);
            if (i >= 14 && FORMULA.matcher(v).matches()) v = "'" + v;
            if (QUOTE.matcher(v).find()) v = "\"" + v.replace("\"", "\"\"") + "\"";
            if (i > 0) out.append(',');
            out.append(v);
        }
        // A lone surrogate (a "\ud800" escape, a text cut inside a pair) is written as U+FFFD, as Node writes it; Java's UTF-8
        // encoder would refuse the line and the report would be lost.
        return Unicode.wellFormed(out.append('\n').toString());
    }
}
