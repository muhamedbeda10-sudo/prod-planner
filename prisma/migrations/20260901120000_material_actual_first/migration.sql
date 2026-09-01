-- The MATERIAL tab records what an order ACTUALLY consumed, so the two numbers
-- swap roles: the sheets really used become mandatory, and the nesting BOM's
-- sheets-per-unit becomes the optional yardstick beside them. A line with no
-- BOM figure still stands on its own as "used N sheets"; it simply has nothing
-- to compare against.

ALTER TABLE "MaterialUsage" ALTER COLUMN "sheetsPerUnit" DROP NOT NULL;

-- Any line carried over from before this change was, by definition, entered
-- without a real consumption figure. Zero is the only honest value to give it,
-- and the note says so rather than leaving it silently indistinguishable from
-- a genuine "used nothing".
UPDATE "MaterialUsage"
   SET "sheetsUsed" = 0,
       "note" = COALESCE(NULLIF("note", '') || ' — ', '') || 'actual usage not recorded before this line became mandatory'
 WHERE "sheetsUsed" IS NULL;

ALTER TABLE "MaterialUsage" ALTER COLUMN "sheetsUsed" SET NOT NULL;
