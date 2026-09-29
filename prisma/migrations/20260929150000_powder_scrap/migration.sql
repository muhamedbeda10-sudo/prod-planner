-- POWDER SCRAP: the powder-coating powder the painting lines throw away,
-- weighed in kg per painting section and day, set against the powder handed
-- out to the section for the month's scrap rate. Soft delete; every change
-- kept in PowderScrapRevision.

-- CreateTable
CREATE TABLE "PowderScrap" (
    "id" SERIAL NOT NULL,
    "day" DATE NOT NULL,
    "department" TEXT NOT NULL,
    "kg" DECIMAL(12,3) NOT NULL,
    "notes" TEXT,
    "recordedById" INTEGER,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "editedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PowderScrap_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PowderScrap_kg_positive" CHECK ("kg" > 0),
    CONSTRAINT "PowderScrap_department_check" CHECK ("department" IN ('PaintingTX', 'PaintingLV'))
);

-- CreateTable
CREATE TABLE "PowderScrapRevision" (
    "id" SERIAL NOT NULL,
    "scrapId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB,
    "byId" INTEGER,
    "by" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PowderScrapRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PowderScrap_deletedAt_day_idx" ON "PowderScrap"("deletedAt", "day");

-- CreateIndex
CREATE INDEX "PowderScrapRevision_scrapId_idx" ON "PowderScrapRevision"("scrapId");

-- CreateIndex
CREATE INDEX "PowderScrapRevision_at_idx" ON "PowderScrapRevision"("at");

-- AddForeignKey
ALTER TABLE "PowderScrap" ADD CONSTRAINT "PowderScrap_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowderScrapRevision" ADD CONSTRAINT "PowderScrapRevision_scrapId_fkey" FOREIGN KEY ("scrapId") REFERENCES "PowderScrap"("id") ON DELETE CASCADE ON UPDATE CASCADE;
