CREATE TABLE product_rewards (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    create_payload text NOT NULL,
    name varchar(40) NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    points integer NOT NULL CHECK (points BETWEEN 1 AND 1000000),
    redemption_limit varchar(24) NOT NULL CHECK (redemption_limit IN ('once_per_broadcast','unlimited')),
    enabled boolean NOT NULL,
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>0),
    UNIQUE(channel_id,client_request_id)
);
CREATE INDEX product_rewards_channel_time_idx ON product_rewards(channel_id,created_at_ms DESC,id DESC);

CREATE TABLE product_point_wallets (
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    balance bigint NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 9000000000000),
    pending_watch_ms integer NOT NULL DEFAULT 0 CHECK (pending_watch_ms BETWEEN 0 AND 59999),
    watch_visit uuid,
    watch_instance uuid,
    watch_process uuid,
    watch_session varchar(32),
    watch_sequence bigint NOT NULL DEFAULT -1,
    watch_at_ms bigint,
    PRIMARY KEY(channel_id,user_id)
);

CREATE TABLE product_redemptions (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    reward_id uuid NOT NULL REFERENCES product_rewards(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    requested_reward_version integer NOT NULL CHECK (requested_reward_version>=0),
    reward_name varchar(40) NOT NULL,
    points integer NOT NULL CHECK (points BETWEEN 1 AND 1000000),
    once_per_broadcast boolean NOT NULL,
    broadcast_id varchar(32) NOT NULL CHECK (broadcast_id ~ '^[0-9a-f]{32}$'),
    path varchar(64) NOT NULL CHECK (path ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    broadcast_instance_id uuid NOT NULL,
    note varchar(500) NOT NULL DEFAULT '',
    reason varchar(500) NOT NULL DEFAULT '',
    status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected','canceled')),
    version integer NOT NULL DEFAULT 0 CHECK (version>=0),
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>0),
    UNIQUE(user_id,client_request_id)
);
CREATE UNIQUE INDEX product_redemptions_once_idx ON product_redemptions(user_id,reward_id,broadcast_instance_id) WHERE once_per_broadcast;
CREATE INDEX product_redemptions_channel_time_idx ON product_redemptions(channel_id,created_at_ms DESC,id DESC);
CREATE INDEX product_redemptions_user_time_idx ON product_redemptions(user_id,created_at_ms DESC,id DESC);

CREATE TABLE product_point_ledger (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    kind varchar(12) NOT NULL CHECK (kind IN ('watch','redemption','refund')),
    delta bigint NOT NULL,
    balance_after bigint NOT NULL CHECK (balance_after BETWEEN 0 AND 9000000000000),
    label varchar(100) NOT NULL,
    redemption_id uuid REFERENCES product_redemptions(id) ON DELETE CASCADE,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    CHECK ((kind='watch' AND delta>0 AND redemption_id IS NULL) OR (kind='redemption' AND delta<0 AND redemption_id IS NOT NULL) OR (kind='refund' AND delta>0 AND redemption_id IS NOT NULL)),
    UNIQUE(redemption_id,kind)
);
CREATE INDEX product_point_ledger_user_time_idx ON product_point_ledger(user_id,channel_id,created_at_ms DESC,id DESC);
