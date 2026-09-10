-- The two shifts' hours and the usual overtime become the planner's to set:
-- the plant changes its roster, and every man-hour the app counts is measured
-- with them. The defaults are what the plant runs today (9 h, 11 h, +3 h).
ALTER TABLE "Settings" ADD COLUMN "shiftShortH" DOUBLE PRECISION NOT NULL DEFAULT 9;
ALTER TABLE "Settings" ADD COLUMN "shiftLongH"  DOUBLE PRECISION NOT NULL DEFAULT 11;
ALTER TABLE "Settings" ADD COLUMN "overtimeH"   DOUBLE PRECISION NOT NULL DEFAULT 3;
