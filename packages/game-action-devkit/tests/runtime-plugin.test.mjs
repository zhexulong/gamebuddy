import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GAME_RUNTIME_PLUGIN_API, createGameRuntimePlugin } from "../src/index.mjs";

const target = {
  targetId: "fixture-target",
  targetVersion: "v1",
  actions: [{ actionId: "toggle_lamp", verifier: { admit: () => true, verify: () => true } }],
};

function makePlugin(overrides = {}) {
  return createGameRuntimePlugin({ gameId: "clockwork_fixture", targets: [target], ...overrides });
}

function admission(plugin, overrides = {}) {
  return plugin.inspectTarget({
    targetId: "fixture-target",
    targetVersion: "v1",
    actionId: "toggle_lamp",
    runId: "run-1",
    ...overrides,
  });
}

function successfulRunner(overrides = {}) {
  return {
    actionId: "toggle_lamp",
    runId: "run-1",
    execute: () => ({
      receipt: { state: "succeeded", code: "accepted", evidence: "opaque-evidence" },
      postcondition: { state: "verified", code: "state_verified", evidence: "opaque-postcondition" },
      cleanup: { state: "complete", code: "complete" },
    }),
    ...overrides,
  };
}

test("exports exactly the neutral versioned runtime plugin factory", async () => {
  const module = await import("../src/index.mjs");
  assert.deepEqual(Object.keys(module).filter((key) => key.includes("RUNTIME_PLUGIN") || key === "createGameRuntimePlugin").sort(), ["GAME_RUNTIME_PLUGIN_API", "createGameRuntimePlugin"]);
  assert.equal(GAME_RUNTIME_PLUGIN_API, "gamebuddy-game-runtime-plugin/v1");
});

test("publishes a closed neutral outcome schema without game-specific fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/game-runtime-plugin.v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, "https://gamebuddy.local/game-action-devkit/schemas/game-runtime-plugin.v1.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schema", "gameId", "targetId", "targetVersion", "actionId", "runId", "state", "verdict", "receipt", "postcondition", "cleanup", "failure"]);
  assert.doesNotMatch(JSON.stringify(schema), /stardew|farm|tile|npc|player|equip_tool|toggle_lamp/iu);
  assert.equal(schema.$defs.receipt.additionalProperties, false);
  assert.equal(schema.$defs.postcondition.additionalProperties, false);
  assert.equal(schema.$defs.cleanup.additionalProperties, false);
});

test("admits only an opaque action with a project-owned verifier and freezes the boundary", () => {
  const plugin = makePlugin();
  const result = admission(plugin);
  assert.equal(result.blocked, false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.admission));
  assert.deepEqual(result.summary, {
    schema: "gamebuddy-game-runtime-plugin-admission/v1",
    gameId: "clockwork_fixture",
    targetId: "fixture-target",
    targetVersion: "v1",
    actionId: "toggle_lamp",
    runId: "run-1",
    deadlineMs: 120000,
  });
  for (const field of ["pipe", "token", "client", "command", "path", "scriptPath", "backupPath", "payload", "args"]) {
    assert.ok(!(field in result.admission), `admission exposes ${field}`);
    assert.ok(!(field in result.summary), `summary exposes ${field}`);
  }
});

test("missing action verifier blocks admission even when action identity is published", () => {
  const plugin = createGameRuntimePlugin({
    gameId: "clockwork_fixture",
    targets: [{ targetId: "fixture-target", targetVersion: "v1", actions: [{ actionId: "toggle_lamp", verifier: null }] }],
  });
  const result = admission(plugin);
  assert.equal(result.blocked, true);
  assert.equal(result.report.code, "VERIFIER_REQUIRED");
});

test("verifier admission rejection blocks without exposing its reason", () => {
  const plugin = makePlugin({
    targets: [{ targetId: "fixture-target", targetVersion: "v1", actions: [{ actionId: "toggle_lamp", verifier: { admit: () => false, verify: () => true } }] }],
  });
  assert.equal(admission(plugin).report.code, "VERIFIER_REJECTED");
});

