-- Dev/local database bootstrap (run once, as a PostgreSQL superuser).
--
--   psql -U postgres -h 127.0.0.1 -v app_password='changeme' -f scripts/dev-db-setup.sql
--
-- Creates the application role and the two databases used in development:
--   aichat       — the dev database (DATABASE_URL)
--   aichat_test  — integration tests (TEST_DATABASE_URL)
--
-- Never run this against production. The VPS deploy guide (deploy/vps/) uses a
-- dedicated migrator role and explicit grants instead (AGENTS §6.11).

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE aichat LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aichat')
\gexec

SELECT 'CREATE DATABASE aichat OWNER aichat'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aichat')
\gexec

SELECT 'CREATE DATABASE aichat_test OWNER aichat'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aichat_test')
\gexec

ALTER DATABASE aichat OWNER TO aichat;
ALTER DATABASE aichat_test OWNER TO aichat;

\echo 'Dev databases ready: aichat, aichat_test (role: aichat)'
