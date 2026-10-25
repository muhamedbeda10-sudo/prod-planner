-- Choose the first tracked plan month before allocating project-only Odoo closings.
-- No historical quantity or closing record is changed.
ALTER TABLE "Settings" ADD COLUMN "odooTrackingFrom" TEXT;
