-- CreateTable
CREATE TABLE "AiSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "apiKeyEnc" TEXT NOT NULL DEFAULT '',
    "apiKeyHint" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'claude-opus-5-5',
    "monthlyUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dbPassword" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAccess" (
    "userId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "monthlyUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAccess_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER,
    "conversationId" INTEGER,
    "model" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "queries" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiConversation_userId_updatedAt_idx" ON "AiConversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AiMessage_conversationId_id_idx" ON "AiMessage"("conversationId", "id");

-- CreateIndex
CREATE INDEX "AiUsage_at_idx" ON "AiUsage"("at");

-- CreateIndex
CREATE INDEX "AiUsage_userId_at_idx" ON "AiUsage"("userId", "at");

-- AddForeignKey
ALTER TABLE "AiAccess" ADD CONSTRAINT "AiAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The settings row. It carries the password of ai_reader, the login the
-- assistant reads the database through: 64 hex characters from the
-- database's own strong random source, made here and written nowhere else.
INSERT INTO "AiSettings" ("id", "dbPassword", "updatedAt")
VALUES (1, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), CURRENT_TIMESTAMP);

DO $$
DECLARE pw text;
BEGIN
  SELECT "dbPassword" INTO pw FROM "AiSettings" WHERE "id" = 1;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') THEN
    EXECUTE format('ALTER ROLE ai_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD %L', pw);
  ELSE
    EXECUTE format('CREATE ROLE ai_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD %L', pw);
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ai_reader', current_database());
END $$;

-- It only ever reads, and never for long.
ALTER ROLE ai_reader SET default_transaction_read_only = on;
ALTER ROLE ai_reader SET statement_timeout = '15s';
ALTER ROLE ai_reader SET idle_in_transaction_session_timeout = '30s';

-- Every table of the app, today's and those added later…
GRANT USAGE ON SCHEMA public TO ai_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ai_reader;

-- …but not the private ones: the sessions, the chat, people's preferences
-- and the assistant's own tables (its key, the conversations); of the
-- accounts only who they are; nor the migrations and the backups.
REVOKE ALL ON "Session", "UserPref", "ChatMessage", "ChatGroup", "ChatGroupMember", "ChatMessageHide", "ChatReaction",
  "AiSettings", "AiAccess", "AiConversation", "AiMessage", "AiUsage" FROM ai_reader;
REVOKE ALL ON "User" FROM ai_reader;
GRANT SELECT ("id", "name", "active") ON "User" TO ai_reader;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND left(tablename, 1) = '_' LOOP
    EXECUTE format('REVOKE ALL ON %I FROM ai_reader', t);
  END LOOP;
END $$;
