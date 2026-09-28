-- CONSUMABLES: the store's log of what it hands out to the shop floor — an
-- item, a quantity, the department and the worker who took it, stamped with
-- the server's time. Rows are the admin's to change once written; every edit
-- or delete keeps the row as it was in ConsumableIssueRevision, and delete is
-- soft (deletedAt) so the log's history survives.

-- CreateTable
CREATE TABLE "ConsumableIssue" (
    "id" SERIAL NOT NULL,
    "item" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "department" TEXT NOT NULL,
    "workerId" INTEGER NOT NULL,
    "notes" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" INTEGER,
    "recordedBy" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "editedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumableIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumableIssueRevision" (
    "id" SERIAL NOT NULL,
    "issueId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "byId" INTEGER,
    "by" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumableIssueRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsumableIssue_deletedAt_issuedAt_idx" ON "ConsumableIssue"("deletedAt", "issuedAt");

-- CreateIndex
CREATE INDEX "ConsumableIssue_workerId_idx" ON "ConsumableIssue"("workerId");

-- CreateIndex
CREATE INDEX "ConsumableIssue_department_idx" ON "ConsumableIssue"("department");

-- CreateIndex
CREATE INDEX "ConsumableIssue_recordedById_idx" ON "ConsumableIssue"("recordedById");

-- CreateIndex
CREATE INDEX "ConsumableIssueRevision_issueId_idx" ON "ConsumableIssueRevision"("issueId");

-- AddForeignKey
ALTER TABLE "ConsumableIssue" ADD CONSTRAINT "ConsumableIssue_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumableIssue" ADD CONSTRAINT "ConsumableIssue_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumableIssueRevision" ADD CONSTRAINT "ConsumableIssueRevision_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ConsumableIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A hand-out of nothing is a typo, not a record. Prisma does not model CHECK
-- constraints; it leaves this one alone on later migrations.
ALTER TABLE "ConsumableIssue" ADD CONSTRAINT "ConsumableIssue_qty_positive" CHECK ("qty" > 0);
