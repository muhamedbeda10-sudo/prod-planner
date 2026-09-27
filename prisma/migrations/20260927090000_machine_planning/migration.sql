-- Master switch for planning work onto machines: the machine board and the
-- Machine column on the worklists, and the Floor view. Off until the plant
-- plans by machine; the assignments already made stay in WorklistMachine.
ALTER TABLE "Settings" ADD COLUMN "machinePlanning" BOOLEAN NOT NULL DEFAULT false;
