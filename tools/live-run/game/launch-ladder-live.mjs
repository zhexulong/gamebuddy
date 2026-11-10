/**
 * Launch one Game ladder live run (the recipe, in one place).
 *
 * The ladder runner is the single live-run file (`run-stardew-…-ab-live.mjs`); this
 * is its launcher, because the ORDER is load-bearing and was previously only in an
 * operator's head:
 *
 *   1. restore the native save template as this transaction's disposable working save
 *   2. prepare the fixture transaction (writes the Mod config, backs it up, deploys
 *      the Release bundle into the REAL game Mods dir that ladder runs attach to)
 *   3. launch the game + the ladder runner through the ladder's orchestrator
 *   4. restore the transaction
 *
 * It also recovers two states that otherwise deadlock a shared fixture root: an
 * ORPHANED transaction (a run that ended abnormally cannot restore itself, so the
 * lock is renamed aside — never deleted — when no game process is alive), and this
 * launcher's own leftover backup from an earlier attempt.
 *
 * Usage:
 *   node tools/live-run/game/launch-ladder-live.mjs --scenario morning_routine [--action till_soil] [--label c]
 *                                                    [--save <Slot>] [--backup <name>]
 *
 * `--scenario` is the run's scenario (`morning_routine`, `memory_covenant`, `npc_social_and_presence`). The
 * legacy `--ladder <n>` is still accepted and translated by the runner, so an operator's existing command keeps
 * working; new commands should use the scenario name.
 *
 * Every run writes its own result/log pair (`tools/_<scenario>[-<label>]…`), so a
 * run somebody is already reading is never overwritten by the next attempt.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killProcessTree, listStardewProcessIds } from "../../lib/windows-process-tree.mjs";
import {
  installLiveRunInterrupt,
  killedReasonCode,
  launcherReclamationSteps,
  missingReclamationSteps,
  reclamationExitReason,
  restoreFixtureTransaction as restoreFixtureTransactionSteps,
  stampReclamation,
  writeKilledRunRecord,
} from "../../lib/live-run-teardown.mjs";
import { EVIDENCE_BUNDLE_FILES } from "../../lib/evidence-bundle.mjs";
import { judgeResultFreshness, supersedePreviousResult } from "../core/result-freshness.mjs";
import { announceStardewFixtureRoots, resolveStardewFixtureRoots } from "../../lib/stardew-fixture-roots.mjs";
import { STARDEW_MOD_FOLDER } from "../../lib/stardew-mod-folder.mjs";
import { normalizeLiveRunWindowMode } from "../../lib/stardew-live-run.mjs";

const repo = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

// A value that is present but blank is the same as absent: an empty path is not a path.
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);

const LEGACY_LADDER = option("ladder", null);
const LEGACY_SCENARIO_BY_LADDER = Object.freeze({
  0: "morning_routine",
  1: "morning_routine",
  2: "morning_routine",
  3: "morning_routine",
  4: "npc_social_and_presence",
  5: "memory_covenant",
  6: "morning_routine",
});
const SCENARIOS = Object.freeze(["morning_routine", "memory_covenant", "npc_social_and_presence", "multiday_routine"]);
const scenario = (() => {
  const requested = option("scenario", LEGACY_LADDER === null ? null : LEGACY_SCENARIO_BY_LADDER[LEGACY_LADDER]);
  if (!SCENARIOS.includes(requested)) {
    throw new Error(`unknown_run_scenario:${String(requested)} (expected one of ${SCENARIOS.join(", ")})`);
  }
  return requested;
})();
// The window mode is configuration with ONE vocabulary (`tools/lib/stardew-live-run.mjs`, mirroring the Host's
// authority), and it is read once here: the game child and the runner's own evidence bundle must agree about
// what mode this run was in, and an invalid value is refused rather than silently coerced.
const windowMode = normalizeLiveRunWindowMode(process.env.GAMEBUDDY_LADDER_WINDOW_MODE ?? "hidden");
const action = option("action", "play_session");
const label = option("label", "");
const gameDir =
  nonEmpty(option("game", null)) ??
  nonEmpty(process.env.GAMEBUDDY_STARDEW_GAME_DIR) ??
  "D:/Steam/steamapps/common/Stardew Valley";
// resolve(), for the same reason as releaseDir: the fixture refuses relative paths with
// `native_local_fixture_absolute_paths_required`, and an env override can be relative.
// An EMPTY env var is not an answer: `??` only falls back on null/undefined, so a blank
// GAMEBUDDY_STARDEW_MODS_DIR became an empty argument and the fixture refused the whole run in 65 seconds.
const fixtureRoots = resolveStardewFixtureRoots({ fixturesRoot: option("root", null) });
const fixtureRoot = fixtureRoots.fixturesRoot;
announceStardewFixtureRoots(fixtureRoots);

//
// The DEFAULT is a lane-private mods folder, never <game>/Mods.
//
// This used to default to the game's own Mods directory, so every run wrote the built bundle into the Steam install. Steam
// notices: it reported the install as modified, because it was - by us, on every run. Deploying there was also redundant,
// since the fixture copies the same bundle into its own root and launches SMAPI with `--mods-path`.
//
// Pointing at the install now requires saying so explicitly (`--allow-game-mods`), because a silent default that writes
// into a store-managed directory is exactly the kind of side effect a run should never have.
const allowGameMods = option("allow-game-mods", null) !== null;
const modsPath = path.resolve(
  nonEmpty(option("mods", null)) ?? nonEmpty(process.env.GAMEBUDDY_STARDEW_MODS_DIR) ?? path.join(fixtureRoot, "mods"),
);
const gameModsRoot = path.resolve(path.join(gameDir, "Mods"));
if (!allowGameMods && (modsPath === gameModsRoot || modsPath.startsWith(`${gameModsRoot}${path.sep}`))) {
  throw new Error(
    `refusing_to_write_into_the_game_install:${modsPath} (pass --allow-game-mods if that is really intended; ` +
      `Steam reports files under its install as modified, and the fixture deploys its own copy anyway)`,
  );
}
// Both fixture roots come from the single shared resolver
// (tools/lib/stardew-fixture-roots.mjs). The defaults are the historical paths;
// GAMEBUDDY_STARDEW_PROFILE_ROOT / GAMEBUDDY_STARDEW_FIXTURE_ROOT point one
// concurrent lane at private roots, and an explicit --root still wins. The
// resolved roots are printed once so an operator can see which root this run
// holds before it takes the fixture transaction.

// resolve(), not join(): the fixture refuses relative paths with
// `native_local_fixture_absolute_paths_required`, so a relative --release silently broke the restore half of
// every run while the run itself looked healthy.
const releaseDir = path.resolve(repo, option("release", "integrations/stardew/bin/Release/net6.0"));
const saveName = option("save", "GameBuddyFixtureNavigation_447088730");
const backupName = option("backup", `native-local-${action.replaceAll("_", "-")}-fixture-backup`);
const templateName = option("template", saveName);
const suffix = label.length > 0 ? `-${label}` : "";
const resultPath = path.join(repo, "tools", `_${scenario}${suffix}.result.json`);
const logPath = path.join(repo, "tools", `_${scenario}${suffix}-live-runner.log`);

// A `result.json` this launch did not write is not this attempt's answer, and the tail below reads it as one: a run that
// died before writing its own bundle left the previous run's file exactly where the report looks, so a crash printed a
// pass. The previous bundle is MOVED ASIDE, never deleted - it is the only record of a run that may have cost 34
// minutes - and `judgeResultFreshness` below is the second half of the same rule, for a bundle that appears during the
// launch. One implementation, shared with `tools/live-run/multiday-iterate.mjs`.
const supersededResult = supersedePreviousResult({ resultPath });
if (supersededResult !== null) console.log("previous result moved aside:", path.basename(supersededResult));
// Where the orchestrator writes what only IT measured: the game process it launched, how it ended, and the survivors it
// could not reap. A file, because its stderr is a real console (SMAPI needs one) and nothing can be parsed out of it.
const processReclamationPath = path.join(repo, "tools", `_${scenario}${suffix}-process-reclamation.json`);
const lockDir = path.join(fixtureRoot, ".stardew-native-local-player-fixture.lock");

const node = process.execPath;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (argv, env) =>
  execFileSync(node, argv, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });

// The shared reader (tools/lib/windows-process-tree.mjs): one implementation, and the one used by the
// zero-survivor assertion below, so "no orphan" is judged by the same code that reports it.
const liveGameProcesses = () => listStardewProcessIds();

/**
 * A run only starts on a free root: no game, no active transaction. A run that
 * starts while another lane holds the lock has its own transaction overwritten
 * mid-flight and loses its restore — observed for real, which is why this waits
 * instead of racing.
 */
