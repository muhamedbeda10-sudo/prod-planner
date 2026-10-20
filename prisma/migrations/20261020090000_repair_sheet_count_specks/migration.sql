-- FABRICATION: repair sheet counts written as a speck on 19 Oct 2026, while the
-- old build (whole-number counts) still ran against the columns just widened
-- to double precision (20261019090000_sheet_job_part_sheets). A whole count n
-- written that way reads back as n × 2^-1074 — 4 sheets show as 2e-323. Every
-- real count is 0.01 or more, so a value above 0 and under 1e-300 is such a
-- speck; multiplying by 2^1074 (twice 2^537, exact in double precision) gives
-- the count back. No other row is touched.

UPDATE "ManualJob" SET "qty" = round("qty" * power(2::float8, 537) * power(2::float8, 537))
WHERE "qty" > 0 AND "qty" < 1e-300;

UPDATE "ManualJob" SET "doneQty" = round("doneQty" * power(2::float8, 537) * power(2::float8, 537))
WHERE "doneQty" > 0 AND "doneQty" < 1e-300;

UPDATE "WorklistMachine" SET "qty" = round("qty" * power(2::float8, 537) * power(2::float8, 537))
WHERE "qty" > 0 AND "qty" < 1e-300;

UPDATE "SheetCutLog" SET "qty" = round("qty" * power(2::float8, 537) * power(2::float8, 537))
WHERE "qty" > 0 AND "qty" < 1e-300;
