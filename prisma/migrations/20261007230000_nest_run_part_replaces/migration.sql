-- A nest run's part cut from another sheet than its nesting's: the sheet it stands in for.
ALTER TABLE "NestRunPart" ADD COLUMN "replaces" TEXT NOT NULL DEFAULT '';
