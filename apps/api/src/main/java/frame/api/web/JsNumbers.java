package frame.api.web;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** Numbers written as the Node relay writes them, where Java's own formatting differs. */
public final class JsNumbers {
    private JsNumbers() {}

    /**
     * Number.prototype.toFixed: the exact binary value rounded half up ({@code String.format("%.3f")} rounds Java's shortest
     * decimal instead: 1.0005 is 1.000 in JavaScript, 1.001 in Java).
     */
    public static String toFixed(double v, int digits) {
        return new BigDecimal(v).setScale(digits, RoundingMode.HALF_UP).toPlainString();
    }

    /**
     * A JSON number as JSON.stringify writes it: integers as integers, others in plain digits (Jackson writes a Double of
     * 1e7 or more in scientific notation, e.g. 1.761618455354294E12 for an epoch time with a fraction).
     */
    public static Object json(double v) {
        if (v == Math.rint(v) && Math.abs(v) < 1e15) return (long) v;
        return BigDecimal.valueOf(v);
    }
}
