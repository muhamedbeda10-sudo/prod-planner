-- CONSUMABLES limits: a month at the least.
--
-- The store is tracked month by month and draws stock in bulk, so nothing is
-- counted over less than a calendar month; a limit runs a month, or every 2,
-- 3, 4 or 6 months, or a year.
--
-- 1. Each weekly limit becomes a monthly one of four weeks — the same
--    multiple the monthly review already used for them, so the month's
--    numbers do not move: 90 a week -> 360 a month. Every change is written
--    to the catalogue's history, as an edit in the Limits view would be.
-- 2. The period check no longer takes 'week'.
-- 3. The "over limit" flags on hand-outs were set against the daily and
--    weekly limits that no longer exist; they are cleared, so nothing is
--    flagged against a number the store does not keep. (The reason and the
--    breach as recorded stay on the row.) A month over its new limit shows
--    on the dashboard's alarms, which are counted afresh.

INSERT INTO "ConsumableCatalogueChange" ("itemId", "entity", "entityId", "action", "before", "after", "by", "at")
SELECT "itemId", 'limit', "id", 'update',
       jsonb_build_object('departments', "departments", 'basis', "basis", 'period', 'week', 'qty', "qty"),
       jsonb_build_object('departments', "departments", 'basis', "basis", 'period', 'month', 'qty', "qty" * 4),
       'System — weekly limits made monthly (× 4 weeks)', CURRENT_TIMESTAMP
FROM "ConsumableLimit"
WHERE "period" = 'week';

UPDATE "ConsumableLimit" SET "period" = 'month', "qty" = "qty" * 4, "updatedAt" = CURRENT_TIMESTAMP WHERE "period" = 'week';

ALTER TABLE "ConsumableLimit" DROP CONSTRAINT "ConsumableLimit_period_check";
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_period_check" CHECK ("period" IN ('month', 'bimonth', 'quarter', 'fourmonth', 'halfyear', 'year'));

UPDATE "ConsumableIssue" SET "overLimit" = false WHERE "overLimit" = true;
