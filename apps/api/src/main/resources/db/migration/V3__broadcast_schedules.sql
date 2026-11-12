CREATE TABLE product_broadcast_schedules (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    title varchar(100) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    starts_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    UNIQUE (channel_id, starts_at)
);
