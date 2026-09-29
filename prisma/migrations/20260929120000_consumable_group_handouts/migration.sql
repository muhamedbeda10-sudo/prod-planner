-- CONSUMABLES: a hand-out can go to a group — several workers picked by
-- name, or the whole department as it stood (the workers present in the
-- section at recording) — instead of one worker. A group's people are kept in
-- ConsumableIssueRecipient and its size in recipientCount, as it was that
-- day; each counts an equal share against a per-person limit, and a
-- per-person limit checked for the group is its number × the people.
-- Every hand-out recorded so far was for one worker.

-- AlterTable
ALTER TABLE "ConsumableIssue" ADD COLUMN     "recipientCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "recipientScope" TEXT NOT NULL DEFAULT 'worker',
ALTER COLUMN "workerId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ConsumableIssueRecipient" (
    "issueId" INTEGER NOT NULL,
    "workerId" INTEGER NOT NULL,

    CONSTRAINT "ConsumableIssueRecipient_pkey" PRIMARY KEY ("issueId","workerId")
);

-- CreateIndex
CREATE INDEX "ConsumableIssueRecipient_workerId_idx" ON "ConsumableIssueRecipient"("workerId");

-- AddForeignKey
ALTER TABLE "ConsumableIssueRecipient" ADD CONSTRAINT "ConsumableIssueRecipient_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ConsumableIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumableIssueRecipient" ADD CONSTRAINT "ConsumableIssueRecipient_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One worker ⇔ workerId set and a count of one; a group ⇔ no single worker
-- and at least one person.
ALTER TABLE "ConsumableIssue" ADD CONSTRAINT "ConsumableIssue_recipients_check" CHECK (
  ("recipientScope" = 'worker' AND "workerId" IS NOT NULL AND "recipientCount" = 1)
  OR ("recipientScope" IN ('workers', 'department') AND "workerId" IS NULL AND "recipientCount" >= 1)
);