async function waitForFreeFixture(deadlineMs = Date.now() + 45 * 60 * 1000) {
  for (;;) {
    const game = liveGameProcesses();
    const locked = fs.existsSync(lockDir);
    if (game.length === 0 && !locked) return;
    if (game.length === 0 && locked) {
      const idleMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (idleMs > 3 * 60 * 1000) {
        const aside = `${lockDir}.orphaned-${Date.now()}`;
        fs.renameSync(lockDir, aside);
        console.log(
          `[recover] orphaned fixture transaction renamed aside: ${path.basename(aside)} (idle ${Math.round(idleMs / 1000)}s)`,
        );
        return;
      }
    }
    if (Date.now() > deadlineMs) throw new Error("fixture_never_became_free");
    console.log(`[wait] fixture busy (game=${game.join(",") || "none"}, lock=${locked}); retrying in 30s`);
    await sleep(30_000);
  }
}

// The binding file's PATH is derived from the save name - the fixture names it `<saveName>.native-local-binding.json`
// (`launch-stardew-navigation-fixture.ps1:46`) - and the file is WRITTEN by the prepare step below.
//
// This used to be a directory scan followed by `if (!binding) throw`, both of which ran BEFORE preparing. So on a root
// that did not exist yet the launcher could not rebuild the very thing it was about to build: it died with a raw
// `ENOENT: scandir`, and after that check was made tolerant it died with "no native-local binding" instead. A path is
// knowable before the file exists; whether the file exists is a question only preparing can answer.
const binding = path.join(fixtureRoot, `${saveName}.native-local-binding.json`);

