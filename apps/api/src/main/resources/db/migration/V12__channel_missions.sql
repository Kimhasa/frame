CREATE TABLE product_missions (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    broadcast_instance_id uuid NOT NULL,
    title varchar(100) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    description varchar(1000) NOT NULL DEFAULT '',
    duration_minutes integer NOT NULL CHECK (duration_minutes IN (15,30,60)),
    deadline_at_ms bigint NOT NULL,
    status varchar(12) NOT NULL DEFAULT 'received' CHECK (status IN ('received','running','completed','rejected','canceled','expired','failed')),
    reason varchar(500) NOT NULL DEFAULT '',
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>=created_at_ms),
    CHECK (deadline_at_ms=created_at_ms+duration_minutes*60000::bigint),
    UNIQUE(author_id,client_request_id)
);
CREATE INDEX product_missions_channel_time_idx ON product_missions(channel_id,created_at_ms DESC,id DESC);
CREATE INDEX product_missions_author_time_idx ON product_missions(author_id,created_at_ms DESC,id DESC);
CREATE INDEX product_missions_open_idx ON product_missions(channel_id) WHERE status IN ('received','running');

CREATE TABLE product_mission_history (
    id uuid PRIMARY KEY,
    mission_id uuid NOT NULL REFERENCES product_missions(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version>=0),
    status varchar(12) NOT NULL CHECK (status IN ('received','running','completed','rejected','canceled','expired','failed')),
    reason varchar(500) NOT NULL,
    actor varchar(8) NOT NULL CHECK (actor IN ('viewer','owner','system')),
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    UNIQUE(mission_id,version)
);
