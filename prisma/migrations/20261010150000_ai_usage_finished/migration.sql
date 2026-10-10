-- AlterTable: a question in flight has no finishedAt yet
ALTER TABLE "AiUsage" ADD COLUMN "finishedAt" TIMESTAMP(3);
-- every question logged so far is finished
UPDATE "AiUsage" SET "finishedAt" = "at" WHERE "finishedAt" IS NULL;
