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
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard&range=7d", arriving: true, view: "dashboard", read: store({ "odoo:last": "/odoo?view=dashboard&range=month", "odoo:last:dashboard": "/odoo?view=dashboard&range=month" }) });
    expect(p.redirect).toBeNull();
    expect(p.save).toEqual([{ key: "odoo:last", url: "/odoo?view=dashboard&range=7d" }, { key: "odoo:last:dashboard", url: "/odoo?view=dashboard&range=7d" }]);
  });

  it("reopens a view as it was left when only the view switch is in the link — on landing, or on the switch itself", () => {
    const saved = "/odoo?view=dashboard&range=month&compare=lastMonth&product=Mono+Box";
    const read = store({ "odoo:last": "/odoo?view=log", "odoo:last:dashboard": saved });
    expect(planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard", arriving: true, view: "dashboard", read })).toEqual({ redirect: saved, save: [] });
    expect(planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard", arriving: false, viewChanged: true, view: "dashboard", read })).toEqual({ redirect: saved, save: [] });
  });

  it("a switch to the bare path opens that view, never the tab's last one", () => {
    // Consumables: "Log" is /consumables itself, while the tab's last URL is the dashboard's
    const p = planLastVisit({ storageKey: "consumables:last", pathname: "/consumables", qs: "", arriving: false, viewChanged: true, view: "log", read: store({ "consumables:last": "/consumables?view=dashboard&from=2026-10-01&to=2026-10-15" }) });
    expect(p.redirect).toBeNull();
    expect(p.save).toEqual([{ key: "consumables:last", url: "/consumables" }, { key: "consumables:last:log", url: "/consumables?view=log" }]);
  });

  it("keeps each view's memory apart: the log does not overwrite the dashboard's", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=log", arriving: false, forget: ["day"], view: "log", read: store({}) });
    expect(p.save).toEqual([{ key: "odoo:last", url: "/odoo?view=log" }, { key: "odoo:last:log", url: "/odoo?view=log" }]);
    expect(p.save.some((s) => s.key === "odoo:last:dashboard")).toBe(false);
  });

  it("does not reopen anything once on the page, only remembers", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "view=dashboard", arriving: false, view: "dashboard", read: store({ "odoo:last:dashboard": "/odoo?view=dashboard&range=month" }) });
    expect(p.redirect).toBeNull();
    expect(p.save[1]).toEqual({ key: "odoo:last:dashboard", url: "/odoo?view=dashboard" });
  });

  it("lays what the switch carries over the view's memory", () => {
    const read = store({ "consumables:last:powder": "/consumables?view=powder&month=2026-09&from=2026-08-01&to=2026-08-31" });
    const p = planLastVisit({ storageKey: "consumables:last", pathname: "/consumables", qs: "from=2026-10-01&to=2026-10-15&view=powder", arriving: false, viewChanged: true, view: "powder", carry: ["from", "to"], read });
    expect(p.redirect).toBe("/consumables?view=powder&month=2026-09&from=2026-10-01&to=2026-10-15");
    // no period on the link: none on the reopened view either
    const q = planLastVisit({ storageKey: "consumables:last", pathname: "/consumables", qs: "view=powder", arriving: false, viewChanged: true, view: "powder", carry: ["from", "to"], read });
    expect(q.redirect).toBe("/consumables?view=powder&month=2026-09");
    // a link with anything else on it is explicit
    const r = planLastVisit({ storageKey: "consumables:last", pathname: "/consumables", qs: "view=powder&month=2026-07", arriving: true, view: "powder", carry: ["from", "to"], read });
    expect(r.redirect).toBeNull();
  });

  it("remembers a view under the name the page resolved, not the link's alias", () => {
    const p = planLastVisit({ storageKey: "consumables:last", pathname: "/consumables", qs: "view=monthly&from=2026-10-01", arriving: false, view: "dashboard", read: store({}) });
    expect(p.save).toEqual([{ key: "consumables:last", url: "/consumables?view=monthly&from=2026-10-01" }, { key: "consumables:last:dashboard", url: "/consumables?view=dashboard&from=2026-10-01" }]);
  });

  it("drops the forgotten keys from what is remembered", () => {
    const p = planLastVisit({ storageKey: "odoo:last", pathname: "/odoo", qs: "day=2026-09-01&view=log", arriving: false, forget: ["day"], read: store({}) });
    expect(p.save).toEqual([{ key: "odoo:last", url: "/odoo?view=log" }]);
  });

  it("never reopens the URL already on screen, nor one of another path", () => {
    expect(planLastVisit({ storageKey: "k", pathname: "/odoo", qs: "", arriving: true, read: store({ k: "/odoo" }) }).redirect).toBeNull();
    expect(planLastVisit({ storageKey: "k", pathname: "/odoo", qs: "", arriving: true, read: store({ k: "/material?x=1" }) }).redirect).toBeNull();
    expect(planLastVisit({ storageKey: "k", pathname: "/odoo", qs: "view=dashboard", arriving: true, view: "dashboard", read: store({ "k:dashboard": "/odoo?view=dashboard" }) }).redirect).toBeNull();
  });

  it("names a view's memory after the tab's key", () => {
    expect(viewStorageKey("consumables:last", "powder")).toBe("consumables:last:powder");
  });
});

describe("planLastVisit and the product line", () => {
  it("never remembers the line — a bare arrival opens on the person's own", () => {
    const p = planLastVisit({ storageKey: "material:last", pathname: "/material", qs: "line=LV&month=2026-10", arriving: false, read: store({}) });
    expect(p.save).toEqual([{ key: "material:last", url: "/material?month=2026-10" }]);
  });

  it("drops a line remembered before it was left out", () => {
    const p = planLastVisit({ storageKey: "odoo:log", pathname: "/odoo", qs: "", arriving: true, read: store({ "odoo:log": "/odoo?line=LV" }) });
    expect(p).toEqual({ redirect: null, save: [{ key: "odoo:log", url: "/odoo" }] });
  });

  it("reopens the tab as it was left on the line the address names", () => {
    const p = planLastVisit({ storageKey: "material:last", pathname: "/material", qs: "line=LV", arriving: true, read: store({ "material:last": "/material?month=2026-10" }) });
    expect(p).toEqual({ redirect: "/material?month=2026-10&line=LV", save: [] });
  });

  it("lets the view switch reopen a view with the line carried along", () => {
    const p = planLastVisit({ storageKey: "consumables:views", pathname: "/consumables", qs: "view=powder&line=LV", arriving: true, view: "powder", read: store({ "consumables:views:powder": "/consumables?view=powder&month=2026-09" }) });
    expect(p.redirect).toBe("/consumables?view=powder&month=2026-09&line=LV");
  });
});
