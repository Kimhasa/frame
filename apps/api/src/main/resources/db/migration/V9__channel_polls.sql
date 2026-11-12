CREATE TABLE product_polls (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    broadcast_instance_id uuid NOT NULL,
    question varchar(100) NOT NULL CHECK (char_length(question) BETWEEN 1 AND 100),
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    ends_at_ms bigint NOT NULL CHECK (ends_at_ms>created_at_ms),
    closed_at_ms bigint,
    close_reason varchar(20) CHECK (close_reason IN ('manual','expired','broadcast_ended')),
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    CHECK ((closed_at_ms IS NULL AND close_reason IS NULL) OR (closed_at_ms IS NOT NULL AND close_reason IS NOT NULL))
);
CREATE UNIQUE INDEX product_polls_open_channel_idx ON product_polls(channel_id) WHERE closed_at_ms IS NULL;
CREATE INDEX product_polls_channel_time_idx ON product_polls(channel_id,created_at_ms DESC,id DESC);
CREATE INDEX product_polls_broadcast_time_idx ON product_polls(path,broadcast_id,created_at_ms DESC,id DESC);
CREATE TABLE product_poll_options (
    id uuid PRIMARY KEY,
    poll_id uuid NOT NULL REFERENCES product_polls(id) ON DELETE CASCADE,
    position smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
    text varchar(100) NOT NULL CHECK (char_length(text) BETWEEN 1 AND 100),
    UNIQUE(poll_id,position),
    UNIQUE(poll_id,id)
);
CREATE TABLE product_poll_votes (
    poll_id uuid NOT NULL REFERENCES product_polls(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    option_id uuid NOT NULL,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    PRIMARY KEY(poll_id,user_id),
    FOREIGN KEY(poll_id,option_id) REFERENCES product_poll_options(poll_id,id) ON DELETE CASCADE
);
