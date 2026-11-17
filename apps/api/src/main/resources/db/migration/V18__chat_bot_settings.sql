-- Owner-written command replies; no bot account or synthetic viewer session is created.
CREATE TABLE product_chat_bot_settings (
    channel_id uuid PRIMARY KEY REFERENCES product_channels(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    commands jsonb NOT NULL DEFAULT '[]'::jsonb,
    version integer NOT NULL CHECK (version > 0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
    CHECK (jsonb_typeof(commands) = 'array' AND jsonb_array_length(commands) <= 20)
);
