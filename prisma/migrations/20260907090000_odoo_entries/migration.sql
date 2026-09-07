-- The ODOO tab: a daily log of the Odoo manufacturing orders the office tried
-- to close and what came back — "Done", or the stock error Odoo raised.
-- Deliberately no unique key: a close retried on a later day is another row,
-- because the log records attempts, not orders.

-- CreateTable
CREATE TABLE "OdooEntry" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "soi" TEXT,
    "fgCode" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "odooMo" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'MO to be close',
    "reason" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OdooEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OdooEntry_date_idx" ON "OdooEntry"("date");

-- CreateIndex
CREATE INDEX "OdooEntry_odooMo_idx" ON "OdooEntry"("odooMo");
