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
 *   node tools/live-run/game/launch-ladder-live.mjs --ladder 6 --action play_session [--label c]
 *                                                    [--save <Slot>] [--backup <name>]
 *
 * Every run writes its own result/log pair (`tools/_ladder<ladder>[-<label>]…`), so a
 * run somebody is already reading is never overwritten by the next attempt.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { announceStardewFixtureRoots, resolveStardewFixtureRoots } from "../../lib/stardew-fixture-roots.mjs";

const repo = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const ladder = option("ladder", "6");
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
const resultPath = path.join(repo, "tools", `_ladder${ladder}${suffix}.result.json`);
const logPath = path.join(repo, "tools", `_ladder${ladder}${suffix}-live-runner.log`);
const lockDir = path.join(fixtureRoot, ".stardew-native-local-player-fixture.lock");

const node = process.execPath;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (argv, env) =>
  execFileSync(node, argv, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });

function liveGameProcesses() {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-Process -Name 'StardewModdingAPI','Stardew Valley' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"],
      { encoding: "utf8", timeout: 60_000 },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

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
        console.log(`[recover] orphaned fixture transaction renamed aside: ${path.basename(aside)} (idle ${Math.round(idleMs / 1000)}s)`);
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

execFileSync(
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ["-NoProfile", "-File", path.join(repo, "tools", "prepare-stardew-action-fixture.ps1"), "-FixtureRoot", fixtureRoot, "-TemplateName", templateName, "-SaveName", saveName],
  { cwd: repo, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
);
console.log("working save restored from the native template");

run([
  "tools/prepare-stardew-native-local-player-fixture.mjs",
  "--root", fixtureRoot,
  "--mods-path", modsPath,
  "--release-dir", releaseDir,
  "--save-name", saveName,
  "--backup-name", backupName,
  "--binding-path", binding,
  "--action", action,
]);
console.log(`fixture prepared (action=${action})`);

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
  console.error(`[abort] fixture transaction taken over by ${owner ?? "a run that removed the lock"} — this session is no longer valid`);
  for (const pid of liveGameProcesses()) {
    try { execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { encoding: "utf8", timeout: 60_000 }); } catch {}
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
      GAMEBUDDY_AGENT_LADDER: ladder,
      GAMEBUDDY_RUNTIME_ROOT: process.env.GAMEBUDDY_RUNTIME_ROOT ?? path.join(process.env.LOCALAPPDATA, "GameBuddy"),
      GAMEBUDDY_RESULT_FILE: resultPath,
      GAMEBUDDY_LADDER_LIVE_LOG: logPath,
      GAMEBUDDY_LADDER_WINDOW_MODE: process.env.GAMEBUDDY_LADDER_WINDOW_MODE ?? "hidden",
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { process.stderr.write(chunk); });
  child.on("close", (code) => {
    exitCode = code;
    clearInterval(takeoverWatch);
    fs.writeFileSync(path.join(repo, "tools", `_ladder${ladder}${suffix}-stdout.json`), stdout);
    if (takenOver) {
      fs.writeFileSync(path.join(repo, "tools", `_ladder${ladder}${suffix}-INVALID.txt`),
        "Another lane took over the fixture transaction mid-run; this run's result must not be used.\n");
    }
    resolve();
  });
});
console.log("ladder runner exit:", exitCode, takenOver ? "(INVALID: fixture taken over)" : "");
if (takenOver) {
  console.log("result file (if any) is marked invalid next to it; not restoring someone else's transaction");
  process.exitCode = 1;
  throw new Error("fixture_taken_over_mid_run");
}

run([
  "tools/restore-stardew-native-local-player-fixture.mjs",
  "--root", fixtureRoot,
  "--mods-path", modsPath,
  "--release-dir", releaseDir,
  "--backup-name", backupName,
]);
console.log("fixture transaction restored");

if (!fs.existsSync(resultPath)) {
  console.log("no result file was written — the runner failed before it could report");
  process.exitCode = 1;
} else {
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  console.log("RESULT", JSON.stringify({
    state: result.state,
    ladder: result.ladder,
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
  }));
  console.log("result:", resultPath);
}

import { fileURLToPath } from "node:url";
