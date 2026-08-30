import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runActionProject } from "../src/project-adapter.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageFile = path.join(projectDirectory, "package.json");
const manifest = Object.freeze({ gameId: "stardew", evidenceRoot: path.join(projectDirectory, "artifacts", "action-runs") });
const action = Object.freeze({ actionId: "equip_tool" });
const schema = "gamebuddy-action-scenario-result/v1";

function expected(command, status, fields = {}) {
  return {
    schema,
    gameId: "stardew",
    status,
    actionId: "equip_tool",
    ...fields,
    ...(command.briefFile === undefined ? {} : { briefFile: command.briefFile }),
    ...(command.runId === undefined ? {} : { runId: command.runId }),
  };
}

test("returns neutral bounded reports for check and blocked preflight", async () => {
  const checked = await runActionProject({ manifest, invocation: { command: "check", ...action } });
  assert.deepEqual(checked, expected(action, "checked"));
  assert.ok(Object.isFrozen(checked));

  const preflight = await runActionProject({ manifest, invocation: { command: "preflight", ...action } });
  assert.deepEqual(preflight, expected(action, "preflight", { outcome: "blocked", reasonCode: "profile_path_not_absolute" }));
  assert.ok(Object.isFrozen(preflight));
});

test("converts evidence status to a neutral bounded report", async () => {
  const observation = Object.freeze({ availability: "available", status: "complete", verdict: "passed" });
  const report = await runActionProject({
    manifest,
    invocation: { command: "status", ...action },
    dependencies: { readLatestEvidence: async (input) => {
      assert.deepEqual(input, { root: manifest.evidenceRoot, gameId: "stardew", actionId: "equip_tool" });
      return observation;
    } },
  });
  assert.deepEqual(report, expected(action, "status", { outcome: "available" }));
});

test("rejects missing, unknown, and legacy inventory actions before dispatch", async () => {
  const calls = [];
  const dependencies = {
    readLatestEvidence: async () => { calls.push("status"); return { availability: "available" }; },
    inspectReleaseBundle: async () => { calls.push("preflight"); return {}; },
  };
  for (const invocation of [
    { command: "check" },
    { command: "preflight", profileFile: "C:\\profile.json" },
    { command: "status" },
    { command: "run-live", profileFile: "C:\\profile.json" },
    { command: "check", actionId: "enter_mine" },
    { command: "status", actionId: "enter_mine" },
    { command: "inventory" },
  ]) {
    await assert.rejects(runActionProject({ manifest, invocation, dependencies }), invocation.command === "inventory" ? /command_not_available/ : /action_not_available/);
  }
  assert.deepEqual(calls, []);
});

test("does not invoke live execution and returns a neutral blocked report", async () => {
  const report = await runActionProject({
    manifest,
    invocation: { command: "run-live", ...action, profileFile: "C:\\profile.json", runId: "ar1_test" },
    dependencies: { runLive: () => { throw new Error("live execution must not be called"); } },
  });
  assert.deepEqual(report, expected({ ...action, runId: "ar1_test" }, "blocked", { reasonCode: "live_not_exposed" }));
});

test("exposes canonical non-live package scripts and a profile-required preflight blocker", async () => {
  const scripts = JSON.parse(await readFile(packageFile, "utf8")).scripts;
  assert.match(scripts["action:check"], /game-action\.mjs check/);
  assert.match(scripts["action:check"], /--action equip_tool/);
  assert.match(scripts["action:status"], /game-action\.mjs status/);
  assert.match(scripts["action:status"], /--action equip_tool/);
  assert.equal(scripts["action:ci"], "node src/portfolio.mjs --ci");
  assert.equal(scripts["action:run-live"], undefined);
  assert.doesNotMatch(scripts["action:preflight"], /run-live/);
  assert.doesNotMatch(scripts["action:preflight"], /game-action\.mjs\s+preflight/);
});