/**
 * Who owns the fixture transaction right now, as recorded by its owner. Reading the
 * owner (instead of only "is the lock there") is what makes a TAKEOVER visible: two
 * live-run lanes share this root, and a takeover that happens after this launcher's own
 * prepare leaves the run playing against a world and a Mod config that belong to
 * somebody else. That is not hypothetical — run I was contaminated that way, produced an
 * artifact whose trace showed zero attempts while the companion reported that "every
 * attempt was refused", and its restore then correctly refused as a non-owner.
 */
function currentOwnerId() {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "transaction.json"), "utf8")).ownerId ?? null;
  } catch {
    return null;
  }
}

/**
 * A run that is killed from outside still costs its own verdict, and this is the process that owns the fixture
 * transaction, so this is where its teardown has to be armed.
 *
 * Measured 2026-11-06 at 19:37:14: an external timeout ended the launcher mid-await, leaving the transaction unreleased
 * under `.stardew-native-local-player-fixture.lock`, the run directory holding only `launch.json`, and no restore ever
 * run. The trap itself, the reason the run publishes and the two teardown steps live in `tools/lib/live-run-teardown.mjs`
 * because the RUNNER needs the same rule for its own bundle.
 *
 * The settle window is the point of the delay: on Windows Ctrl+C reaches every process on the console, so the runner sees
 * the same signal and gets to write its accumulated day records before this process restores the fixture underneath it.
 */
const KILL_SETTLE_MS = 60_000;
const startedAtMs = Date.now();
let takeoverWatch = null;
let childSettled = null;

/**
 * What a killed run runs: settle the runner, reap the game, restore the fixture, and leave a record only if the runner
 * left none.
 */
