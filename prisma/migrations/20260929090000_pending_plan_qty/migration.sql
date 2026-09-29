-- A plan import that brings a different qty for an order already in the
-- registry now holds it for the planner's decision instead of overwriting.
ALTER TABLE "MasterOrder" ADD COLUMN "pendingPlanQty" DOUBLE PRECISION;
ALTER TABLE "MasterOrder" ADD COLUMN "pendingQtyMonth" TEXT;
ALTER TABLE "MasterOrder" ADD COLUMN "pendingQtyAt" TIMESTAMP(3);
