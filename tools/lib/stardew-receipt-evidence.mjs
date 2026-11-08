/** Pure, runner-owned acceptance predicate. It complements—not replaces—the Mod's receipt evidence. */

/**
 * The receipt's `detail` string as its `key=value` fields, or null when it is not a well-formed detail.
 *
 * The Mod writes one detail per terminal receipt as `k=v;k=v` (`ToolActionEvidence.Compose`), and a malformed one is
 * refused rather than half-read: an empty or repeated key means the receipt cannot be attributed field by field, and
 * a caller that accepts it would be reading a value it cannot place.
 */
export function parseReceiptFields(detail) {
  if (typeof detail !== "string" || detail.length === 0 || detail.length > 4_096) return null;
  const fields = new Map();
  for (const segment of detail.split(";")) {
    const pivot = segment.indexOf("=");
    if (pivot <= 0) continue;
    const key = segment.slice(0, pivot).trim();
    const value = segment.slice(pivot + 1).trim();
    if (key.length === 0 || value.length === 0 || fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields.size === 0 ? null : fields;
}

export function hasMatchingEquipToolEvidence(detail) {
  const fields = parseReceiptFields(detail);
  if (fields === null) return false;
  const before = fields.get("before");
  const expected = fields.get("expected");
  const after = fields.get("after");
  return before !== undefined && expected !== undefined && after !== undefined && expected === after;
}
