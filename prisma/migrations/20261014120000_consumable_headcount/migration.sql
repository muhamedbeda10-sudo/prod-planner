-- CONSUMABLES: each section's workers, month by month — a per-worker limit
-- reviewed for a past month is multiplied by the workers the section had
-- then, not by today's list. Rewritten on every change to the workers list
-- and every hand-out; a month with no row reads the latest month before it.

-- CreateTable
CREATE TABLE "ConsumableHeadcount" (
    "month" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "workers" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumableHeadcount_pkey" PRIMARY KEY ("month","department")
);
