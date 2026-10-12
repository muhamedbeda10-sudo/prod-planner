-- The assistant's changes: what it proposes and what it did (AiAction), and
-- the owner's two brakes on the settings row.

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "actionsPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "automationsPaused" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiAction" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "conversationId" INTEGER,
    "toolUseId" TEXT,
    "automationId" INTEGER,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "risk" TEXT NOT NULL,
    "snapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" TEXT,
    "error" TEXT,
    "undo" JSONB,
    "undoOfId" INTEGER,
    "undoneAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),

    CONSTRAINT "AiAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAction_userId_createdAt_idx" ON "AiAction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAction_conversationId_idx" ON "AiAction"("conversationId");

-- CreateIndex
CREATE INDEX "AiAction_status_expiresAt_idx" ON "AiAction"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AiAction_automationId_idx" ON "AiAction"("automationId");

-- AddForeignKey
ALTER TABLE "AiAction" ADD CONSTRAINT "AiAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAction" ADD CONSTRAINT "AiAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The assistant's own records stay closed to its read-only login, like its
-- conversations: a proposal holds what the person asked for and the rows it
-- read on their behalf.
REVOKE ALL ON "AiAction" FROM ai_reader;
