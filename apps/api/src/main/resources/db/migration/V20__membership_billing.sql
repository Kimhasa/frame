-- Product customer memberships are independent of the local operator donation ledger.
CREATE TABLE product_membership_plans (
    channel_id uuid PRIMARY KEY REFERENCES product_channels(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    amount bigint NOT NULL CHECK (amount BETWEEN 1000 AND 1000000),
    benefits varchar(500) NOT NULL DEFAULT '',
    version integer NOT NULL CHECK (version>0),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms>0)
);
CREATE TABLE product_memberships (
    id uuid PRIMARY KEY,
    subscriber_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    client_request_id uuid NOT NULL,
    consent_version varchar(20) NOT NULL,
    consented_at_ms bigint NOT NULL CHECK (consented_at_ms>0 AND consented_at_ms>=created_at_ms),
    customer_key varchar(64) NOT NULL UNIQUE,
    plan_version integer NOT NULL CHECK (plan_version>0),
    amount bigint NOT NULL CHECK (amount BETWEEN 1000 AND 1000000),
    benefits varchar(500) NOT NULL,
    order_name varchar(100) NOT NULL,
    status varchar(20) NOT NULL CHECK (status IN ('pending_auth','issuing','issue_unknown','pending_charge','active','ended','failed')),
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    auth_hash char(64) UNIQUE CHECK (auth_hash ~ '^[0-9a-f]{64}$'),
    issue_idempotency_key uuid NOT NULL UNIQUE,
    billing_key text UNIQUE,
    card_label varchar(100),
    billing_key_deletion varchar(8) NOT NULL DEFAULT 'none' CHECK (billing_key_deletion IN ('none','pending','done','unknown')),
    delete_idempotency_key uuid NOT NULL UNIQUE,
    delete_attempts integer NOT NULL DEFAULT 0 CHECK (delete_attempts BETWEEN 0 AND 5),
    next_delete_at_ms bigint,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    period_started_at_ms bigint,
    period_ends_at_ms bigint,
    next_charge_at_ms bigint,
    cancel_requested_at_ms bigint CHECK (cancel_requested_at_ms>=created_at_ms),
    ended_at_ms bigint CHECK (ended_at_ms>=created_at_ms),
    last_error_code varchar(64),
    CHECK ((period_started_at_ms IS NULL AND period_ends_at_ms IS NULL) OR (period_started_at_ms IS NOT NULL AND period_ends_at_ms IS NOT NULL AND period_started_at_ms>0 AND period_ends_at_ms>period_started_at_ms)),
    CHECK (cancel_requested_at_ms IS NULL OR next_charge_at_ms IS NULL),
    UNIQUE(subscriber_id,client_request_id),
    UNIQUE(id,subscriber_id)
);
CREATE UNIQUE INDEX product_memberships_open_idx ON product_memberships(subscriber_id,channel_id) WHERE ended_at_ms IS NULL;
CREATE INDEX product_memberships_channel_idx ON product_memberships(channel_id,created_at_ms DESC,id DESC);
CREATE INDEX product_memberships_subscriber_idx ON product_memberships(subscriber_id,created_at_ms DESC,id DESC);
CREATE INDEX product_memberships_due_idx ON product_memberships(next_charge_at_ms,id) WHERE next_charge_at_ms IS NOT NULL;
CREATE TABLE product_membership_payments (
    id uuid PRIMARY KEY,
    membership_id uuid NOT NULL,
    subscriber_id uuid NOT NULL,
    cycle integer NOT NULL CHECK (cycle>=0),
    order_id varchar(64) NOT NULL UNIQUE,
    amount bigint NOT NULL CHECK (amount BETWEEN 1000 AND 1000000),
    idempotency_key uuid NOT NULL UNIQUE,
    status varchar(8) NOT NULL CHECK (status IN ('ready','sending','unknown','paid','failed')),
    payment_key text UNIQUE,
    created_at_ms bigint NOT NULL CHECK (created_at_ms>0),
    sent_at_ms bigint,
    next_lookup_at_ms bigint,
    approved_at_ms bigint,
    method varchar(100),
    receipt_url text,
    error_code varchar(64),
    period_started_at_ms bigint,
    period_ends_at_ms bigint,
    FOREIGN KEY(membership_id,subscriber_id) REFERENCES product_memberships(id,subscriber_id) ON DELETE CASCADE,
    UNIQUE(membership_id,cycle),
    CHECK ((period_started_at_ms IS NULL AND period_ends_at_ms IS NULL) OR (period_started_at_ms IS NOT NULL AND period_ends_at_ms IS NOT NULL AND period_started_at_ms>0 AND period_ends_at_ms>period_started_at_ms)),
    CHECK (status<>'paid' OR (payment_key IS NOT NULL AND approved_at_ms IS NOT NULL AND approved_at_ms>0 AND period_started_at_ms IS NOT NULL AND period_ends_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX product_membership_payments_unresolved_idx ON product_membership_payments(membership_id) WHERE status IN ('ready','sending','unknown');
CREATE INDEX product_membership_payments_lookup_idx ON product_membership_payments(next_lookup_at_ms,id) WHERE status='unknown';
CREATE TABLE product_membership_requests (
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    resource_id uuid NOT NULL,
    request_id uuid NOT NULL,
    operation varchar(8) NOT NULL CHECK (operation IN ('plan','cancel')),
    request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response jsonb NOT NULL,
    PRIMARY KEY(user_id,resource_id,request_id)
);
