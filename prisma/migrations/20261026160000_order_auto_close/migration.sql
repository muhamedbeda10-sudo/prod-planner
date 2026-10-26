-- An order closes by itself once it is finished and Odoo has closed all it
-- needs (autoClosedAt: when); one reopened by hand is left open
-- (autoCloseOff) until someone closes it again. New columns with a default or
-- nullable only — nothing existing changes.

-- AlterTable
ALTER TABLE "MasterOrder" ADD COLUMN "autoCloseOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autoClosedAt" TIMESTAMP(3);
