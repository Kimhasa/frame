package frame.api;

/** Settings for unit tests: the application.yml defaults with one publisher token per path list. */
public final class TestProps {
    public static final String TOKEN_A = "token-a-0123456789abcdef0123456789";
    public static final String TOKEN_B = "token-b-0123456789abcdef0123456789";
    /** A second sender allowed on screen-01 too (path takeover and reservation rules). */
    public static final String TOKEN_C = "token-c-0123456789abcdef0123456789";

    private TestProps() {}

    public static FrameProperties props() {
        return props("");
    }

    /** With the relay ladder's qualities (RELAY_RENDITIONS), e.g. "720p,480p". */
    public static FrameProperties props(String renditions) {
        return new FrameProperties("", "127.0.0.1,::1", TOKEN_A + " screen-01 screen-03," + TOKEN_B + " screen-02," + TOKEN_C + " screen-01", "",
                true, false, "[]", 15000, 15000, 30000, true, 12000,
                new FrameProperties.MediaMtx("http://127.0.0.1:9997", "http://127.0.0.1:8888", "http://127.0.0.1:8889", "http://127.0.0.1:9996", "", "", 15000),
                new FrameProperties.Quality(renditions, "ffmpeg", "rtsp://127.0.0.1:8554", 300000),
                new FrameProperties.Dvr(true, ""),
                new FrameProperties.Turn("", "", 3600),
                new FrameProperties.Stats("", 50, 30),
                new FrameProperties.LegacyUi("", "", ""),
                new FrameProperties.Limits(4000, 2, 1000, 200, 2000, 50, 64, 64, 8, 20000, 400),
                new FrameProperties.Rates("60/10", "30/5", "10/0.1667", "60/2", "30/1", "20/2", "30/2", "120/20", "120/20"));
    }
}
