package frame.api.page;

import frame.api.FrameProperties;
import frame.api.broadcast.Announcement;
import frame.api.web.Replies;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * The existing single-file viewer page (the sender app's UI build, relay.mjs uiPage/scriptFile): GET / and /{path} serve
 * RELAY_UI_FILE (no-store, never framed), [/{path}]/assets/js/{file} its player scripts (RELAY_JS_DIR, default the page's
 * assets/js), [/{path}]/assets/fonts/{file} its font (RELAY_FONTS_DIR, default the page's assets/fonts). Files are read
 * only from these configured places, kept in memory and re-read when they change. Without RELAY_UI_FILE the page is 404
 * (the React viewer is served by the front proxy).
 */
@RestController
public class LegacyPageController {
    private static final Pattern SCRIPT = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\\.(?:js|txt)$");
    private static final Pattern FONT = Pattern.compile("^(PretendardVariable\\.woff2|OFL\\.txt)$");

    private record Cached(long checkedAt, long mtime, byte[] body) {}

    private final Path page, scripts, fonts;
    private final ConcurrentHashMap<Path, Cached> cache = new ConcurrentHashMap<>();

    public LegacyPageController(FrameProperties props) {
        FrameProperties.LegacyUi ui = props.legacyUi();
        this.page = blank(ui.file()) ? null : Path.of(ui.file().trim()).toAbsolutePath();
        Path base = page == null ? null : page.getParent();
        this.scripts = !blank(ui.jsDir()) ? Path.of(ui.jsDir().trim()).toAbsolutePath() : base == null ? null : base.resolve("assets/js");
        this.fonts = !blank(ui.fontsDir()) ? Path.of(ui.fontsDir().trim()).toAbsolutePath() : base == null ? null : base.resolve("assets/fonts");
    }

    @GetMapping({"/", "/{path}", "/{path}/"})
    public ResponseEntity<Object> page(@PathVariable(required = false) String path, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (path != null && !Announcement.PATH.matcher(path).matches()) return Replies.text(404, "Not found");
        byte[] body = page == null ? null : read(page, 2000);
        if (body == null) return Replies.text(404, "UI files are missing");
        res.setHeader("X-Frame-Options", "DENY");
        Replies.write(req, res, 200, "text/html; charset=utf-8", "no-store", body);
        return null;
    }

    @GetMapping({"/assets/js/{name}", "/{path}/assets/js/{name}"})
    public ResponseEntity<Object> script(@PathVariable(required = false) String path, @PathVariable String name, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if ((path != null && !Announcement.PATH.matcher(path).matches()) || !SCRIPT.matcher(name).matches()) return Replies.text(404, "Not found");
        byte[] body = scripts == null ? null : read(scripts.resolve(name), 5000);
        if (body == null) return Replies.textNoStore(404, "Not found");
        boolean js = name.endsWith(".js");
        Replies.write(req, res, 200, js ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8", js ? "public, max-age=31536000, immutable" : "max-age=86400", body);
        return null;
    }

    @GetMapping({"/assets/fonts/{name}", "/{path}/assets/fonts/{name}"})
    public ResponseEntity<Object> font(@PathVariable(required = false) String path, @PathVariable String name, HttpServletRequest req, HttpServletResponse res) throws IOException {
        if ((path != null && !Announcement.PATH.matcher(path).matches()) || !FONT.matcher(name).matches()) return Replies.text(404, "Not found");
        byte[] body = fonts == null ? null : read(fonts.resolve(name), 5000);
        if (body == null) return Replies.text(404, "Not found");
        Replies.write(req, res, 200, name.equals("OFL.txt") ? "text/plain; charset=utf-8" : "font/woff2", "max-age=86400", body);
        return null;
    }

    // The file's bytes (re-read when its modification time changed, checked at most every `checkMs`), or null if missing.
    private byte[] read(Path file, long checkMs) {
        long now = System.currentTimeMillis();
        Cached hit = cache.get(file);
        if (hit != null && now - hit.checkedAt() < checkMs) return hit.body();
        try {
            long mtime = Files.getLastModifiedTime(file).toMillis();
            byte[] body = hit != null && hit.mtime() == mtime ? hit.body() : Files.readAllBytes(file);
            if (cache.size() > 64) cache.clear();
            cache.put(file, new Cached(now, mtime, body));
            return body;
        } catch (IOException e) {
            cache.remove(file);
            return null;
        }
    }

    private static boolean blank(String s) { return s == null || s.isBlank(); }
}
