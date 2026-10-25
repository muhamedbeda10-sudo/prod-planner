-- The assistant learns: a thumbs up or down on an answer (AiFeedback), what
-- it keeps about each person between chats (AiMemory), and the owner's
-- quality checks (AiCheck). New tables only — nothing existing changes.

-- CreateTable
CREATE TABLE "AiFeedback" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "conversationId" INTEGER,
    "turn" INTEGER NOT NULL,
    "rating" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMemory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCheck" (
    "id" SERIAL NOT NULL,
    "question" TEXT NOT NULL,
    "expect" TEXT NOT NULL,
    "referenceSql" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastPass" BOOLEAN,
    "lastAnswer" TEXT,
    "lastWhy" TEXT,
    "lastModel" TEXT,
    "lastCostUsd" DOUBLE PRECISION,

    CONSTRAINT "AiCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiFeedback_conversationId_turn_key" ON "AiFeedback"("conversationId", "turn");
CREATE INDEX "AiFeedback_status_createdAt_idx" ON "AiFeedback"("status", "createdAt");
CREATE INDEX "AiMemory_userId_idx" ON "AiMemory"("userId");
CREATE INDEX "AiCheck_active_idx" ON "AiCheck"("active");

-- AddForeignKey
ALTER TABLE "AiFeedback" ADD CONSTRAINT "AiFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiMemory" ADD CONSTRAINT "AiMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The assistant's own records: its SQL login has no business with them.
REVOKE ALL ON "AiFeedback", "AiMemory", "AiCheck" FROM ai_reader;
