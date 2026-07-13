-- CreateTable
CREATE TABLE "MasterOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "mo" TEXT NOT NULL,
    "soi" TEXT,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "customer" TEXT,
    "fgCode" TEXT,
    "bom" TEXT NOT NULL,
    "kva" TEXT,
    "rating" TEXT,
    "secItem" TEXT,
    "planQty" REAL NOT NULL DEFAULT 0,
    "colorRal" TEXT,
    "remarks" TEXT,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MasterOrder_mo_key" ON "MasterOrder"("mo");

-- CreateIndex
CREATE INDEX "MasterOrder_bom_idx" ON "MasterOrder"("bom");
