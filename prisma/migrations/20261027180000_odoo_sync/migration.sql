-- Odoo, read on a schedule: the connection, the runs, what Odoo says about the
-- close-out log's MOs, and the sub-assembly MOs under each open order.
-- Additions only: no existing table or row is touched.

-- CreateTable
CREATE TABLE "OdooSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "url" TEXT NOT NULL DEFAULT '',
    "db" TEXT NOT NULL DEFAULT '',
    "login" TEXT NOT NULL DEFAULT '',
    "apiKeyEnc" TEXT NOT NULL DEFAULT '',
    "apiKeyHint" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooSyncRun" (
    "id" SERIAL NOT NULL,
    "slot" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB,
    "error" TEXT,
    "startedBy" TEXT,

    CONSTRAINT "OdooSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooMoState" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL DEFAULT true,
    "currentName" TEXT NOT NULL DEFAULT '',
    "odooId" INTEGER,
    "state" TEXT NOT NULL DEFAULT '',
    "productCode" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qtyProduced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooMoState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooChildMo" (
    "id" SERIAL NOT NULL,
    "parentMo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "odooId" INTEGER NOT NULL,
    "item" TEXT NOT NULL DEFAULT '',
    "productCode" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qtyProduced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "doneAt" TIMESTAMP(3),
    "linkHow" TEXT NOT NULL DEFAULT '',
    "sharedWith" TEXT NOT NULL DEFAULT '',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooChildMo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OdooSyncRun_slot_key" ON "OdooSyncRun"("slot");
CREATE INDEX "OdooSyncRun_startedAt_idx" ON "OdooSyncRun"("startedAt");
CREATE UNIQUE INDEX "OdooMoState_name_key" ON "OdooMoState"("name");
CREATE INDEX "OdooMoState_state_idx" ON "OdooMoState"("state");
CREATE UNIQUE INDEX "OdooChildMo_parentMo_odooId_key" ON "OdooChildMo"("parentMo", "odooId");
CREATE INDEX "OdooChildMo_parentMo_item_idx" ON "OdooChildMo"("parentMo", "item");
CREATE INDEX "OdooChildMo_name_idx" ON "OdooChildMo"("name");

-- The connection holds the encrypted API key: the assistant's SQL login has
-- no business with it. What the sync READ (the MO states, the child MOs, the
-- runs) stays readable to the assistant, like every other table.
REVOKE ALL ON "OdooSettings" FROM ai_reader;
