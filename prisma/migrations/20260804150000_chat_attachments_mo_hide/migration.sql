-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "mo" TEXT,
ADD COLUMN     "attachments" TEXT,
ADD COLUMN     "hiddenForFrom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hiddenForTo" BOOLEAN NOT NULL DEFAULT false;
