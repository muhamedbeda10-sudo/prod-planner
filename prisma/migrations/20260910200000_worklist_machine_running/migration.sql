-- More than one line can run on a machine at once: "running" marks them,
-- the rest wait in rank order. Until now the front of the queue was the
-- running line — keep that reading for what is already on the board.
ALTER TABLE "WorklistMachine" ADD COLUMN "running" BOOLEAN NOT NULL DEFAULT false;
UPDATE "WorklistMachine" SET "running" = true WHERE "rank" = 1;
