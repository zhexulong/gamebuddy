/** Pure, runner-owned acceptance predicate. It complements—not replaces—the Mod's receipt evidence. */
export function hasMatchingEquipToolEvidence(detail) {
  if (typeof detail !== "string" || detail.length === 0 || detail.length > 4_096) return false;
  const fields = new Map();
  for (const segment of detail.split(";")) {
    const pivot = segment.indexOf("=");
    if (pivot <= 0) continue;
    const key = segment.slice(0, pivot).trim();
    const value = segment.slice(pivot + 1).trim();
    if (key.length === 0 || value.length === 0 || fields.has(key)) return false;
    fields.set(key, value);
  }
  const before = fields.get("before");
  const expected = fields.get("expected");
  const after = fields.get("after");
  return before !== undefined && expected !== undefined && after !== undefined && expected === after;
}
