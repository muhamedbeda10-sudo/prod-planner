-- Admins now follow their permission ticks like everyone else (hasPerm no
-- longer lets isAdmin through). So nobody loses anything on the day it
-- changes, every admin is ticked here with every access right; the owner
-- then unticks, on Users & Permissions, what each admin does not do. The
-- notifications (odoo.alerts, odoo.needMo) are not access rights and are
-- kept exactly as they were ticked.
UPDATE "User"
SET "perms" = 'cut.edit,welding.edit,leaktest.edit,painting.edit,quality.qa,workers.manage,shifts.cut,shifts.welding,shifts.shotblast,shifts.painting,shifts.lv,material.edit,odoo.edit,consumables.edit,tracker.cut,tracker.weld,tracker.paint,tracker.shp,tracker.delivered,tracker.status,tracker.components,tracker.qty,tracker.priority,tracker.push,weekly.record,lv.punching,lv.bending,lv.welding,lv.painting,lv.tracker.punch,lv.tracker.bend,lv.tracker.weld,lv.tracker.paint,lv.tracker.delivered,lv.status,lv.import,lv.odoo,lv.material,plans.import,logs.import,calendar.manage,machines.manage'
  || CASE WHEN position('odoo.alerts' in "perms") > 0 THEN ',odoo.alerts' ELSE '' END
  || CASE WHEN position('odoo.needMo' in "perms") > 0 THEN ',odoo.needMo' ELSE '' END
WHERE "isAdmin" = true;
