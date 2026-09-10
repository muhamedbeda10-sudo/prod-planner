-- Bending joins the machine list, and every machine gets the hours a day the
-- load board and the ⚡ planner measure against.
--
-- The plant runs about ten bending presses; the planner works them as ONE
-- machine for now (one queue, one load), so they enter the list as a single
-- row. Its hours a day are the capacity sheet's own figures: the fabrication
-- crew is "laser 15 + bending 8 + fin folding 10 people" on the 11-hour
-- shift, so bending has 8 × 11 = 88 man-hours a day.
INSERT INTO "Machine" ("code", "name", "dept", "center", "hoursPerDay", "sortOrder", "createdAt", "updatedAt")
VALUES ('BND-1', 'Bending presses', 'Cut', 'Bending', 88, 13, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;

-- Hours a day, only where nobody has set them (an edited figure is kept).
-- The same capacity sheet, split over the machines of each work centre:
--   • laser + punch, 15 people × 11 h = 165 over the eleven cutting machines
--     (the tube and roll-blank lasers are that crew's too) → 15 each
--   • fin folding, 10 people × 11 h = 110 on the one fins machine
--   • shot blast 4 people × 11 h = 44 over two lines → 22 each
--   • painting 29 people × 11 h = 319 over two lines → 159.5 each
-- Fabrication then totals 9×15 + 15 + 15 + 110 + 88 = 363 man-hours a day,
-- exactly the Cut capacity the sheet states. Welding is left alone: its
-- partitions are still being drawn, and each gets its crew's hours.
UPDATE "Machine" SET "hoursPerDay" = 15    WHERE "hoursPerDay" IS NULL AND "dept" = 'Cut' AND "center" IN ('Cutting', 'Tubes', 'RollBlank');
UPDATE "Machine" SET "hoursPerDay" = 110   WHERE "hoursPerDay" IS NULL AND "dept" = 'Cut' AND "center" = 'Fins';
UPDATE "Machine" SET "hoursPerDay" = 22    WHERE "hoursPerDay" IS NULL AND "dept" = 'ShotBlast';
UPDATE "Machine" SET "hoursPerDay" = 159.5 WHERE "hoursPerDay" IS NULL AND "dept" = 'Painting';
