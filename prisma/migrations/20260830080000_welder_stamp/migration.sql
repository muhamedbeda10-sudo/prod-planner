-- The single letter beside each welder is his STAMP: the mark he punches into
-- every tank he welds. Naming it properly, and — more importantly — recording
-- it on the tank itself.
--
-- A tank's stamp is physically on the steel. Reading it back off the welder's
-- profile would rewrite history the day an admin re-assigns a letter, so the
-- tank keeps its own snapshot, exactly as it already does for the welder's name.

ALTER TABLE "Worker" RENAME COLUMN "mark" TO "stamp";

ALTER TABLE "TankUnit" ADD COLUMN "weldedStamp" TEXT;

-- Tanks welded before this migration: take the stamp their welder carries now.
-- That is the best evidence available, and from here on it is snapshotted at
-- the moment of welding instead.
UPDATE "TankUnit" t
SET "weldedStamp" = w."stamp"
FROM "Worker" w
WHERE t."weldedById" = w."id"
  AND t."weldedStamp" IS NULL
  AND w."stamp" IS NOT NULL;
