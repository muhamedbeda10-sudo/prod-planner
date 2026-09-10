-- Which machine a recorded quantity was finished on. Only a record made from a
-- machine card can say it, and only with it can the app MEASURE how long an
-- item really takes on a machine: the pieces it produced against the hours the
-- shift log put on it. Older rows keep NULL — they were recorded before
-- anybody was asked, and they simply do not count towards a rate.
ALTER TABLE "HandoverEntry" ADD COLUMN "machineId" INTEGER;
CREATE INDEX "HandoverEntry_machineId_idx" ON "HandoverEntry"("machineId");
ALTER TABLE "HandoverEntry" ADD CONSTRAINT "HandoverEntry_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
