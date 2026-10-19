// Run by the build: applies the database migrations on the production
// deployment only (lib/domain/buildMigrate.ts). A pull request's preview is
// built against the factory's database, so it must not migrate it.
//   npx tsx scripts/migrate-on-build.ts
import { execSync } from "node:child_process";
import { migratesOnBuild } from "../lib/domain/buildMigrate";

const env = process.env.VERCEL_ENV;
if (migratesOnBuild(env)) {
  execSync("prisma migrate deploy", { stdio: "inherit" });
} else {
  console.log(`Migrations skipped on the ${env} deployment — they are applied when the change reaches production.`);
}
