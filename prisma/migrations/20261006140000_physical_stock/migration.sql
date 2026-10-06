-- PHYSICAL MATERIAL: the store's count against SF01's stock in Odoo.
CREATE TABLE "PhysicalStock" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "uom" TEXT NOT NULL DEFAULT '',
    "physical" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "odoo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalStock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhysicalStock_code_key" ON "PhysicalStock"("code");
