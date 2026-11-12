ALTER TABLE product_accounts
    ADD COLUMN terms_version varchar(20),
    ADD COLUMN privacy_version varchar(20),
    ADD COLUMN consented_at timestamptz;

-- Existing accounts have no recorded consent. Never manufacture agreement dates or versions for them.
ALTER TABLE product_accounts ADD CONSTRAINT product_accounts_consent_complete CHECK (
    (terms_version IS NULL AND privacy_version IS NULL AND consented_at IS NULL)
    OR (terms_version IS NOT NULL AND privacy_version IS NOT NULL AND consented_at IS NOT NULL)
);
