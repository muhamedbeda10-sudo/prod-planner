-- Per-account view settings (the Plan Tracker's columns…) — additive, safe to deploy.
CREATE TABLE IF NOT EXISTS "UserPref" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserPref_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserPref_userId_key_key" ON "UserPref"("userId", "key");
DO $$ BEGIN
  ALTER TABLE "UserPref" ADD CONSTRAINT "UserPref_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
