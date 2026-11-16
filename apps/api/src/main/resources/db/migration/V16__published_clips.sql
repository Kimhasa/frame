-- Clips are generated from explicitly public, owned VODs. Source files and V1..V15 remain unchanged.
ALTER TABLE product_vods ADD CONSTRAINT product_vods_id_channel_unique UNIQUE(id,channel_id);
CREATE TABLE product_clips (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    source_vod_id uuid NOT NULL,
    client_request_id uuid NOT NULL,
    request_title varchar(100) NOT NULL,
    request_description varchar(2000) NOT NULL,
    title varchar(100) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    description varchar(2000) NOT NULL DEFAULT '',
    start_ms bigint NOT NULL CHECK (start_ms >= 0),
    end_ms bigint NOT NULL,
    source_size_bytes bigint NOT NULL CHECK (source_size_bytes > 0),
    source_modified_ms bigint NOT NULL,
    source_key text NOT NULL,
    source_sha256 varchar(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    status varchar(10) NOT NULL CHECK (status IN ('preparing','ready','failed')),
    visibility varchar(7) NOT NULL CHECK (visibility IN ('public','private')),
    duration_ms bigint NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 61000),
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0 AND size_bytes <= 536870912),
    archive_modified_ms bigint,
    archive_key text,
    archive_sha256 varchar(64),
    published_at_ms bigint CHECK (published_at_ms > 0),
    created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= created_at_ms),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    reason varchar(40),
    UNIQUE(channel_id,client_request_id),
    FOREIGN KEY(source_vod_id,channel_id) REFERENCES product_vods(id,channel_id) ON DELETE CASCADE,
    CHECK (end_ms > start_ms AND end_ms-start_ms BETWEEN 5000 AND 60000),
    CHECK ((status='ready' AND size_bytes>0 AND archive_modified_ms IS NOT NULL AND archive_key IS NOT NULL
            AND archive_sha256 IS NOT NULL AND archive_sha256 ~ '^[0-9a-f]{64}$' AND reason IS NULL)
        OR (status='preparing' AND reason IS NULL)
        OR (status='failed' AND reason IS NOT NULL)),
    CHECK (status<>'ready' OR visibility<>'public' OR published_at_ms IS NOT NULL)
);
CREATE INDEX product_clips_public_idx ON product_clips(published_at_ms DESC,id DESC) WHERE status='ready' AND visibility='public';
CREATE INDEX product_clips_channel_idx ON product_clips(channel_id,created_at_ms DESC,id DESC);
CREATE INDEX product_clips_source_idx ON product_clips(source_vod_id,created_at_ms DESC,id DESC);
