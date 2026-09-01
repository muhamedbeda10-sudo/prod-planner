-- The date the material was worked. A consumption record that cannot say WHEN
-- is only half a record — it answers "how much" but never "when did we cut it".
--
-- Existing rows are backdated to the day they were entered, which is the
-- closest thing to the truth the table already holds.

ALTER TABLE "MaterialUsage" ADD COLUMN "workedAt" TIMESTAMP(3);
UPDATE "MaterialUsage" SET "workedAt" = date_trunc('day', "createdAt") WHERE "workedAt" IS NULL;
ALTER TABLE "MaterialUsage" ALTER COLUMN "workedAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "MaterialUsage_workedAt_idx" ON "MaterialUsage"("workedAt");
