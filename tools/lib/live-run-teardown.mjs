/**
 * The teardown a live run owes whether it ended or was KILLED, and the trap that makes the second case possible.
 *
 * WHY this exists: measured 2026-11-06 at 19:37:14, a launcher ended by an external timeout left its fixture transaction
 * unreleased (`.stardew-native-local-player-fixture.lock` with its `transaction.json` intact), its run directory holding
 * `launch.json` and nothing else, and its restore never run — so the run could not be classified at all and the next lane
 * met a busy root. Nothing trapped the signal; the process simply stopped mid-await.
 *
 * Three facts live here, for the two processes that need them (the launcher and the runner), so a killed run has ONE
 * spelling:
 *
 *   1. the trap: the FIRST signal owns the unwind and the process exits with the signal's own code; a SECOND signal exits
 *      immediately, because the first unwind is stuck on a bridge that may already be gone;
 *   2. the reason the interrupted run publishes, `run_killed_by_signal:<signal>`;
 *   3. the two teardown steps this process owns: the fixture restore (which is what releases the lock) and the killed
 *      record (written only when the runner published none — two records for one run is the defect it avoids).
 *
 * A killed run is NOT a failed run: nothing about the product was measured, so the record is `state: "killed"` and no
 * failure dump is published (see `EVIDENCE_BUNDLE_VERDICT_STATES` in `evidence-bundle.mjs`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Each signal's own interrupt exit code, so a killed run is distinguishable from a failed one by exit status alone.
 */
export const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** The one spelling of "an external stop ended this run", shared by the runner's bundle and the launcher's record. */
export function killedReasonCode(signal) {
  return `run_killed_by_signal:${signal}`;
}

/**
 * Install the trap, and return what the caller can observe about it.
 *
 * `onInterrupt(signal)` is the unwind: it is awaited once, and then the process exits with the signal's code whatever the
 * unwind did — a teardown that failed must not be able to leave a killed run looking alive.
 *
 * Ctrl+C reaches every process on a Windows console, which is why SIGINT is the realistic case there; SIGTERM is listened
 * for so a soft POSIX-style timeout takes the same path.
 */
export function installLiveRunInterrupt({
  onInterrupt,
  exit = (code) => process.exit(code),
  log = (line) => process.stderr.write(`${line}\n`),
  signals = ["SIGTERM", "SIGINT"],
}) {
  const handlers = new Map();
  let killedSignal = null;
  // ONE exit per process. The second signal exits while the first unwind is still pending, so the unwind's own exit has
  // to be the one that is skipped - otherwise a run leaves twice, and with an injected `exit` it would leave twice for real.
  let exited = false;
  const leave = (code) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const handle = (signal) => {
    if (killedSignal !== null) {
      // The second signal gets no second unwind: it means the first one is not finishing.
      leave(SIGNAL_EXIT_CODES[signal]);
      return;
    }
    killedSignal = signal;
    log(`[killed] ${signal}: this run was interrupted from outside`);
    Promise.resolve(onInterrupt(signal)).then(
      () => leave(SIGNAL_EXIT_CODES[signal]),
      (error) => {
        log(`[killed] teardown failed: ${String(error?.message ?? error).slice(0, 200)}`);
        leave(SIGNAL_EXIT_CODES[signal]);
      },
    );
  };
  for (const signal of signals) {
    const handler = () => handle(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return Object.freeze({
    /** Remove the trap, so a test that installed one leaves no listener behind for the next test. */
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    },
  });
}

/**
 * The ONE restore both exits run: the fixture transaction is released here, which is what frees the lock for the next
 * lane. `run` is the caller's own command runner, so the harness layer keeps owning how a child is spawned.
 */
export function restoreFixtureTransaction({ run, fixtureRoot, modsPath, releaseDir, backupName, evidenceDir }) {
  run([
    "tools/restore-stardew-native-local-player-fixture.mjs",
    "--root",
    fixtureRoot,
    "--mods-path",
    modsPath,
    "--release-dir",
    releaseDir,
    "--backup-name",
    backupName,
    // The run's own directory: the fixture archives the body-program journal here before deleting the live scope, so
    // what the programs did survives the restore instead of existing only in a log.
    "--evidence-dir",
    evidenceDir,
  ]);
  // PROGRESS GOES TO STDERR, because the tools that call this publish ONE JSON block on stdout and a caller has to be
  // able to parse it: measured 2026-11-11, `tools/live-program.mjs --script ...` printed `fixture transaction restored`
  // before its block, so the run's own product could not be read by `JSON.parse`.
  process.stderr.write("fixture transaction restored\n");
}

/**
 * The killed run's record, written only when nothing is at its path: a bundle the runner wrote is the run's own account
 * of itself, and a second record for one run is how two artifacts come to disagree.
 */
export function writeKilledRunRecord({ resultPath, record }) {
  if (existsSync(resultPath)) {
    console.log(`[killed] the runner published its own bundle: ${resultPath}`);
    return false;
  }
  writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[killed] killed record written: ${resultPath}`);
  return true;
}

// ── The reclamation account ────────────────────────────────────────────────────────────────────────────────────────
//
// WHY: measured 2026-11-09 (`round40`), the run reaped its game, released its fixture transaction and flushed its runtime
// trace - and its bundle published `reclamation: {state: "unobserved", exitReason: null, steps: [], reflection:
// "completed"}`, a completed reflection over zero steps, which the contract accepted. Nobody reading the artifact could
// tell a clean unwind from one that never happened, so the account could not be audited at all.
//
// The account is a sequence of STEPS, each measured by the process that performed it: the runner owns the runtime and the
// bridge, the launcher owns the game tree and the fixture transaction. Each appends what it measured to the one record
// already in the artifact (`stampReclamation`), so the fact has one home and two authors rather than two artifacts that
// can disagree. `state` and `reflection` are DERIVED from the steps - never written by hand - so a run cannot publish a
// completed unwind it did not perform.

/** The closed set a reader may branch on. `unobserved` is the absence of an account, which is not a clean one. */
export const RECLAMATION_STATES = Object.freeze(["clean", "failed", "unobserved"]);

/** The contract's own reflection vocabulary (`evidence-bundle.mjs` requires one of these). */
export const RECLAMATION_REFLECTIONS = Object.freeze(["completed", "skipped", "failed"]);

/**
 * Every step a finished run owes, in the order the unwind performs it. The two owners are visible in the list: the first
 * three belong to the runner, the last two to the launcher that owns the game process and the fixture transaction.
 */
export const RECLAMATION_REQUIRED_STEPS = Object.freeze([
  "runtime_close",
  "binding_close",
  "bridge_detach",
  "process_reap",
  "fixture_restore",
]);

/**
 * One step, as the process that ran it saw it. `detail` carries the failure's own message or the fact that explains the
 * step (`game_exit:code:0`); `pids` carries exactly the processes this step reaped, never a pattern.
 */
export function reclamationStep({ step, ok, detail = null, pids = [] }) {
  if (typeof step !== "string" || step.trim().length === 0) throw new Error("a reclamation step needs its name");
  if (typeof ok !== "boolean") throw new Error(`reclamation step ${step} must say whether it finished`);
  return Object.freeze({
    step,
    state: ok ? "ok" : "failed",
    detail: detail === null || detail === undefined ? null : String(detail).slice(0, 300),
    pids: Object.freeze([...pids]),
  });
}

/** The record, derived from its steps. Nothing here is asserted: a state with no step behind it is not publishable. */
export function reclamationRecord({ steps = [], exitReason = null } = {}) {
  const state =
    steps.length === 0 ? "unobserved" : steps.some((entry) => entry.state === "failed") ? "failed" : "clean";
  return Object.freeze({
    state,
    exitReason: exitReason === null || exitReason === undefined ? null : String(exitReason),
    steps: Object.freeze([...steps]),
    reflection: state === "clean" ? "completed" : state === "failed" ? "failed" : "skipped",
  });
}

/** Extend an existing account with steps this caller just measured. The outcome follows the merged steps. */
function mergeReclamation(existing, { steps, exitReason }) {
  const kept = Array.isArray(existing?.steps) ? existing.steps : [];
  return reclamationRecord({
    steps: [...kept, ...steps],
    exitReason: exitReason ?? existing?.exitReason ?? null,
  });
}

/**
 * Write the steps into the artifacts that already exist, and invent none. A path that was never written is skipped: a run
 * that published no result has no account to carry, and creating one would be the artifact lying about having run.
 * Returns the merged record from the last file written, so a caller can gate on the account it just published.
 */
export function stampReclamation({ paths, steps = [], exitReason = undefined }) {
  const written = [];
  let record = null;
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || !existsSync(path)) continue;
    let document;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`run_reclamation_not_stamped:unreadable:${path}`);
    }
    record = mergeReclamation(document?.reclamation, { steps, exitReason });
    writeFileSync(path, `${JSON.stringify({ ...document, reclamation: record }, null, 2)}\n`, "utf8");
    written.push(path);
  }
  return Object.freeze({ written: Object.freeze(written), record });
}

