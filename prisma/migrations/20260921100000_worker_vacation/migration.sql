-- A worker away on vacation until a day: absent by default on the shift log, out of the dropdowns.
ALTER TABLE "Worker" ADD COLUMN "vacationUntil" TIMESTAMP(3);
