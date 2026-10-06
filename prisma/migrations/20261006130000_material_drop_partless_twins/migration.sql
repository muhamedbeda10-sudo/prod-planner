-- Material lines with NO part code that have an identical twin WITH one (same
-- order, BOM, material, thickness, size, units, rates and nested sheets) — an
-- import that wrote S01134-3's lines twice. The twin with the part code stays.
-- Only lines nobody has added production to are dropped.
DELETE FROM "MaterialUsage" a
USING "MaterialUsage" b
WHERE a.id IN (4140, 4141, 4142, 4143, 4144, 4145, 4146, 4147, 4148, 4149, 4150, 4151, 4152, 4153)
  AND a.id <> b.id
  AND a."partCode" = '' AND b."partCode" <> ''
  AND a.line = b.line AND a.month = b.month AND a.bom = b.bom AND a.mo = b.mo AND a.soi = b.soi
  AND a."materialCode" = b."materialCode" AND a.material = b.material
  AND a."thicknessMm" = b."thicknessMm" AND a."sheetSize" = b."sheetSize"
  AND a.units = b.units AND a."sheetsPerUnit" = b."sheetsPerUnit"
  AND COALESCE(a."actualPerUnit", -1) = COALESCE(b."actualPerUnit", -1)
  AND COALESCE(a."sheetsUsed", -1) = COALESCE(b."sheetsUsed", -1)
  AND a."producedQty" IS NULL;
