-- The app's owner: every right, and the only one managing users & permissions
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isOwner" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "isOwner" = true, "isAdmin" = false WHERE lower("email") = 'muhamedbeda10@gmail.com';
