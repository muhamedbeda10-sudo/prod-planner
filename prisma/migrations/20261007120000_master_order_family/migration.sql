-- Which of the line's plans brought an order: "" the main plan (transformers,
-- LV panels), "MB" the LV meter boxes' own sheet.
ALTER TABLE "MasterOrder" ADD COLUMN "family" TEXT NOT NULL DEFAULT '';

-- The meter boxes' October 2026 plan (Meter_Box_Production_Plan_10-2026.xlsx,
-- Rev_0.0), loaded as its import would file it: line LV, plan MB, the FG code
-- standing in for the BOM. An MO already in the registry is left alone.
INSERT INTO "MasterOrder" ("mo", "line", "family", "soi", "urgent", "customer", "fgCode", "bom", "secItem", "product", "planQty", "ospEncloser", "source", "months", "updatedAt")
VALUES
  ('SF01/MO/19808-001', 'LV', 'MB', 'S01340-1',  true,  'PRI', 'FG-SDMB-8421036',    'FG-SDMB-8421036',    '908421036', 'CTMB',        70,   0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/19809',     'LV', 'MB', 'S01340-2',  true,  'PRI', 'FG-SDMB-8421033',    'FG-SDMB-8421033',    '908421033', 'CTMB',        50,   0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/19810',     'LV', 'MB', 'S01340-3',  true,  'PRI', 'FG-SDMB-8421034',    'FG-SDMB-8421034',    '908421034', 'CTMB',        12,   0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/16604',     'LV', 'MB', 'S01086-3',  true,  'PRI', 'FG-SDMB-8421036',    'FG-SDMB-8421036',    '908421036', 'CTMB',        40,   0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/16605',     'LV', 'MB', 'S01086-4',  true,  'PRI', 'FG-SDMB-8421033',    'FG-SDMB-8421033',    '908421033', 'CTMB',        2,    0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/21108',     'LV', 'MB', 'S00474-56', true,  'PRI', 'FG-SDMB-8421035',    'FG-SDMB-8421035',    '908421035', 'Remote MB',   2,    0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/21017',     'LV', 'MB', 'Mix',       false, 'SEC', 'FG-LV-B-DMB-000001', 'FG-LV-B-DMB-000001', '908421025', 'SMB GI V2.1', 1300, 0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/14516',     'LV', 'MB', 'Repair',    false, 'SEC', 'FG-RPR-SMB',         'FG-RPR-SMB',         '908421025', 'SMB Repair',  2000, 0,    'October 2026', 'October 2026', NOW()),
  ('SF01/MO/21031',     'LV', 'MB', 'Mix',       false, 'SEC', 'FG-LV-B-DMB-000002', 'FG-LV-B-DMB-000002', '908421031', 'DMB GI V2.3', 8320, 8320, 'October 2026', 'October 2026', NOW()),
  ('SF01/MO/14515',     'LV', 'MB', 'Repair',    false, 'SEC', 'FG-RPR-DMB',         'FG-RPR-DMB',         '908421031', 'DMB Repair',  203,  0,    'October 2026', 'October 2026', NOW())
ON CONFLICT ("mo") DO NOTHING;
