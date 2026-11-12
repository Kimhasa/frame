CREATE TABLE product_accounts (
    id uuid PRIMARY KEY,
    email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash varchar(512) NOT NULL,
    display_name varchar(30) NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 30),
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE TABLE product_channels (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL UNIQUE REFERENCES product_accounts(id) ON DELETE CASCADE,
    handle varchar(24) NOT NULL UNIQUE CHECK (handle ~ '^[a-z][a-z0-9_-]{2,23}$'),
    display_name varchar(30) NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 30),
    description varchar(500) NOT NULL DEFAULT '',
    notice varchar(1000) NOT NULL DEFAULT '',
    category varchar(30) NOT NULL DEFAULT '개발·작업' CHECK (category IN ('개발·작업', '게임', '일상·이야기', '디자인·창작', '지식·탐색')),
    banner_preset varchar(10) CHECK (banner_preset IN ('studio', 'forest', 'city')),
    stream_path varchar(64) UNIQUE,
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE TABLE product_follows (
    user_id uuid NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES product_channels(id) ON DELETE CASCADE,
    notifications_on boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX product_follows_channel_idx ON product_follows(channel_id);
