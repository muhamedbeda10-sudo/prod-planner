import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
const wb = XLSX.read(readFileSync("reference/workbook/Production_Master_Excel.xlsm"), { cellDates: false });
const dh = XLSX.utils.sheet_to_json(wb.Sheets["Daily Handover"], { header: 1, raw: true, defval: null });
const S = (v) => (v == null ? "" : String(v).trim());
for (const code of ["14002E13M13","14003E13M13","14002","14003","12011E14M12"]) {
  const hits = [];
  for (let i=1;i<dh.length;i++){const r=dh[i];if(r&&S(r[2]).toUpperCase().startsWith(code)) hits.push(`${S(r[0])} ${S(r[1])} ${S(r[2])} ${S(r[3])}=${S(r[4])}`);}
  console.log(`\n[${code}] ${hits.length} handover rows`);
  hits.slice(0,12).forEach(h=>console.log("   "+h));
}
