// Smart-drops Phase 2: superseded-edit compression. When a file has been edited
// more than once, the older edits' bulky diffs are dead weight (the newest edit
// is what matters), but FULLY dropping them loses the agent's record that it
// edited that file/region. An "edit marker" is the middle ground: keep the
// tool_use call with its `filePath` verbatim and a short region-hint prefix of
// the diff, replace the output with `[dropped §N§]`, and clamp the rest.
//
// This is a SEPARATE representation from the existing `truncate()` skeleton
// (which clamps every arg, incl. filePath, to 5 chars). It must never change the
// existing skeleton bytes — that path replays on every pass, including flag-off
// defer passes, so altering it would silently bust the cache for users who never
// enabled smart-drops. Edit-marker bytes are produced ONLY for `drop_mode =
// "edit_marker"` rows, which only exist when `smart_drops` is on.
//
// Determinism / idempotency: callers always start from the ORIGINAL wire part
// (the transform rebuilds the message array from source every pass), so applying
// this fresh each pass is byte-stable. The `endsWith(SENTINEL)` guard also makes
// a within-pass double-application a no-op.

const TRUNCATION_SENTINEL = "...[truncated]";

/** Region-hint length: enough to identify the edited section, cheap to keep. */
export const EDIT_REGION_HINT_LEN = 40;

/** Argument keys preserved VERBATIM (the file identity the agent needs). */
const PATH_KEYS = new Set(["filePath", "file_path", "path"]);

/** The bulky diff keys clamped to a region hint. `edit` uses oldString/newString;
 * `write` uses content. Snake-case variants tolerated defensively. */
const DIFF_KEYS = new Set(["oldString", "newString", "content", "old_string", "new_string"]);

/** Slice without splitting a surrogate pair (mirrors tool-drop-target's helper;
 * duplicated rather than shared to avoid touching the existing truncate path). */
function safeSlice(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    const lastCharCode = str.charCodeAt(maxLen - 1);
    if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
        return str.slice(0, maxLen - 1);
    }
    return str.slice(0, maxLen);
}

/** True for the tools whose superseded older calls we compress. */
export function isEditTool(name: string | null | undefined): boolean {
    return name === "edit" || name === "write";
}

/**
 * Mutate a tool input object in place into its edit-marker form: preserve
 * path-like keys verbatim, clamp the diff keys to a region-hint prefix, leave
 * other (small) keys untouched. Idempotent.
 */
export function applyEditMarkerToInput(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
        if (PATH_KEYS.has(key)) continue;
        const value = input[key];
        if (typeof value !== "string" || !DIFF_KEYS.has(key)) continue;
        if (value.endsWith(TRUNCATION_SENTINEL)) continue; // already a hint
        input[key] =
            value.length > EDIT_REGION_HINT_LEN
                ? `${safeSlice(value, EDIT_REGION_HINT_LEN)}${TRUNCATION_SENTINEL}`
                : value;
    }
}
