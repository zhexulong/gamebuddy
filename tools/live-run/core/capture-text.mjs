/**
 * The one place a live run keeps WORDS.
 *
 * Every live-run surface has the same problem: to judge whether a companion reads naturally you need the
 * text, but the artifacts that prove product invariants must stay content-free, and nothing may leak a
 * credential. That policy was implemented twice (once per surface) and diverged — the game runner kept
 * the delivered goal and the presented reply unbounded and unredacted, the chat runner wrote a bounded,
 * redacted side file only after an audit pointed out that a content-free trace answers no naturalness
 * question at all. A third surface would have made it three copies.
 *
 * So the policy lives here, once, and surfaces call it:
 *
 *  - **Bounded**: `maxChars` per entry and `maxEntries` per run, with the collector itself bounded so a
 *    long run cannot accumulate text in memory waiting to be written.
 *  - **Redacted**: provider macro residue (`{{...}}`) and secret shapes are replaced by markers, not
 *    dropped — a reader should see THAT a reply contained one.
 *  - **Beside, never inside**: the side file is a sibling of the report. A frozen content-free trace (the
 *    chat audit's `chat_run_audit/v1`) keeps its promise; a surface whose envelope has no such promise
 *    can still choose to keep words in its own artifact. This module only guarantees the policy.
 *
 * A surface names its own schema (so a reader knows which surface produced the file) but never its own
 * limits: those are policy, and policy has one owner.
 */

export const LIVE_RUN_TEXT_MAX_CHARS = 600;
export const LIVE_RUN_TEXT_MAX_ENTRIES = 40;

/** Deliberately broad: a leaked key is worse than a slightly over-eager `<REDACTED>`. */
// A bare `[A-Za-z0-9_-]{32,}` was too eager: it also matches a long run of ordinary letters, so prose
// would have been replaced by `<REDACTED>`. A real token of that length carries a digit or an upper-case
// character (hex, base64, uuid, key); a lower-case word does not. Prefix-marked shapes stay unconditional.
const SECRET_SHAPES = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{10,}|(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{32,})/g;
const MACRO_SHAPES = /\{\{[^}]*\}\}/g;

/**
 * Bound and redact one piece of text. Non-strings become the empty string: a caller that passes an
 * object must not have it stringified into the evidence by accident.
 */
export function redactLiveRunText(value, { maxChars = LIVE_RUN_TEXT_MAX_CHARS } = {}) {
  const raw = typeof value === "string" ? value : "";
  return raw.slice(0, maxChars).replace(SECRET_SHAPES, "<REDACTED>").replace(MACRO_SHAPES, "<MACRO>");
}

/**
 * Collect words as a run goes. Bounded in memory, because a run that talks a lot must not be able to
 * grow the harness's own footprint; the oldest entries fall off exactly as they would in the file.
 */
export function createLiveRunTextCollector({ maxEntries = LIVE_RUN_TEXT_MAX_ENTRIES } = {}) {
  const entries = [];
  return Object.freeze({
    push(role, text) {
      if (typeof role !== "string" || role.length === 0) throw new Error("live_run_text_role_invalid");
      if (typeof text !== "string" || text.length === 0) return;
      entries.push(Object.freeze({ role, text }));
      while (entries.length > maxEntries) entries.shift();
    },
    entries: () => [...entries],
    get size() {
      return entries.length;
    },
  });
}

/**
 * The side-file envelope. `schema` is the surface's own name; `entryCount` is the number of entries
 * actually kept, so a reader can tell a silent run from a truncated one.
 */
export function buildLiveRunTextSideFile({
  schema,
  runId,
  entries,
  maxEntries = LIVE_RUN_TEXT_MAX_ENTRIES,
  maxChars = LIVE_RUN_TEXT_MAX_CHARS,
}) {
  if (typeof schema !== "string" || schema.length === 0) throw new Error("live_run_text_schema_invalid");
  const kept = (Array.isArray(entries) ? entries : []).slice(-maxEntries);
  return Object.freeze({
    schema,
    runId,
    entryCount: kept.length,
    maxCharsPerEntry: maxChars,
    maxEntries,
    entries: Object.freeze(
      kept.map((entry) =>
        Object.freeze({
          role: entry?.role ?? null,
          chars: typeof entry?.text === "string" ? entry.text.length : 0,
          text: redactLiveRunText(entry?.text, { maxChars }),
        }),
      ),
    ),
  });
}

/**
 * Where the side file goes: beside the report, sharing its stem. A run with no report path has no
 * durable location, so nothing is written (the caller decides what to do with the in-memory collector).
 */
export function liveRunTextSideFilePath(reportTarget, suffix = "-transcript") {
  if (typeof reportTarget !== "string" || reportTarget.length === 0) return undefined;
  return reportTarget.endsWith(".json")
    ? `${reportTarget.slice(0, -".json".length)}${suffix}.json`
    : `${reportTarget}${suffix}.json`;
}
