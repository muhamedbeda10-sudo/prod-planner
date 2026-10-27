-- Odoo, read on a schedule. The app reads Odoo — never writes to it — and
-- not from its server: a scheduled task on the owner's computer opens Odoo in
-- the Claude desktop app's browser with the user's own login, runs
-- /odoo-pull.js there with the plan odoo_pull_plan() gives, and hands what it
-- read to odoo_ingest() in one call. These tables keep what Odoo said, apart
-- from anything people type. Additions only: no existing row is changed here.

-- CreateTable
CREATE TABLE "OdooSyncRun" (
    "id" SERIAL NOT NULL,
    "slot" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB,
    "error" TEXT,
    "startedBy" TEXT,

    CONSTRAINT "OdooSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooMoState" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL DEFAULT true,
    "currentName" TEXT NOT NULL DEFAULT '',
    "odooId" INTEGER,
    "state" TEXT NOT NULL DEFAULT '',
    "productCode" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qtyProduced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooMoState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooChildMo" (
    "id" SERIAL NOT NULL,
    "parentMo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "odooId" INTEGER NOT NULL,
    "item" TEXT NOT NULL DEFAULT '',
    "productCode" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qtyProduced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "doneAt" TIMESTAMP(3),
    "linkHow" TEXT NOT NULL DEFAULT '',
    "sharedWith" TEXT NOT NULL DEFAULT '',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooChildMo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooOrderSync" (
    "parentMo" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooOrderSync_pkey" PRIMARY KEY ("parentMo")
);

-- CreateIndex
CREATE UNIQUE INDEX "OdooSyncRun_slot_key" ON "OdooSyncRun"("slot");
CREATE INDEX "OdooSyncRun_startedAt_idx" ON "OdooSyncRun"("startedAt");
CREATE UNIQUE INDEX "OdooMoState_name_key" ON "OdooMoState"("name");
CREATE INDEX "OdooMoState_state_idx" ON "OdooMoState"("state");
CREATE UNIQUE INDEX "OdooChildMo_parentMo_odooId_key" ON "OdooChildMo"("parentMo", "odooId");
CREATE INDEX "OdooChildMo_parentMo_item_idx" ON "OdooChildMo"("parentMo", "item");
CREATE INDEX "OdooChildMo_name_idx" ON "OdooChildMo"("name");

-- What the pull should read: the close-out log's MOs Odoo has not settled yet
-- (a done or cancelled MO stays as read), the open orders of both lines,
-- Physical Material's codes, and how each order's sub-assemblies read last
-- time. Names as the log and Odoo write them: trimmed, upper case; a row
-- cancelled here is nothing to compare (lib/domain/odooSync.ts odooAgreement).
CREATE OR REPLACE FUNCTION odoo_pull_plan() RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_build_object(
    'logNames', COALESCE((
      SELECT jsonb_agg(n ORDER BY n) FROM (
        SELECT DISTINCT upper(btrim(e."odooMo")) AS n
        FROM "OdooEntry" e
        WHERE btrim(e."odooMo") <> '' AND lower(btrim(e."status")) NOT IN ('cancelled', 'canceled')
      ) x
      WHERE NOT EXISTS (SELECT 1 FROM "OdooMoState" s WHERE s."name" = x.n AND s."found" AND s."state" IN ('done', 'cancel'))
    ), '[]'::jsonb),
    'tr', COALESCE((SELECT jsonb_agg(DISTINCT upper(btrim(m."mo"))) FROM "MasterOrder" m WHERE m."status" = 'open' AND m."line" <> 'LV' AND btrim(m."mo") <> ''), '[]'::jsonb),
    'lv', COALESCE((SELECT jsonb_agg(DISTINCT upper(btrim(m."mo"))) FROM "MasterOrder" m WHERE m."status" = 'open' AND m."line" = 'LV' AND btrim(m."mo") <> ''), '[]'::jsonb),
    'codes', COALESCE((SELECT jsonb_agg(p."code" ORDER BY p."sortOrder", p."id") FROM "PhysicalStock" p), '[]'::jsonb),
    'hashes', COALESCE((SELECT jsonb_object_agg(o."parentMo", o."hash") FROM "OdooOrderSync" o), '{}'::jsonb)
  );
$fn$;

