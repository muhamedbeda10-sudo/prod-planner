export const mm = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : "–");
export const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
export const int = (n: number): string => Math.round(n).toLocaleString("en-US");
export const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

export function download(name: string, content: string | Blob, type = "application/octet-stream") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
