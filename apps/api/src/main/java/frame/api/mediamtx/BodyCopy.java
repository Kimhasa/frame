package frame.api.mediamtx;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Copies a MediaMTX body (an HLS part that arrives while it is produced, a DVR chunk) to the viewer as it arrives, each read
 * flushed. The JDK client's request timeout ends with the headers, so a body that stalls is closed after {@code stallMs}
 * without data. A failure of the upstream side is {@link Broken}: the caller aborts the viewer's connection, so the player
 * sees a failed request, never a shorter but apparently complete body.
 */
public final class BodyCopy {
    /** MediaMTX stopped sending (an error, or no data for the stall time) after the viewer's answer had started. */
    public static final class Broken extends RuntimeException {
        public Broken(Throwable cause) { super(cause); }
        public String why() { return getCause() == null ? "no data in time" : getCause().toString(); }
    }

    private BodyCopy() {}

    public static void copy(InputStream in, OutputStream out, long stallMs) throws IOException {
        AtomicLong lastData = new AtomicLong(System.currentTimeMillis());
        AtomicBoolean done = new AtomicBoolean(), stalled = new AtomicBoolean();
        Thread watchdog = Thread.ofVirtual().start(() -> {
            while (!done.get()) {
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                if (!done.get() && System.currentTimeMillis() - lastData.get() > stallMs) {
                    stalled.set(true);
                    try { in.close(); } catch (IOException ignored) { }
                    return;
                }
            }
        });
        try {
            byte[] buf = new byte[64 * 1024];
            while (true) {
                int n;
                try { n = in.read(buf); } catch (IOException e) { throw new Broken(stalled.get() ? null : e); }
                if (n < 0) break;
                lastData.set(System.currentTimeMillis());
                out.write(buf, 0, n);
                out.flush();
            }
            if (stalled.get()) throw new Broken(null);
        } finally {
            done.set(true);
            watchdog.interrupt();
        }
    }
}
