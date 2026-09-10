-- Covering indexes for the foreign keys the linter flagged: the shift log
-- joins workers and machines per day, and chat threads follow replyToId.
CREATE INDEX IF NOT EXISTS "ShiftEntry_workerId_idx" ON "ShiftEntry"("workerId");
CREATE INDEX IF NOT EXISTS "ShiftEntry_machineId_idx" ON "ShiftEntry"("machineId");
CREATE INDEX IF NOT EXISTS "ChatMessage_replyToId_idx" ON "ChatMessage"("replyToId");
