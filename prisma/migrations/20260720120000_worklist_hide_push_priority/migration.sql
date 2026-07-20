-- Priority flag on orders: shows in a dedicated table on every dept worklist.
ALTER TABLE "MasterOrder" ADD COLUMN "priority" BOOLEAN NOT NULL DEFAULT false;

-- Worklist lines the admin removed from view (restore = delete the row).
CREATE TABLE "WorklistLineHide" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorklistLineHide_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorklistLineHide_dept_bom_mo_item_key" ON "WorklistLineHide"("dept", "bom", "mo", "item");

-- Orders sent down from the Plan Tracker to a dept worklist (qty per item).
CREATE TABLE "WorklistPush" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorklistPush_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorklistPush_dept_mo_item_key" ON "WorklistPush"("dept", "mo", "item");
