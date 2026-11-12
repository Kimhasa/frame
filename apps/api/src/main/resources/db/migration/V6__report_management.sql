ALTER TABLE product_accounts ADD COLUMN is_operator boolean NOT NULL DEFAULT false;

ALTER TABLE product_channel_reports
    DROP CONSTRAINT product_channel_reports_status_check,
    ADD COLUMN review_note varchar(1000) NOT NULL DEFAULT '',
    ADD COLUMN reviewed_by uuid REFERENCES product_accounts(id) ON DELETE SET NULL,
    ADD COLUMN updated_at timestamptz,
    ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK (version >= 0);
UPDATE product_channel_reports SET updated_at=created_at;
ALTER TABLE product_channel_reports
    ALTER COLUMN updated_at SET DEFAULT current_timestamp,
    ALTER COLUMN updated_at SET NOT NULL,
    ADD CONSTRAINT product_channel_reports_status_check CHECK (status IN ('received','reviewing','resolved','dismissed')),
    ADD CONSTRAINT product_channel_reports_closed_note_check CHECK (status IN ('received','reviewing') OR btrim(review_note) <> '');
CREATE INDEX product_channel_reports_created_idx ON product_channel_reports(created_at DESC,id DESC);
