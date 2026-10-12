-- Saving and deleting what-if scenarios now has its own permission
-- (simulator.edit, "Simulator — save and delete scenarios"); until now anyone
-- signed in could. So nobody loses it on the day it changes, every account
-- that sees the Simulator tab is ticked with it here; the owner then unticks,
-- on Users & Permissions, whoever should only look.
UPDATE "User"
SET "perms" = CASE WHEN btrim("perms") = '' THEN 'simulator.edit' ELSE "perms" || ',simulator.edit' END
WHERE NOT ('simulator.edit' = ANY (string_to_array(replace("perms", ' ', ''), ',')))
  AND NOT ('simulate' = ANY (string_to_array(replace("hiddenTabs", ' ', ''), ',')));
