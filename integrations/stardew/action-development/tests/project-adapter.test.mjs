import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProjectAdapter } from "../src/project-adapter-core.mjs";
import { runActionProject as runProductionActionProject } from "../src/project-adapter.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageFile = path.join(projectDirectory, "package.json");
const manifest = Object.freeze({
  gameId: "stardew",
  portfolioFile: path.join(projectDirectory, "portfolio.json"),
  evidenceRoot: path.join(projectDirectory, "artifacts", "action-runs"),
});
const action = Object.freeze({ actionId: "equip_tool" });
const schema = "gamebuddy-action-scenario-result/v1";

async function runActionProject(input) {
  const registrations = input.dependencies?.__testOnlyActionRegistrations;
  if (registrations === undefined) return runProductionActionProject(input);
  const dependencies = Object.freeze({ ...input.dependencies, __testOnlyActionRegistrations: undefined });
  return await createProjectAdapter(registrations).runActionProject({ ...input, dependencies });
}

function syntheticRegistration(overrides = {}) {
  const actionId = overrides.actionId ?? "inspect_weather";
  return Object.freeze({
    actionId,
    check: async ({ dependencies }) => { dependencies.calls.push("check"); return { gameId: "stardew", actionId, verified: true }; },
    preflight: async ({ dependencies }) => { dependencies.calls.push("preflight"); return { gameId: "stardew", actionId, status: "preflight", state: "BLOCKED", ready: false, reasons: ["synthetic_blocked"] }; },
    status: async ({ dependencies }) => { dependencies.calls.push("status"); return { gameId: "stardew", actionId, status: "evidence", observation: { availability: "unavailable", reason: "synthetic_unavailable" } }; },
    runLive: async ({ invocation, dependencies }) => { dependencies.calls.push("run-live"); return { gameId: "stardew", actionId, status: "live", state: "PASSED", runId: invocation.runId, verification: { receipt: true, postcondition: true, cleanup: true } }; },
    verifyContract: async ({ actionId: id }) => ({ gameId: "stardew", actionId: id, verified: true }),
    verifyReceiptEvidencePostcondition: async ({ actionId: id, invocation }) => ({ gameId: "stardew", actionId: id, runId: invocation.runId, verified: true }),
    verifyCleanup: async ({ actionId: id, invocation }) => ({ gameId: "stardew", actionId: id, runId: invocation.runId, complete: true }),
    ...overrides,
  });
}

