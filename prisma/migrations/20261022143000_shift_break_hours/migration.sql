-- The factory works 07:00–16:00 by day and 19:00–07:00 by night.
-- Each shift includes a one-hour break, so their net working time is 8 and
-- 11 hours. Overtime is the day team's fixed 16:00–19:00 period.
ALTER TABLE "Settings" ALTER COLUMN "shiftShortH" SET DEFAULT 8;

-- Move installations that still have all the old defaults to the real net
-- hours. Deliberately leave any customised schedule untouched.
UPDATE "Settings"
SET "shiftShortH" = 8
WHERE "shiftShortH" = 9
  AND "shiftLongH" = 11
  AND "overtimeH" = 3;
