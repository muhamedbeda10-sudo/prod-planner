-- The What-if Simulator screen is gone: the assistant runs the what-ifs, and
-- each chat keeps the scenario it is working on (what "add Fridays too"
-- builds on). One nullable column — nothing existing changes.
ALTER TABLE "AiConversation" ADD COLUMN "scenario" JSONB;
