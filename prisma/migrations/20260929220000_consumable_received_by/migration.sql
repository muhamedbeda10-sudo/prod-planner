-- CONSUMABLES: a hand-out is the department's, and names who asked for it
-- or collected it.
--
-- Hand-outs recorded "to the department" were refused by the check written
-- for group hand-outs — it wanted a department hand-out to list at least one
-- worker and to name none — so recording one failed (and took the page with
-- it). A department hand-out now names the person who asked for it or
-- collected it in "workerId" (the older ones recorded without a name keep
-- none), with no group list (recipientCount 0); the limits count it under the
-- department either way.

ALTER TABLE "ConsumableIssue" DROP CONSTRAINT "ConsumableIssue_recipients_check";
ALTER TABLE "ConsumableIssue" ADD CONSTRAINT "ConsumableIssue_recipients_check" CHECK (
  ("recipientScope" = 'worker' AND "workerId" IS NOT NULL AND "recipientCount" = 1)
  OR ("recipientScope" IN ('workers', 'department') AND "recipientCount" >= 0)
);
