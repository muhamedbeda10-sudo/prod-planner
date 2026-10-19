-- DAILY LOG: the chain check, the tracker's totals and the trace all read one
-- order's item at one stage. Index only; no row changes.

-- CreateIndex
CREATE INDEX "HandoverEntry_mo_item_dept_idx" ON "HandoverEntry"("mo", "item", "dept");
