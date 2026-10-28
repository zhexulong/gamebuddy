#!/usr/bin/env node
/**
 * One iteration of the multi-day live run, from a clean slate to a result file.
 *
 * This is the loop `tools/live-run/ITERATION-LOOP.md` describes, in the only form that survives a handoff: executable.
 * Everything here was learned by losing runs to it - see the header comments on each step for which failure it prevents.
 *
 *   node tools/live-run/multiday-iterate.mjs            # build, clean, run, report
 *   node tools/live-run/multiday-iterate.mjs --no-build # run only (when nothing under host/src or integrations changed)
 *   node tools/live-run/multiday-iterate.mjs --label x  # name the run
 *
 * It deliberately does NOT interpret the result. Reading `result.json` is judgement, and judgement is the step that must
 * not be automated: an IDEAL run reports `blocked` when the companion simply chose not to sleep, and a script cannot tell
 * that from a defect.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--no-build");
const labelIndex = args.indexOf("--label");
const label = labelIndex >= 0 ? args[labelIndex + 1] : "loop";

/** The fixture save both the fixture profile and the launcher name. One value, because a mismatch reads as no_launch. */
const SAVE = "GameBuddyFixtureStable2_451844707";
const SCENARIO = "multiday_routine";
const ACTION = "play_session_multi_day";

const GAME_PATH = process.env.GAMEBUDDY_STARDEW_GAME_DIR ?? "D:/Steam/steamapps/common/Stardew Valley";
const GAME_DIR = process.env.GAMEBUDDY_STARDEW_GAME_DIR ?? "D:/Steam/steamapps/common/Stardew Valley";
const RUNTIME_ROOT = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "GameBuddy") : null;

