CREATE TABLE product_watch_history (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    broadcast_instance_id uuid NOT NULL,
    title text NOT NULL,
    publisher text NOT NULL,
    channel_id uuid REFERENCES product_channels(id) ON DELETE SET NULL,
    watched_at_ms bigint NOT NULL CHECK (watched_at_ms > 0),
    UNIQUE (user_id, path, broadcast_id, broadcast_instance_id)
);
CREATE INDEX product_watch_history_user_time_idx ON product_watch_history(user_id, watched_at_ms DESC, id DESC);
