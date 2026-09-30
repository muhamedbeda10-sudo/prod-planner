-- The plan's child MOs per component, and the ODOO rows that took one
ALTER TABLE "OdooEntry" ADD COLUMN IF NOT EXISTS "autoMo" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ChildMo" (
    "id" SERIAL NOT NULL,
    "planMo" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "item" TEXT,
    "childMo" TEXT NOT NULL,
    "parentMo" TEXT,
    "productCode" TEXT,
    "qty" DOUBLE PRECISION,
    "state" TEXT,
    "linkMethod" TEXT,
    "remarks" TEXT,
    "planMonth" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChildMo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChildMo_planMo_component_childMo_key" ON "ChildMo"("planMo", "component", "childMo");
CREATE INDEX IF NOT EXISTS "ChildMo_planMo_item_idx" ON "ChildMo"("planMo", "item");
CREATE INDEX IF NOT EXISTS "ChildMo_childMo_idx" ON "ChildMo"("childMo");
