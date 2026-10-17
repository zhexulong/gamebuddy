import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  isLiveRunWindowMode,
  launchStardewLiveRun,
  normalizeLiveRunWindowMode,
  shouldCaptureWindowEvidence,
  windowModeEnvironment,
  windowModeToStyle,
} from "./stardew-live-run.mjs";

const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
});
