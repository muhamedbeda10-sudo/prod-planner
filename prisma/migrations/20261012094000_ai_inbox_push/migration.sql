-- What the assistant sends a person (AiInboxItem), the devices people turned
-- notifications on for (PushSubscription), and the app's Web Push key pair.

-- CreateTable
CREATE TABLE "AiInboxItem" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fromName" TEXT,
    "automationId" INTEGER,
    "runId" INTEGER,
    "actionIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),

    CONSTRAINT "AiInboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOkAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushKeys" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushKeys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiInboxItem_userId_createdAt_idx" ON "AiInboxItem"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiInboxItem_userId_readAt_idx" ON "AiInboxItem"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- AddForeignKey
ALTER TABLE "AiInboxItem" ADD CONSTRAINT "AiInboxItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to the assistant's read-only login: what it sent people is its own
-- record, a device's push address is as good as a key to it, and the push
-- key pair is a secret.
REVOKE ALL ON "AiInboxItem" FROM ai_reader;
REVOKE ALL ON "PushSubscription" FROM ai_reader;
REVOKE ALL ON "PushKeys" FROM ai_reader;
