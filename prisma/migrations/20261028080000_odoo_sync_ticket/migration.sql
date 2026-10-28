-- The Odoo sync writes straight from the Odoo page: the scheduled task asks
-- for a one-time pass (odoo_issue_ticket()), hands it to the page, and the
-- page reads the plan and writes what it read through the "odoo-sync" Edge
-- Function (supabase/functions/odoo-sync), which calls the two pass-checking
-- functions below. All of them are the database owner's alone: the tables
-- stay off the public API. Additions only.

-- CreateTable
CREATE TABLE "OdooSyncTicket" (
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooSyncTicket_pkey" PRIMARY KEY ("hash")
);

-- A pass: 64 hex characters, good for 15 minutes; only its SHA-256 is kept.
-- Expired passes are cleared each time a new one is made.
CREATE OR REPLACE FUNCTION odoo_issue_ticket() RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  DELETE FROM "OdooSyncTicket" WHERE "expiresAt" < (now() AT TIME ZONE 'UTC');
  INSERT INTO "OdooSyncTicket" ("hash", "expiresAt")
  VALUES (encode(sha256(convert_to(t, 'UTF8')), 'hex'), (now() AT TIME ZONE 'UTC') + interval '15 minutes');
  RETURN t;
END;
$fn$;

-- Whether a pass is live.
CREATE OR REPLACE FUNCTION odoo_ticket_ok(ticket text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT ticket ~ '^[0-9a-f]{64}$' AND EXISTS (
    SELECT 1 FROM "OdooSyncTicket"
    WHERE "hash" = encode(sha256(convert_to(ticket, 'UTF8')), 'hex') AND "expiresAt" > (now() AT TIME ZONE 'UTC'));
$fn$;

-- The plan, for a live pass.
CREATE OR REPLACE FUNCTION odoo_pull_plan_t(ticket text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NOT odoo_ticket_ok(ticket) THEN RAISE EXCEPTION 'odoo sync: no live pass' USING ERRCODE = '42501'; END IF;
  RETURN odoo_pull_plan();
END;
$fn$;

-- One piece of what the pull read, for a live pass.
CREATE OR REPLACE FUNCTION odoo_ingest_t(ticket text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NOT odoo_ticket_ok(ticket) THEN RAISE EXCEPTION 'odoo sync: no live pass' USING ERRCODE = '42501'; END IF;
  RETURN odoo_ingest(p);
END;
$fn$;

-- The owner's alone: not the public API's roles, not the assistant's login.
REVOKE ALL ON "OdooSyncTicket" FROM ai_reader;
DO $do$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION odoo_issue_ticket() FROM PUBLIC;
  REVOKE ALL ON FUNCTION odoo_ticket_ok(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION odoo_pull_plan_t(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION odoo_ingest_t(text, jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'ai_reader'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "OdooSyncTicket" FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_issue_ticket() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_ticket_ok(text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_pull_plan_t(text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION odoo_ingest_t(text, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
