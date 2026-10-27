-- Every question on Auto takes its own model, and a reopened chat shows
-- under each answer the model that wrote it, read off the chat's usage rows.
-- One index — nothing existing changes.
CREATE INDEX "AiUsage_conversationId_id_idx" ON "AiUsage"("conversationId", "id");
