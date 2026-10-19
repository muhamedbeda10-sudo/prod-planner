-- LOGIN: failed sign-ins, kept a day, so the login can wait after too many
-- wrong passwords. New table only; no existing row changes.

-- CreateTable
CREATE TABLE "LoginFailure" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginFailure_email_ip_at_idx" ON "LoginFailure"("email", "ip", "at");

-- CreateIndex
CREATE INDEX "LoginFailure_ip_at_idx" ON "LoginFailure"("ip", "at");

-- CreateIndex
CREATE INDEX "LoginFailure_at_idx" ON "LoginFailure"("at");

-- Closed to the assistant's read-only login: who tried to sign in, from
-- where, is nobody's business but the admin's.
REVOKE ALL ON "LoginFailure" FROM ai_reader;
