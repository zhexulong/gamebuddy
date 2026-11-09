import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  fixtureSetupFailureIn,
  isLiveRunWindowMode,
  launchStardewLiveRun,
  normalizeLiveRunWindowMode,
  openLaneLog,
  pipeConsoleInto,
  shouldCaptureWindowEvidence,
  windowModeEnvironment,
  windowModeToStyle,
} from "./stardew-live-run.mjs";

const execFileAsync = promisify(execFile);

const toolPath = fileURLToPath(new URL("./stardew-live-run.mjs", import.meta.url));
const source = readFileSync(toolPath, "utf8");

test("the launch reclaims its process TREE, by exact PID, and never by image name", () => {
  // `child.kill()` does not kill a tree on Windows: the game is a separate image the SMAPI child spawns, so
  // killing the child left `Stardew Valley.exe` running and the NEXT run found a busy fixture root with an
  // orphaned transaction (measured repeatedly 2026-10-16/17, and every one of those orphans was cleared by hand).
  assert.match(source, /import \{ killProcessTree \} from "\.\/windows-process-tree\.mjs";/u);
  assert.match(source, /outcome: killProcessTree\(launchedPid\)/u);
  // Both the failed-launch path and the normal teardown go through it, and neither kills only the child.
  // (The comment above `close()` names the old call on purpose, so the check is over CODE, not prose.)
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /child\.kill\(\)/u);
  assert.equal((code.match(/killProcessTree\(/gu) ?? []).length, 2, "the spawn-failure path and close()");
  // No image-name matching anywhere in this module: a stray game belonging to the player is not ours to kill.
  assert.doesNotMatch(code, /taskkill.*\/IM|\/IM.*taskkill/u);
});

test("windowModeToStyle maps all five window modes to their native style", () => {
  assert.equal(windowModeToStyle("hidden"), "Hidden");
  assert.equal(windowModeToStyle("background"), "Hidden");
  assert.equal(windowModeToStyle("minimized"), "Minimized");
  assert.equal(windowModeToStyle("visible"), "Normal");
  assert.equal(windowModeToStyle("foreground"), "Normal");
});

test("shouldCaptureWindowEvidence is true for visible/foreground/minimized and false for hidden/background", () => {
  assert.equal(shouldCaptureWindowEvidence("visible"), true);
  assert.equal(shouldCaptureWindowEvidence("foreground"), true);
  assert.equal(shouldCaptureWindowEvidence("minimized"), true);
  assert.equal(shouldCaptureWindowEvidence("hidden"), false);
  assert.equal(shouldCaptureWindowEvidence("background"), false);
});

test("windowModeEnvironment returns the frozen GAMEBUDDY_WINDOW_MODE envelope", () => {
  assert.deepEqual(windowModeEnvironment("hidden"), { GAMEBUDDY_WINDOW_MODE: "hidden" });
  assert.ok(Object.isFrozen(windowModeEnvironment("visible")));
});

test("isLiveRunWindowMode accepts only the five modes", () => {
  for (const mode of ["visible", "foreground", "minimized", "hidden", "background"]) {
    assert.equal(isLiveRunWindowMode(mode), true);
  }
  assert.equal(isLiveRunWindowMode("foregrounded"), false);
  assert.equal(isLiveRunWindowMode(undefined), false);
});

test("normalizeLiveRunWindowMode fails closed on invalid or missing input", () => {
  assert.equal(normalizeLiveRunWindowMode("background"), "background");
  assert.equal(normalizeLiveRunWindowMode("visible"), "visible");
  assert.throws(() => normalizeLiveRunWindowMode("foregrounded"), TypeError);
  assert.throws(() => normalizeLiveRunWindowMode(undefined), TypeError);
});

test("CLI --print-map emits the single-authority window-mode map", async () => {
  const { stdout } = await execFileAsync(process.execPath, [toolPath, "--print-map"]);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed.windowModes).sort(), [
    "background",
    "foreground",
    "hidden",
    "minimized",
    "visible",
  ]);
  assert.equal(parsed.windowModes.hidden.style, "Hidden");
  assert.equal(parsed.windowModes.hidden.captureEvidence, false);
  assert.equal(parsed.windowModes.visible.style, "Normal");
  assert.equal(parsed.windowModes.visible.captureEvidence, true);
});

