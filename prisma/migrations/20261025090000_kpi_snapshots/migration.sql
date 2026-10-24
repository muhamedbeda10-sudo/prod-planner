-- The cockpit's figures as they read on each factory day, for their trend.
-- A new table only.
CREATE TABLE "KpiSnapshot" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KpiSnapshot_date_key" ON "KpiSnapshot"("date");
