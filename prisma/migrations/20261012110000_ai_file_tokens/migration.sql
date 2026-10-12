-- What the model counted an attached photo or PDF as, in tokens, when it was
-- attached: what decides how many of a chat's photos and PDFs are sent again
-- with each question. Null for a sheet, or a file that could not be counted.
-- (ai_reader stays shut out: the table's REVOKE covers the new column.)

-- AlterTable
ALTER TABLE "AiFile" ADD COLUMN "tokens" INTEGER;
