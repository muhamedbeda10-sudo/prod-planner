-- The Odoo sync reads Odoo's BoMs too (lib/domain/odooBomPull.ts): the plan
-- names the open orders' BOM codes and the fingerprint of every BoM held, and
-- the pull's pieces carry the BoMs that changed and every code's root, which
-- odoo_ingest writes into OdooBom / OdooBomLine / OdooBomRoot. The three
-- functions are the same as the odoo_sync migration's, with that added; they
-- stay the database owner's alone (CREATE OR REPLACE keeps their grants).

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
    'hashes', COALESCE((SELECT jsonb_object_agg(o."parentMo", o."hash") FROM "OdooOrderSync" o), '{}'::jsonb),
    'boms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('bom', b, 'mos', mos) ORDER BY b) FROM (
        SELECT upper(btrim(m."bom")) AS b, jsonb_agg(DISTINCT btrim(m."mo")) AS mos
        FROM "MasterOrder" m WHERE m."status" = 'open' AND btrim(m."bom") <> '' GROUP BY 1
      ) x
    ), '[]'::jsonb),
    'bomSigs', COALESCE((SELECT jsonb_object_agg(b."odooId"::text, b."sig") FROM "OdooBom" b), '{}'::jsonb)
  );
$fn$;

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
    'boms', jsonb_build_object(
      'written', COALESCE((a#>>'{boms,written}')::int, 0) + COALESCE((b#>>'{boms,written}')::int, 0),
      'lines', COALESCE((a#>>'{boms,lines}')::int, 0) + COALESCE((b#>>'{boms,lines}')::int, 0),
      'roots', COALESCE((a#>>'{boms,roots}')::int, 0) + COALESCE((b#>>'{boms,roots}')::int, 0),
      'missing', COALESCE((a#>>'{boms,missing}')::int, 0) + COALESCE((b#>>'{boms,missing}')::int, 0)),
    'issues', COALESCE(a->'issues', '[]'::jsonb) || COALESCE(b->'issues', '[]'::jsonb),
    'ms', GREATEST((a->>'ms')::int, (b->>'ms')::int)
  ) END;
$fn$;

CREATE OR REPLACE FUNCTION odoo_ingest(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  v_at TIMESTAMP(3) := ((p->>'at')::timestamptz AT TIME ZONE 'UTC');
  v_issues jsonb := COALESCE(p->'issues', '[]'::jsonb);
  n_log int := 0; n_done int := 0; n_open int := 0; n_ren int := 0; n_nf int := 0;
  n_orders int := 0; n_mos int := 0;
  st_upd int := 0; st_seen int := 0; st_miss int := 0; st_skip boolean := false;
  nonzero int := 0; tozero int := 0;
  b_written int := 0; b_lines int := 0; b_roots int := 0; b_missing int := 0;
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

  -- 4. Odoo's BoMs: each BoM that changed replaced whole, with its lines;
  -- every open code's root when the piece carries them
  IF jsonb_typeof(p->'boms') = 'array' AND jsonb_array_length(p->'boms') > 0 THEN
    INSERT INTO "OdooBom" ("odooId", "code", "productCode", "productName", "qty", "uom", "sig", "syncedAt")
    SELECT (x->>0)::int, left(COALESCE(x->>1, ''), 120), left(COALESCE(x->>2, ''), 120), left(COALESCE(x->>3, ''), 300),
           GREATEST(COALESCE((x->>4)::float8, 1), 1e-9), left(COALESCE(x->>5, ''), 60), left(COALESCE(x->>6, ''), 120), v_at
    FROM jsonb_array_elements(p->'boms') x
    ON CONFLICT ("odooId") DO UPDATE SET
      "code" = EXCLUDED."code", "productCode" = EXCLUDED."productCode", "productName" = EXCLUDED."productName",
      "qty" = EXCLUDED."qty", "uom" = EXCLUDED."uom", "sig" = EXCLUDED."sig", "syncedAt" = EXCLUDED."syncedAt";
    GET DIAGNOSTICS b_written = ROW_COUNT;
    DELETE FROM "OdooBomLine" l USING "OdooBom" b
    WHERE l."bomId" = b."id" AND b."odooId" IN (SELECT (x->>0)::int FROM jsonb_array_elements(p->'boms') x);
    INSERT INTO "OdooBomLine" ("bomId", "seq", "productCode", "productName", "qty", "uom", "stockQty", "stockUom", "childOdooId")
    SELECT b."id", (l->>0)::int, left(COALESCE(l->>1, ''), 120), left(COALESCE(l->>2, ''), 300), COALESCE((l->>3)::float8, 0),
           left(COALESCE(l->>4, ''), 60), COALESCE((l->>5)::float8, 0), left(COALESCE(l->>6, ''), 60), (l->>7)::int
    FROM jsonb_array_elements(p->'boms') x
    JOIN "OdooBom" b ON b."odooId" = (x->>0)::int
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(x->7, '[]'::jsonb)) l;
    GET DIAGNOSTICS b_lines = ROW_COUNT;
  END IF;
  IF jsonb_typeof(p->'bomRoots') = 'array' THEN
    INSERT INTO "OdooBomRoot" ("bom", "odooId", "via", "syncedAt")
    SELECT DISTINCT ON (upper(btrim(x->>0))) upper(btrim(x->>0)), (x->>1)::int, COALESCE(x->>2, ''), v_at
    FROM jsonb_array_elements(p->'bomRoots') x WHERE btrim(COALESCE(x->>0, '')) <> ''
    ON CONFLICT ("bom") DO UPDATE SET "odooId" = EXCLUDED."odooId", "via" = EXCLUDED."via", "syncedAt" = EXCLUDED."syncedAt";
    SELECT count(*) FILTER (WHERE x->>1 IS NOT NULL), count(*) FILTER (WHERE x->>1 IS NULL)
      INTO b_roots, b_missing FROM jsonb_array_elements(p->'bomRoots') x;
  END IF;

  v_summary := jsonb_build_object(
    'log', jsonb_build_object('checked', n_log, 'done', n_done, 'open', n_open, 'renamed', n_ren, 'notFound', n_nf),
    'children', jsonb_build_object('orders', n_orders, 'mos', n_mos, 'unchanged', COALESCE((p->>'unchanged')::int, 0)),
    'stock', jsonb_build_object('updated', st_upd, 'unchanged', GREATEST(st_seen - st_upd, 0), 'missing', st_miss, 'skipped', st_skip),
    'boms', jsonb_build_object('written', b_written, 'lines', b_lines, 'roots', b_roots, 'missing', b_missing),
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

-- The BoM mirror is the app's and the assistant's to read, never the public API's.
DO $do$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "OdooBom", "OdooBomLine", "OdooBomRoot" FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
