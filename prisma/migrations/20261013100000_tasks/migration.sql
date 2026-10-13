-- Tasks: a piece of work one person gives others, its people and its thread;
-- and the inbox items that tell a task's news, tied to the task.

-- CreateTable
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "batchId" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueDate" DATE,
    "mo" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdById" INTEGER,
    "createdByName" TEXT NOT NULL,
    "via" TEXT NOT NULL DEFAULT 'app',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "overdueSentAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Task_status_check" CHECK ("status" IN ('open', 'in_progress', 'submitted', 'returned', 'done', 'cancelled')),
    CONSTRAINT "Task_priority_check" CHECK ("priority" IN ('normal', 'urgent'))
);

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskUpdate" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "authorId" INTEGER,
    "authorName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "via" TEXT NOT NULL DEFAULT 'app',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskUpdate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaskUpdate_kind_check" CHECK ("kind" IN ('note', 'start', 'submit', 'approve', 'return', 'cancel', 'reopen'))
);

-- AlterTable
ALTER TABLE "AiInboxItem" ADD COLUMN "taskId" INTEGER;

-- CreateIndex
CREATE INDEX "Task_createdById_activityAt_idx" ON "Task"("createdById", "activityAt");
CREATE INDEX "Task_status_dueDate_idx" ON "Task"("status", "dueDate");
CREATE INDEX "Task_batchId_idx" ON "Task"("batchId");
CREATE UNIQUE INDEX "TaskAssignee_taskId_userId_key" ON "TaskAssignee"("taskId", "userId");
CREATE INDEX "TaskAssignee_userId_idx" ON "TaskAssignee"("userId");
CREATE INDEX "TaskUpdate_taskId_id_idx" ON "TaskUpdate"("taskId", "id");
CREATE INDEX "AiInboxItem_taskId_idx" ON "AiInboxItem"("taskId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskUpdate" ADD CONSTRAINT "TaskUpdate_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskUpdate" ADD CONSTRAINT "TaskUpdate_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiInboxItem" ADD CONSTRAINT "AiInboxItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A task is its people's own — read through the assistant's list_tasks, which
-- shows a person only the tasks they gave or were given, never through its SQL.
REVOKE ALL ON "Task", "TaskAssignee", "TaskUpdate" FROM ai_reader;
