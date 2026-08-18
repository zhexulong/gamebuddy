import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { superviseProductionFarmhandSession } from "./production-farmhand-session-supervisor.mjs";

const SCRIPT_URL = new URL("./production-farmhand-session-supervisor.mjs", import.meta.url);
const WINDOWS_BLOCKERS = [
  "ephemeral_farmhand_bridge_attachment_capability_source_unavailable",
  "ai_client_process_launch_ownership_unavailable",
  "native_farmhand_direct_child_launch_identity_proof_unavailable",
];

test("production supervisor returns the sole redacted zero-input blocked terminal", async () => {
  const record = await superviseProductionFarmhandSession();

  assert.deepEqual(Object.keys(record).sort(), ["blockerFacts", "evidenceClass", "schema", "state", "topology"]);
  assert.equal(record.schema, "production_farmhand_session_supervision/v1");
  assert.equal(record.evidenceClass, "production_farmhand_session_supervision");
  assert.equal(record.state, "blocked");
  assert.equal(record.topology, "native_ai_farmhand_multiplayer");
  assert.deepEqual(record.blockerFacts, process.platform === "win32" ? WINDOWS_BLOCKERS : ["windows_unsupported"]);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.blockerFacts), true);

  const serialized = JSON.stringify(record);
  for (const forbidden of [
    "\\\"path\\\"", "\\\"pipeName\\\"", "\\\"token\\\"", "\\\"error\\\"", "\\\"pid\\\"",
    "\\\"processIdentity\\\"", "\\\"attachment\\\"", "\\\"payload\\\"", "\\\"evidence\\\"", "\\\"ready\\\"",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `record leaked ${forbidden}`);
  }
});

test("production supervisor rejects every argument", async () => {
  await assert.rejects(() => superviseProductionFarmhandSession({}), /production_farmhand_supervisor_input_forbidden/);
  await assert.rejects(() => superviseProductionFarmhandSession(undefined), /production_farmhand_supervisor_input_forbidden/);
  await assert.rejects(() => superviseProductionFarmhandSession("unknown-setting"), /production_farmhand_supervisor_input_forbidden/);
});

test("production boundary has no I/O, spawn, launcher, control, artifact, or ready composition grammar", async () => {
  const source = await readFile(SCRIPT_URL, "utf8");

  for (const forbidden of [
    "node:child_process", "node:net", "node:fs", "node:fs/promises", "spawn(", "fork(", "createServer",
    "production-artifact", "launcher", "control-client", "pipe", "token", "ready", "__testOnly",
    "observeFixedComposition", "artifact", "createHash", "setTimeout", "setInterval",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden production composition grammar: ${forbidden}`);
  }
});