test("CLI fails closed on invalid or missing window mode", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      toolPath,
      "--game-path",
      "C:\\x",
      "--mods-path",
      "C:\\y",
      "--window-mode",
      "weird",
    ]),
    /invalid_live_run_window_mode/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [toolPath, "--game-path", "C:\\x", "--mods-path", "C:\\y"]),
    /missing_window_mode|invalid_live_run_window_mode/,
  );
});

test("launchStardewLiveRun rejects invalid launch inputs before spawning", async () => {
  await assert.rejects(
    launchStardewLiveRun({ gamePath: "relative/x", modsPath: "C:\\y", windowMode: "hidden", pipeName: "p" }),
    /invalid_live_run_game_path/,
  );
  await assert.rejects(
    launchStardewLiveRun({ gamePath: "C:\\x", modsPath: "relative/y", windowMode: "hidden", pipeName: "p" }),
    /invalid_live_run_mods_path/,
  );
  await assert.rejects(
    launchStardewLiveRun({ gamePath: "C:\\x", modsPath: "C:\\y", windowMode: "hidden", pipeName: "bad name!" }),
    /invalid_live_run_pipe_name/,
  );
  await assert.rejects(
    launchStardewLiveRun({ gamePath: "C:\\x", modsPath: "C:\\y", windowMode: "fake", pipeName: "p" }),
    TypeError,
  );
  // A lane log is a path this lane owns, so a relative one is a caller bug: it would resolve against whatever cwd the
  // harness happens to have and land in another lane's tree.
  await assert.rejects(
    launchStardewLiveRun({
      gamePath: "C:\\x",
      modsPath: "C:\\y",
      windowMode: "hidden",
      pipeName: "p",
      logPath: "lane/smapi.log",
    }),
    /invalid_live_run_log_path/,
  );
});

test("a named lane log receives the console stream the drain would otherwise discard", async (t) => {
  // The lane log is not a copy of SMAPI's own file: SMAPI names that by PLAYER INDEX inside the game, so two lanes
  // cannot be told apart by it. What this module does is keep the bytes it must drain anyway, on the only path the
  // caller can attribute to its lane - driven here with a real child instead of a game process.
  const dir = mkdtempSync(join(tmpdir(), "gb-lane-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "nested", "smapi-console.log");
  const laneLog = openLaneLog(logPath);
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('mod line\\n'); process.stderr.write('stderr line\\n')"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  pipeConsoleInto(laneLog, { stdout: child.stdout, stderr: child.stderr });
  await new Promise((resolvePromise) => child.once("close", resolvePromise));
  await new Promise((resolvePromise) => laneLog.end(resolvePromise));
  const text = readFileSync(logPath, "utf8");
  assert.match(text, /mod line/u);
  assert.match(text, /stderr line/u);
  // And the no-log path still drains: an unread console pipe is what froze the game thread.
  assert.match(source, /if \(laneLog === null\) child\.stdout\?\.resume\(\);/u);
});

test("the Mod's arm-time refusal is read out of the log instead of waiting for a pipe that cannot open", async () => {
  // Measured 2026-11-09: a fixture Given severed the farm's door→field route, the Mod said so by name at second 17,
  // and the launcher reported `stardew_pipe_not_listening` two minutes later - naming a component that was fine.
  const line =
    "[14:35:31 ERROR GameBuddy] GameBuddy native-local-player fixture setup failed: " +
    "scenario=native_multi_day_play_session_v1; error=fixture_native_local_multi_day_home_unreachable";
  assert.equal(
    fixtureSetupFailureIn(line),
    "fixture setup failed: scenario=native_multi_day_play_session_v1; error=fixture_native_local_multi_day_home_unreachable",
    "the reason must survive verbatim, because it is the only thing that says which given was impossible",
  );
  // A healthy log is not a failure, and a log that mentions the phrase in prose is not one either: only the marker on
  // the Mod's own line counts.
  assert.equal(fixtureSetupFailureIn("[14:35:20 INFO  SMAPI] Loading mods..."), null);
  assert.equal(fixtureSetupFailureIn(""), null);
});
