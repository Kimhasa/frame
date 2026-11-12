ALTER TABLE product_channels
    ADD COLUMN country_code varchar(2) CHECK (country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 14);

-- Current and retired names share a namespace. Deleted channels leave reserved tombstones.
CREATE TABLE product_channel_handles (
    handle varchar(24) PRIMARY KEY CHECK (handle ~ '^[a-z][a-z0-9_-]{2,23}$'),
    channel_id uuid REFERENCES product_channels(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE INDEX product_channel_handles_channel_idx ON product_channel_handles(channel_id);
INSERT INTO product_channel_handles(handle,channel_id) SELECT handle,id FROM product_channels;

CREATE TABLE product_channel_reports (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    reporter_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    reason varchar(20) NOT NULL CHECK (reason IN ('spam','impersonation','harassment','inappropriate','other')),
    details varchar(1000) NOT NULL DEFAULT '',
    status varchar(10) NOT NULL DEFAULT 'received' CHECK (status = 'received'),
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE INDEX product_channel_reports_reporter_time_idx ON product_channel_reports(reporter_id,created_at DESC);
