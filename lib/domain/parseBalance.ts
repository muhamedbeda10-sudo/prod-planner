// ParseBalance — port of the REMARKS "BALANCE" parser.
//
// Rules (from ImportWeek ParseBalance, with the digit<->letter split applied in
// BOTH directions as the spec requires):
//   * Only parse when the remark contains "BALANCE" (case-insensitive).
//   * Uppercase; insert a space at every digit<->letter boundary (both ways);
//     turn every non-alphanumeric char into a space; then tokenize on spaces.
//   * A number token sets the "current qty". Item tokens that follow take it.
//   * An item token with no preceding number takes the full requiredQty (default).
//   * Typo map: RC -> TC.
//   * If any item was mentioned, unmentioned items = 0 and the result is valid.

import { SHEET_ITEMS, type SheetItem } from "./constants";

export interface BalanceResult {
  hasBalance: boolean;
  /** Per-item balance over the four base components; meaningful only when
   *  hasBalance is true. AR/MB never appear in a balance remark. */
  balance: Record<SheetItem, number>;
}

const ITEM_INDEX: Record<string, SheetItem> = {
  CF: "CF",
  TC: "TC",
  TN: "TN",
  CB: "CB",
  RC: "TC", // common typo
};

/** Normalize a remark into whitespace-separated tokens with digit/letter splits. */
export function tokenizeRemark(remark: string): string[] {
  const s = remark.toUpperCase();
  let res = "";
  let prevDigit = false;
  let prevAlpha = false;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      if (prevAlpha) res += " "; // letter -> digit boundary
      res += ch;
      prevDigit = true;
      prevAlpha = false;
    } else if (ch >= "A" && ch <= "Z") {
      if (prevDigit) res += " "; // digit -> letter boundary
      res += ch;
      prevAlpha = true;
      prevDigit = false;
    } else {
      res += " ";
      prevDigit = false;
      prevAlpha = false;
    }
  }
  return res.split(/\s+/).filter((t) => t.length > 0);
}

export function parseBalance(remark: string, defaultQty: number): BalanceResult {
  const empty: Record<SheetItem, number> = { CF: 0, TC: 0, TN: 0, CB: 0 };
  if (!remark || !/BALANCE/i.test(remark)) {
    return { hasBalance: false, balance: { ...empty } };
  }

  const tokens = tokenizeRemark(remark);
  const bal: Partial<Record<SheetItem, number>> = {};
  let cur: number | undefined;
  let found = false;

  for (const t of tokens) {
    if (/^\d+(\.\d+)?$/.test(t)) {
      cur = Number(t);
    } else {
      const item = ITEM_INDEX[t];
      if (item) {
        bal[item] = cur === undefined ? defaultQty : cur;
        found = true;
      }
    }
  }

  if (!found) return { hasBalance: false, balance: { ...empty } };

  const balance: Record<SheetItem, number> = { ...empty };
  for (const it of SHEET_ITEMS) balance[it] = bal[it] ?? 0;
  return { hasBalance: true, balance };
}
