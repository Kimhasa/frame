-- Developer credentials remain separate from browser sessions and publisher tokens.
CREATE TABLE product_api_keys (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    name varchar(40) NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 3),
    token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    prefix varchar(16) NOT NULL,
    last4 char(4) NOT NULL,
    client_request_id uuid NOT NULL,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    last_used_at_ms bigint CHECK (last_used_at_ms>=created_at_ms),
    revoked_at_ms bigint CHECK (revoked_at_ms>=created_at_ms),
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    UNIQUE(owner_id,client_request_id)
);
CREATE INDEX product_api_keys_owner_idx ON product_api_keys(owner_id,created_at_ms DESC,id DESC);
CREATE TABLE product_webhooks (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    name varchar(40) NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    url varchar(2048) NOT NULL,
    events jsonb NOT NULL CHECK (jsonb_typeof(events)='array' AND jsonb_array_length(events) BETWEEN 1 AND 2),
    enabled boolean NOT NULL,
    signing_secret bytea NOT NULL CHECK (octet_length(signing_secret)=32),
    client_request_id uuid NOT NULL,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>=created_at_ms),
    revoked_at_ms bigint CHECK (revoked_at_ms>=created_at_ms),
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    UNIQUE(owner_id,client_request_id),
    UNIQUE(id,owner_id)
);
CREATE INDEX product_webhooks_owner_idx ON product_webhooks(owner_id,created_at_ms DESC,id DESC);
-- Saved responses contain public credential metadata only; secrets are never recoverable here.
CREATE TABLE product_developer_mutations (
    owner_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    resource_type varchar(8) NOT NULL CHECK (resource_type IN ('key','webhook')),
    resource_id uuid NOT NULL,
    request_id uuid NOT NULL,
    operation varchar(8) NOT NULL CHECK (operation IN ('update','revoke')),
    response jsonb NOT NULL,
    PRIMARY KEY(owner_id,resource_type,resource_id,request_id)
);
CREATE TABLE product_webhook_deliveries (
    id uuid PRIMARY KEY,
    webhook_id uuid NOT NULL,
    owner_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    event_id uuid NOT NULL,
    event varchar(32) NOT NULL CHECK (event IN ('webhook.test','broadcast.started','broadcast.ended')),
    client_request_id uuid,
    payload text NOT NULL CHECK (octet_length(payload)<=16384),
    status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','succeeded','failed','cancelled')),
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    started_at_ms bigint CHECK (started_at_ms>=created_at_ms),
    completed_at_ms bigint CHECK (completed_at_ms>=created_at_ms AND (started_at_ms IS NULL OR completed_at_ms>=started_at_ms)),
    http_status integer CHECK (http_status BETWEEN 100 AND 599),
    error_code varchar(48),
    FOREIGN KEY(webhook_id,owner_id) REFERENCES product_webhooks(id,owner_id) ON DELETE CASCADE,
    CHECK ((status='pending' AND started_at_ms IS NULL AND completed_at_ms IS NULL AND http_status IS NULL AND error_code IS NULL)
        OR (status='inflight' AND started_at_ms IS NOT NULL AND completed_at_ms IS NULL AND http_status IS NULL AND error_code IS NULL)
        OR (status IN ('succeeded','failed','cancelled') AND completed_at_ms IS NOT NULL)),
    UNIQUE(webhook_id,event_id),
    UNIQUE(webhook_id,client_request_id)
);
CREATE INDEX product_webhook_deliveries_pending_idx ON product_webhook_deliveries(created_at_ms,id) WHERE status='pending';
CREATE INDEX product_webhook_deliveries_history_idx ON product_webhook_deliveries(webhook_id,created_at_ms DESC,id DESC);
