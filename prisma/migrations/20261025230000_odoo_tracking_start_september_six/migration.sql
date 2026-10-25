-- The plant confirmed that Odoo recording began on 6 September 2026.
-- Set that shared starting point once; no closing or production record changes.
INSERT INTO "Settings" ("id", "odooTrackingFrom")
VALUES (1, '2026-09-06')
ON CONFLICT ("id") DO UPDATE SET "odooTrackingFrom" = EXCLUDED."odooTrackingFrom";
