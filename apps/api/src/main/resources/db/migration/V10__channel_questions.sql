CREATE TABLE product_questions (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    broadcast_instance_id uuid NOT NULL,
    text varchar(500) NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
    answer varchar(1000) CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 1000),
    answered_at_ms bigint CHECK (answered_at_ms>0),
    pinned boolean NOT NULL DEFAULT false,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>0),
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    UNIQUE(author_id,client_request_id),
    CHECK ((answer IS NULL AND answered_at_ms IS NULL) OR (answer IS NOT NULL AND answered_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX product_questions_pin_idx ON product_questions(channel_id) WHERE pinned;
CREATE INDEX product_questions_channel_time_idx ON product_questions(channel_id,created_at_ms DESC,id DESC);
CREATE INDEX product_questions_author_time_idx ON product_questions(author_id,created_at_ms DESC,id DESC);
