-- The per-unit rate can now be TYPED in the Material tab, for the lines the
-- nesting sheet does not carry one for. The flag marks those lines so a
-- re-import leaves them alone instead of blanking what the planner worked out.
ALTER TABLE "MaterialUsage"
  ADD COLUMN IF NOT EXISTS "actualPerUnitManual" BOOLEAN NOT NULL DEFAULT false;
