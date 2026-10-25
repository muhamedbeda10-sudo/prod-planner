// Tiny DXF builders for tests: enough structure for the parser, nothing more.
export function dxfText(entities: string, opts: { insunits?: number | null; version?: string; layers?: string[]; blocks?: string } = {}): string {
  const L: string[] = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", opts.version ?? "AC1015"];
  if (opts.insunits !== null) L.push("9", "$INSUNITS", "70", String(opts.insunits ?? 4));
  L.push("0", "ENDSEC");
  L.push("0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", String((opts.layers ?? ["0"]).length));
  for (const n of opts.layers ?? ["0"]) L.push("0", "LAYER", "2", n, "70", "0", "62", "7", "6", "Continuous");
  L.push("0", "ENDTAB", "0", "ENDSEC");
  L.push("0", "SECTION", "2", "BLOCKS", ...(opts.blocks ? opts.blocks.split("\n") : []), "0", "ENDSEC");
  L.push("0", "SECTION", "2", "ENTITIES", ...entities.split("\n").filter((x) => x !== ""), "0", "ENDSEC", "0", "EOF");
  return L.join("\r\n") + "\r\n";
}

export function lwpolyline(pts: [number, number, number?][], closed = true, layer = "0"): string {
  const L: string[] = ["0", "LWPOLYLINE", "8", layer, "100", "AcDbEntity", "100", "AcDbPolyline", "90", String(pts.length), "70", closed ? "1" : "0"];
  for (const [x, y, b] of pts) {
    L.push("10", String(x), "20", String(y));
    if (b) L.push("42", String(b));
  }
  return L.join("\n");
}
export function circle(cx: number, cy: number, r: number, layer = "0"): string {
  return ["0", "CIRCLE", "8", layer, "10", String(cx), "20", String(cy), "30", "0", "40", String(r)].join("\n");
}
export function line(x1: number, y1: number, x2: number, y2: number, layer = "0"): string {
  return ["0", "LINE", "8", layer, "10", String(x1), "20", String(y1), "30", "0", "11", String(x2), "21", String(y2), "31", "0"].join("\n");
}
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, layer = "0"): string {
  return ["0", "ARC", "8", layer, "10", String(cx), "20", String(cy), "30", "0", "40", String(r), "50", String(a0), "51", String(a1)].join("\n");
}
export function rect(x: number, y: number, w: number, h: number, layer = "0"): string {
  return lwpolyline(
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    true,
    layer,
  );
}
export function text(x: number, y: number, s: string, layer = "0"): string {
  return ["0", "TEXT", "8", layer, "10", String(x), "20", String(y), "30", "0", "40", "5", "1", s].join("\n");
}
