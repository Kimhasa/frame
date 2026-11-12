package frame.api.web;

import java.util.concurrent.ConcurrentHashMap;

/**
 * Token bucket per key: {@code burst} requests at once, refilled at {@code perSecond}. Answers how many seconds to wait
 * (the Retry-After of a 429), 0 when allowed. Idle buckets are dropped on the next sweep.
 */
public final class RateLimit {
    private final double burst, perSecond;
    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();
    private long lastSweep = System.currentTimeMillis();

    private static final class Bucket {
        double tokens;
        long at;
        Bucket(double tokens, long at) { this.tokens = tokens; this.at = at; }
    }

    public RateLimit(double burst, double perSecond) {
        if (!(burst >= 1 && perSecond > 0)) throw new IllegalArgumentException("rate must look like 30/5 (burst/perSecond)");
        this.burst = burst;
        this.perSecond = perSecond;
    }

    /** "burst/perSecond", e.g. "60/10". */
    public static RateLimit parse(String spec) {
        String[] parts = spec.trim().split("/");
        if (parts.length != 2) throw new IllegalArgumentException("rate must look like 30/5 (burst/perSecond): " + spec);
        return new RateLimit(Double.parseDouble(parts[0]), Double.parseDouble(parts[1]));
    }

    /** Takes one; seconds to wait when refused. */
    public int take(String key) {
        sweep();
        Bucket b = buckets.computeIfAbsent(key, k -> new Bucket(burst, System.currentTimeMillis()));
        synchronized (b) {
            refill(b);
            if (b.tokens < 1) return wait(b);
            b.tokens -= 1;
            return 0;
        }
    }

    /** Seconds take() would wait now, without spending anything. */
    public int peek(String key) {
        Bucket b = buckets.get(key);
        if (b == null) return 0;
        synchronized (b) {
            refill(b);
            return b.tokens < 1 ? wait(b) : 0;
        }
    }

    private void refill(Bucket b) {
        long now = System.currentTimeMillis();
        b.tokens = Math.min(burst, b.tokens + (now - b.at) / 1000.0 * perSecond);
        b.at = now;
    }

    private int wait(Bucket b) {
        return Math.max(1, (int) Math.ceil((1 - b.tokens) / perSecond));
    }

    private void sweep() {
        long now = System.currentTimeMillis();
        if (now - lastSweep < 30000) return;
        lastSweep = now;
        buckets.entrySet().removeIf(e -> {
            Bucket b = e.getValue();
            synchronized (b) { return b.tokens + (now - b.at) / 1000.0 * perSecond >= burst; }
        });
    }
}
