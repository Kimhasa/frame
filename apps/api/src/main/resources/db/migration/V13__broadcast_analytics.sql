-- Product-only, sampled server observations. No viewer identities or playback reports are retained.
CREATE TABLE product_broadcast_analytics (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    title text NOT NULL,
    source_session varchar(64) NOT NULL CHECK (source_session ~ '^[0-9a-f]{64}$'),
    started_at_ms bigint NOT NULL CHECK (started_at_ms > 0),
    last_observed_at_ms bigint NOT NULL CHECK (last_observed_at_ms >= started_at_ms),
    ended_at_ms bigint,
    status varchar(12) NOT NULL DEFAULT 'live' CHECK (status IN ('live','ended','interrupted')),
    end_reason varchar(24),
    broadcast_duration_ms bigint NOT NULL DEFAULT 0 CHECK (broadcast_duration_ms >= 0),
    observed_duration_ms bigint NOT NULL DEFAULT 0 CHECK (observed_duration_ms >= 0 AND observed_duration_ms <= broadcast_duration_ms),
    viewer_ms bigint NOT NULL DEFAULT 0 CHECK (viewer_ms >= 0),
    peak_concurrent integer NOT NULL CHECK (peak_concurrent >= 0),
    last_concurrent integer NOT NULL CHECK (last_concurrent >= 0),
    interval_ready boolean NOT NULL DEFAULT true,
    CHECK ((status='live' AND ended_at_ms IS NULL AND end_reason IS NULL)
        OR (status='ended' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL AND ended_at_ms=last_observed_at_ms AND end_reason IN ('broadcast_ended','channel_disconnected'))
        OR (status='interrupted' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL AND ended_at_ms=last_observed_at_ms AND end_reason='server_restart'))
);
CREATE INDEX product_broadcast_analytics_channel_time_idx ON product_broadcast_analytics(channel_id,started_at_ms DESC,id DESC);
CREATE INDEX product_broadcast_analytics_live_idx ON product_broadcast_analytics(id) WHERE status='live';
CREATE TABLE product_broadcast_analytics_daily (
    broadcast_id uuid NOT NULL REFERENCES product_broadcast_analytics(id) ON DELETE CASCADE,
    day date NOT NULL,
    broadcast_duration_ms bigint NOT NULL DEFAULT 0 CHECK (broadcast_duration_ms >= 0),
    observed_duration_ms bigint NOT NULL DEFAULT 0 CHECK (observed_duration_ms >= 0 AND observed_duration_ms <= broadcast_duration_ms),
    viewer_ms bigint NOT NULL DEFAULT 0 CHECK (viewer_ms >= 0),
    peak_concurrent integer NOT NULL CHECK (peak_concurrent >= 0),
    PRIMARY KEY (broadcast_id,day)
);
CREATE INDEX product_broadcast_analytics_daily_day_idx ON product_broadcast_analytics_daily(day,broadcast_id);
