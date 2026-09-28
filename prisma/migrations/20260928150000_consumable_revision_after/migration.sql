-- CONSUMABLES: the person who recorded a hand-out may now edit it too, and
-- the admin reads every change as before → after and can restore any earlier
-- version. A revision therefore keeps the row AFTER the change as well; the
-- few revisions written before this have none, and show their "before" alone.

-- AlterTable
ALTER TABLE "ConsumableIssueRevision" ADD COLUMN     "after" JSONB;

-- CreateIndex
CREATE INDEX "ConsumableIssueRevision_at_idx" ON "ConsumableIssueRevision"("at");

