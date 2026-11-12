ALTER TABLE product_channels ADD COLUMN notification_live_after_ms bigint NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
ALTER TABLE product_follows ADD COLUMN notifications_enabled_at timestamptz;
UPDATE product_follows SET notifications_enabled_at=clock_timestamp() WHERE notifications_on;

-- Delivery markers are independent of user-visible rows, so deletion never replays an event.
CREATE TABLE product_notification_events (
    event_key varchar(160) PRIMARY KEY,
    created_at_ms bigint NOT NULL CHECK (created_at_ms > 0)
);
CREATE TABLE product_notifications (
    id uuid PRIMARY KEY,
    recipient_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    event_key varchar(160) NOT NULL REFERENCES product_notification_events(event_key),
    kind varchar(10) NOT NULL CHECK (kind IN ('live','report')),
    title varchar(200) NOT NULL,
    body varchar(1000) NOT NULL,
    created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
    read_at_ms bigint CHECK (read_at_ms > 0),
    channel_id uuid,
    channel_handle varchar(24),
    broadcast_id varchar(32),
    path varchar(64),
    broadcast_instance_id uuid,
    source_session varchar(64),
    report_id uuid,
    report_status varchar(10),
    UNIQUE (recipient_id,event_key),
    CHECK ((kind='live' AND channel_id IS NOT NULL AND channel_handle IS NOT NULL AND broadcast_id IS NOT NULL AND path IS NOT NULL AND broadcast_instance_id IS NOT NULL AND source_session IS NOT NULL AND report_id IS NULL AND report_status IS NULL)
        OR (kind='report' AND report_id IS NOT NULL AND report_status IS NOT NULL AND report_status IN ('resolved','dismissed') AND channel_id IS NULL AND channel_handle IS NULL AND broadcast_id IS NULL AND path IS NULL AND broadcast_instance_id IS NULL AND source_session IS NULL))
);
CREATE INDEX product_notifications_recipient_time_idx ON product_notifications(recipient_id,created_at_ms DESC,id DESC);
CREATE INDEX product_notifications_unread_idx ON product_notifications(recipient_id) WHERE read_at_ms IS NULL;
