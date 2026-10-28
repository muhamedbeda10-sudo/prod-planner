-- The Odoo BoM mirror is removed too (the owner's decision, 2026-10-28): its
-- three tables go, the lines first (they reference OdooBom). They held only
-- what the Odoo sync read; nothing anyone typed.

DROP TABLE IF EXISTS "OdooBomLine";
DROP TABLE IF EXISTS "OdooBomRoot";
DROP TABLE IF EXISTS "OdooBom";
