-- CONSUMABLES catalogue and limits. The store's list of what it hands out —
-- code, name, unit — and how much of each may go out: a number per day,
-- work week (Saturday → Friday), calendar month or calendar quarter, for the
-- departments it names, shared by them ("pool") or for each worker
-- ("person"). A hand-out now points at its catalogue item, and one recorded
-- over a limit carries the flag, the reason the recorder gave and the breach
-- as it read. Every change to the catalogue or a limit is kept in
-- ConsumableCatalogueChange.

-- AlterTable
ALTER TABLE "ConsumableIssue" ADD COLUMN     "itemId" INTEGER,
ADD COLUMN     "overLimit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "overLimitNote" TEXT,
ADD COLUMN     "overLimitReason" TEXT;

-- CreateTable
CREATE TABLE "ConsumableItem" (
    "id" SERIAL NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'PC',
    "remark" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumableItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumableLimit" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "departments" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'pool',
    "period" TEXT NOT NULL DEFAULT 'week',
    "qty" DECIMAL(14,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumableLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumableCatalogueChange" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "byId" INTEGER,
    "by" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumableCatalogueChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsumableItem_code_key" ON "ConsumableItem"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumableItem_name_key" ON "ConsumableItem"("name");

-- CreateIndex
CREATE INDEX "ConsumableItem_active_idx" ON "ConsumableItem"("active");

-- CreateIndex
CREATE INDEX "ConsumableLimit_itemId_idx" ON "ConsumableLimit"("itemId");

-- CreateIndex
CREATE INDEX "ConsumableCatalogueChange_itemId_idx" ON "ConsumableCatalogueChange"("itemId");

-- CreateIndex
CREATE INDEX "ConsumableCatalogueChange_at_idx" ON "ConsumableCatalogueChange"("at");

-- CreateIndex
CREATE INDEX "ConsumableIssue_itemId_issuedAt_idx" ON "ConsumableIssue"("itemId", "issuedAt");

-- AddForeignKey
ALTER TABLE "ConsumableIssue" ADD CONSTRAINT "ConsumableIssue_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ConsumableItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ConsumableItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The database refuses what the app would never write.
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_basis_check" CHECK ("basis" IN ('pool', 'person'));
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_period_check" CHECK ("period" IN ('day', 'week', 'month', 'quarter'));
ALTER TABLE "ConsumableLimit" ADD CONSTRAINT "ConsumableLimit_departments_nonempty" CHECK (btrim("departments") <> '');

-- ---- The store's sheet, as sent (47 items). Its "Weekly Issue Limit" is
-- split between the departments it names, unless it is smaller than their
-- number (then one shared pool); "All", "All fabrication" and "All
-- fabrication and welding" are one pool for the group. The remark sets the
-- period ("Every day" → a day, "1 month" → a month, "3 Month" → a quarter)
-- or the basis ("Qty for one person" → each worker). Generated with the
-- app's own split (lib/domain/consumableLimits.ts splitSheetLimit).

INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES (NULL, 'Black Marker', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Black Marker';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES (NULL, 'Red Marker', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Red Marker';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-04', 'Drill Bit 4mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 4mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-05', 'Drill Bit 5mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 5mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-06', 'Drill Bit 6mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 6mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-08', 'Drill Bit 8mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 8mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-10', 'Drill Bit 10mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 10mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-12', 'Drill Bit 12mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 12mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-14', 'Drill Bit 14mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 14mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-16', 'Drill Bit 16mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 16mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-18', 'Drill Bit 18mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 18mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DRB-22', 'Drill Bit 22mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'Channels', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Drill Bit 22mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-TOL-AGD-SS-17mm', 'Air Gun Drive Short Socket 17mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'ShotBlast', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Air Gun Drive Short Socket 17mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-TOL-SS-HT-M8', 'Hand Tap - SS - M8', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Hand Tap - SS - M8';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-TOL-SS-HT-M10', 'Hand Tap - SS - M10', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Hand Tap - SS - M10';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-WRP-RL', 'Wrapping Plastic Roll', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Wrapping Plastic Roll';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingLV', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Wrapping Plastic Roll';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GRD-115x6x22.23', 'Grinding Disk 115x6x22.23mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Grinding Disk 115x6x22.23mm';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Grinding Disk 115x6x22.23mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-FLD-115x6x22.23', 'Flap Disk 115x6x22.23mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Flap Disk 115x6x22.23mm';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Flap Disk 115x6x22.23mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-MTP-AA', 'Masking Tape, 2 inches', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Masking Tape, 2 inches';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-STRP-BLT', 'Plastic Strap Belt - Roll', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'month', 3, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Plastic Strap Belt - Roll';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-DA-SKD-S2', 'SKD-S2 Developer Aerosol', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 20, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'SKD-S2 Developer Aerosol';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-PBR-01', 'Paint Brush 1"', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Paint Brush 1"';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-LOCTITE-LB-8201', 'LOCTITE® LB 8201 Lubricant Multi Spray', 'PC', '3 Month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", '*', 'pool', 'quarter', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'LOCTITE® LB 8201 Lubricant Multi Spray';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-CLEAN-CLOTH', 'Cleaning Cloth', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", '*', 'pool', 'week', 10, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Cleaning Cloth';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-PTX-AA', 'PATTEX', 'PC', '3 Month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", '*', 'pool', 'quarter', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'PATTEX';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GRD-115X1X22.23', 'Cutting Disk 115x1x22.23mm', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Cutting Disk 115x1x22.23mm';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Cutting Disk 115x1x22.23mm';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-WBAS-WL', 'Water Base Anti Spatter (20 Ltr./Drum)', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 2, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Water Base Anti Spatter (20 Ltr./Drum)';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 2, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Water Base Anti Spatter (20 Ltr./Drum)';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-WELD-SPT', 'S-WELD Spatter Guard', 'PC', 'Every day', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'day', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'S-WELD Spatter Guard';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'day', 15, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'S-WELD Spatter Guard';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-SP-120CW', 'Sand Paper - 120CW', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 60, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Sand Paper - 120CW';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-TOL-MW-NG', 'Mig Welding Nozzle Gel', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 4, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Mig Welding Nozzle Gel';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 4, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Mig Welding Nozzle Gel';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GRD-SND-125', 'Sanding Disk - RB346 23 MAX P100 Self Stick 125MM', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingLV', 'pool', 'week', 12, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Sanding Disk - RB346 23 MAX P100 Self Stick 125MM';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-STRP-BLT-CLP', 'Strap Belt Clip', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 100, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Strap Belt Clip';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GLV-COTT', 'Cotton Gloves', 'PC', 'Every day', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'day', 30, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Cotton Gloves';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-SEFTY-FM-N95', 'Face Mask - N95 Filter', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 50, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - N95 Filter';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 50, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - N95 Filter';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 50, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - N95 Filter';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingLV', 'pool', 'week', 50, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - N95 Filter';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GLV-CR', 'Cut Resistant Gloves - Ninja', 'PC', 'Qty for one person', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'LaserCutTX,BendingTX,Channels,Fins,WeldingTX,LaserCutLV,Punching,BendingLV,WeldingLV', 'person', 'week', 2, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Cut Resistant Gloves - Ninja';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GLV-AB', 'Welding Hand Gloves', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 40, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welding Hand Gloves';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 40, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welding Hand Gloves';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-EP-CT', 'Ear Plug - Corded Type', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'LaserCutTX,BendingTX,Channels,Fins,LaserCutLV,Punching,BendingLV', 'pool', 'week', 30, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Ear Plug - Corded Type';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-SEFTY-FM', 'Face Mask - Box', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'month', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - Box';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingLV', 'pool', 'month', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - Box';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-P-UNIFORM', 'Painting Uniform', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'week', 6, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Painting Uniform';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingLV', 'pool', 'week', 6, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Painting Uniform';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-SEFTY-FM-6003', 'Face Mask Filter - 6003 - 3M', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX', 'pool', 'month', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask Filter - 6003 - 3M';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingLV', 'pool', 'month', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask Filter - 6003 - 3M';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-SEFTY-FM-6200', 'Face Mask - 6200 - 3M', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX,PaintingLV', 'pool', 'month', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - 6200 - 3M';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GOGGLE-S', 'Safety Goggle White', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", '*', 'pool', 'week', 80, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Safety Goggle White';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-WBG-AA', 'Welding Black Glass', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 10, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welding Black Glass';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 10, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welding Black Glass';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-SEFTY-FM-6000', 'Face Mask - 6000 - 3M', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'PaintingTX,PaintingLV', 'pool', 'month', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Face Mask - 6000 - 3M';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-GOGGLE-B', 'Safety Goggle Black', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'month', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Safety Goggle Black';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'month', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Safety Goggle Black';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-CON-WL-APRON', 'Welder Apron', 'PC', NULL, CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingLV', 'pool', 'week', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welder Apron';
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX', 'pool', 'week', 5, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welder Apron';
INSERT INTO "ConsumableItem" ("code", "name", "uom", "remark", "updatedAt") VALUES ('C-W-HELMET', 'Welding Helmet Plastic Black EN175', 'PC', '1 month', CURRENT_TIMESTAMP);
INSERT INTO "ConsumableLimit" ("itemId", "departments", "basis", "period", "qty", "updatedAt") SELECT "id", 'WeldingTX,WeldingLV', 'pool', 'month', 1, CURRENT_TIMESTAMP FROM "ConsumableItem" WHERE "name" = 'Welding Helmet Plastic Black EN175';

-- Hand-outs already recorded under a catalogue item's name join it.
UPDATE "ConsumableIssue" i SET "itemId" = c."id"
FROM "ConsumableItem" c
WHERE i."itemId" IS NULL AND lower(btrim(i."item")) = lower(c."name");
