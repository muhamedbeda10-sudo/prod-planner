-- CreateTable
CREATE TABLE "SimScenario" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "savedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunOrderEntry" (
    "id" SERIAL NOT NULL,
    "rank" INTEGER NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "batchQty" DOUBLE PRECISION,
    "batchNo" INTEGER,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedBy" TEXT,

    CONSTRAINT "RunOrderEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SimScenario_name_key" ON "SimScenario"("name");

-- CreateIndex
CREATE INDEX "RunOrderEntry_mo_idx" ON "RunOrderEntry"("mo");
