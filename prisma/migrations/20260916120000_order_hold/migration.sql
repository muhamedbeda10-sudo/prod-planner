-- An order the planner has put ON HOLD: still open on the tracker, out of
-- every worklist queue until released. holdAt set = on hold.
ALTER TABLE "MasterOrder" ADD COLUMN IF NOT EXISTS "holdAt" TIMESTAMP(3);
ALTER TABLE "MasterOrder" ADD COLUMN IF NOT EXISTS "holdNote" TEXT;
ALTER TABLE "MasterOrder" ADD COLUMN IF NOT EXISTS "holdBy" TEXT;
