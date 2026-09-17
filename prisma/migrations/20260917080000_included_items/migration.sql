-- Components forced ON by the planner although the KVA/rating rule says
-- otherwise (AR / MB). The counterpart of excludedItems.
ALTER TABLE "MasterOrder" ADD COLUMN IF NOT EXISTS "includedItems" TEXT;
