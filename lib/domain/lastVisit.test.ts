import { describe, it, expect } from "vitest";
import { planLastVisit, viewStorageKey } from "./lastVisit";

const store = (entries: Record<string, string>) => (key: string) => entries[key] ?? null;

describe("planLastVisit", () => {
  it("reopens the tab's last URL on a bare arrival, and saves nothing then", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "", arriving: true, read: store({ "odoo:last": "/odoo?view=dashboard&range=month" }) });
    expect(p).toEqual({ redirect: "/odoo?view=dashboard&range=month", save: [] });
  });

  it("opens on the defaults when nothing was left, and remembers them", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "", arriving: true, read: store({}) });
    expect(p).toEqual({ redirect: null, save: [{ key: "odoo:last", url: "/odoo" }] });
  });

  it("lets an explicit link win over the memory, and remembers it in turn", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard&range=7d", arriving: true, viewKey: "view", view: "dashboard", read: store({ "odoo:last": "/odoo?view=dashboard&range=month", "odoo:last:dashboard": "/odoo?view=dashboard&range=month" }) });
    expect(p.redirect).toBeNull();
    expect(p.save).toEqual([{ key: "odoo:last", url: "/odoo?view=dashboard&range=7d" }, { key: "odoo:last:dashboard", url: "/odoo?view=dashboard&range=7d" }]);
  });

  it("reopens a view as it was left when only the view switch is in the link", () => {
    const saved = "/odoo?view=dashboard&range=month&compare=lastMonth&product=Mono+Box";
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard", arriving: true, viewKey: "view", view: "dashboard", read: store({ "odoo:last": "/odoo?view=log", "odoo:last:dashboard": saved }) });
    expect(p).toEqual({ redirect: saved, save: [] });
  });

  it("keeps each view's memory apart: the log does not overwrite the dashboard's", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=log", arriving: false, forget: ["day"], viewKey: "view", view: "log", read: store({}) });
    expect(p.save).toEqual([{ key: "odoo:last", url: "/odoo?view=log" }, { key: "odoo:last:log", url: "/odoo?view=log" }]);
    expect(p.save.some((s) => s.key === "odoo:last:dashboard")).toBe(false);
  });

  it("does not reopen anything once on the page, only remembers", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard", arriving: false, viewKey: "view", view: "dashboard", read: store({ "odoo:last:dashboard": "/odoo?view=dashboard&range=month" }) });
    expect(p.redirect).toBeNull();
    expect(p.save[1]).toEqual({ key: "odoo:last:dashboard", url: "/odoo?view=dashboard" });
  });

  it("drops the forgotten keys from what is remembered", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "day=2026-09-01&view=log", arriving: false, forget: ["day"], read: store({}) });
    expect(p.save).toEqual([{ key: "odoo:last", url: "/odoo?view=log" }]);
  });

  it("never reopens the URL already on screen, nor one of another path", () => {
    expect(planLastVisit({ storageKey: "k", pathname: "/odoo", qs: "", arriving: true, read: store({ k: "/odoo" }) }).redirect).toBeNull();
    expect(planLastVisit({ storageKey: "k", pathname: "/odoo", qs: "", arriving: true, read: store({ k: "/material?x=1" }) }).redirect).toBeNull();
    expect(planLastVisit({ storageKey: "k", pathname: "/odoo", qs: "view=dashboard", arriving: true, viewKey: "view", view: "dashboard", read: store({ "k:dashboard": "/odoo?view=dashboard" }) }).redirect).toBeNull();
  });

  it("names a view's memory after the tab's key", () => {
    expect(viewStorageKey("consumables:last", "powder")).toBe("consumables:last:powder");
  });
});
