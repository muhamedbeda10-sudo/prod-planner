import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// userMessage (lib/server/errors.ts) — the one sentence a server action hands
// the screen when something it did not expect was thrown. The whole error goes
// to the server log; the person sees only text they can act on, never the
// driver's or Prisma's own words, and never the database host.

vi.mock("server-only", () => ({}));

import { UserError, isUniqueViolation, uniqueViolationTarget, userMessage } from "@/lib/server/errors";

const GENERIC = "Could not save the output — the server did not finish it. Check the records, then try again.";

function prismaError(code: string, message = "Something failed") {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta: { target: ["ledgerId"] } });
}

// what Prisma really throws: several lines, the invocation and the host
const PRISMA_TEXT = `
Invalid \`prisma.sheetCutLog.create()\` invocation in
/var/task/.next/server/app/worklist/actions.js:12:34

  Can't reach database server at \`db.internal.example.com:5432\`

Please make sure your database server is running at \`db.internal.example.com:5432\`.`;

describe("userMessage", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });

  it("logs the whole error on the server and names the action", () => {
    const e = new Error("connection lost");
    userMessage(e, "save the output");
    expect(log).toHaveBeenCalledWith("[save the output]", e);
  });

  it("turns a driver message into the generic sentence", () => {
    expect(userMessage(new Error("connection lost"), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("Unique constraint failed on ledgerId"), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("ENOENT: no such file or directory, open '/tmp/x.xlsx'"), "save the output")).toBe(GENERIC);
  });

  it("never shows Prisma's text, host included", () => {
    const e = new Prisma.PrismaClientInitializationError(PRISMA_TEXT, "test");
    const msg = userMessage(e, "save the output");
    expect(msg).toBe("Could not save the output — the database cannot be reached right now. Check the records, then try again in a moment.");
    expect(msg).not.toContain("db.internal");
    expect(msg).not.toContain("\n");
    // the same text thrown as a plain Error is caught by the shape, not the class
    const plain = userMessage(new Error(PRISMA_TEXT), "save the output");
    expect(plain).toBe(GENERIC);
    expect(plain).not.toContain("db.internal");
  });

  it("maps the Prisma codes a person can act on", () => {
    expect(userMessage(prismaError("P2002"), "save the row")).toBe("Could not save the row — a row with the same key is already there. Refresh the page and check it.");
    expect(userMessage(prismaError("P2003"), "save the row")).toBe("Could not save the row — it points at a record that is no longer there. Refresh the page and try again.");
    expect(userMessage(prismaError("P2025"), "remove the row")).toBe("Could not remove the row — that record is no longer there. Refresh the page.");
    expect(userMessage(prismaError("P2028"), "save the row")).toBe("Could not save the row — the database took too long. Check the records, then try again.");
    for (const code of ["P1001", "P1017"]) {
      expect(userMessage(prismaError(code), "save the row")).toBe("Could not save the row — the database cannot be reached right now. Check the records, then try again in a moment.");
    }
  });

  it("gives the generic sentence for any other Prisma error, even one that reads like a sentence", () => {
    expect(userMessage(prismaError("P2011", "Null constraint violation."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Prisma.PrismaClientValidationError("Argument `qty` is missing.", { clientVersion: "test" }), "save the output")).toBe(GENERIC);
    // a Prisma-shaped object without the class (a mocked client) is still Prisma
    expect(userMessage({ name: "PrismaClientKnownRequestError", code: "P2002", message: "x" }, "save the row")).toContain("same key");
  });

  it("passes the app's own sentence through unchanged", () => {
    class TankMovedError extends Error {}
    const own = "T-0042 was just recorded from another screen — refresh the page and check it.";
    expect(userMessage(new TankMovedError(own), "save the tank record")).toBe(own);
    const total = "The total cannot go that low: 3 of those tanks have already been tested or painted. Undo the later stage first.";
    expect(userMessage(new Error(total), "save the total")).toBe(total);
    expect(userMessage(new Error("Pick which plan the sheet is?"), "import the plan")).toBe("Pick which plan the sheet is?");
  });

  it("does not mistake ordinary words for Node codes, stack frames or null", () => {
    // words starting with e/E are not ENOENT-style codes
    for (const own of [
      "Enter the Odoo MO number.",
      "That serial already exists on another MO.",
      "Nothing was entered for this day.",
      "The sheet is empty.",
      "Either pick a BOM or an MO.",
      // "at <word> (" without a file:line is not a stack frame
      "Already recorded at Welding (3 of 5).",
      // "null" and "stack" inside other words
      "The record was annulled.",
      "Stack the sheets before cutting.",
    ]) {
      expect(userMessage(new Error(own), "save the output")).toBe(own);
    }
  });

  it("does not pass through text that only looks like a sentence but is technical", () => {
    expect(userMessage(new TypeError("Cannot read properties of undefined (reading 'mo')."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("Cannot read properties of undefined (reading 'mo')."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("Error at Object.<anonymous> (/var/task/x.js:1:2)."), "save the output")).toBe(GENERIC);
    // Node codes, even inside a well-formed sentence
    expect(userMessage(new Error("ENOENT: no such file or directory."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("Connection reset by peer (ECONNRESET)."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("The value was null."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("Connection timed out."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("First line.\nSecond line."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error(`${"Very long. ".repeat(30)}End.`), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("lowercase start is not how the app writes."), "save the output")).toBe(GENERIC);
    expect(userMessage(new Error("No full stop at the end"), "save the output")).toBe(GENERIC);
  });

  it("passes a UserError's text through even when the sentence test would refuse it", () => {
    class LvRefused extends UserError {}
    for (const own of [
      "The value was null.",
      "No full stop at the end",
      "lowercase start, still written for a person.",
    ]) {
      expect(userMessage(new UserError(own), "save the output")).toBe(own);
      expect(userMessage(new LvRefused(own), "save the output")).toBe(own);
      // the same text as a plain Error is judged by the sentence test
      expect(userMessage(new Error(own), "save the output")).toBe(GENERIC);
    }
  });

  it("logs a UserError too", () => {
    const e = new UserError("Nothing changed — the total is already 4.");
    userMessage(e, "save the output");
    expect(log).toHaveBeenCalledWith("[save the output]", e);
  });

  it("handles things that are not errors at all", () => {
    expect(userMessage("a string.", "save the output")).toBe(GENERIC);
    expect(userMessage(undefined, "save the output")).toBe(GENERIC);
    expect(userMessage(null, "save the output")).toBe(GENERIC);
    expect(userMessage({ message: "Looks like a sentence." }, "save the output")).toBe(GENERIC);
  });
});

describe("isUniqueViolation / uniqueViolationTarget", () => {
  const p2002 = (target: unknown) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta: { target } });

  it("recognises Prisma's P2002, by class or by shape", () => {
    expect(isUniqueViolation(p2002(["code"]))).toBe(true);
    expect(isUniqueViolation({ name: "PrismaClientKnownRequestError", code: "P2002" })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("x"), { code: "P2002" }))).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isUniqueViolation(prismaError("P2025"))).toBe(false);
    expect(isUniqueViolation(new Error("Unique constraint failed on the fields: (`code`)"))).toBe(false);
    expect(isUniqueViolation({ code: "ENOENT" })).toBe(false);
    for (const e of [null, undefined, "P2002", 2002]) expect(isUniqueViolation(e)).toBe(false);
  });

  it("reads the column names when the target is a list", () => {
    expect(uniqueViolationTarget(p2002(["empId"]))).toEqual(["empId"]);
    expect(uniqueViolationTarget(p2002(["mo", "bom", "part"]))).toEqual(["mo", "bom", "part"]);
  });

  it("reads the column names out of an index name", () => {
    expect(uniqueViolationTarget(p2002("Worker_empId_key"))).toEqual(["empId"]);
    expect(uniqueViolationTarget(p2002("MaterialUsage_mo_bom_part_key"))).toEqual(["mo", "bom", "part"]);
    expect(uniqueViolationTarget(p2002("name"))).toEqual(["name"]);
  });

  it("is empty when there is no target or no unique violation", () => {
    expect(uniqueViolationTarget(p2002(undefined))).toEqual([]);
    expect(uniqueViolationTarget(p2002(""))).toEqual([]);
    expect(uniqueViolationTarget(prismaError("P2025"))).toEqual([]);
    expect(uniqueViolationTarget(null)).toEqual([]);
  });
});
