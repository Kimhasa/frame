package frame.api.web;

import java.util.concurrent.ConcurrentHashMap;

/** A count per key (requests per address, pending WHEP offers per path); keys at zero are dropped. */
public final class Counter {
    private final ConcurrentHashMap<String, Integer> map = new ConcurrentHashMap<>();

    public int get(String key) { return map.getOrDefault(key, 0); }

    public int add(String key, int n) {
        Integer v = map.compute(key, (k, old) -> { int x = (old == null ? 0 : old) + n; return x <= 0 ? null : x; });
        return v == null ? 0 : v;
    }
}
