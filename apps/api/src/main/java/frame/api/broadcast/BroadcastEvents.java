package frame.api.broadcast;

/** What the registry tells other features (the chat rooms): published after the registry's lock is released. */
public final class BroadcastEvents {
    private BroadcastEvents() {}

    /** A broadcast is live on its path. */
    public record Started(Broadcast broadcast) {}

    /** A broadcast ended: bye, expiry without announcements, or the same publisher starting anew. reason is shown to viewers. */
    public record Ended(Broadcast broadcast, String reason) {}
}
