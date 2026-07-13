import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
const wb = XLSX.read(readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Production_Master_Excel.xlsm"), { cellDates: false });
const rows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
const S = (v) => (v == null ? "" : String(v).trim());
const N = (v) => (typeof v === "number" ? v : Number(v)) || 0;

const po = rows("Plan Orders");
const poBoms = new Set();
for (let i = 1; i < po.length; i++) if (N(po[i]?.[0]) === 27 && S(po[i][1])) poBoms.add(S(po[i][1]).toUpperCase());

// Handover BOMs NOT exactly present in Plan Orders (candidates for NormalizeBoms)
const dh = rows("Daily Handover");
const unknown = new Map();
for (let i = 1; i < dh.length; i++) {
  const b = S(dh[i]?.[2]);
  if (b && !poBoms.has(b.toUpperCase())) unknown.set(b, (unknown.get(b) || 0) + 1);
}
console.log("Handover BOMs not exactly in Plan Orders:", unknown.size ? [...unknown] : "(none)");

const bomPrefix = (s) => { const m = /^(.*?)E\d/.exec(s.toUpperCase()); return m ? m[1] : s.toUpperCase(); };

// prefixes with multiple PO members (ambiguous) vs single
const byPrefix = {};
for (const b of poBoms) (byPrefix[bomPrefix(b)] ??= []).push(b);

console.log("\n14002 / 14003 prefixes:");
for (const p of ["14002", "14003"]) console.log(p, "->", byPrefix[p] || "(none)");

// 12011 family: Plan Orders target per bom|item, handover per bom|item (Cut/Welding)
const IT = ["CF","TC","TN","CB"];
const fam = ["12011E13M12","12011E14M12","12011E16M12"];
console.log("\n12011 family — Plan Orders required/target per bom:");
for (const bom of fam) {
  const perItem = {};
  let req = new Set();
  for (let i=1;i<po.length;i++){const r=po[i];if(N(r?.[0])===27&&S(r[1]).toUpperCase()===bom){perItem[S(r[5])]=(perItem[S(r[5])]||0)+N(r[8]);}}
  console.log(` ${bom}: target`, perItem);
}
console.log("\n12011 family — raw handover per bom|dept|item:");
const h = {};
for (let i=1;i<dh.length;i++){const r=dh[i];const b=S(r?.[2]).toUpperCase();if(fam.includes(b)){const k=`${b}|${S(r[1])}|${S(r[3])}`;h[k]=(h[k]||0)+N(r[4]);}}
console.log(h);
