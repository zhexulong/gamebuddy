/**
 * The Mod's own Body Program journal, read as the evaluator's SECOND source of truth.
 *
 * The evaluator asks the live bridge what a submitted program did, and that is the right primary source: it is the
 * Mod's own answer for the run that is happening. It is also the only source that disappears exactly when its evidence
 * matters most. Measured 2026-10-27: the game process exited during a `pickup_item` dispatch, the evaluator's status
 * query answered `bridge_not_authenticated`, and the run was scored `observed: 0 of 6` - while the same six programs'
 * work was already written to disk. A run that did real work read as a run that did nothing.
 *
 * So a bridge read that yields NO record falls back to this file, which is the Mod's durable authority for the ActionProgram
 * graph (`BodyProgramJournal-v1`, written by `integrations/stardew/WindowsBodyProgramJournalStore.cs`). What it can
 * prove is exactly what the bridge would have reported: the program's `native_dispatch` events (each with the journal's
 * own `cursor`/`nodeId`/`nodeAttempt` identity) and its per-node states. Journal-sourced outcomes are marked
 * `source: "journal"` and bridge-sourced ones `source: "bridge"`, because an answer from a file and an answer from the
 * live Mod are not the same strength of evidence.
 *
 * The path is derived, not searched: the store writes to
 * `<Constants.DataPath>/BodyProgramJournal-v1/stardew/<saveId>/<worldId>/<playerId>/<companionId>/journal.json`, and the
 * four ids are the ones the run's own Mod config already declares.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const JOURNAL_SCHEMA_NAMESPACE = "BodyProgramJournal-v1";
const JOURNAL_INTEGRATION_ID = "stardew";
const JOURNAL_FILE = "journal.json";
/** One scope segment: the store itself refuses anything else, so a path is only ever built from admitted ids. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The Mod's program states, by the durable numeric value the journal stores (`BodyProgramModels.cs:144`).
 *
 * The wire spells these as strings (`BridgeProtocol.ToWire`); the file stores the enum. This is the one translation
 * between the two, so a journal-sourced outcome reads in the same vocabulary as a bridge-sourced one.
 */
const PROGRAM_STATE_NAMES = Object.freeze({
  1: "active",
  2: "succeeded",
  3: "failed",
  4: "cancelled",
  5: "recovery_required",
  6: "quarantined",
});

/**
 * The node states, by durable numeric value (`BodyProgramModels.cs:145`).
 *
 * `skipped_dependency` (10) and `abandoned` (11) are Journal-authority states the bridge projection folds into
 * `recovery_required` (`BridgeSession.ToWire`'s default arm). They are named here as the Mod names them, so a
 * journal-sourced node outcome does not inherit that lossy fold.
 */
const NODE_STATE_NAMES = Object.freeze({
  1: "pending",
  2: "awaiting_host_admission",
  3: "host_admitted",
  4: "running",
  5: "succeeded",
  6: "failed",
  7: "cancelled",
  8: "recovery_required",
  9: "rejected",
  10: "skipped_dependency",
  11: "abandoned",
});

/**
 * The Stardew data root the Mod joins `BodyProgramJournal-v1` onto: `SMAPI.Constants.DataPath`, the folder that
 * CONTAINS `Saves` (`ModEntry.GetBodyProgramJournalRoot`, and `ModEntryBodyProgramJournalRootTests` pins both facts).
 *
 * Read from the same `%APPDATA%/StardewValley` the runner already takes the Mod's log from, rather than from any
 * configuration this evaluator would have to invent.
 */
export function stardewDataPath(env = process.env) {
  const appData = env?.APPDATA;
  return typeof appData === "string" && appData.length > 0 ? join(appData, "StardewValley") : null;
}

/**
 * The one journal path this run's scope owns, or `null` when the scope cannot name one.
 *
 * A scope that is missing an id is not a different journal, it is a journal nobody can address: returning `null` keeps
 * the caller from reading a neighbouring save's programs.
 */
