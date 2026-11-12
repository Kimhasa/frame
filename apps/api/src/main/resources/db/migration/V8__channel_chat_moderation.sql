CREATE TABLE product_chat_settings (
    channel_id uuid PRIMARY KEY REFERENCES product_channels(id) ON DELETE CASCADE,
    slow_mode boolean NOT NULL DEFAULT false,
    slow_seconds integer NOT NULL DEFAULT 5 CHECK (slow_seconds BETWEEN 1 AND 120),
    followers_only boolean NOT NULL DEFAULT false,
    block_links boolean NOT NULL DEFAULT false,
    banned_words jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(banned_words)='array' AND jsonb_array_length(banned_words)<=100),
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>0)
);
INSERT INTO product_chat_settings(channel_id,updated_at_ms) SELECT id,(extract(epoch FROM clock_timestamp())*1000)::bigint FROM product_channels;
CREATE TABLE product_chat_blocks (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    blocked_user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    target_channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    reason varchar(200) NOT NULL DEFAULT '',
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    expires_at_ms bigint CHECK (expires_at_ms>created_at_ms),
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    UNIQUE(channel_id,blocked_user_id)
);
CREATE INDEX product_chat_blocks_channel_time_idx ON product_chat_blocks(channel_id,created_at_ms DESC,id DESC);
