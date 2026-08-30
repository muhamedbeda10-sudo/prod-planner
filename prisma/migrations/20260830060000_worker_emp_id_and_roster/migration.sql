-- The shop floor identifies a man by the number on his badge, not by his name:
-- names on the workforce sheet repeat, are long, and are easy to mistype. empId
-- becomes the identifier the technician enters; the name is only shown back to
-- confirm the right person was picked.
--
-- Written to survive a table that already holds rows: empId arrives nullable,
-- gets a placeholder, and only then becomes NOT NULL.

ALTER TABLE "Worker" ADD COLUMN "empId" TEXT;
UPDATE "Worker" SET "empId" = 'TMP-' || "id"::text WHERE "empId" IS NULL;
ALTER TABLE "Worker" ALTER COLUMN "empId" SET NOT NULL;

ALTER TABLE "Worker" DROP COLUMN IF EXISTS "code";
ALTER TABLE "Worker" ADD COLUMN "jobTitle" TEXT;
ALTER TABLE "Worker" ADD COLUMN "mark" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Worker_empId_key" ON "Worker"("empId");

-- CreateIndex
CREATE INDEX "Worker_active_idx" ON "Worker"("active");

-- The workforce as supplied: welders and welder helpers on Welding, the two men
-- assigned to the leak test, and the painting crew. "mark" is the single letter
-- printed beside each welder on that sheet, kept verbatim.
-- ON CONFLICT DO NOTHING so re-running this migration, or adding someone by hand
-- first, never fails or overwrites what the admin has already edited.
INSERT INTO "Worker" ("empId", "name", "jobTitle", "mark", "depts", "active", "createdAt", "updatedAt") VALUES
  ('100058', 'Ohidul Faraji Eunus',      'Tank Full Welder',     'X', 'Welding',  true, NOW(), NOW()),
  ('100103', 'Ahashad Miah Younus Miah', 'Tank Full Welder',     'C', 'Welding',  true, NOW(), NOW()),
  ('100133', 'Mohammad Islam',           'Tank Full Welder',     'F', 'Welding',  true, NOW(), NOW()),
  ('100138', 'MD Razu',                  'Tank Full Welder',     'K', 'Welding',  true, NOW(), NOW()),
  ('100196', 'Sanawwar Ali',             'Tank Full Welder',     'M', 'Welding',  true, NOW(), NOW()),
  ('100197', 'Noorul Hasan',             'Tank Full Welder',     'D', 'Welding',  true, NOW(), NOW()),
  ('100236', 'Abdul Sohel Baig',         'Tank Full Welder',     'E', 'Welding',  true, NOW(), NOW()),
  ('100285', 'Mohammad Juber Khan',      'Tank Full Welder',     'N', 'Welding',  true, NOW(), NOW()),
  ('100334', 'Momen Miah Kazi Kuddus',   'Tank Full Welder',     'S', 'Welding',  true, NOW(), NOW()),
  ('100378', 'Sohel Sheikh Babu Sheikh', 'Tank Full Welder',     'A', 'Welding',  true, NOW(), NOW()),
  ('100423', 'MD Rony Mondol',           'Tank Full Welder',     'W', 'Welding',  true, NOW(), NOW()),
  ('100487', 'Emon Miah',                'Tank Full Welder',     'H', 'Welding',  true, NOW(), NOW()),
  ('100496', 'Forhad Mahmud',            'Tank Full Welder',     'Z', 'Welding',  true, NOW(), NOW()),
  ('100525', 'MD Foysal Miah',           'Welder Helper',        'P', 'Welding',  true, NOW(), NOW()),
  ('100613', 'MD Salim Sarkar',          'Welder Helper',        'Q', 'Welding',  true, NOW(), NOW()),
  ('101067', 'Anburragul',               'CNC Machine Operator', NULL, 'LeakTest', true, NOW(), NOW()),
  ('101232', 'Gulam Rasul Mansuri',      'Welder',               NULL, 'LeakTest', true, NOW(), NOW()),
  ('100498', 'MD Azad Miah',             'Painter',              NULL, 'Painting', true, NOW(), NOW()),
  ('100590', 'MD Masud Rana',            'Painting Helper',      NULL, 'Painting', true, NOW(), NOW()),
  ('100600', 'MD Mujahid Molla',         'Painter Helper',       NULL, 'Painting', true, NOW(), NOW()),
  ('100609', 'Emon Monshi',              'Painter',              NULL, 'Painting', true, NOW(), NOW()),
  ('101338', 'Mohammad Haseeb Suleman',  'Painter',              NULL, 'Painting', true, NOW(), NOW()),
  ('101339', 'MD Kazi Jonayet',          'Painter',              NULL, 'Painting', true, NOW(), NOW()),
  ('101345', 'Abu Obaida Rais Ahmad',    'Painter',              NULL, 'Painting', true, NOW(), NOW())
ON CONFLICT DO NOTHING;
