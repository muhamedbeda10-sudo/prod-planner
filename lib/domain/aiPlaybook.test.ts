import { describe, expect, it } from "vitest";
import { playbookText } from "./aiPlaybook";

describe("playbookText", () => {
  it("groups the rules by topic in the fixed order, oldest first, each numbered", () => {
    const { text, left } = playbookText([
      { id: 5, topic: "general", title: "Language", body: "Answer in Arabic." },
      { id: 2, topic: "machines", title: "Thick plate", body: "B4-10 takes 6 mm and up." },
      { id: 3, topic: "machines", title: "Top covers", body: "TC goes on the punch." },
    ]);
    expect(left).toBe(0);
    expect(text).toBe(
      ["## Machines and their distribution", "#2 Thick plate: B4-10 takes 6 mm and up.", "#3 Top covers: TC goes on the punch.", "## General", "#5 Language: Answer in Arabic."].join("\n"),
    );
  });

  it("leaves the oldest rules out when the whole would be too long, and counts them", () => {
    const body = "x".repeat(60);
    const rows = [1, 2, 3].map((id) => ({ id, topic: "general", title: `R${id}`, body }));
    const { text, left } = playbookText(rows, 200);
    expect(left).toBe(1);
    expect(text).not.toContain("#1 ");
    expect(text).toContain("#3 ");
  });

  it("is empty with no rules", () => {
    expect(playbookText([])).toEqual({ text: "", left: 0 });
  });
});
