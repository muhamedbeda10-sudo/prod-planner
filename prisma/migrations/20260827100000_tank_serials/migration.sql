-- CreateTable
CREATE TABLE "Worker" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "depts" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TankUnit" (
    "id" SERIAL NOT NULL,
    "serial" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL DEFAULT 'TN',
    "seq" INTEGER NOT NULL,
    "planNo" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'welded',
    "weldedAt" TIMESTAMP(3) NOT NULL,
    "weldedById" INTEGER,
    "weldedBy" TEXT,
    "weldedLogBy" TEXT,
    "testedAt" TIMESTAMP(3),
    "testedById" INTEGER,
    "testedBy" TEXT,
    "testResult" TEXT,
    "testNote" TEXT,
    "paintedAt" TIMESTAMP(3),
    "paintedById" INTEGER,
    "paintedBy" TEXT,
    "qaAt" TIMESTAMP(3),
    "qaById" INTEGER,
    "qaBy" TEXT,
    "qaResult" TEXT,
    "qaNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TankUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TankEvent" (
    "id" SERIAL NOT NULL,
    "tankId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workerId" INTEGER,
    "workerName" TEXT,
    "byUser" TEXT,
    "note" TEXT,

    CONSTRAINT "TankEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TankSerialCounter" (
    "bom" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TankSerialCounter_pkey" PRIMARY KEY ("bom")
);

-- CreateIndex
CREATE UNIQUE INDEX "Worker_name_key" ON "Worker"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TankUnit_serial_key" ON "TankUnit"("serial");

-- CreateIndex
CREATE INDEX "TankUnit_mo_status_idx" ON "TankUnit"("mo", "status");

-- CreateIndex
CREATE INDEX "TankUnit_status_idx" ON "TankUnit"("status");

-- CreateIndex
CREATE INDEX "TankUnit_bom_idx" ON "TankUnit"("bom");

-- CreateIndex
CREATE UNIQUE INDEX "TankUnit_bom_seq_key" ON "TankUnit"("bom", "seq");

-- CreateIndex
CREATE INDEX "TankEvent_tankId_idx" ON "TankEvent"("tankId");

-- AddForeignKey
ALTER TABLE "TankEvent" ADD CONSTRAINT "TankEvent_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "TankUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