-- Two run summaries added together — the pieces of one pull (below).
CREATE OR REPLACE FUNCTION odoo_summary_add(a jsonb, b jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a ELSE jsonb_build_object(
    'log', jsonb_build_object(
      'checked', (a#>>'{log,checked}')::int + (b#>>'{log,checked}')::int, 'done', (a#>>'{log,done}')::int + (b#>>'{log,done}')::int,
      'open', (a#>>'{log,open}')::int + (b#>>'{log,open}')::int, 'renamed', (a#>>'{log,renamed}')::int + (b#>>'{log,renamed}')::int,
      'notFound', (a#>>'{log,notFound}')::int + (b#>>'{log,notFound}')::int),
    'children', jsonb_build_object(
      'orders', (a#>>'{children,orders}')::int + (b#>>'{children,orders}')::int, 'mos', (a#>>'{children,mos}')::int + (b#>>'{children,mos}')::int,
      'unchanged', (a#>>'{children,unchanged}')::int + (b#>>'{children,unchanged}')::int),
    'stock', jsonb_build_object(
      'updated', (a#>>'{stock,updated}')::int + (b#>>'{stock,updated}')::int, 'unchanged', (a#>>'{stock,unchanged}')::int + (b#>>'{stock,unchanged}')::int,
      'missing', (a#>>'{stock,missing}')::int + (b#>>'{stock,missing}')::int,
      'skipped', COALESCE((a#>>'{stock,skipped}')::boolean, false) OR COALESCE((b#>>'{stock,skipped}')::boolean, false)),
    'issues', COALESCE(a->'issues', '[]'::jsonb) || COALESCE(b->'issues', '[]'::jsonb),
    'ms', GREATEST((a->>'ms')::int, (b->>'ms')::int)
  ) END;
$fn$;

-- What the pull read, written in one go per piece (lib/domain/odooPull.ts
-- OdooPullPayload; a big pull comes in several pieces of the same `at`, kept
-- as one run whose summary adds them up). Each part of the read on its own: a
-- part the pull could not read is missing from the payload and leaves the
-- stored rows as they were. Handing the same piece in twice writes the same
-- rows (its counts are then added to the run twice — a run summary, not data).
-- Physical Material: only the Odoo column of codes already listed, and not at
-- all when most of the stock would drop to zero at once (a broken read).
CREATE OR REPLACE FUNCTION odoo_ingest(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  v_at TIMESTAMP(3) := ((p->>'at')::timestamptz AT TIME ZONE 'UTC');
  v_issues jsonb := COALESCE(p->'issues', '[]'::jsonb);
  n_log int := 0; n_done int := 0; n_open int := 0; n_ren int := 0; n_nf int := 0;
  n_orders int := 0; n_mos int := 0;
  st_upd int := 0; st_seen int := 0; st_miss int := 0; st_skip boolean := false;
  nonzero int := 0; tozero int := 0;
  v_summary jsonb;
BEGIN
  IF p IS NULL OR (p->>'v') IS DISTINCT FROM '1' OR v_at IS NULL THEN
    RAISE EXCEPTION 'odoo_ingest: not an Odoo pull payload (v=%, at=%)', p->>'v', p->>'at';
  END IF;

  -- 1. the close-out log's MOs
  INSERT INTO "OdooMoState" ("name", "found", "currentName", "odooId", "state", "productCode", "qty", "qtyProduced", "doneAt", "checkedAt")
  SELECT upper(btrim(x->>0)), (x->>1) = '1', COALESCE(x->>2, ''), (x->>3)::int, COALESCE(x->>4, ''), COALESCE(x->>5, ''),
         COALESCE((x->>6)::float8, 0), COALESCE((x->>7)::float8, 0), (x->>8)::timestamp, v_at
  FROM jsonb_array_elements(COALESCE(p->'log', '[]'::jsonb)) x
  ON CONFLICT ("name") DO UPDATE SET
    "found" = EXCLUDED."found", "currentName" = EXCLUDED."currentName", "odooId" = EXCLUDED."odooId", "state" = EXCLUDED."state",
    "productCode" = EXCLUDED."productCode", "qty" = EXCLUDED."qty", "qtyProduced" = EXCLUDED."qtyProduced", "doneAt" = EXCLUDED."doneAt",
    "checkedAt" = EXCLUDED."checkedAt";
  GET DIAGNOSTICS n_log = ROW_COUNT;
  SELECT count(*) FILTER (WHERE x->>1 = '1' AND x->>4 = 'done'),
         count(*) FILTER (WHERE x->>1 = '1' AND COALESCE(x->>4, '') NOT IN ('done', 'cancel', '')),
         count(*) FILTER (WHERE x->>1 = '1' AND upper(COALESCE(x->>2, '')) <> upper(x->>0)),
         count(*) FILTER (WHERE x->>1 = '0')
    INTO n_done, n_open, n_ren, n_nf
  FROM jsonb_array_elements(COALESCE(p->'log', '[]'::jsonb)) x;

  -- 2. the sub-assembly MOs of the orders that read differently from last time
  DELETE FROM "OdooChildMo" WHERE "parentMo" IN (SELECT o->>'mo' FROM jsonb_array_elements(COALESCE(p->'orders', '[]'::jsonb)) o);
  INSERT INTO "OdooChildMo" ("parentMo", "name", "odooId", "item", "productCode", "qty", "qtyProduced", "uom", "state", "doneAt", "linkHow", "sharedWith", "syncedAt")
  SELECT x->>0, x->>1, (x->>2)::int, COALESCE(x->>3, ''), COALESCE(x->>4, ''), COALESCE((x->>5)::float8, 0), COALESCE((x->>6)::float8, 0),
         COALESCE(x->>7, ''), COALESCE(x->>8, ''), (x->>9)::timestamp, COALESCE(x->>10, ''), COALESCE(x->>11, ''), v_at
  FROM jsonb_array_elements(COALESCE(p->'children', '[]'::jsonb)) x
  ON CONFLICT ("parentMo", "odooId") DO NOTHING;
  GET DIAGNOSTICS n_mos = ROW_COUNT;
  INSERT INTO "OdooOrderSync" ("parentMo", "hash", "syncedAt")
  SELECT o->>'mo', o->>'hash', v_at FROM jsonb_array_elements(COALESCE(p->'orders', '[]'::jsonb)) o
  ON CONFLICT ("parentMo") DO UPDATE SET "hash" = EXCLUDED."hash", "syncedAt" = EXCLUDED."syncedAt";
  GET DIAGNOSTICS n_orders = ROW_COUNT;

  -- 3. SF01/Shop Floor Warehouse into Physical Material's Odoo column
  IF jsonb_typeof(p->'stock') = 'object' THEN
    st_miss := jsonb_array_length(COALESCE(p->'stock'->'missing', '[]'::jsonb));
    SELECT count(*), count(*) FILTER (WHERE ps."odoo" <> 0), count(*) FILTER (WHERE ps."odoo" <> 0 AND v.q = 0)
      INTO st_seen, nonzero, tozero
    FROM "PhysicalStock" ps
    JOIN (SELECT upper(btrim(x->>0)) AS code, (x->>1)::float8 AS q FROM jsonb_array_elements(COALESCE(p->'stock'->'values', '[]'::jsonb)) x) v
      ON upper(btrim(ps."code")) = v.code;
    IF nonzero > 0 AND tozero * 2 > nonzero THEN
      st_skip := true;
      v_issues := v_issues || to_jsonb(format('SF01 stock: %s of %s stocks would drop to zero at once — not written', tozero, nonzero));
    ELSE
      UPDATE "PhysicalStock" ps SET "odoo" = v.q, "updatedBy" = 'Odoo sync', "updatedAt" = (now() AT TIME ZONE 'UTC')
      FROM (SELECT upper(btrim(x->>0)) AS code, (x->>1)::float8 AS q FROM jsonb_array_elements(COALESCE(p->'stock'->'values', '[]'::jsonb)) x) v
      WHERE upper(btrim(ps."code")) = v.code AND ps."odoo" IS DISTINCT FROM v.q;
      GET DIAGNOSTICS st_upd = ROW_COUNT;
    END IF;
  END IF;

  v_summary := jsonb_build_object(
    'log', jsonb_build_object('checked', n_log, 'done', n_done, 'open', n_open, 'renamed', n_ren, 'notFound', n_nf),
    'children', jsonb_build_object('orders', n_orders, 'mos', n_mos, 'unchanged', COALESCE((p->>'unchanged')::int, 0)),
    'stock', jsonb_build_object('updated', st_upd, 'unchanged', GREATEST(st_seen - st_upd, 0), 'missing', st_miss, 'skipped', st_skip),
    'issues', v_issues,
    'ms', COALESCE((p->>'ms')::int, 0)
  );
  INSERT INTO "OdooSyncRun" ("slot", "trigger", "startedAt", "finishedAt", "status", "summary")
  VALUES ('pull@' || (p->>'at'), 'schedule', v_at, (now() AT TIME ZONE 'UTC'),
          CASE WHEN jsonb_array_length(v_issues) > 0 THEN 'partial' ELSE 'ok' END, v_summary)
  ON CONFLICT ("slot") DO UPDATE SET
    "summary" = odoo_summary_add("OdooSyncRun"."summary", EXCLUDED."summary"),
    "finishedAt" = EXCLUDED."finishedAt",
    "status" = CASE WHEN "OdooSyncRun"."status" = 'partial' OR EXCLUDED."status" = 'partial' THEN 'partial' ELSE 'ok' END
  RETURNING "summary" INTO v_summary;
  RETURN v_summary;
END;
$fn$;

-- The task could not read Odoo at all (the computer off, a login page): kept
-- as a failed run, so the settings card says so.
CREATE OR REPLACE FUNCTION odoo_sync_failed(reason text) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO "OdooSyncRun" ("slot", "trigger", "startedAt", "finishedAt", "status", "error")
  VALUES ('failed@' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'schedule',
          (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'), 'failed', left(COALESCE(reason, ''), 500));
$fn$;

-- Only the database's owner (the task, through the Supabase connector) runs
-- these — never the public API's roles or the assistant's SQL login.
DO $do$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION odoo_pull_plan() FROM PUBLIC;
  REVOKE ALL ON FUNCTION odoo_ingest(jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION odoo_sync_failed(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION odoo_summary_add(jsonb, jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'ai_reader'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_pull_plan() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_ingest(jsonb) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_sync_failed(text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_summary_add(jsonb, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
