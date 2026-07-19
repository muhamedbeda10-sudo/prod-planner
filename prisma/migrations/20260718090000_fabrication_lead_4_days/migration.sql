-- Fabrication (Cut) gets the plan 4 days ahead of delivery instead of 2.
ALTER TABLE "Settings" ALTER COLUMN "leadCut" SET DEFAULT 4;
UPDATE "Settings" SET "leadCut" = 4 WHERE "leadCut" = 2;
