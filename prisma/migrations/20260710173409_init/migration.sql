-- CreateTable
CREATE TABLE "Plan" (
    "planNo" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startDate" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PlanOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "planNo" INTEGER NOT NULL,
    "bom" TEXT NOT NULL,
    "soi" TEXT,
    "mo" TEXT NOT NULL,
    "description" TEXT,
    "item" TEXT NOT NULL,
    "requiredQty" REAL NOT NULL DEFAULT 0,
    "plannerBalance" REAL,
    "targetQty" REAL NOT NULL DEFAULT 0,
    "remark" TEXT,
    CONSTRAINT "PlanOrder_planNo_fkey" FOREIGN KEY ("planNo") REFERENCES "Plan" ("planNo") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanSchedule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "planNo" INTEGER NOT NULL,
    "bom" TEXT NOT NULL,
    "soi" TEXT,
    "mo" TEXT NOT NULL,
    "description" TEXT,
    "item" TEXT NOT NULL,
    "ovenDate" DATETIME NOT NULL,
    "qty" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "PlanSchedule_planNo_fkey" FOREIGN KEY ("planNo") REFERENCES "Plan" ("planNo") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HandoverEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "date" DATETIME NOT NULL,
    "dept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "bomRaw" TEXT,
    "item" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "planNo" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT
);

-- CreateTable
CREATE TABLE "ReallocationMove" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "planNo" INTEGER NOT NULL,
    "fromBom" TEXT NOT NULL,
    "toBom" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "date" DATETIME NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "leadCut" INTEGER NOT NULL DEFAULT 2,
    "leadWeld" INTEGER NOT NULL DEFAULT 1,
    "capacityPerItem" INTEGER NOT NULL DEFAULT 27,
    "dailyTarget" INTEGER NOT NULL DEFAULT 27
);

-- CreateIndex
CREATE INDEX "PlanOrder_planNo_idx" ON "PlanOrder"("planNo");

-- CreateIndex
CREATE INDEX "PlanOrder_bom_idx" ON "PlanOrder"("bom");

-- CreateIndex
CREATE UNIQUE INDEX "PlanOrder_planNo_mo_item_key" ON "PlanOrder"("planNo", "mo", "item");

-- CreateIndex
CREATE INDEX "PlanSchedule_planNo_idx" ON "PlanSchedule"("planNo");

-- CreateIndex
CREATE INDEX "PlanSchedule_bom_idx" ON "PlanSchedule"("bom");

-- CreateIndex
CREATE INDEX "PlanSchedule_ovenDate_idx" ON "PlanSchedule"("ovenDate");

-- CreateIndex
CREATE INDEX "HandoverEntry_planNo_idx" ON "HandoverEntry"("planNo");

-- CreateIndex
CREATE INDEX "HandoverEntry_date_idx" ON "HandoverEntry"("date");

-- CreateIndex
CREATE INDEX "HandoverEntry_bom_idx" ON "HandoverEntry"("bom");

-- CreateIndex
CREATE INDEX "HandoverEntry_dept_idx" ON "HandoverEntry"("dept");

-- CreateIndex
CREATE INDEX "ReallocationMove_planNo_idx" ON "ReallocationMove"("planNo");

-- CreateIndex
CREATE INDEX "ReallocationMove_status_idx" ON "ReallocationMove"("status");
