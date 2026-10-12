-- The files a person attaches in the assistant's chat (AiFile): a sheet the
-- assistant reads and the app's own importers run on once an import is
-- approved. Kept a fortnight, then cleared by the hourly housekeeping.

-- CreateTable
CREATE TABLE "AiFile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "conversationId" INTEGER,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiFile_userId_createdAt_idx" ON "AiFile"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiFile_conversationId_idx" ON "AiFile"("conversationId");

-- CreateIndex
CREATE INDEX "AiFile_createdAt_idx" ON "AiFile"("createdAt");

-- AddForeignKey
ALTER TABLE "AiFile" ADD CONSTRAINT "AiFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFile" ADD CONSTRAINT "AiFile_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to the assistant's read-only login: a person's files are theirs,
-- read only through the assistant's own tool, in their own chat.
REVOKE ALL ON "AiFile" FROM ai_reader;
