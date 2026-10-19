// Whether a build applies the database migrations. Every Vercel deployment
// builds, and the preview of a pull request is connected to the same database
// as the factory, so applying them there would change the live database before
// the change was reviewed or merged. Only the production deployment (the merge
// to master) migrates; a build outside Vercel (VERCEL_ENV unset) keeps doing it
// too, as it always did. Pure, so the rule is tested.

export function migratesOnBuild(vercelEnv: string | undefined): boolean {
  return vercelEnv === undefined || vercelEnv === "" || vercelEnv === "production";
}
