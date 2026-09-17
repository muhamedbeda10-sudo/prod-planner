-- Quick hours entry: heads present × hours each, straight into the day's figure.
ALTER TABLE "DeptDayHours"
  ADD COLUMN "people" INTEGER,
  ADD COLUMN "hoursEach" DOUBLE PRECISION,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'roster',
  ADD COLUMN "recordedBy" TEXT;
