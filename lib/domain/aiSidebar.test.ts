import { describe, expect, it } from "vitest";
import { AI_SIDE_DEFAULT, AI_SIDE_MAX, AI_SIDE_MIN, clampSideWidth, dragSide, parseAiSide } from "./aiSidebar";

describe("the chats' sidebar width", () => {
  it("stays between its narrowest and widest", () => {
    expect(clampSideWidth(100)).toBe(AI_SIDE_MIN);
    expect(clampSideWidth(900)).toBe(AI_SIDE_MAX);
    expect(clampSideWidth(333.6)).toBe(334);
    expect(clampSideWidth(Number.NaN)).toBe(AI_SIDE_DEFAULT);
  });
  it("leaves the chat at least half a narrow window", () => {
    expect(clampSideWidth(500, 800)).toBe(400);
    // never below its narrowest, however small the window
    expect(clampSideWidth(500, 300)).toBe(AI_SIDE_MIN);
  });
  it("hides when dragged past its narrowest", () => {
    expect(dragSide(120)).toEqual({ width: AI_SIDE_DEFAULT, open: false });
    // shown again at the width it had before the drag
    expect(dragSide(120, 1400, 440)).toEqual({ width: 440, open: false });
    expect(dragSide(180)).toEqual({ width: AI_SIDE_MIN, open: true });
    expect(dragSide(360, 1400)).toEqual({ width: 360, open: true });
  });
  it("reads back what was kept, and the default for anything else", () => {
    expect(parseAiSide(JSON.stringify({ width: 410, open: false }))).toEqual({ width: 410, open: false });
    expect(parseAiSide(JSON.stringify({ width: 5000 }))).toEqual({ width: AI_SIDE_MAX, open: true });
    expect(parseAiSide("not json")).toEqual({ width: AI_SIDE_DEFAULT, open: true });
    expect(parseAiSide("null")).toEqual({ width: AI_SIDE_DEFAULT, open: true });
    expect(parseAiSide(null)).toEqual({ width: AI_SIDE_DEFAULT, open: true });
  });
});
