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
import { announceStardewFixtureRoots, resolveStardewFixtureRoots } from "../../lib/stardew-fixture-roots.mjs";
import { normalizeLiveRunWindowMode } from "../../lib/stardew-live-run.mjs";

const repo = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

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
const gameDir = option("game", process.env.GAMEBUDDY_STARDEW_GAME_DIR ?? "D:/Steam/steamapps/common/Stardew Valley");
const modsPath = option("mods", process.env.GAMEBUDDY_STARDEW_MODS_DIR ?? path.join(gameDir, "Mods"));
// Both fixture roots come from the single shared resolver
// (tools/lib/stardew-fixture-roots.mjs). The defaults are the historical paths;
// GAMEBUDDY_STARDEW_PROFILE_ROOT / GAMEBUDDY_STARDEW_FIXTURE_ROOT point one
// concurrent lane at private roots, and an explicit --root still wins. The
// resolved roots are printed once so an operator can see which root this run
// holds before it takes the fixture transaction.
const fixtureRoots = resolveStardewFixtureRoots({ fixturesRoot: option("root", null) });
const fixtureRoot = fixtureRoots.fixturesRoot;
announceStardewFixtureRoots(fixtureRoots);
const releaseDir = option("release", path.join(repo, "integrations", "stardew", "bin", "Release", "net6.0"));
const saveName = option("save", "GameBuddyFixtureNavigation_447088730");
const backupName = option("backup", `native-local-${action.replaceAll("_", "-")}-fixture-backup`);
const templateName = option("template", saveName);
const suffix = label.length > 0 ? `-${label}` : "";
const resultPath = path.join(repo, "tools", `_${scenario}${suffix}.result.json`);
const logPath = path.join(repo, "tools", `_${scenario}${suffix}-live-runner.log`);
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

const binding = fs
  .readdirSync(fixtureRoot)
  .filter((name) => name.endsWith(".native-local-binding.json"))
  .map((name) => path.join(fixtureRoot, name))
  .find((file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).observedSaveSlot === saveName;
    } catch {
      return false;
    }
  });
if (!binding) throw new Error(`no native-local binding for save ${saveName}`);

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

await waitForFreeFixture();
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
    // NOTE: the cross-day lifecycle is deliberately NOT armed here.
    //
    // Arming it (`--sleep-lifecycle-evidence`, i.e. `SleepLifecycle.Enable`) at config load starts it BEFORE the
    // bridge exists, and it then sits in `AwaitingEligibility`, reporting `time_paused` and
    // `bridge session unavailable`, while the Mod never opens the pipe: the launcher dies at
    // `stardew_pipe_not_listening:gamebuddy-stardew` and the companion never gets to act. Measured 2026-10-17 on
    // run g8, in the SMAPI log: `sleep lifecycle started` at load time, the multi-day and play-session givens armed,
    // then `not_home` / `time_paused` forever and no bridge attach.
    //
    // So a night still cannot be advanced by this launcher, and that is the NEXT change: the lifecycle has to be
    // armed after the bridge (or created on demand when `advance_day` arrives) rather than at config load. Leaving
    // it off keeps runs attachable and playable in the meantime, which is what the other findings need.
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
const takeoverWatch = setInterval(() => {
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
await new Promise((resolve) => {
  const child = spawn(node, ["tools/_ladder-live-orchestrator.mjs"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GAMEBUDDY_STARDEW_GAME_DIR: gameDir,
      GAMEBUDDY_STARDEW_MODS_DIR: modsPath,
      GAMEBUDDY_STARDEW_CONFIG: path.join(modsPath, "GameBuddy.Stardew", "config.json"),
      GAMEBUDDY_AGENT_SCENARIO: scenario,
      ...(LEGACY_LADDER === null ? {} : { GAMEBUDDY_AGENT_LADDER: LEGACY_LADDER }),
      GAMEBUDDY_RUNTIME_ROOT: process.env.GAMEBUDDY_RUNTIME_ROOT ?? path.join(process.env.LOCALAPPDATA, "GameBuddy"),
      GAMEBUDDY_RESULT_FILE: resultPath,
      // The slot this run replayed from, published so a failure dump can say where to return to. Without it the
      // repro plan has no slot to name and the bundle contract refuses it (measured 2026-10-16).
      GAMEBUDDY_DAY_START_SLOT: saveName,
      GAMEBUDDY_LADDER_LIVE_LOG: logPath,
      // Both names: the orchestrator uses LADDER_WINDOW_MODE for the game child, and the RUNNER records the
      // window mode it ran under from GAMEBUDDY_WINDOW_MODE. Setting only the former made a hidden run describe
      // itself as `visible` in its own evidence bundle (which the contract then refused, correctly).
      GAMEBUDDY_LADDER_WINDOW_MODE: windowMode,
      GAMEBUDDY_WINDOW_MODE: windowMode,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
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
console.log("live runner exit:", exitCode, takenOver ? "(INVALID: fixture taken over)" : "");
if (takenOver) {
  console.log("result file (if any) is marked invalid next to it; not restoring someone else's transaction");
  process.exitCode = 1;
  throw new Error("fixture_taken_over_mid_run");
}

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
console.log("fixture transaction restored");

if (fs.existsSync(resultPath)) {
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
