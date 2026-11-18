/**
 * What the runtime's OWN session record says about a run's turns, and nothing about what the model said.
 *
 * The record is the authority for two questions the harness used to answer from its own impressions: whether the last
 * turn ended in a provider failure (rather than the companion choosing silence), and which record under this run's own
 * surface session is this run's. Only bounded, content-free facts leave here: a stop reason, whether an assistant text
 * part existed, a redacted transport message. The one exception is `readSessionPlayerTexts`, which reads the player's
 * own lines for MATCHING (was the day's note delivered to her) and never copies them into a result.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sessionEntries } from "../../lib/session-jsonl.mjs";
import { redactLiveRunText } from "../core/capture-text.mjs";

/**
 * The agent session's own terminal record for the turn(s) this run drove.
 *
 * The harness used to decide "did the companion speak" from `presentedSummary` alone, so a turn whose
 * provider stream ENDED IN AN ERROR was reported as `silent` — as if the companion had chosen not to
 * speak. Measured on a real self-directed run: the last assistant message carried `stopReason: "error"`,
 * `errorMessage: "unexpected EOF"` and zero usage tokens, the verdict was `silent`, `sessionTurnErrors`
 * was empty, and the harness log contained no agent-side line at all. The runtime's own durable session
 * record is the authoritative fact here and the capture already keeps it.
 *
 * Only bounded, content-free facts are published: the stop reason, whether any assistant text part
 * existed, how many assistant messages the turn had, and a redacted provider transport message. Player
 * or companion TEXT is never read into the result.
 */
export function readAgentTurnOutcome(sessionJsonlPath) {
  let raw;
  try {
    raw = readFileSync(sessionJsonlPath, "utf8");
  } catch {
    return Object.freeze({ observed: false, reason: "session_not_readable" });
  }
  let assistantMessages = 0;
  let last = null;
  for (const entry of sessionEntries(raw)) {
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "assistant") continue;
    assistantMessages += 1;
    const parts = Array.isArray(message.content) ? message.content : [];
    last = {
      stopReason: typeof message.stopReason === "string" ? message.stopReason : "unknown",
      hasText: parts.some(
        (part) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
      ),
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : null,
      totalTokens: typeof message.usage?.totalTokens === "number" ? message.usage.totalTokens : null,
    };
  }
  if (last === null) return Object.freeze({ observed: false, reason: "no_assistant_message" });
  return Object.freeze({
    observed: true,
    assistantMessages,
    stopReason: last.stopReason,
    // A turn that produced no assistant text at all is exactly the case that used to be
    // indistinguishable from a companion choosing silence.
    producedText: last.hasText,
    error: last.errorMessage === null ? null : redactLiveRunText(last.errorMessage).slice(0, 120),
    totalTokens: last.totalTokens,
  });
}

/**
 * `provider_error`-style reason for a turn that ended in a provider/runtime failure WITHOUT producing
 * any text, or `undefined` when the session record does not say that. Deliberately narrow: a turn that
 * spoke and then failed is not this case, and an unreadable session stays `unobserved` — the verdict
 * reports that rather than converting it into a cause.
 */
export function agentTurnFailureReason(outcome) {
  if (outcome?.observed !== true) return undefined;
  if (outcome.producedText === true) return undefined;
  if (outcome.stopReason !== "error" && outcome.stopReason !== "aborted") return undefined;
  return `provider_${outcome.stopReason}${outcome.error === null ? "" : `:${outcome.error}`}`;
}

/**
 * The reason one unsettled turn is recorded with, or a NAMED absence when the record has none.
 *
 * The verdict used to print the literal word `unsettled` for a turn carrying no error, which is how a round46 run ended
 * with a cause nobody could act on while the reason itself was in the envelope: `unsettled` was doing two jobs - the
 * class of the answer (`turn_unsettled`) and the whole sentence. The class stays on the verdict; the sentence is the
 * turn's own named cause, and a missing one says WHERE it is missing rather than defaulting to a plausible word.
 */
export function unsettledTurnError(turn) {
  const recorded = typeof turn?.error === "string" ? turn.error.trim() : "";
  return recorded.length > 0 ? recorded : "abandon_cause_absent:session_turn_record";
}

/**
 * THIS run's own session record: the files under the surface session directory this run materialized, or an object
 * saying why there is none.
 *
 * The product's convention is `<runtimeCwd>/surface-sessions/<surfaceSessionId>/sessions/*.jsonl`
 * (`host/src/runtime-identity.ts:127-136`), and the Game runtime is materialized with this run's own
 * `gameSessionId` - so that directory IS the binding, and it is the only place this reader looks. It used to walk the
 * runtime root and take the newest file it found, which is how two runs launched 38 minutes apart published the SAME
 * foreign record (`calls=45`, `sumMs=47189`, `frames=0` - 2026-10-22 audit) as each run's own measurement, and the
 * pair was quoted afterwards. A record this run cannot bind is not this run's record: the answer is "none" with the
 * reason and the directory searched, never a neighbour's numbers. `searched` stays in the answer because a reader has
 * to tell a missing session from a reader looking in the wrong place.
 */
/**
 * The session id the Magic Context store keys on, read from the session record's own name.
 *
 * `<timestamp>_<sessionId>.jsonl` is the shape `findRunSessionJsonl` already selects by, and `context.db`'s
 * `tags.session_id` holds exactly that second field - verified against the 2026-10-29 run, whose record
 * `2026-10-29T18-01-38-566Z_01a188d3-1a06-7103-bff6-bb3975370191.jsonl` matches 29 compartments and 191 tags.
 *
 * Returns undefined rather than a guess when the name does not have that shape: a wrong id would report another
 * session's totals as this run's.
 */
export function sessionIdFromSessionRecord(path) {
  if (typeof path !== "string") return undefined;
  const name = path.split(/[\\/]/u).at(-1) ?? "";
  return /_(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(name)?.groups?.id;
}

export function findRunSessionJsonl(sessionDir) {
  const searched = Object.freeze([String(sessionDir)]);
  const unbound = Object.freeze({
    path: undefined,
    reason: "no_session_record_for_run_surface_session",
    searched,
  });
  let entries;
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return unbound;
  }
  // Session file names are UTC timestamps, so the last one lexicographically is the newest - of THIS run's session,
  // which is what makes it this run's record. A resumed or compacted run may leave several here; all of them belong to
  // the same surface session, unlike the files of another run under a sibling directory.
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) return unbound;
  return Object.freeze({ path: join(sessionDir, files[files.length - 1]), reason: null, searched });
}

/**
 * The user messages a session record holds, in order - what she was actually TOLD.
 *
 * This is the only instrument that answers that question. `acceptPlayerText` answers whether the Host took the line, and
 * `round49` is the case where the two came apart: one player message in the session, and it was a gate's, while the day's
 * note appeared nowhere. A record that cannot be read answers `null`, which the reading reports as NOT MEASURED rather
 * than as an absent note - the two have different owners. Text is read here for matching only and is never copied into
 * the result.
 */
export function readSessionPlayerTexts(sessionJsonlPath) {
  if (typeof sessionJsonlPath !== "string" || sessionJsonlPath.length === 0) return null;
  let raw;
  try {
    raw = readFileSync(sessionJsonlPath, "utf8");
  } catch {
    return null;
  }
  const texts = [];
  for (const entry of sessionEntries(raw)) {
    if (entry?.type !== "message" || entry?.message?.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
          : "";
    texts.push(text);
  }
  return Object.freeze(texts);
}
