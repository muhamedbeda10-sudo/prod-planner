-- The ODOO log's Reason column becomes a list of notes per row: the clerk
-- enters the row up to Status; the planner then moves the status and adds
-- notes, each kept with its time and author and deletable on its own.
-- The reason-history table already holds every reason ever written, so it
-- simply becomes the notes table, and the single "reason" cell goes.

ALTER TABLE "OdooReasonHistory" RENAME TO "OdooNote";
ALTER TABLE "OdooNote" RENAME COLUMN "reason" TO "text";
ALTER TABLE "OdooNote" RENAME CONSTRAINT "OdooReasonHistory_pkey" TO "OdooNote_pkey";
ALTER TABLE "OdooNote" RENAME CONSTRAINT "OdooReasonHistory_entryId_fkey" TO "OdooNote_entryId_fkey";
ALTER INDEX "OdooReasonHistory_entryId_idx" RENAME TO "OdooNote_entryId_idx";
ALTER SEQUENCE "OdooReasonHistory_id_seq" RENAME TO "OdooNote_id_seq";

-- A row whose reason said "Done" is a done row: carry that into Status.
UPDATE "OdooEntry" SET "status" = 'Done' WHERE lower(btrim(coalesce("reason", ''))) = 'done';

ALTER TABLE "OdooEntry" DROP COLUMN "reason";
