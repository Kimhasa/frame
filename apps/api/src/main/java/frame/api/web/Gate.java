package frame.api.web;

import java.util.concurrent.atomic.AtomicInteger;

/** Work in flight (WHEP negotiations, DVR streams, HLS requests); enter() fails instead of queueing without bound. */
public final class Gate {
    private final int max;
    private final AtomicInteger active = new AtomicInteger();

    public Gate(int max) { this.max = max; }

    public boolean enter() {
        for (;;) {
            int n = active.get();
            if (n >= max) return false;
            if (active.compareAndSet(n, n + 1)) return true;
        }
    }

    public void leave() { active.updateAndGet(n -> n > 0 ? n - 1 : 0); }

    public int active() { return active.get(); }

    public int max() { return max; }
}
