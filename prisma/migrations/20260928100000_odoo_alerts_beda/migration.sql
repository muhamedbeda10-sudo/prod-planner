-- The ODOO "ready to close" alert goes to the planner who closes the MOs in
-- Odoo. It is a ticked permission (odoo.alerts), not an admin right, so it is
-- switched on for him here; anyone else is ticked on Users & Permissions.
UPDATE "User"
SET "perms" = CASE WHEN "perms" = '' THEN 'odoo.alerts' ELSE "perms" || ',odoo.alerts' END
WHERE "name" = 'Muhamed Beda' AND position('odoo.alerts' in "perms") = 0;
