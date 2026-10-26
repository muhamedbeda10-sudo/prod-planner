-- How long each question took: until the first word of the answer reached
-- the person, and in all. New nullable columns only — nothing existing changes.
ALTER TABLE "AiUsage" ADD COLUMN "firstTokenMs" INTEGER;
ALTER TABLE "AiUsage" ADD COLUMN "totalMs" INTEGER;

-- The chats people keep: a pinned one stays at the top of their list.
ALTER TABLE "AiConversation" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
