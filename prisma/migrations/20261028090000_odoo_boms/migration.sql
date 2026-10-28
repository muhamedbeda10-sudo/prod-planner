-- Odoo's bills of materials, mirrored read-only by the Odoo sync: each BoM
-- once with its lines, and the BoM each order code is built with. Written by
-- odoo_ingest (the next migration), read by the app; additions only.

-- CreateTable
CREATE TABLE "OdooBom" (
    "id" SERIAL NOT NULL,
    "odooId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "uom" TEXT NOT NULL DEFAULT '',
    "sig" TEXT NOT NULL DEFAULT '',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooBom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooBomLine" (
    "id" SERIAL NOT NULL,
    "bomId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL,
    "uom" TEXT NOT NULL DEFAULT '',
    "stockQty" DOUBLE PRECISION NOT NULL,
    "stockUom" TEXT NOT NULL DEFAULT '',
    "childOdooId" INTEGER,

    CONSTRAINT "OdooBomLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooBomRoot" (
    "bom" TEXT NOT NULL,
    "odooId" INTEGER,
    "via" TEXT NOT NULL DEFAULT '',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooBomRoot_pkey" PRIMARY KEY ("bom")
);

-- CreateIndex
CREATE UNIQUE INDEX "OdooBom_odooId_key" ON "OdooBom"("odooId");
CREATE INDEX "OdooBom_code_idx" ON "OdooBom"("code");
CREATE INDEX "OdooBom_productCode_idx" ON "OdooBom"("productCode");
CREATE INDEX "OdooBomLine_bomId_idx" ON "OdooBomLine"("bomId");
CREATE INDEX "OdooBomLine_productCode_idx" ON "OdooBomLine"("productCode");

-- AddForeignKey
ALTER TABLE "OdooBomLine" ADD CONSTRAINT "OdooBomLine_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "OdooBom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
