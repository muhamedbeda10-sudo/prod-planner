import { afterEach, describe, expect, it, vi } from "vitest";

// The Odoo client (lib/server/odooApi.ts): reads only, whatever the key's
// user may do in Odoo — a write never leaves the server.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { connectOdoo, normalizeOdooUrl } from "@/lib/server/odooApi";

const conn = { url: "https://atcodoo.odoo.com", db: "db", login: "me", apiKey: "k" };

afterEach(() => vi.unstubAllGlobals());

describe("the Odoo client", () => {
  it("keeps the address to https and a host name", () => {
    expect(normalizeOdooUrl("atcodoo.odoo.com/web#cids=1")).toBe("https://atcodoo.odoo.com");
    expect(normalizeOdooUrl("https://AtcOdoo.odoo.com/")).toBe("https://atcodoo.odoo.com");
    expect(normalizeOdooUrl("http://atcodoo.odoo.com")).toBeNull();
    expect(normalizeOdooUrl("https://user:pw@atcodoo.odoo.com")).toBeNull();
    expect(normalizeOdooUrl("localhost")).toBeNull();
    expect(normalizeOdooUrl("")).toBeNull();
  });

  it("signs in with the key, then reads", async () => {
    const bodies: { params: { service: string; method: string; args: unknown[] } }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: b.params.method === "authenticate" ? 7 : [{ id: 1 }] }));
    }));
    const { rpc, uid } = await connectOdoo(conn);
    expect(uid).toBe(7);
    expect(await rpc("mrp.production", "search_read", [[]], { fields: ["name"] })).toEqual([{ id: 1 }]);
    expect(bodies[1].params).toEqual({ service: "object", method: "execute_kw", args: ["db", 7, "k", "mrp.production", "search_read", [[]], { fields: ["name"] }] });
  });

  it("refuses every method that is not a read, before anything is sent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 })));
    vi.stubGlobal("fetch", fetchMock);
    const { rpc } = await connectOdoo(conn);
    for (const m of ["write", "create", "unlink", "button_mark_done", "action_confirm"]) {
      await expect(rpc("mrp.production", m, [[1]])).rejects.toThrow(/not a read/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1); // the sign-in alone
  });

  it("says so when Odoo refuses the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: false }))));
    await expect(connectOdoo(conn)).rejects.toThrow(/refused the login/);
  });

  it("passes Odoo's own error words on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Odoo Server Error", data: { message: "Access Denied" } } }))));
    await expect(connectOdoo(conn)).rejects.toThrow("Access Denied");
  });
});
