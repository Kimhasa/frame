package frame.api.web;

/**
 * Text from a client may carry lone UTF-16 surrogates (a JSON "\ud800" escape, or a value cut inside a pair). JavaScript
 * keeps them and writes them as U+FFFD to UTF-8; Java's UTF-8 encoders refuse them (a WebSocket send or a file append
 * would fail). Text that leaves this service goes through {@link #wellFormed}.
 */
public final class Unicode {
    private Unicode() {}

    /** {@code s} with every lone surrogate replaced by U+FFFD (the same string when there is none). */
    public static String wellFormed(String s) {
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (!Character.isSurrogate(c)) continue;
            if (Character.isHighSurrogate(c) && i + 1 < n && Character.isLowSurrogate(s.charAt(i + 1))) { i++; continue; }
            StringBuilder out = new StringBuilder(n).append(s, 0, i);
            for (int j = i; j < n; j++) {
                char d = s.charAt(j);
                if (Character.isHighSurrogate(d) && j + 1 < n && Character.isLowSurrogate(s.charAt(j + 1))) { out.append(d).append(s.charAt(++j)); }
                else out.append(Character.isSurrogate(d) ? '�' : d);
            }
            return out.toString();
        }
        return s;
    }
}
