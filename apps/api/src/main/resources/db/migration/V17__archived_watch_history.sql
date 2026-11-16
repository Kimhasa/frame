-- Saved positions are private snapshots, independent of the public media lifecycle.
ALTER TABLE product_accounts ADD COLUMN watch_history_epoch bigint NOT NULL DEFAULT 0 CHECK (watch_history_epoch >= 0);
ALTER TABLE product_watch_history
    ALTER COLUMN broadcast_id DROP NOT NULL,
    ALTER COLUMN path DROP NOT NULL,
    ALTER COLUMN broadcast_instance_id DROP NOT NULL,
    ADD COLUMN kind varchar(4) NOT NULL DEFAULT 'live' CHECK (kind IN ('live','vod','clip')),
    ADD COLUMN media_id uuid,
    ADD COLUMN duration_ms bigint,
    ADD COLUMN position_ms bigint,
    ADD COLUMN completed boolean NOT NULL DEFAULT false,
    ADD COLUMN version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    ADD CONSTRAINT product_watch_history_kind_shape CHECK (
        (kind='live' AND broadcast_id IS NOT NULL AND path IS NOT NULL AND broadcast_instance_id IS NOT NULL
            AND media_id IS NULL AND duration_ms IS NULL AND position_ms IS NULL AND NOT completed AND version=0)
        OR (kind IN ('vod','clip') AND broadcast_id IS NULL AND path IS NULL AND broadcast_instance_id IS NULL
            AND media_id IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms>0 AND position_ms IS NOT NULL
            AND position_ms>=0 AND position_ms<=duration_ms AND (NOT completed OR position_ms=duration_ms))
    );
-- No media foreign key: withdrawn/deleted media must leave an unavailable private history snapshot.
CREATE UNIQUE INDEX product_watch_history_archive_unique ON product_watch_history(user_id,kind,media_id) WHERE kind IN ('vod','clip');
