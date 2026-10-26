import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- The product line on screen is the page's address, else the person's own ----
// There is no switch in the top bar any more: a page shows the line its
// address names (?line=LV, copied by the proxy into a header), and with none
// the person's own line — the panels for someone who records only on the
// panels. A screen that belongs to one line always gets it.

const h = vi.hoisted(() => ({ header: vi.fn(), user: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => ({ get: h.header }) }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: h.user }));

import { getActiveLine, withLine } from "@/lib/server/line";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

const person = (perms: string, isAdmin = false) => ({ perms, isAdmin });

beforeEach(() => {
  vi.resetAllMocks();
  h.header.mockReturnValue(null);
  h.user.mockResolvedValue(person("welding.edit"));
});

describe("getActiveLine", () => {
  it("reads the line the address names", async () => {
    h.header.mockReturnValue("LV");
    expect(await getActiveLine()).toBe("LV");
    expect(h.user).not.toHaveBeenCalled();
  });

  it("falls back to the person's own line", async () => {
    h.user.mockResolvedValue(person("lv.punching,lv.bending"));
    expect(await getActiveLine()).toBe("LV");
    h.user.mockResolvedValue(person("lv.punching,welding.edit"));
    expect(await getActiveLine()).toBe("TR");
    h.user.mockResolvedValue(person("lv.punching", true));
    expect(await getActiveLine()).toBe("TR");
  });

  it("ignores nonsense in the header", async () => {
    h.header.mockReturnValue("panels");
    h.user.mockResolvedValue(person("lv.welding"));
    expect(await getActiveLine()).toBe("LV");
  });

  it("is the transformers' with nobody signed in", async () => {
    h.user.mockResolvedValue(null);
    expect(await getActiveLine()).toBe("TR");
  });

  it("lets withLine override the address for the span of one call", async () => {
    h.header.mockReturnValue("TR");
    expect(await withLine("LV", () => getActiveLine())).toBe("LV");
    expect(await getActiveLine()).toBe("TR");
  });
});

describe("the proxy hands the address's line to the page", () => {
  const req = (url: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(url, "http://plant.test"), { headers: { cookie: "atc_session=x", ...headers } });
  const forwarded = (res: Response) => res.headers.get("x-middleware-request-x-atc-line");

  it("copies ?line= into the request header", () => {
    expect(forwarded(proxy(req("/tracker?line=lv")))).toBe("LV");
  });

  it("never passes on a header the browser sent itself", () => {
    const res = proxy(req("/tracker", { "x-atc-line": "LV" }));
    expect(forwarded(res)).toBeNull();
    // the request's headers are overridden, and the override leaves it out
    const overridden = res.headers.get("x-middleware-override-headers");
    expect(overridden).not.toBeNull();
    expect(overridden!.split(",")).not.toContain("x-atc-line");
  });

  it("hands a screen pinned to one line its own line, whatever the address names", () => {
    expect(forwarded(proxy(req("/import")))).toBe("TR");
    expect(forwarded(proxy(req("/worklist/punching")))).toBe("LV");
  });

  it("sends an address naming the other line to the pinned screen's own, the rest kept", () => {
    const res = proxy(req("/import?plan=12&line=LV"));
    expect(res.headers.get("location")).toBe("http://plant.test/import?plan=12&line=TR");
  });

  it("clears the cookie the old top-bar switch left behind", () => {
    const res = proxy(req("/tracker", { cookie: "atc_session=x; line=LV" }));
    expect(res.headers.get("set-cookie")).toMatch(/^line=;/);
  });

  it("still sends a visitor with no session to the login page", () => {
    const res = proxy(new NextRequest(new URL("/tracker?line=LV", "http://plant.test")));
    expect(res.headers.get("location")).toBe("http://plant.test/login");
  });
});
