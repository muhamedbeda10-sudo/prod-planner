-- The Odoo sync is removed (the owner's decision, 2026-10-28): its database
-- functions and the five tables it wrote go. The BoM mirror (OdooBom,
-- OdooBomLine, OdooBomRoot) stays with what the sync last read. Nothing a
-- person typed is in these tables: the close-out log (OdooEntry) and
-- PhysicalStock are untouched.

DROP FUNCTION IF EXISTS odoo_ingest_t(text, jsonb);
DROP FUNCTION IF EXISTS odoo_pull_plan_t(text);
DROP FUNCTION IF EXISTS odoo_ticket_ok(text);
DROP FUNCTION IF EXISTS odoo_issue_ticket();
DROP FUNCTION IF EXISTS odoo_ingest(jsonb);
DROP FUNCTION IF EXISTS odoo_pull_plan();
DROP FUNCTION IF EXISTS odoo_sync_failed(text);
DROP FUNCTION IF EXISTS odoo_summary_add(jsonb, jsonb);

DROP TABLE IF EXISTS "OdooSyncTicket";
DROP TABLE IF EXISTS "OdooOrderSync";
DROP TABLE IF EXISTS "OdooChildMo";
DROP TABLE IF EXISTS "OdooMoState";
DROP TABLE IF EXISTS "OdooSyncRun";
