-- Workers are registered in SECTIONS (Laser Cutting TX, Welding USS/LV …) that
-- roll up to the departments the app records on. Rows stored with the bare
-- department read as its first section.
UPDATE "Worker" SET depts = regexp_replace(depts, '\mCut\M', 'LaserCutTX', 'g');
UPDATE "Worker" SET depts = regexp_replace(depts, '\mWelding\M', 'WeldingTX', 'g');
UPDATE "Worker" SET depts = regexp_replace(depts, '\mPainting\M', 'PaintingTX', 'g');