function run(command, argv, { allowFailure = false } = {}) {
  process.stdout.write(`\n$ ${command} ${argv.join(" ")}\n`);
  if (dryRun) return { status: 0, stdout: "", stderr: "" };
  const result = spawnSync(command, argv, { cwd: repo, encoding: "utf8", shell: false });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (out.trim()) process.stdout.write(`${out.trim().split("\n").slice(-12).join("\n")}\n`);
  if (result.status !== 0 && !allowFailure) {
    console.error(`\nfailed: ${command} exited ${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
  return result;
}

// 1. BUILD - both of them. The game loads `bin/Release`, the runner imports `host/dist-test`; a stale dist-test refuses
//    with `live_run_artifact_stale`, which is correct and reads like a harness bug until you have met it.
if (!skipBuild) {
  run("dotnet", ["build", "integrations/stardew", "-c", "Release", `-p:GamePath=${GAME_PATH}`]);
  run("node", ["host/scripts/build-test-artifact.mjs"]);
}

/**
 * Copy the three assemblies and the manifest the Mod loads into the game's Mods folder.
 *
 * The game holds the DLL open while it runs, so this only works after step 2 has stopped it - and a copy that silently
 * keeps the old build is the worst failure mode here: every following run tests yesterday's code and reports it as
 * today's result.
 */
function deployMod() {
  const build = path.join(repo, "integrations/stardew/bin/Release/net6.0");
  const target = path.join(GAME_DIR, "Mods", "GameBuddy");
  if (!fs.existsSync(build)) {
    console.error(`build output missing: ${build}`);
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    console.error(`mod folder missing: ${target}`);
    process.exit(1);
  }
  const names = ["GameBuddy.Stardew.dll", "GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json"];
  const copied = [];
  for (const name of names) {
    const from = path.join(build, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(target, name));
    copied.push(`${name} -> ${fs.statSync(path.join(target, name)).mtime.toISOString()}`);
  }
  console.log(`deployed ${String(copied.length)} file(s)`);
  for (const entry of copied) console.log(`  ${entry}`);
}

// 2. STOP the previous game, then deploy the Mod. A live game holds the DLL open, so the copy silently keeps the old build.
if (process.platform === "win32") {
  if (!dryRun) {
    spawnSync("taskkill", ["/IM", "StardewModdingAPI.exe", "/F"], { stdio: "ignore" });
    spawnSync("taskkill", ["/IM", "Stardew Valley.exe", "/F"], { stdio: "ignore" });
  }
  if (!dryRun) deployMod();
} else {
  console.log("\nskip: deploy-mod is Windows-only in this repo");
}

// 3. CLEAN the debris a killed run leaves. Each of these reports as a different, plausible failure:
//    a fixture lock (a directory) -> no_launch; orphaned backups -> restore refused;
//    a cumulative recovery journal -> every admission waits for ever; a leftover work save -> prepare refused.
if (!dryRun && RUNTIME_ROOT !== null) {
  const removed = [];

  const recovery = path.join(RUNTIME_ROOT, "stardew-recovery");
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.includes("recovery-journal")) {
        fs.rmSync(full, { force: true });
        removed.push(`journal ${path.relative(RUNTIME_ROOT, full)}`);
      }
    }
  };
  walk(recovery);

  const fixtures = path.join(RUNTIME_ROOT, "stardew-fixtures");
  if (fs.existsSync(fixtures)) {
    for (const name of fs.readdirSync(fixtures)) {
      // Remove the lock, any orphaned directory, AND the plain backup directory a run leaves behind.
      //
      // The backup is written by the fixture transaction and carries no "lock" or "orphaned" in its name, so the
      // previous condition kept it while deleting everything else. The next launch then found a backup with no lock,
      // refused to restore it (`native_local_fixture_restore_failed`), renamed it `orphaned-...` and slept 30
      // seconds before retrying - measured on every run of 2026-10-28. Cleaning the thing that causes the wait is
      // cheaper than waiting for it.
      if (!(name.includes(".lock") || name.includes("orphaned") || name.includes("fixture-backup"))) continue;
      fs.rmSync(path.join(fixtures, name), { recursive: true, force: true });
      removed.push(`fixture ${name}`);
    }
  }

  const saves = process.env.APPDATA ? path.join(process.env.APPDATA, "StardewValley", "Saves") : null;
  if (saves !== null && fs.existsSync(saves)) {
    for (const name of fs.readdirSync(saves)) {
      if (!name.startsWith(SAVE)) continue;
      fs.rmSync(path.join(saves, name), { recursive: true, force: true });
      removed.push(`work save ${name}`);
    }
  }

  console.log(`\ncleaned ${String(removed.length)} item(s)`);
  for (const item of removed.slice(0, 8)) console.log(`  ${item}`);
}

// 4. RUN. `MAGIC_CONTEXT_STORAGE_DIR` inherited from an operator shell makes the runtime open a store it does not own and
//    abort mid-turn; the launcher's own environment is the only one it should see.
if (!dryRun) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;

const env = { ...process.env, GAMEBUDDY_LADDER_WINDOW_MODE: "foreground" };
if (!dryRun) {
  process.stdout.write(`\n$ node tools/live-run/game/launch-ladder-live.mjs --scenario ${SCENARIO} --label ${label}\n`);
  const launched = spawnSync(
    "node",
    [
      "tools/live-run/game/launch-ladder-live.mjs",
      "--scenario",
      SCENARIO,
      "--action",
      ACTION,
      "--save",
      SAVE,
      "--template",
      SAVE,
      "--label",
      label,
    ],
    { cwd: repo, env, encoding: "utf8", stdio: "inherit" },
  );
  process.stdout.write(`\nlauncher exit: ${String(launched.status)}\n`);
}

// 5. REPORT what the run says, and stop. Interpreting it is the reader's job.
const result = path.join(repo, "tools", `_${SCENARIO}-${label}.result.json`);
if (!fs.existsSync(result)) {
  console.log(`\nno result at ${path.relative(repo, result)} - the launcher did not finish`);
  process.exit(0);
}
const parsed = JSON.parse(fs.readFileSync(result, "utf8"));
const multiday = parsed.multiday ?? {};
const outcomes = parsed.programOutcomes ?? [];
console.log("\n==== result ====");
console.log(`state        ${String(parsed.state)}`);
console.log(`reason       ${String(multiday.reasonCode ?? "(none)")}`);
console.log(`crossings    ${String(multiday.crossings ?? "(none)")} of 2`);
console.log(`submissions  ${String((parsed.programSubmissions ?? []).length)}`);
console.log(
  `observed     ${String(outcomes.filter((entry) => entry.observed === true).length)} of ${String(outcomes.length)}`,
);
console.log("\nRead the three answers before touching code: what it tried, where it stopped, what it cost.");
console.log("tools/live-run/ITERATION-LOOP.md says what a pass looks like.");