test("rejects forged, replayed, wrong identity, and closed admissions fail-closed", () => {
  const plugin = makePlugin();
  const { admission: handle } = admission(plugin);
  const forged = plugin.run({ admission: Object.freeze({}), actionRunner: successfulRunner() });
  assert.equal(forged.failure.code, "INVALID_ADMISSION");
  assert.equal(plugin.run({ admission: handle, actionRunner: successfulRunner({ actionId: "other_action" }) }).failure.code, "WRONG_ACTION");
  assert.equal(plugin.run({ admission: handle, actionRunner: successfulRunner({ runId: "run-2" }) }).failure.code, "WRONG_RUN");
  const first = plugin.run({ admission: handle, actionRunner: successfulRunner() });
  assert.equal(first.state, "PASSED");
  assert.equal(plugin.run({ admission: handle, actionRunner: successfulRunner() }).failure.code, "ADMISSION_CONSUMED");
  const closed = makePlugin();
  const pending = admission(closed);
  closed.close();
  assert.equal(closed.run({ admission: pending.admission, actionRunner: successfulRunner() }).failure.code, "PLUGIN_CLOSED");
});

test("session is one-shot and does not expose arbitrary command or transport capabilities", () => {
  const plugin = makePlugin();
  const { admission: handle } = admission(plugin);
  let session;
  const outcome = plugin.run({
    admission: handle,
    actionRunner: successfulRunner({ execute(received) {
      session = received;
      received.executeOnce({ payload: "opaque" });
      return {
        receipt: { state: "succeeded", code: "accepted", evidence: "opaque-evidence" },
        postcondition: { state: "verified", code: "state_verified", evidence: "opaque-postcondition" },
        cleanup: { state: "complete", code: "complete" },
      };
    } }),
  });
  assert.equal(outcome.state, "PASSED");
  assert.deepEqual(Object.keys(session).sort(), ["close", "executeOnce", "observeFresh"]);
  assert.ok(Object.isFrozen(session));
  assert.equal(session.executeOnce().code, "SESSION_CLOSED");
  for (const field of ["pipe", "token", "client", "command", "path", "cwd", "argv", "spawn", "exec"]) assert.ok(!(field in session));
});

test("sensitive fields, action-specific payloads, and oversized output are rejected", () => {
  assert.throws(() => makePlugin({ secret: "no" }), /invalid_options|sensitive_field/);
  const plugin = makePlugin();
  const { admission: handle } = admission(plugin);
  const sensitive = plugin.run({ admission: handle, actionRunner: successfulRunner({ secret: "no" }) });
  assert.equal(sensitive.failure.code, "INVALID_RUNNER");
  const oversizedPlugin = makePlugin();
  const oversizedHandle = admission(oversizedPlugin).admission;
  const oversized = oversizedPlugin.run({
    admission: oversizedHandle,
    actionRunner: successfulRunner({ execute: () => ({
      receipt: { state: "succeeded", code: "accepted", evidence: "x".repeat(3000) },
      postcondition: { state: "verified", code: "verified", evidence: "ok" },
      cleanup: { state: "complete", code: "complete" },
    }) }),
  });
  assert.equal(oversized.state, "INCOMPLETE");
  assert.equal(oversized.failure.phase, "output");
});

test("successful-looking generic output cannot pass without verifier verification", () => {
  const plugin = makePlugin({
    targets: [{ targetId: "fixture-target", targetVersion: "v1", actions: [{ actionId: "toggle_lamp", verifier: { admit: () => true, verify: () => false } }] }],
  });
  const result = admission(plugin);
  const outcome = plugin.run({ admission: result.admission, actionRunner: successfulRunner() });
  assert.equal(outcome.state, "INCOMPLETE");
  assert.equal(outcome.failure.code, "POSTCONDITION_UNVERIFIED");
});

test("incomplete cleanup can never produce PASSED", () => {
  const plugin = makePlugin();
  const result = admission(plugin);
  const outcome = plugin.run({
    admission: result.admission,
    actionRunner: successfulRunner({ execute: () => ({
      receipt: { state: "succeeded", code: "accepted", evidence: "opaque-evidence" },
      postcondition: { state: "verified", code: "state_verified", evidence: "opaque-postcondition" },
      cleanup: { state: "incomplete", code: "restore_failed" },
    }) }),
  });
  assert.equal(outcome.state, "INCOMPLETE");
  assert.equal(outcome.failure.code, "CLEANUP_INCOMPLETE");
});
