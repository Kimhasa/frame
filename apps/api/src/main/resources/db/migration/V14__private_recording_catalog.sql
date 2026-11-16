-- Product metadata only: original MediaMTX files are never moved or removed by this feature.
CREATE TABLE product_recording_windows (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    broadcast_instance_id uuid NOT NULL,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    source_session varchar(64) NOT NULL CHECK (source_session ~ '^[0-9a-f]{64}$'),
    title text NOT NULL,
    connection_at_ms bigint NOT NULL CHECK (connection_at_ms > 0),
    started_at_ms bigint NOT NULL CHECK (started_at_ms > 0),
    last_observed_at_ms bigint NOT NULL CHECK (last_observed_at_ms >= started_at_ms),
    ended_at_ms bigint,
    reason varchar(32),
    UNIQUE(id,path),
    CHECK ((ended_at_ms IS NULL AND reason IS NULL) OR (ended_at_ms IS NOT NULL AND ended_at_ms=last_observed_at_ms AND reason IS NOT NULL))
);
CREATE INDEX product_recording_windows_open_idx ON product_recording_windows(path) WHERE ended_at_ms IS NULL;
CREATE TABLE product_recording_files (
    id uuid PRIMARY KEY,
    window_id uuid NOT NULL,
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    file_name varchar(100) NOT NULL CHECK (file_name ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{6}(Z|[+-][0-9]{4})[.]mp4$'),
    recorded_at_ms bigint NOT NULL CHECK (recorded_at_ms > 0),
    size_bytes bigint CHECK (size_bytes >= 0),
    duration_ms bigint CHECK (duration_ms >= 0),
    file_modified_ms bigint,
    file_key text,
    status varchar(12) NOT NULL CHECK (status IN ('ready','recording','ambiguous','missing','corrupt')),
    reason varchar(32) NOT NULL,
    hidden boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    checked_at_ms bigint NOT NULL CHECK (checked_at_ms > 0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
    FOREIGN KEY(window_id,path) REFERENCES product_recording_windows(id,path) ON DELETE CASCADE,
    CHECK (status<>'ready' OR (size_bytes IS NOT NULL AND size_bytes>0 AND duration_ms IS NOT NULL AND duration_ms>0 AND file_modified_ms IS NOT NULL AND file_key IS NOT NULL)),
    UNIQUE(path,file_name)
);
CREATE INDEX product_recording_files_window_time_idx ON product_recording_files(window_id,recorded_at_ms DESC,id DESC);