/**
 * The gate a finished run's finalizer applies: which steps the run owes and this account never measured. Empty means the
 * account is complete. A null record owes every step - "no account" must not pass as "nothing to do".
 */
export function missingReclamationSteps(record) {
  const measured = new Set(
    (Array.isArray(record?.steps) ? record.steps : [])
      .filter((entry) => entry?.state === "ok")
      .map((entry) => entry.step),
  );
  return RECLAMATION_REQUIRED_STEPS.filter((step) => !measured.has(step));
}

/**
 * The steps the LAUNCHER owes, and the values they carry: the game tree (which it does not launch, but does own to
 * reclaim) and the fixture transaction it holds. `game` is the orchestrator's own record, or null when it published none;
 * `survivors` is this process's own post-restore reading, because a zero-survivor assertion is a measurement, not an
 * inference from the record above it.
 */
export function launcherReclamationSteps({ game, survivors, fixtureRestore }) {
  const running = Array.isArray(survivors) ? [...survivors] : [];
  const exitDetail = reclamationExitReason(game) ?? "game_exit:unreported";
  return Object.freeze([
    reclamationStep({
      step: "process_reap",
      ok: running.length === 0,
      detail: running.length === 0 ? exitDetail : `${exitDetail}:survivors:${running.join(",")}`,
      // Exactly the process this run started, by the handle's own pid. A survivor is NAMED in the detail, never written
      // here as a pid that was reaped - the two lists would then read as one.
      pids: Number.isInteger(game?.pid) ? [game.pid] : [],
    }),
    reclamationStep({
      step: "fixture_restore",
      ok: fixtureRestore?.ok === true,
      detail: fixtureRestore?.ok === true ? null : (fixtureRestore?.error ?? "restore_not_measured"),
    }),
  ]);
}

/** How the game process this run launched ended, in one spelling, or null when nobody observed it. */
export function reclamationExitReason(game) {
  const exit = game?.exit ?? null;
  if (exit === null) return null;
  if (Number.isInteger(exit.code)) return `game_exit:code:${exit.code}`;
  if (typeof exit.signal === "string") return `game_exit:signal:${exit.signal}`;
  return null;
}