export function bodyProgramJournalPath({ dataPath, scope } = {}) {
  if (typeof dataPath !== "string" || dataPath.length === 0) return null;
  const ids = [scope?.saveId, scope?.worldId, scope?.playerId, scope?.companionId];
  if (!ids.every((id) => typeof id === "string" && SAFE_SEGMENT.test(id))) return null;
  return join(dataPath, JOURNAL_SCHEMA_NAMESPACE, JOURNAL_INTEGRATION_ID, ...ids, JOURNAL_FILE);
}

function programStateName(value) {
  return PROGRAM_STATE_NAMES[value] ?? null;
}

function nodeStateName(value) {
  return NODE_STATE_NAMES[value] ?? null;
}

/** One program's journal entry, folded into the same evidence shape `readProgramOutcomes` publishes. */
function programEvidence(program, events) {
  const executions = events
    .filter((event) => event?.kind === "native_dispatch")
    .map((event) =>
      Object.freeze({
        nodeId: event?.nodeId ?? null,
        nodeAttempt: event?.nodeAttempt ?? null,
        cursor: event?.cursor ?? null,
      }),
    );
  return Object.freeze({
    dispatched: executions.length,
    executions: Object.freeze(executions),
    nodeOutcomes: Object.freeze(
      (Array.isArray(program?.nodes) ? program.nodes : []).map((node) =>
        Object.freeze({ nodeId: node?.nodeId ?? null, state: nodeStateName(node?.state) }),
      ),
    ),
    programState: programStateName(program?.state),
  });
}

/**
 * A lazy reader over this run's journal: the file is opened only when a caller actually needs an outcome, so a bridge
 * that answers is never second-guessed by a file, and a bridge that fails six times reads the journal once.
 *
 * `readFile` is injected so a test can drive a real file without a real game; production passes nothing.
 */
export function createBodyProgramJournalFallback({ dataPath, scope, readFile = readFileSync } = {}) {
  const path = bodyProgramJournalPath({ dataPath, scope });
  let loaded = null;

  const load = () => {
    if (loaded !== null) return loaded;
    if (path === null) {
      loaded = Object.freeze({ programs: null, reason: "journal_scope_unaddressable" });
      return loaded;
    }
    let document;
    try {
      document = JSON.parse(readFile(path, "utf8"));
    } catch (error) {
      loaded = Object.freeze({
        programs: null,
        reason:
          error?.code === "ENOENT"
            ? "journal_absent"
            : `journal_unreadable:${String(error?.message ?? error).slice(0, 80)}`,
      });
      return loaded;
    }
    const programs = Array.isArray(document?.programs) ? document.programs : null;
    if (programs === null) {
      loaded = Object.freeze({ programs: null, reason: "journal_has_no_programs" });
      return loaded;
    }
    const byId = new Map();
    for (const entry of programs) {
      const programId = entry?.program?.programId;
      if (typeof programId === "string" && programId.length > 0) byId.set(programId, entry);
    }
    // One pass over the events, keyed by program: a run can hold hundreds of them and every lookup is by program.
    const eventsByProgram = new Map();
    for (const event of Array.isArray(document?.events) ? document.events : []) {
      const programId = event?.programId;
      if (typeof programId !== "string") continue;
      const list = eventsByProgram.get(programId);
      if (list === undefined) eventsByProgram.set(programId, [event]);
      else list.push(event);
    }
    loaded = Object.freeze({ programs: byId, eventsByProgram, reason: null });
    return loaded;
  };

  return Object.freeze({
    path,
    /** What the journal proves about one program, or `null` when it proves nothing about it. */
    outcomeFor(programId) {
      const journal = load();
      if (journal.programs === null || typeof programId !== "string") return null;
      const program = journal.programs.get(programId);
      if (program === undefined) return null;
      return programEvidence(program, journal.eventsByProgram?.get(programId) ?? []);
    },
    /** Whether the file answered at all, and why not when it did not - the fact a fallback that found nothing owes a reader. */
    state() {
      const journal = load();
      return Object.freeze({ path, ok: journal.programs !== null, reason: journal.reason });
    },
  });
}
