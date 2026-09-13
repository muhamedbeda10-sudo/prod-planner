-- BOM Review is gone: it proposed excess-reallocation moves between BOMs, and
-- in the plant's whole history it produced none — the table never held a row
-- (its id sequence never advanced past 0). With the only page that could write
-- one removed, nothing can ever create another, so the table goes too rather
-- than sitting as a permanently empty read on the plan logs and the trace.
DROP TABLE IF EXISTS "ReallocationMove";
