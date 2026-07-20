-- Admin date overrides on fabrication-worklist lines.
-- origISO = the line's original delivery ISO date ("" = the line was date-less).
CREATE TABLE "WorklistDateOverride" (
    "id" SERIAL NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "origISO" TEXT NOT NULL DEFAULT '',
    "newDate" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorklistDateOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorklistDateOverride_bom_mo_item_origISO_key" ON "WorklistDateOverride"("bom", "mo", "item", "origISO");
