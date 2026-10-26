-- When the backup's login password was last made, and by whom: unused since
-- 20261026140000_drop_backup_login removed the backup, and no deployment
-- reads them any more.
-- AlterTable
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "backupLoginAt",
DROP COLUMN IF EXISTS "backupLoginBy";
