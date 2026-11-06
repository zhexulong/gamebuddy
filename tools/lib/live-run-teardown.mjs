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
import { existsSync, writeFileSync } from "node:fs";

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
  console.log("fixture transaction restored");
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
