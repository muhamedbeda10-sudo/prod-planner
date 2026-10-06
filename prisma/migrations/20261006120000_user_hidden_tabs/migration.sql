-- The screens an account does not see (CSV of tab ids). Empty = sees everything.
ALTER TABLE "User" ADD COLUMN "hiddenTabs" TEXT NOT NULL DEFAULT '';
