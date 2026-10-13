-- What happens in the app, recorded by its own actions, and the "on event"
-- automations that fire from it.

-- CreateTable
CREATE TABLE "AppEvent" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" INTEGER,
    "actorName" TEXT NOT NULL,
    "subject" TEXT,
    "summary" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AppEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppEvent_type_at_idx" ON "AppEvent"("type", "at");
CREATE INDEX "AppEvent_at_idx" ON "AppEvent"("at");

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "eventActorIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN "eventMatch" TEXT;

-- The log names people and what they did, tasks among it: the assistant reads
-- what happened through the app's own screens and tools, never this table.
REVOKE ALL ON "AppEvent" FROM ai_reader;
