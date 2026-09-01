-- MATERIAL / nesting tracker — one row per BOM (× order) × material ×
-- thickness × sheet size. The workbook's computed columns ("No. of Sheets in
-- BOM for Job", "Difference") are deliberately NOT columns here: they are
-- derived from sheetsPerUnit, the order's quantity and sheetsUsed, so they
-- can never drift or come back as #VALUE!.

-- CreateTable
CREATE TABLE "MaterialUsage" (
    "id" SERIAL NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL DEFAULT '',
    "material" TEXT NOT NULL,
    "thicknessMm" DOUBLE PRECISION NOT NULL,
    "sheetSize" TEXT NOT NULL,
    "sheetsPerUnit" DOUBLE PRECISION NOT NULL,
    "sheetsUsed" DOUBLE PRECISION,
    "unitsOverride" DOUBLE PRECISION,
    "note" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialUsage_pkey" PRIMARY KEY ("id")
);

-- One line per material spec: re-entering the same one edits it instead of
-- silently duplicating it, which the workbook allowed.
-- CreateIndex
CREATE UNIQUE INDEX "MaterialUsage_bom_mo_material_thicknessMm_sheetSize_key"
    ON "MaterialUsage"("bom", "mo", "material", "thicknessMm", "sheetSize");

-- CreateIndex
CREATE INDEX "MaterialUsage_bom_idx" ON "MaterialUsage"("bom");

-- CreateIndex
CREATE INDEX "MaterialUsage_mo_idx" ON "MaterialUsage"("mo");
