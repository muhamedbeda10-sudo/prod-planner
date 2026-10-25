-- Tasks 2.0: a task's checklist, its due-day reminder and its going up to the
-- owner when late; tasks kept as templates; tasks that repeat by themselves.
-- New columns with defaults or nullable, and new tables — nothing existing changes.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "dueSoonSentAt" TIMESTAMP(3),
ADD COLUMN "escalatedAt" TIMESTAMP(3),
ADD COLUMN "checklist" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "repeatId" INTEGER;

-- CreateTable
CREATE TABLE "TaskTemplate" (
    "id" SERIAL NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "people" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRepeat" (
    "id" SERIAL NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "people" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "mo" TEXT,
    "every" TEXT NOT NULL,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "monthDay" INTEGER,
    "dueDays" INTEGER NOT NULL DEFAULT 0,
    "nextOn" DATE,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastGivenOn" DATE,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRepeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskTemplate_ownerId_idx" ON "TaskTemplate"("ownerId");
CREATE INDEX "TaskRepeat_enabled_nextOn_idx" ON "TaskRepeat"("enabled", "nextOn");
CREATE INDEX "TaskRepeat_ownerId_idx" ON "TaskRepeat"("ownerId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_repeatId_fkey" FOREIGN KEY ("repeatId") REFERENCES "TaskRepeat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskRepeat" ADD CONSTRAINT "TaskRepeat_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Like the tasks themselves: a giver's own, never read through the assistant's SQL.
REVOKE ALL ON "TaskTemplate", "TaskRepeat" FROM ai_reader;