async function killedTeardown(signal) {
  if (childSettled !== null) {
    console.error(`[killed] waiting up to ${KILL_SETTLE_MS} ms for the runner to publish its own killed bundle`);
    await Promise.race([childSettled, sleep(KILL_SETTLE_MS)]);
  }
  // A killed run does not leave its game playing. Same primitive as the takeover watch: the exact PIDs of the game
  // processes this launcher's own orchestrator started, never a kill by image name.
  for (const pid of liveGameProcesses()) killProcessTree(pid);
  if (takeoverWatch !== null) clearInterval(takeoverWatch);
  try {
    restoreFixtureTransaction();
  } catch (error) {
    // A restore that refuses must not take the killed record with it: "the lock is still held" and "we stopped this
    // run" are two separate facts, and the second one is the run's verdict.
    console.error(`[killed] fixture restore failed: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  writeKilledRunRecord({
    resultPath,
    record: {
      state: "killed",
      reasonCode: killedReasonCode(signal),
      scenario,
      action,
      label,
      saveName,
      windowMode,
      fixtureOwnerId: myOwnerId,
      startedAtMs,
      endedAtMs: Date.now(),
      // The day records and counters are the RUNNER's own accumulation. This record exists only because it published
      // none inside the settle window, so they are named absent with the reason rather than filled with zeroes.
      evidence: { dayRecords: null, counters: null, reason: "runner_published_no_bundle" },
    },
  });
}

/** The ONE restore both exits run, so a killed run cannot miss a teardown the ordinary one performs. */
function restoreFixtureTransaction() {
  restoreFixtureTransactionSteps({
    run,
    fixtureRoot,
    modsPath,
    releaseDir,
    backupName,
    evidenceDir: path.dirname(resultPath),
  });
}

installLiveRunInterrupt({ onInterrupt: killedTeardown });

await waitForFreeFixture();

// A previous run that died before restoring leaves its working save behind, and prepare then refuses
// with `native_local_fixture_working_save_exists`. That refusal is right, but it makes one failed run
// block every later one until someone deletes a directory by hand. Finish the leftover transaction
// first.
//
// THE CALL IS GUARDED BY THE TRANSACTION ITSELF. `restore` refuses with
// `native_local_fixture_transaction_owner_mismatch` when there is nothing to restore, and that refusal looks exactly
// like a real failure in the log - measured 2026-11-03: every run since 2026-11-02 opened with
// `restore_refused:native_local_fixture_restore_failed`, the fixture was in fact prepared correctly from the template,
// and I spent a turn treating it as "runs do not start from the same day" until the template's own `dayOfMonth 1` refuted
// that. A log line that reads as a failure when it means "nothing to do" is worse than no line.
const leftoverTransaction = path.join(fixtureRoot, ".stardew-native-local-player-fixture.lock", "transaction.json");
if (!fs.existsSync(leftoverTransaction)) {
  console.log("[recover] no leftover transaction: preparing from the template");
} else {
  try {
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
    ]);
    console.log("[recover] leftover fixture transaction restored before preparing");
  } catch (error) {
    // There WAS a leftover this lane may not own: preparing will refuse with its own named reason.
    console.log("[recover] leftover transaction not restorable:", String(error?.message ?? error).slice(0, 120));
  }
}
const orphan = path.join(fixtureRoot, backupName);
if (fs.existsSync(orphan)) {
  const aside = `${orphan}.orphaned-${Date.now()}`;
  fs.renameSync(orphan, aside);
  console.log("[recover] orphaned backup preserved as:", path.basename(aside));
}

// Preparing is racy on a shared root: another lane can start a session in the gap between the
// free-fixture check and the file operation, and the fixture refuses to touch a running game. That
// refusal is contention, not a failure, so it re-enters the wait instead of ending the run.
const CONTENTION =
  /Refusing fixture file operation while Stardew|native_local_fixture_transaction_locked|SMAPI is running/;
const prepareAttempt = (attempt) => {
  execFileSync(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    [
      "-NoProfile",
      "-File",
      path.join(repo, "tools", "prepare-stardew-action-fixture.ps1"),
      "-FixtureRoot",
      fixtureRoot,
      "-TemplateName",
      templateName,
      "-SaveName",
      saveName,
    ],
    { cwd: repo, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
  );
  run([
    "tools/prepare-stardew-native-local-player-fixture.mjs",
    "--root",
    fixtureRoot,
    "--mods-path",
    modsPath,
    "--release-dir",
    releaseDir,
    "--save-name",
    saveName,
    "--backup-name",
    backupName,
    "--binding-path",
    binding,
    "--action",
    action,
    // The declared Stardew save root, so the fixture transaction can manage the Mod-owned Body Program journal.
    //
    // That journal is scoped by the binding's four ids and is what decides whether the companion may submit a plan at
    // all: the Mod opens `RecoveryRequired` whenever the scope holds a program with a dispatched-but-unsettled node,
    // and `ShouldComposeBodyProgramController` accepts only `Empty|Opened` (ModEntry.cs:2834). Without this flag the
    // tool reports the journal as "not scoped, not managed by this transaction" (its backup marker records
    // `path: null, existed: null`), so a leftover program survives every run and every `program_submit` is refused with
    // `body_program_journal_unavailable`. Measured 2026-10-18: the real scope journal still held `farm_day5_b` from a
    // killed run while this very launcher's runs were refused - and the flag was simply never passed.
    "--stardew-save-root",
    path.join(process.env.APPDATA ?? "", "StardewValley", "Saves"),
    // NOTE: the config-load lifecycle flag (`--sleep-lifecycle-evidence`, i.e. `SleepLifecycle.Enable`) is
    // deliberately NOT passed here - and that costs the run nothing, because it is not what lets a night be
    // advanced.
    //
    // Passing it would arm `ModEntry.TryArmSleepLifecycle` at config load, BEFORE the bridge exists: the lifecycle
    // then sits in `AwaitingEligibility`, reporting `time_paused` and `bridge session unavailable`, while the Mod
    // never opens the pipe. The launcher dies at `stardew_pipe_not_listening:gamebuddy-stardew` and the companion
    // never gets to act. Measured 2026-10-17 on run g8, in the SMAPI log: `sleep lifecycle started` at load time,
    // the multi-day and play-session givens armed, then `not_home` / `time_paused` forever and no bridge attach.
    //
    // A night IS advanceable anyway, because `advance_day` owns its own lifecycle on demand rather than borrowing
    // an armed one: `RequestLocalAdvanceDay` starts it itself
    // (farmhandexecutioncontroller.lifecycleactions.cs:103-107, `SleepAndAdvanceDayLifecycle.TryStart` +
    // `new ActiveDayAdvance(...)`) and `UpdateActiveDayAdvance()` drives it to its receipt from the ordinary
    // game-thread update. Arming the flag as well would be actively wrong: the file lane and the wire action would
    // then compete for the same actor, and the dispatched night would bounce off `body_owned`
    // (`ModConfig.cs:66-68`). So leaving it off is what keeps runs attachable AND nights reachable.
  ]);
  console.log(`fixture prepared (action=${action}, attempt ${attempt})`);
};
for (let attempt = 1; ; attempt += 1) {
  try {
    prepareAttempt(attempt);
    break;
  } catch (error) {
    const message = String((error.stdout ?? "") + (error.stderr ?? "") + (error.message ?? ""));
    if (attempt >= 6 || !CONTENTION.test(message)) throw error;
    console.log(`[wait] prepare contention (attempt ${attempt}); re-entering the free-fixture wait`);
    await sleep(30_000);
    await waitForFreeFixture();
  }
}

let exitCode = null;
const myOwnerId = currentOwnerId();
if (myOwnerId === null) throw new Error("fixture transaction was not established by prepare");
console.log("fixture owned by this run:", myOwnerId);

// A takeover invalidates everything this run would report, so the run is stopped as soon
// as the root stops being ours rather than allowed to finish and produce an artifact
// that looks like a companion failure but is an environment failure.
let takenOver = false;
takeoverWatch = setInterval(() => {
  if (takenOver) return;
  const owner = currentOwnerId();
  if (owner === myOwnerId) return;
  takenOver = true;
  console.error(
    `[abort] fixture transaction taken over by ${owner ?? "a run that removed the lock"} — this session is no longer valid`,
  );
  for (const pid of liveGameProcesses()) {
    // Exact PID, and only the one already-exited status is tolerated. A broad catch here swallowed the failure
    // this whole step exists to prevent.
    killProcessTree(pid);
  }
}, 5_000);
const launchedAtMs = Date.now();
childSettled = new Promise((resolve) => {
  const child = spawn(node, ["tools/_ladder-live-orchestrator.mjs"], {
    cwd: repo,
    // The orchestrator's only job is to launch SMAPI, and SMAPI's entry point needs an
    // inherited console (`Console.Title` throws without one). Giving the orchestrator
    // new pipes would hand SMAPI a pipe where it expects a console, so stdout and
    // stderr are inherited too and the orchestrator's own diagnostics go to the
    // terminal. That is deliberate: this is an interactive launcher, and its
    // recoverable detail is also written to the runner log file.
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      GAMEBUDDY_STARDEW_GAME_DIR: gameDir,
      GAMEBUDDY_STARDEW_MODS_DIR: modsPath,
      GAMEBUDDY_STARDEW_CONFIG: path.join(modsPath, STARDEW_MOD_FOLDER, "config.json"),
      GAMEBUDDY_AGENT_SCENARIO: scenario,
      ...(LEGACY_LADDER === null ? {} : { GAMEBUDDY_AGENT_LADDER: LEGACY_LADDER }),
      GAMEBUDDY_RUNTIME_ROOT: process.env.GAMEBUDDY_RUNTIME_ROOT ?? path.join(process.env.LOCALAPPDATA, "GameBuddy"),
      GAMEBUDDY_RESULT_FILE: resultPath,
      // Where the fixture archives the body-program journal before restore deletes it. The capture directory is
      // the run's own, so an evidence copy can never land in a guessed place - and a run that ends before the
      // bundle exists simply records `archived: false, reason: no_bundle_path`.
      GAMEBUDDY_EVIDENCE_DIR: path.dirname(resultPath),
      // The slot this run replayed from, published so a failure dump can say where to return to. Without it the
      // repro plan has no slot to name and the bundle contract refuses it (measured 2026-10-16).
      GAMEBUDDY_DAY_START_SLOT: saveName,
      GAMEBUDDY_LADDER_LIVE_LOG: logPath,
      // Both names: the orchestrator uses LADDER_WINDOW_MODE for the game child, and the RUNNER records the
      // window mode it ran under from GAMEBUDDY_WINDOW_MODE. Setting only the former made a hidden run describe
      // itself as `visible` in its own evidence bundle (which the contract then refused, correctly).
      GAMEBUDDY_LADDER_WINDOW_MODE: windowMode,
      GAMEBUDDY_WINDOW_MODE: windowMode,
      GAMEBUDDY_PROCESS_RECLAMATION_FILE: processReclamationPath,
    },
  });
  // stdio is inherited now (the orchestrator and SMAPI need a real console), so there
  // are no pipes to collect. The orchestrator writes its own diagnostics to the
  // terminal and to its runner log; nothing here fabricates a stdout artefact from a
  // stream it does not own.
  const stdout = "";
  child.on("close", (code) => {
    exitCode = code;
    clearInterval(takeoverWatch);
    fs.writeFileSync(path.join(repo, "tools", `_${scenario}${suffix}-stdout.json`), stdout);
    if (takenOver) {
      fs.writeFileSync(
        path.join(repo, "tools", `_${scenario}${suffix}-INVALID.txt`),
        "Another lane took over the fixture transaction mid-run; this run's result must not be used.\n",
      );
    }
    resolve();
  });
});
// The child's own completion. A signal does not wait here: the trap's teardown runs concurrently, gives the runner its
// settle window, and then exits the process - so this await is simply where an ORDINARY run continues.
await childSettled;
console.log("live runner exit:", exitCode, takenOver ? "(INVALID: fixture taken over)" : "");
// The child's own exit code IS this process's exit code. It was captured above and used only for a console line, so a
// launcher whose runner ended in failure still exited 0 - and whoever invoked the ladder read that as a pass.
process.exitCode = exitCode ?? 1;
// The second half of the stale-bundle rule: a bundle written before this launch is not this attempt's answer, whatever
// it says, and it must not receive this attempt's teardown account either.
const freshness = judgeResultFreshness({ resultPath, launchedAtMs });
if (takenOver) {
  console.log("result file (if any) is marked invalid next to it; not restoring someone else's transaction");
  process.exitCode = 1;
  throw new Error("fixture_taken_over_mid_run");
}

/** The orchestrator's own reading of the game it launched, or a null rather than a fabricated zero. */
function readProcessReclamation() {
  try {
    return JSON.parse(fs.readFileSync(processReclamationPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Complete the run's reclamation account with the two steps only this process can measure: the game tree the
 * orchestrator launched and reaped, and the fixture transaction this launcher holds.
 *
 * WHY here and not in the runner: the runner has already exited - having written its own account of its unwind - before
 * either of these happens, so a bundle that claimed them would be claiming a fact about the future. Measured 2026-11-09
 * (`round40`): the run reaped its game and released its transaction, and its artifact published `steps: []`, because the
 * only process that knew those facts never wrote them down.
 *
 * A step this account owes and never measured is named, and makes the launch exit non-zero: an artifact an auditor reads
 * must not be able to lose its teardown account silently, which is the defect this closes.
 */
function stampReclamationAccount(fixtureRestore) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch {
    console.error(
      "RECLAMATION_INCOMPLETE",
      JSON.stringify({ reasonCode: "run_reclamation_not_stamped:no_result_artifact" }),
    );
    return null;
  }
  const runDir = typeof document?.bundle?.runDir === "string" ? document.bundle.runDir : null;
  const game = readProcessReclamation();
  const stamped = stampReclamation({
    paths: [resultPath, runDir === null ? null : path.join(runDir, EVIDENCE_BUNDLE_FILES.manifest)],
    steps: launcherReclamationSteps({
      game,
      // Read AFTER the fixture is released: this is the zero-survivor assertion as much as it is a field, and a game this
      // run started that is still alive is the run's ending rather than a line in a list of problems.
      survivors: liveGameProcesses(),
      fixtureRestore,
    }),
    exitReason: reclamationExitReason(game),
  });
  const missing = missingReclamationSteps(stamped.record);
  console.log(
    "RECLAMATION",
    JSON.stringify({
      state: stamped.record?.state ?? null,
      game: game === null ? "unobserved" : { pid: game.pid ?? null, closeOutcome: game.closeOutcome ?? null },
      steps: (stamped.record?.steps ?? []).map((entry) => `${entry.step}:${entry.state}`),
      missing,
    }),
  );
  if (missing.length > 0) {
    console.error(
      "RECLAMATION_INCOMPLETE",
      JSON.stringify({
        reasonCode: `run_reclamation_step_missing:${missing.join(",")}`,
        state: stamped.record?.state ?? null,
      }),
    );
    process.exitCode = 1;
  }
  return stamped.record;
}

// The restore is measured BEFORE the account is written: a restore that refused is a fact the artifact owes, and throwing
// first would lose the account of everything else that did happen.
const fixtureRestore = { ok: true, error: null };
try {
  restoreFixtureTransaction();
} catch (error) {
  fixtureRestore.ok = false;
  fixtureRestore.error = String(error?.message ?? error).slice(0, 300);
}
// A stale bundle is not this attempt's artifact: stamping it would write this launch's teardown account into another
// run's record, so the account is refused by name instead.
if (freshness.state === "stale") {
  console.error(
    "RECLAMATION_INCOMPLETE",
    JSON.stringify({ reasonCode: "run_reclamation_not_stamped:stale_result_precedes_launch" }),
  );
} else {
  stampReclamationAccount(fixtureRestore);
}
if (!fixtureRestore.ok) throw new Error(fixtureRestore.error);

if (freshness.state === "stale") {
  console.log(freshness.reading);
  process.exitCode = 1;
} else if (freshness.state === "fresh") {
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  console.log(
    "RESULT",
    JSON.stringify({
      state: result.state,
      scenario: result.scenario ?? scenario,
      configuredFixtureScenario: result.configuredFixtureScenario ?? null,
      attempted: result.attemptedActionIds,
      succeeded: result.succeededActionIds,
      audit: result.capabilityAudit
        ? {
            attemptedCount: result.capabilityAudit.attemptedCount,
            succeededCount: result.capabilityAudit.succeededCount,
            advertisedCount: result.capabilityAudit.advertisedCount,
            advertisedAxisUsable: result.capabilityAudit.advertisedAxisUsable,
            blocked: (result.capabilityAudit.blockedBySystem ?? []).map((entry) => entry.actionId),
            unresolved: result.capabilityAudit.unresolved,
          }
        : null,
    }),
  );
  console.log("result:", resultPath);
} else {
  console.log("no result file was written — the runner failed before it could report");
  process.exitCode = 1;
}

import { fileURLToPath } from "node:url";
