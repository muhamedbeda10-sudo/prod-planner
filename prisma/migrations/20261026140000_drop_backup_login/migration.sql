-- Settings → Database backup and the nightly GitHub backup are gone, and with
-- them the backup's own login (20261012120000_backup_reader): it read every
-- table, so it does not stay behind. Each step stands on its own, so one the
-- database refuses never undoes the ones before it, nor stops a deploy: the
-- login is locked and its password cleared first, then its sessions closed,
-- its rights taken back, and the role dropped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    RETURN;
  END IF;
  BEGIN
    ALTER ROLE backup_reader NOLOGIN PASSWORD NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'backup_reader could not be locked: %', SQLERRM;
  END;
  BEGIN
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'backup_reader';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'backup_reader''s sessions could not be closed: %', SQLERRM;
  END;
  BEGIN
    DROP OWNED BY backup_reader;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'backup_reader''s rights could not be taken back: %', SQLERRM;
  END;
  BEGIN
    DROP ROLE backup_reader;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'backup_reader could not be dropped: %', SQLERRM;
  END;
END $$;

-- Settings.backupLoginAt / backupLoginBy leave the schema but stay in the
-- table for now: the deployment still serving while this one builds reads
-- them on every Settings load. A later migration drops them.
