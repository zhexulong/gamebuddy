/**
 * The launch sequence, on ONE clock, in ONE line shape.
 *
 * "Why is startup slow" could not be answered by subtraction because the log had no phases to subtract: a launch builds
 * nothing, copies a save template into the real save root, deploys the built Mod bundle, starts the game, waits for the
 * Mod's pipe, spawns the runner, evaluates ~200 modules, connects, mounts the persona and only then waits for the model.
 * The first number in the log belonged to the bridge, so the save copy, the deploy and the game's own load were one blank
 * (measured 2026-11-15, `round55`: nothing at all until 25.7s, and no phase said which step owned it).
 *
 * Two properties make the table answer that question, and both are assertions below rather than intentions:
 *
 *   - ONE CLOCK. The launcher starts the clock and every later process continues it (`readLaunchPhaseHandover`), so
 *     "the game's load" is `runner_process_start - game_launched` and nothing has to be reconciled. A phase marked before
 *     the clock, or behind a phase already written, is a caller bug and is refused by name.
 *   - ONE SPELLING. The line is formatted here and nowhere else: `LAUNCH_PHASE {"phase":…,"elapsedMs":…,"atMs":…}`.
 *     `elapsedMs` is the duration a reader subtracts; `atMs` is the wall clock, so a phase can also be matched against a
 *     log line another process wrote.
 *
 * The session's phases are measured where they happen: the launcher owns the steps before the runner exists, the runner
 * owns the ones after. `event` is deliberately absent - a phase is a moment the launch reached, not an event stream.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** The one spelling of the marker, so a reader can grep a log for one token. */
export const LAUNCH_PHASE_PREFIX = "LAUNCH_PHASE";

const isClock = (value) => Number.isSafeInteger(value) && value > 0;
const isDuration = (value) => Number.isSafeInteger(value) && value >= 0;

/** One line, and the only place its shape is decided. */
function formatLaunchPhaseLine(record) {
  return `${LAUNCH_PHASE_PREFIX} ${JSON.stringify({
    phase: record.phase,
    elapsedMs: record.elapsedMs,
    atMs: record.atMs,
  })}\n`;
}

/** A record that is not a phase this module produced is named rather than half-used. */
function assertLaunchPhaseRecord(record, source) {
  if (typeof record?.phase !== "string" || record.phase.length === 0) throw new Error(`${source}:phase_not_named`);
  if (!isDuration(record.elapsedMs)) throw new Error(`${source}:elapsed_not_a_duration:${record.phase}`);
  if (!isClock(record.atMs)) throw new Error(`${source}:atMs_not_a_clock:${record.phase}`);
  return Object.freeze({ phase: record.phase, elapsedMs: record.elapsedMs, atMs: record.atMs });
}

/**
 * The run's phase clock: `startedAtMs` is the wall clock elapsed values are measured against, and each `mark` prints its
 * own line as it happens so a log read DURING a launch is already answerable.
 */
export function createLaunchPhaseLog({ startedAtMs, emit = (line) => process.stdout.write(line) }) {
  if (!isClock(startedAtMs)) throw new Error(`invalid_launch_phase_clock:${String(startedAtMs)}`);
  const recorded = [];
  let lastElapsedMs = 0;
  const publish = (record) => {
    const accepted = assertLaunchPhaseRecord(record, "invalid_launch_phase_record");
    // A phase that steps behind one already written would make every later subtraction lie about its own sign, and the
    // table would still look plausible.
    if (accepted.elapsedMs < lastElapsedMs)
      throw new Error(`launch_phase_went_backwards:${accepted.phase}:${lastElapsedMs - accepted.elapsedMs}ms`);
    lastElapsedMs = accepted.elapsedMs;
    recorded.push(accepted);
    emit(formatLaunchPhaseLine(accepted));
    return accepted;
  };
  return Object.freeze({
    startedAtMs,
    get records() {
      return Object.freeze([...recorded]);
    },
    /** Mark `phase` at `atMs` (default: now) on this clock, print it, and return the record. */
    mark(phase, atMs = Date.now()) {
      if (!isClock(atMs)) throw new Error(`invalid_launch_phase_moment:${phase}:${String(atMs)}`);
      if (atMs < startedAtMs) throw new Error(`launch_phase_before_the_clock:${phase}:${startedAtMs - atMs}ms`);
      return publish({ phase, elapsedMs: atMs - startedAtMs, atMs });
    },
    /** Continue this clock with records another process measured, in the order it measured them. */
    adopt(records) {
      for (const record of records) publish(record);
      return recorded.length;
    },
  });
}

/**
 * Hand the launcher's records to the runner.
 *
 * A FILE, not an environment variable, because the last step the launcher measures (`game_launched`) happens AFTER the
 * orchestrator has been spawned with its environment already fixed. Written through a rename so a reader never parses
 * half a document.
 */
export function writeLaunchPhaseHandover({ path, startedAtMs, records }) {
  if (typeof path !== "string" || path.length === 0) throw new Error("invalid_launch_phase_handover_path");
  if (!isClock(startedAtMs)) throw new Error(`invalid_launch_phase_clock:${String(startedAtMs)}`);
  const document = {
    startedAtMs,
    records: records.map((record) => assertLaunchPhaseRecord(record, "invalid_launch_phase_record")),
  };
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(document), "utf8");
  renameSync(temporary, path);
  return document;
}

/** The launcher's records, or `null` when this launch has none. A document that is not ours is refused by name. */
export function readLaunchPhaseHandover(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`invalid_launch_phase_handover:unreadable:${path}`);
  }
  if (!isClock(document?.startedAtMs)) throw new Error("invalid_launch_phase_handover:clock");
  if (!Array.isArray(document.records)) throw new Error("invalid_launch_phase_handover:records");
  return Object.freeze({
    startedAtMs: document.startedAtMs,
    records: Object.freeze(
      document.records.map((record) => assertLaunchPhaseRecord(record, "invalid_launch_phase_handover")),
    ),
  });
}
