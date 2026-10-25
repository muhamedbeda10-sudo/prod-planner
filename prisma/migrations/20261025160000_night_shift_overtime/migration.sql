BEGIN;
ALTER TABLE "Settings" ADD COLUMN "nightOvertimeH" DOUBLE PRECISION NOT NULL DEFAULT 3;
-- Previously a night record meant the entire 19:00–07:00 period (11 net hours),
-- and any overtimeH on S11 was ignored by the application. Represent those
-- existing full nights as 8 base + 3 OT without changing their total hours.
-- Preserve a deliberately customised base duration; clear previously ignored
-- night OT there so enabling OT does not inflate historical hours.
DO $$
DECLARE previous_night DOUBLE PRECISION;
BEGIN
  SELECT COALESCE((SELECT "shiftLongH" FROM "Settings" WHERE "id" = 1), 11) INTO previous_night;
  UPDATE "ShiftEntry" SET "overtimeH" = CASE WHEN "present" AND previous_night = 11 THEN 3 ELSE 0 END
  WHERE "shift" = 'S11';
  UPDATE "Settings" SET "shiftLongH" = 8 WHERE "id" = 1 AND "shiftLongH" = 11;
END $$;
ALTER TABLE "Settings" ALTER COLUMN "shiftLongH" SET DEFAULT 8;
COMMIT;
