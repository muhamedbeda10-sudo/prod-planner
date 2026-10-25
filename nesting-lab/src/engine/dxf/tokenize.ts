// DXF is a flat list of (group code, value) pairs. This tokenizer handles the
// ASCII flavour (CRLF or LF) and refuses binary DXF explicitly instead of
// producing garbage.

export interface Pair {
  code: number;
  value: string;
  /** 0-based line of the group code, for error messages */
  line: number;
}

export class DxfFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DxfFormatError";
  }
}

const BINARY_SENTINEL = "AutoCAD Binary DXF";

export function tokenizeDxf(text: string): Pair[] {
  if (text.startsWith(BINARY_SENTINEL)) {
    throw new DxfFormatError("Binary DXF files are not supported. Save the drawing as ASCII DXF (R2000/AC1015 or later) and upload it again.");
  }
  const lines = text.split(/\r\n|\n|\r/);
  const pairs: Pair[] = [];
  let i = 0;
  // tolerate a trailing empty line
  while (i + 1 < lines.length) {
    const codeStr = lines[i].trim();
    if (codeStr === "" && i >= lines.length - 2) break;
    const code = Number(codeStr);
    if (!Number.isInteger(code)) {
      throw new DxfFormatError(`Not an ASCII DXF file: expected a group code at line ${i + 1}, found "${lines[i].slice(0, 40)}".`);
    }
    pairs.push({ code, value: lines[i + 1].trim(), line: i });
    i += 2;
  }
  if (pairs.length === 0) throw new DxfFormatError("The file is empty.");
  const hasSection = pairs.some((p) => p.code === 0 && p.value === "SECTION");
  const hasEof = pairs.some((p) => p.code === 0 && p.value === "EOF");
  if (!hasSection && !hasEof) throw new DxfFormatError("Not a DXF file: no SECTION or EOF marker found.");
  return pairs;
}

/** Decode a DXF file's bytes. DXF is 8-bit text (the code page in $DWGCODEPAGE)
 *  or UTF-8 for AC1021+; latin-1 keeps every byte intact for the geometry. */
export function decodeDxfBytes(bytes: Uint8Array): string {
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (/AC10(21|24|27|32)/.test(head)) return new TextDecoder("utf-8").decode(bytes);
  return new TextDecoder("latin1").decode(bytes);
}
