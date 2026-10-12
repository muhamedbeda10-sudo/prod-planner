-- What each machine takes: the planner's rules that ⚡ Plan follows. The
-- assistant may read them (they are planning data, not private).

-- CreateTable
CREATE TABLE "MachineRule" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "effect" TEXT NOT NULL,
    "item" TEXT,
    "line" TEXT,
    "minThicknessMm" DOUBLE PRECISION,
    "maxThicknessMm" DOUBLE PRECISION,
    "material" TEXT,
    "minKva" INTEGER,
    "maxKva" INTEGER,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachineRule_machineId_active_idx" ON "MachineRule"("machineId", "active");

-- AddForeignKey
ALTER TABLE "MachineRule" ADD CONSTRAINT "MachineRule_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