function expected(command, status, fields = {}) {
  return {
    schema,
    gameId: "stardew",
    status,
    ...(command.actionId === undefined ? {} : { actionId: command.actionId }),
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

test("reports package-level portfolio status without inferring an action", async () => {
  const report = await runActionProject({
    manifest,
    invocation: { command: "status" },
    dependencies: { readLatestEvidence: async () => { throw new Error("project status must not read action evidence"); } },
  });
  assert.deepEqual(report, expected({ command: "status" }, "observed", {
    outcome: "portfolio_observed",
    reasonCode: "none",
    claimScope: "project",
    evidenceRoot: manifest.evidenceRoot,
  }));
  assert.equal(Object.hasOwn(report, "actionId"), false);
  assert.ok(Object.isFrozen(report));
});

test("reports portfolio_missing for a fixture without its portfolio", async () => {
  const report = await runActionProject({
    manifest: { ...manifest, portfolioFile: path.join(projectDirectory, "fixtures", "missing-portfolio.json") },
    invocation: { command: "status" },
    dependencies: { readLatestEvidence: async () => { throw new Error("project status must not infer action evidence"); } },
  });
  assert.deepEqual(report, expected({ command: "status" }, "blocked", {
    outcome: "portfolio_missing",
    reasonCode: "portfolio_missing",
  }));
  assert.equal(Object.hasOwn(report, "actionId"), false);
});

test("converts action evidence status to a neutral bounded report", async () => {
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

test("production adapter ignores caller-supplied action registrations and uses only its closure-owned registry", async () => {
  await assert.rejects(
    runProductionActionProject({
      manifest,
      invocation: { command: "check", actionId: "inspect_weather" },
      dependencies: { __testOnlyActionRegistrations: [syntheticRegistration()], calls: [] },
    }),
    /action_not_available/,
  );
});

test("rejects missing, unknown, and legacy inventory actions before dispatch", async () => {
  const calls = [];
  const dependencies = {
    __testOnlyActionRegistrations: [syntheticRegistration()],
    readLatestEvidence: async () => { calls.push("status"); return { availability: "available" }; },
    inspectReleaseBundle: async () => { calls.push("preflight"); return {}; },
    runLive: async () => { calls.push("run-live"); },
  };
  for (const invocation of [
    { command: "check" },
    { command: "preflight", profileFile: "C:\\profile.json" },
    { command: "run-live", profileFile: "C:\\profile.json" },
     { command: "check", actionId: "enter_mine" },
    { command: "status", actionId: "enter_mine" },
    { command: "inventory" },
  ]) {
    await assert.rejects(runActionProject({ manifest, invocation, dependencies }), invocation.command === "inventory" ? /command_not_available/ : /action_not_available/);
  }
  assert.deepEqual(calls, []);
});

test("dispatches run-live once and projects bounded success and blocked facts", async () => {
  const calls = [];
  const success = await runActionProject({
    manifest,
    invocation: { command: "run-live", ...action, profileFile: "C:\\profile.json", runId: "ar1_success" },
      dependencies: { __testOnlyActionRegistrations: [syntheticRegistration({ actionId: "equip_tool", runLive: async (input) => {
        calls.push(input);
        return { gameId: "stardew", actionId: "equip_tool", status: "live", state: "PASSED", runId: input.invocation.runId };
      } })] },
  });
  assert.deepEqual(success, expected({ ...action, runId: "ar1_success" }, "live", { outcome: "passed" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].invocation.profileFile, "C:\\profile.json");

  await assert.rejects(
    runActionProject({ manifest, invocation: { command: "run-live", ...action, profileFile: "C:\\profile.json" }, dependencies: { runLive: async () => { throw new Error("must not run"); } } }),
    /run_id_missing/,
  );

  const blocked = await runActionProject({
    manifest,
    invocation: { command: "run-live", ...action, profileFile: "C:\\profile.json", runId: "ar1_blocked" },
    dependencies: { __testOnlyActionRegistrations: [syntheticRegistration({ actionId: "equip_tool", runLive: async () => ({ gameId: "stardew", actionId: "equip_tool", status: "live", state: "BLOCKED", runId: "ar1_blocked", reasons: ["preflight_not_ready"] }) })] },
  });
  assert.deepEqual(blocked, expected({ ...action, runId: "ar1_blocked" }, "live", { outcome: "blocked", reasonCode: "preflight_not_ready" }));
});

test("rejects missing profile and mismatched live identity", async () => {
  let calls = 0;
  await assert.rejects(
    runActionProject({ manifest, invocation: { command: "run-live", ...action }, dependencies: { __testOnlyActionRegistrations: [syntheticRegistration({ actionId: "equip_tool", runLive: async () => { calls += 1; } })] } }),
    /profile_missing/,
  );
  assert.equal(calls, 0);
  for (const result of [
    { gameId: "other", actionId: "equip_tool", runId: "ar1_expected", state: "PASSED" },
    { gameId: "stardew", actionId: "other", runId: "ar1_expected", state: "PASSED" },
    { gameId: "stardew", actionId: "equip_tool", runId: "ar1_wrong", state: "PASSED" },
  ]) {
    await assert.rejects(
      runActionProject({
        manifest,
        invocation: { command: "run-live", ...action, profileFile: "C:\\profile.json", runId: "ar1_expected" },
        dependencies: { __testOnlyActionRegistrations: [syntheticRegistration({ actionId: "equip_tool", runLive: async () => result })] },
      }),
      /live_identity_mismatch/,
    );
  }
});

test("dispatches a second synthetic action through registration without adapter changes", async () => {
  const calls = [];
  const registration = syntheticRegistration();
  const checked = await runActionProject({
    manifest: { gameId: "stardew" },
    invocation: { command: "check", actionId: registration.actionId },
    dependencies: { __testOnlyActionRegistrations: [registration], calls },
  });
  assert.deepEqual(checked, expected({ actionId: registration.actionId }, "checked"));
  assert.deepEqual(calls, ["check"]);

  const preflight = await runActionProject({
    manifest: { gameId: "stardew" },
    invocation: { command: "preflight", actionId: registration.actionId, profileFile: "C:\\profile.json" },
    dependencies: { __testOnlyActionRegistrations: [registration], calls },
  });
  assert.deepEqual(preflight, expected({ actionId: registration.actionId }, "preflight", { outcome: "blocked", reasonCode: "synthetic_blocked" }));
  assert.deepEqual(calls, ["check", "preflight"]);
});

test("rejects a registration that omits any required verifier", async () => {
  const registration = syntheticRegistration({ verifyCleanup: undefined });
  await assert.rejects(
    () => runActionProject({
      manifest: { gameId: "stardew" },
      invocation: { command: "check", actionId: registration.actionId },
      dependencies: { __testOnlyActionRegistrations: [registration], calls: [] },
    }),
    /registration_.*verifier.*missing/,
  );
});

test("does not turn a generic passed live result into success", async () => {
  await assert.rejects(
    runActionProject({
      manifest,
      invocation: { command: "run-live", ...action, profileFile: "C:\\profile.json", runId: "ar1_generic_pass" },
      dependencies: { __testOnlyActionRegistrations: [syntheticRegistration({
        actionId: "equip_tool",
        runLive: async ({ invocation }) => ({ gameId: "stardew", actionId: "equip_tool", status: "live", state: "PASSED", runId: invocation.runId }),
        verifyReceiptEvidencePostcondition: async () => { throw new Error("receipt evidence required"); },
      })], calls: [] },
    }),
    /verification|receipt|postcondition/,
  );
});

test("fails closed for wrong identity, malformed verification, and incomplete cleanup", async () => {
  const cases = [
    { name: "wrong identity", overrides: { verifyReceiptEvidencePostcondition: async ({ invocation }) => ({ gameId: "stardew", actionId: "other_action", runId: invocation.runId, verified: true }) }, pattern: /identity|verification/ },
    { name: "malformed verification", overrides: { verifyReceiptEvidencePostcondition: async () => ({ status: "passed" }) }, pattern: /verification/ },
    { name: "incomplete cleanup", overrides: { verifyCleanup: async ({ actionId, invocation }) => ({ gameId: "stardew", actionId, runId: invocation.runId, complete: false }) }, pattern: /cleanup|verification/ },
  ];
  for (const candidate of cases) {
    const registration = syntheticRegistration(candidate.overrides);
    await assert.rejects(
      runActionProject({
        manifest,
        invocation: { command: "run-live", actionId: registration.actionId, profileFile: "C:\\profile.json", runId: `ar1_${candidate.name.replaceAll(" ", "_")}` },
        dependencies: { __testOnlyActionRegistrations: [registration], calls: [] },
      }),
      candidate.pattern,
      candidate.name,
    );
  }
});

test("exposes canonical action scripts with a required profile passthrough", async () => {
  const scripts = JSON.parse(await readFile(packageFile, "utf8")).scripts;
  assert.equal(scripts["action:check"], "node ../../../packages/game-action-devkit/bin/game-action.mjs check --project game-action-project.json");
  assert.equal(scripts["action:status"], "node ../../../packages/game-action-devkit/bin/game-action.mjs status --project game-action-project.json");
  assert.equal(scripts["action:preflight"], "node ../../../packages/game-action-devkit/bin/game-action.mjs preflight --project game-action-project.json");
  assert.equal(scripts["action:run-live"], "node ../../../packages/game-action-devkit/bin/game-action.mjs run-live --project game-action-project.json");
  for (const name of ["action:check", "action:preflight", "action:run-live"]) {
    assert.doesNotMatch(scripts[name], /--action|--profile/);
  }
  assert.doesNotMatch(scripts["action:status"], /--action/);
  assert.equal(scripts["action:ci"], "node src/portfolio.mjs --ci");
});
