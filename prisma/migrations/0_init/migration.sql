-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "public"."HandoverEntry" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "bomRaw" TEXT,
    "mo" TEXT,
    "item" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "planNo" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "HandoverEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Holiday" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MasterOrder" (
    "id" SERIAL NOT NULL,
    "mo" TEXT NOT NULL,
    "soi" TEXT,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "customer" TEXT,
    "fgCode" TEXT,
    "bom" TEXT NOT NULL,
    "kva" TEXT,
    "rating" TEXT,
    "secItem" TEXT,
    "planQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "colorRal" TEXT,
    "remarks" TEXT,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ospCF" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ospTC" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ospTN" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ospCB" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "excludedItems" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Plan" (
    "planNo" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("planNo")
);

-- CreateTable
CREATE TABLE "public"."PlanOrder" (
    "id" SERIAL NOT NULL,
    "planNo" INTEGER NOT NULL,
    "bom" TEXT NOT NULL,
    "soi" TEXT,
    "mo" TEXT NOT NULL,
    "description" TEXT,
    "item" TEXT NOT NULL,
    "requiredQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "plannerBalance" DOUBLE PRECISION,
    "targetQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remark" TEXT,

    CONSTRAINT "PlanOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlanSchedule" (
    "id" SERIAL NOT NULL,
    "planNo" INTEGER NOT NULL,
    "bom" TEXT NOT NULL,
    "soi" TEXT,
    "mo" TEXT NOT NULL,
    "description" TEXT,
    "item" TEXT NOT NULL,
    "ovenDate" TIMESTAMP(3) NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PlanSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QueueNote" (
    "id" SERIAL NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT,
    "item" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "photos" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReallocationMove" (
    "id" SERIAL NOT NULL,
    "planNo" INTEGER NOT NULL,
    "fromBom" TEXT NOT NULL,
    "toBom" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ReallocationMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReturnEntry" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "fromDept" TEXT NOT NULL,
    "toDept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT,
    "item" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handoverId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "leadCut" INTEGER NOT NULL DEFAULT 2,
    "leadWeld" INTEGER NOT NULL DEFAULT 1,
    "capacityPerItem" INTEGER NOT NULL DEFAULT 27,
    "dailyTarget" INTEGER NOT NULL DEFAULT 27,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HandoverEntry_bom_idx" ON "public"."HandoverEntry"("bom" ASC);

-- CreateIndex
CREATE INDEX "HandoverEntry_date_idx" ON "public"."HandoverEntry"("date" ASC);

-- CreateIndex
CREATE INDEX "HandoverEntry_dept_idx" ON "public"."HandoverEntry"("dept" ASC);

-- CreateIndex
CREATE INDEX "HandoverEntry_planNo_idx" ON "public"."HandoverEntry"("planNo" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_date_key" ON "public"."Holiday"("date" ASC);

-- CreateIndex
CREATE INDEX "MasterOrder_bom_idx" ON "public"."MasterOrder"("bom" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MasterOrder_mo_key" ON "public"."MasterOrder"("mo" ASC);

-- CreateIndex
CREATE INDEX "MasterOrder_status_idx" ON "public"."MasterOrder"("status" ASC);

-- CreateIndex
CREATE INDEX "PlanOrder_bom_idx" ON "public"."PlanOrder"("bom" ASC);

-- CreateIndex
CREATE INDEX "PlanOrder_planNo_idx" ON "public"."PlanOrder"("planNo" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PlanOrder_planNo_mo_item_key" ON "public"."PlanOrder"("planNo" ASC, "mo" ASC, "item" ASC);

-- CreateIndex
CREATE INDEX "PlanSchedule_bom_idx" ON "public"."PlanSchedule"("bom" ASC);

-- CreateIndex
CREATE INDEX "PlanSchedule_ovenDate_idx" ON "public"."PlanSchedule"("ovenDate" ASC);

-- CreateIndex
CREATE INDEX "PlanSchedule_planNo_idx" ON "public"."PlanSchedule"("planNo" ASC);

-- CreateIndex
CREATE INDEX "QueueNote_bom_mo_item_idx" ON "public"."QueueNote"("bom" ASC, "mo" ASC, "item" ASC);

-- CreateIndex
CREATE INDEX "QueueNote_status_idx" ON "public"."QueueNote"("status" ASC);

-- CreateIndex
CREATE INDEX "ReallocationMove_planNo_idx" ON "public"."ReallocationMove"("planNo" ASC);

-- CreateIndex
CREATE INDEX "ReallocationMove_status_idx" ON "public"."ReallocationMove"("status" ASC);

-- CreateIndex
CREATE INDEX "ReturnEntry_toDept_status_idx" ON "public"."ReturnEntry"("toDept" ASC, "status" ASC);

-- AddForeignKey
ALTER TABLE "public"."PlanOrder" ADD CONSTRAINT "PlanOrder_planNo_fkey" FOREIGN KEY ("planNo") REFERENCES "public"."Plan"("planNo") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlanSchedule" ADD CONSTRAINT "PlanSchedule_planNo_fkey" FOREIGN KEY ("planNo") REFERENCES "public"."Plan"("planNo") ON DELETE CASCADE ON UPDATE CASCADE;

