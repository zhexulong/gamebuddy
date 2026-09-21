import assert from "node:assert/strict";
import test from "node:test";

import { isLiveRunWindowMode, normalizeLiveRunWindowMode, shouldCaptureWindowEvidence, windowModeEnvironment, windowModeToStyle } from "./window-mode.js";

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

test("windowModeEnvironment returns a frozen object carrying the exact mode for each of the five modes", () => {
  for (const mode of ["visible", "foreground", "minimized", "hidden", "background"] as const) {
    const environment = windowModeEnvironment(mode);
    assert.ok(Object.isFrozen(environment));
    assert.equal(environment.GAMEBUDDY_WINDOW_MODE, mode);
    assert.deepEqual(environment, { GAMEBUDDY_WINDOW_MODE: mode });
  }
});

test("isLiveRunWindowMode accepts only the five modes", () => {
  for (const mode of ["visible", "foreground", "minimized", "hidden", "background"] as const) {
    assert.equal(isLiveRunWindowMode(mode), true);
  }
  assert.equal(isLiveRunWindowMode("foregrounded"), false);
  assert.equal(isLiveRunWindowMode(""), false);
  assert.equal(isLiveRunWindowMode(undefined), false);
  assert.equal(isLiveRunWindowMode(null), false);
  assert.equal(isLiveRunWindowMode(42), false);
  assert.equal(isLiveRunWindowMode({ hidden: true }), false);
});

test("normalizeLiveRunWindowMode fails closed on invalid or missing input", () => {
  assert.equal(normalizeLiveRunWindowMode("hidden"), "hidden");
  assert.equal(normalizeLiveRunWindowMode("background"), "background");
  assert.equal(normalizeLiveRunWindowMode("visible"), "visible");
  assert.equal(normalizeLiveRunWindowMode("foreground"), "foreground");
  assert.equal(normalizeLiveRunWindowMode("minimized"), "minimized");
  assert.throws(() => normalizeLiveRunWindowMode("foregrounded"), TypeError);
  assert.throws(() => normalizeLiveRunWindowMode(""), TypeError);
  assert.throws(() => normalizeLiveRunWindowMode(undefined), TypeError);
});