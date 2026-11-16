-- Explicitly published copies are independent of the six-hour source recording lifecycle.
CREATE TABLE product_vods (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    recording_id uuid UNIQUE REFERENCES product_recording_files(id) ON DELETE SET NULL,
    title varchar(100) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    description varchar(2000) NOT NULL DEFAULT '',
    status varchar(10) NOT NULL CHECK (status IN ('preparing','ready','failed')),
    visibility varchar(7) NOT NULL CHECK (visibility IN ('public','private')),
    duration_ms bigint NOT NULL CHECK (duration_ms > 0),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 68719476736),
    archive_modified_ms bigint,
    archive_key text,
    archive_sha256 varchar(64),
    published_at_ms bigint CHECK (published_at_ms > 0),
    created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= created_at_ms),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    reason varchar(40),
    CHECK ((status='ready' AND archive_modified_ms IS NOT NULL AND archive_key IS NOT NULL
            AND archive_sha256 IS NOT NULL AND archive_sha256 ~ '^[0-9a-f]{64}$' AND reason IS NULL)
        OR (status='preparing' AND reason IS NULL)
        OR (status='failed' AND reason IS NOT NULL)),
    CHECK (status<>'ready' OR visibility<>'public' OR published_at_ms IS NOT NULL)
);
CREATE INDEX product_vods_public_idx ON product_vods(published_at_ms DESC,id DESC)
    WHERE status='ready' AND visibility='public';
CREATE INDEX product_vods_channel_idx ON product_vods(channel_id,created_at_ms DESC,id DESC);
