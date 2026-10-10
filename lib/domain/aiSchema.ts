import { AI_PRIVATE_TABLES, AI_USER_COLUMNS } from "./ai";

// The database as the assistant is told about it: prisma/schema.prisma with
// its comments — they say what every table and column MEANS on the floor —
// less what it cannot read: the private tables go (with the comment above
// each), the accounts keep only who they are, and the generator and
// datasource blocks are not about the data at all.

const PRIVATE = new Set<string>(AI_PRIVATE_TABLES);
const USER_COLS = new Set<string>(AI_USER_COLUMNS);

export function aiSchemaText(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let block: { name: string; drop: boolean; user: boolean } | null = null;
  for (const line of lines) {
    if (block) {
      const end = /^\s*}\s*$/.test(line);
      if (!block.drop) {
        if (end || !block.user) out.push(line);
        else {
          // the accounts: only their id, name and active — no relations, no
          // password, no permissions
          const field = /^\s*(\w+)\s/.exec(line)?.[1];
          if (field && USER_COLS.has(field)) out.push(line.replace(/\s*\/\/.*$/, ""));
        }
      }
      if (end) block = null;
      continue;
    }
    const open = /^(model|enum|generator|datasource)\s+(\w+)\s*{/.exec(line);
    if (open) {
      const drop = open[1] === "generator" || open[1] === "datasource" || PRIVATE.has(open[2]);
      // the comment that introduces a dropped block goes with it
      if (drop) while (out.length > 0 && /^\s*\/\//.test(out[out.length - 1])) out.pop();
      if (!drop) out.push(line);
      block = { name: open[2], drop, user: open[1] === "model" && open[2] === "User" };
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
