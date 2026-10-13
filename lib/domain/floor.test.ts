import { describe, expect, it } from "vitest";
import { addNode, drawOrder, emptyLayout, freeSpot, moveNode, parseLayout, placeMachine, removeNode, resizeNode, snap, startingFloor, updateNode } from "./floor";

describe("parseLayout", () => {
  it("keeps well-formed nodes, snapped and inside the sheet, and drops the rest", () => {
    const l = parseLayout({
      w: 1200, h: 800,
      nodes: [
        { id: "m1", kind: "machine", machineId: 1, x: 103, y: 47, w: 180, h: 110 },
        { id: "z1", kind: "zone", x: -20, y: 5000, w: 20, h: 20, text: "store", color: "amber" },
        { id: "bad", kind: "machine", x: 0, y: 0 }, // no machineId
        { id: "m1", kind: "machine", machineId: 2, x: 0, y: 0 }, // duplicate id
        { id: "l1", kind: "label", x: 10, y: 10, text: "x".repeat(200), color: "pink" },
        "junk",
      ],
    });
    expect(l.w).toBe(1200);
    expect(l.nodes.map((n) => n.id)).toEqual(["m1", "z1", "l1"]);
    expect(l.nodes[0]).toMatchObject({ x: 100, y: 50, machineId: 1 });
    expect(l.nodes[1]).toMatchObject({ x: 0, y: 750, w: 80, h: 50, color: "amber" });
    expect(l.nodes[2].text).toHaveLength(80);
    expect(l.nodes[2].color).toBeUndefined();
  });
  it("is empty for nothing at all", () => {
    expect(parseLayout(null)).toEqual(emptyLayout());
    expect(parseLayout({ nodes: "no" }).nodes).toEqual([]);
  });
});

describe("placing", () => {
  it("puts a machine on the first free spot, once", () => {
    let l = emptyLayout();
    l = placeMachine(l, 5);
    l = placeMachine(l, 5);
    expect(l.nodes).toHaveLength(1);
    expect(l.nodes[0]).toMatchObject({ id: "m5", kind: "machine", machineId: 5, x: 20, y: 20 });
    l = placeMachine(l, 6);
    expect(l.nodes[1].x).toBeGreaterThan(l.nodes[0].x + l.nodes[0].w);
    expect(l.nodes[1].y).toBe(20);
  });
  it("opens a floor nobody has drawn with the machines set out in rows — a drawn one as it is", () => {
    const fresh = startingFloor(emptyLayout(), [5, 6]);
    expect(fresh.nodes.map((n) => [n.id, n.y])).toEqual([["m5", 20], ["m6", 20]]);
    const drawn = addNode(emptyLayout(), "label", "Door");
    expect(startingFloor(drawn, [5, 6])).toBe(drawn);
  });
  it("finds a spot below when the row is full", () => {
    const l = { ...emptyLayout(), w: 400, nodes: [{ id: "a", kind: "zone" as const, x: 20, y: 20, w: 340, h: 100 }] };
    expect(freeSpot(l, 180, 110)).toEqual({ x: 20, y: 140 });
  });
  it("adds zones and labels with their text and colour", () => {
    const l = addNode(emptyLayout(), "zone", "Bending", "blue");
    expect(l.nodes[0]).toMatchObject({ kind: "zone", text: "Bending", color: "blue", w: 260, h: 160 });
  });
});

describe("editing", () => {
  const base = placeMachine(emptyLayout(), 1);
  it("moves on the grid and never off the sheet", () => {
    expect(moveNode(base, "m1", 207, 33).nodes[0]).toMatchObject({ x: 210, y: 30 });
    expect(moveNode(base, "m1", 99999, -50).nodes[0]).toMatchObject({ x: 1600 - 180, y: 0 });
  });
  it("resizes on the grid, never under the minimum", () => {
    expect(resizeNode(base, "m1", 10, 10).nodes[0]).toMatchObject({ w: 120, h: 80 });
    expect(resizeNode(base, "m1", 233, 151).nodes[0]).toMatchObject({ w: 230, h: 150 });
  });
  it("updates text and colour, removes", () => {
    const l = addNode(base, "label", "Door");
    const id = l.nodes[1].id;
    expect(updateNode(l, id, { text: "Gate", color: "red" }).nodes[1]).toMatchObject({ text: "Gate", color: "red" });
    expect(removeNode(l, id).nodes).toHaveLength(1);
  });
  it("draws zones under machines and labels on top", () => {
    const l = addNode(addNode(base, "label", "L"), "zone", "Z");
    expect(drawOrder(l.nodes).map((n) => n.kind)).toEqual(["zone", "machine", "label"]);
  });
  it("snaps to ten", () => {
    expect(snap(14)).toBe(10);
    expect(snap(15)).toBe(20);
  });
});
