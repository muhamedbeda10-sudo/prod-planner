-- CONSUMABLES limits: no daily limits, and the checks catch up with the app.
--
-- 1. The store draws a week's stock in one go, so a daily limit reads every
--    such draw as over. Each daily limit becomes a weekly one of six working
--    days (the factory's week; the monthly review already counts a month as
--    26 of them): 15 a day -> 90 a week. Every change is written to the
--    catalogue's history, as an edit in the Limits view would be.
-- 2. The counting "each department its own" ('each') and the periods of
--    2, 4 and 6 months and a year are offered by the app but were refused by
--    the checks — saving one failed. The checks now take them, and no longer
--    take 'day'.

ALTER TABLE "ConsumableLimit" DROP CONSTRAINT "ConsumableLimit_basis_check";
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_basis_check" CHECK ("basis" IN ('pool', 'each', 'person'));

INSERT INTO "ConsumableCatalogueChange" ("itemId", "entity", "entityId", "action", "before", "after", "by", "at")
SELECT "itemId", 'limit', "id", 'update',
       jsonb_build_object('departments', "departments", 'basis', "basis", 'period', 'day', 'qty', "qty"),
       jsonb_build_object('departments', "departments", 'basis', "basis", 'period', 'week', 'qty', "qty" * 6),
       'System — daily limits made weekly (× 6 working days)', CURRENT_TIMESTAMP
FROM "ConsumableLimit"
WHERE "period" = 'day';

UPDATE "ConsumableLimit" SET "period" = 'week', "qty" = "qty" * 6, "updatedAt" = CURRENT_TIMESTAMP WHERE "period" = 'day';

ALTER TABLE "ConsumableLimit" DROP CONSTRAINT "ConsumableLimit_period_check";
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_period_check" CHECK ("period" IN ('week', 'month', 'bimonth', 'quarter', 'fourmonth', 'halfyear', 'year'));
