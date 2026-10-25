// The Orders Registry row's free-text fields: how long each may be and what
// the planner calls it. One list, so the registry's edit and the assistant's
// update_order refuse the same lengths in the same words.

export const ORDER_TEXT_FIELDS = {
  soi: { max: 40, label: "SOI" },
  customer: { max: 80, label: "Customer" },
  fgCode: { max: 40, label: "FG code" },
  kva: { max: 20, label: "kVA" },
  rating: { max: 40, label: "Rating" },
  colorRal: { max: 40, label: "Colour (RAL)" },
  remarks: { max: 400, label: "Remarks" },
  product: { max: 20, label: "Product" },
  secItem: { max: 40, label: "Secondary item" },
  materialsRemarks: { max: 400, label: "Materials remarks" },
} as const;

export type OrderTextField = keyof typeof ORDER_TEXT_FIELDS;
export const ORDER_TEXT_KEYS = Object.keys(ORDER_TEXT_FIELDS) as OrderTextField[];

/** The field's value as it will be stored (trimmed, empty → null), or the
 *  sentence that refuses it. */
export function orderTextValue(k: OrderTextField, raw: unknown): { value: string | null } | { error: string } {
  const v = String(raw ?? "").trim();
  const { max, label } = ORDER_TEXT_FIELDS[k];
  if (v.length > max) return { error: `Keep ${label} under ${max} characters.` };
  return { value: v || null };
}
