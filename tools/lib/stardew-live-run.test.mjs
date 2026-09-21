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
const toolPath = fileURLToPath(new URL("./stardew-live-run.mjs", import.meta.url));

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
  assert.deepEqual(Object.keys(parsed.windowModes).sort(), ["background", "foreground", "hidden", "minimized", "visible"]);
  assert.equal(parsed.windowModes.hidden.style, "Hidden");
  assert.equal(parsed.windowModes.hidden.captureEvidence, false);
  assert.equal(parsed.windowModes.visible.style, "Normal");
  assert.equal(parsed.windowModes.visible.captureEvidence, true);
});

test("CLI fails closed on invalid or missing window mode", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [toolPath, "--game-path", "C:\\x", "--mods-path", "C:\\y", "--window-mode", "weird"]),
    /invalid_live_run_window_mode/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [toolPath, "--game-path", "C:\\x", "--mods-path", "C:\\y"]),
    /missing_window_mode|invalid_live_run_window_mode/,
  );
});

test("launchStardewLiveRun rejects invalid launch inputs before spawning", async () => {
  await assert.rejects(launchStardewLiveRun({ gamePath: "relative/x", modsPath: "C:\\y", windowMode: "hidden", pipeName: "p" }), /invalid_live_run_game_path/);
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