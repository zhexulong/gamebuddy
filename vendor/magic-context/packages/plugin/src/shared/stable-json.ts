/**
 * Process-local deterministic JSON serialization for JSON-like plain
 * objects. Keys are sorted by code-point order (NOT locale-sensitive).
 *
 * Contract:
 * - Stable for plain objects, arrays, primitives, and `null`.
 * - `undefined` serialized as the string "undefined".
 * - Circular references serialized as the string `"[Circular]"`.
 * - **NOT** a canonical cross-runtime / cross-locale JSON serializer.
 *   Two different runtimes that disagree on `JSON.stringify` of primitives
 *   (none known today) would produce different output.
 *
 * Used for:
 * - `tool_definition_measurements` fingerprint hashing
 * - `pending_compaction_marker_state` CAS comparison
 *
 * If a future use case needs true canonical JSON (e.g. cross-process
 * signing), build a separate utility — do NOT widen this contract.
 */
export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    }
    // Code-point sort (NOT localeCompare). Stable across runtimes/locales.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    });
    return `{${entries
        .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child, seen)}`)
        .join(",")}}`;
}
