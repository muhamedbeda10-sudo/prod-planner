import { describe, it, expect } from "vitest";
import { migratesOnBuild } from "./buildMigrate";

describe("migratesOnBuild", () => {
  it("migrates on the production deployment", () => {
    expect(migratesOnBuild("production")).toBe(true);
  });

  it("leaves the live database alone on a pull request's preview", () => {
    expect(migratesOnBuild("preview")).toBe(false);
    expect(migratesOnBuild("development")).toBe(false);
  });

  it("migrates on a build outside Vercel, as it always did", () => {
    expect(migratesOnBuild(undefined)).toBe(true);
    expect(migratesOnBuild("")).toBe(true);
  });
});
