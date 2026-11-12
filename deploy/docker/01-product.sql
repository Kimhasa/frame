-- Runs only when the PostgreSQL volume is first initialized.
-- Product tables belong exclusively to Spring Boot's Flyway migrations.
DO $$
BEGIN
    EXECUTE format(
        'CREATE ROLE frame_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',
        rtrim(pg_read_file('/run/secrets/postgres_app_password'), E'\r\n')
    );
END
$$;

CREATE DATABASE frame_product OWNER frame_app;
CREATE DATABASE frame_product_verify OWNER frame_app;
REVOKE ALL ON DATABASE frame_product FROM PUBLIC;
REVOKE ALL ON DATABASE frame_product_verify FROM PUBLIC;

\connect frame_product
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO frame_app;

\connect frame_product_verify
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO frame_app;
