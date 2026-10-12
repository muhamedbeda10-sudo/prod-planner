-- The nightly backup's own login (.github/workflows/backup.yml): backup_reader
-- reads every table of the app and changes nothing, so the address kept in
-- GitHub's secrets cannot write, delete or log in as the app. It is made
-- without a password and cannot log in until the owner makes one on Settings
-- → Database backup: shown to them once, and kept nowhere but in GitHub — the
-- database holds only its SCRAM verifier.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    CREATE ROLE backup_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO backup_reader', current_database());
END $$;

-- It only ever reads.
ALTER ROLE backup_reader SET default_transaction_read_only = on;

-- The app's own login may close its sessions (closing one takes the rights of
-- its login): when the password is changed or the login turned off, nothing
-- that got in before stays in. That is all it adds — the app's login owns
-- every table already.
GRANT backup_reader TO CURRENT_USER;

-- Every table and sequence of the app, today's and those added later. All of
-- them, the private ones too: pg_dump locks each table it writes down — even
-- one whose rows it leaves out, as it does the chat's files — and a lock
-- needs the right to read it.
GRANT USAGE ON SCHEMA public TO backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO backup_reader;

-- When its password was last made, or the login turned off, and by whom.
-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "backupLoginAt" TIMESTAMP(3),
ADD COLUMN "backupLoginBy" TEXT;
