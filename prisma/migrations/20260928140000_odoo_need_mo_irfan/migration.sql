-- The ODOO "needs an MO" alert goes to the one who types Odoo's MO numbers.
-- A ticked permission (odoo.needMo), not an admin right, switched on for him
-- here; anyone else is ticked on Users & Permissions.
UPDATE "User"
SET "perms" = CASE WHEN "perms" = '' THEN 'odoo.needMo' ELSE "perms" || ',odoo.needMo' END
WHERE "name" = 'Irfan' AND position('odoo.needMo' in "perms") = 0;
