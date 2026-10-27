import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOdooPull, ODOO_PULL_FILE } from "../scripts/gen-odoo-pull";

// /odoo-pull.js is what the scheduled task loads into an Odoo page. It must be
// the pull as the code says — rebuild it with `npx tsx scripts/gen-odoo-pull.ts`.

describe("the served Odoo pull", () => {
  it("is current with lib/domain/odooPull.ts", () => {
    expect(readFileSync(ODOO_PULL_FILE, "utf8")).toBe(buildOdooPull());
  });

  it("starts a job and never names a write method", () => {
    const js = readFileSync(ODOO_PULL_FILE, "utf8");
    expect(js).toContain("__odooPullStart");
    expect(js).toContain("/web/dataset/call_kw/");
    for (const m of ['"write"', '"create"', '"unlink"', "button_mark_done", "action_confirm"]) expect(js).not.toContain(m);
  });
});
