-- The plant's playbook for the assistant: the rules its people explained to
-- it, and every change to them.

-- CreateTable
CREATE TABLE "AiPlaybookEntry" (
    "id" SERIAL NOT NULL,
    "topic" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPlaybookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPlaybookRevision" (
    "id" SERIAL NOT NULL,
    "entryId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "by" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPlaybookRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiPlaybookEntry_active_idx" ON "AiPlaybookEntry"("active");

-- CreateIndex
CREATE INDEX "AiPlaybookRevision_entryId_idx" ON "AiPlaybookRevision"("entryId");

-- AddForeignKey
ALTER TABLE "AiPlaybookRevision" ADD CONSTRAINT "AiPlaybookRevision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "AiPlaybookEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The assistant is handed the playbook with every question; its SQL login
-- has no business with it.
REVOKE ALL ON "AiPlaybookEntry", "AiPlaybookRevision" FROM ai_reader;
