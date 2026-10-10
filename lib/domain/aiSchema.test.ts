import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { aiSchemaText } from "./aiSchema";
import { AI_PRIVATE_TABLES } from "./ai";
import { AI_SCHEMA_TEXT } from "@/lib/server/ai/schemaText.generated";

const schema = readFileSync("prisma/schema.prisma", "utf8");

describe("aiSchemaText", () => {
  it("keeps the tables and their comments, drops the private ones", () => {
    const t = aiSchemaText(schema);
    expect(t).toContain("model MasterOrder {");
    expect(t).toContain("// Master order registry");
    for (const p of AI_PRIVATE_TABLES) expect(t).not.toMatch(new RegExp(`model ${p} \\{`));
    expect(t).not.toMatch(/generator client|datasource db/);
  });
  it("tells only who an account is", () => {
    const t = aiSchemaText(schema);
    const user = t.slice(t.indexOf("model User {"), t.indexOf("}", t.indexOf("model User {")));
    expect(user).toMatch(/\bname\b/);
    expect(user).not.toMatch(/passwordHash|perms|email|sessions/);
  });
  it("the generated copy is up to date — run `npm run ai:schema` after changing the schema", () => {
    expect(AI_SCHEMA_TEXT).toBe(aiSchemaText(schema));
  });
});

describe("the read-only login", () => {
  it("every private table is revoked from ai_reader in a migration", () => {
    const sql = readdirSync("prisma/migrations", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => readFileSync(`prisma/migrations/${d.name}/migration.sql`, "utf8"))
      .join("\n");
    const revokes = [...sql.matchAll(/REVOKE[\s\S]*?FROM ai_reader/g)].map((m) => m[0]).join("\n");
    for (const p of [...AI_PRIVATE_TABLES, "User"]) expect(revokes).toContain(`"${p}"`);
  });
});
