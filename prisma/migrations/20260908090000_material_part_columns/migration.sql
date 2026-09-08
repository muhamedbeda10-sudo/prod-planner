-- The Nesting Project Tracker names the PART each line's sheets go into
-- (Part Code FB-022, Part Name TANK) and the material code (T-SSS-5MM), and
-- the same BOM runs one line per part. The part code joins the line's key.

ALTER TABLE "MaterialUsage" ADD COLUMN "partCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MaterialUsage" ADD COLUMN "partName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MaterialUsage" ADD COLUMN "materialCode" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "MaterialUsage_month_bom_mo_material_thicknessMm_sheetSize_key";
CREATE UNIQUE INDEX "MaterialUsage_month_bom_mo_partCode_material_thicknessMm_sheetSize_key"
    ON "MaterialUsage"("month", "bom", "mo", "partCode", "material", "thicknessMm", "sheetSize");
