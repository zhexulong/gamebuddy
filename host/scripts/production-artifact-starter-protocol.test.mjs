/**
 * The starter a published generation is launched through, and the child it is given.
 *
 * The child environment strips inherited Pi and Magic Context selectors, the Game launcher's
 * credentials are fresh, grammar-valid and child-only, and a handoff or test-fixture runtime
 * selected from the environment is refused before a child is spawned. The starter relays the
 * one exact correlated task and its validated terminal aggregate, refuses anything malformed,
 * foreign or duplicate, terminates its direct child when the parent disconnects, and leaves a
 * Preview child live while the STOP receipt stays wrapper-owned.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  productionConfig,
  withFixture,
  waitForChildExit,
  publishTestArtifactForFixture,
  installArtifactTestDependencies,
  scriptRoot,
  runChild,
  emit,
} from "./production-artifact-fixtures.test-support.mjs";
import { REQUIRED_VERIFICATION_ROOTS } from "./production-artifact.mjs";
import { createProductionChildEnvironment } from "./production-control-launch.mjs";

test("production child environment strips inherited Pi and Magic Context selectors", () => {
  const child = createProductionChildEnvironment("main.js", {
    GAMEBUDDY_D0_BOOTSTRAP_TEST: "1",
    GAMEBUDDY_LIVE_SUPERVISOR: "1",
    PI: "developer-pi",
    PI_CODING_AGENT: "1",
    PI_CODING_AGENT_DIR: "developer-agent-dir",
    PI_CODING_AGENT_SESSION_DIR: "developer-sessions",
    PI_MODEL: "developer-model",
    PI_PROVIDER: "developer-provider",
    PI_SESSION_FILE: "developer-session.jsonl",
    PI_SESSION_ID: "developer-session-id",
    PI_SUBAGENT_PARENT_SESSION: "developer-parent-session",
    MAGIC_CONTEXT_PI_SUBAGENT: "1",
    MAGIC_CONTEXT_TEST_DATA_DIR: "developer-magic-context-data",
    SAFE: "ok",
  });
  assert.deepEqual(Object.keys(child).sort(), ["GAMEBUDDY_CONTROL_PIPE", "GAMEBUDDY_CONTROL_TOKEN", "GAMEBUDDY_LIVE_SUPERVISOR", "SAFE"]);
  assert.match(child.GAMEBUDDY_CONTROL_PIPE ?? "", /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(child.GAMEBUDDY_CONTROL_TOKEN ?? "", /^[A-Za-z0-9_-]{16,256}$/);
});


test("Game launcher credentials are fresh, grammar-valid, child-only, and absent for non-launcher entries", () => {
  const inherited = { GAMEBUDDY_CONTROL_PIPE: "inherited_pipe", GAMEBUDDY_CONTROL_TOKEN: "inherited_token_value", SAFE: "ok" };
  const first = createProductionChildEnvironment("main.js", inherited);
  const second = createProductionChildEnvironment("main.js", inherited);
  assert.match(first.GAMEBUDDY_CONTROL_PIPE ?? "", /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(first.GAMEBUDDY_CONTROL_TOKEN ?? "", /^[A-Za-z0-9_-]{16,256}$/);
  assert.notEqual(first.GAMEBUDDY_CONTROL_PIPE, second.GAMEBUDDY_CONTROL_PIPE);
  assert.notEqual(first.GAMEBUDDY_CONTROL_TOKEN, second.GAMEBUDDY_CONTROL_TOKEN);
  assert.equal(inherited.GAMEBUDDY_CONTROL_PIPE, "inherited_pipe");
  assert.equal(inherited.GAMEBUDDY_CONTROL_TOKEN, "inherited_token_value");
  assert.deepEqual(createProductionChildEnvironment("farmhand-companion-preview.js", inherited), { SAFE: "ok" });
});



test("launcher rejects any environment-selected control handoff before child spawn", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));

// The artifact chain imports check-release-persona-hygiene.mjs (production-artifact.mjs:9). A fixture
// that stages production-artifact.mjs without it dies with ERR_MODULE_NOT_FOUND before the first
// assertion, which turns every assert.notEqual(code, 0) into an empty pass.
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  await writeFile(join(emitted, "main.js"), 'import "typebox"; process.send?.({ schema: "ordinary-production-ipc", value: 1 }); setTimeout(() => process.exit(0), 40);');
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], { cwd: root, env: { ...process.env, GAMEBUDDY_LIVE_SUPERVISOR: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; let stderr = "";
  child.on("message", (message) => messages.push(message)); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  assert.notEqual(result, 0, `starter stderr: ${stderr}`);
  assert.deepEqual(messages, []);
}));


test("launcher rejects a test-fixture runtime generation before relaying source evidence", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs", ])  await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const valid = { schema: "gamebuddy-production-live-source-attestation/v1", evidence: { schema: "gamebuddy-production-live-source-attestation/v1", protocolVersion: 1, evidenceClass: "production_live_source_attestation", launchBindingSha256: "d".repeat(64), runtimeInstanceSha256: "a".repeat(64), kind: "stop_settled", sourceEventSha256: "b".repeat(64), batchIdSha256: null, stopIdSha256: "c".repeat(64), epoch: 1, disposition: null, observationRevision: null } };
  await writeFile(join(emitted, "main.js"), `import "typebox"; process.send?.(${JSON.stringify(valid)}); process.send?.({ schema: "ordinary-production-ipc", value: 1 }); setTimeout(() => process.exit(500), 40);`);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; child.on("message", (message) => messages.push(message));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  // The child process has no fixture capability: a test-generated runtime
  // generation cannot be rechecked or launched as a production artifact.
  assert.notEqual(code, 0);
  assert.deepEqual(messages, []);
  await writeFile(join(emitted, "main.js"), `import "typebox"; process.send?.(${JSON.stringify({ ...valid, evidence: { ...valid.evidence, observationRevision: 0 } })}); setTimeout(() => process.exit(0), 40);`);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const malformed = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const malformedCode = await new Promise((resolve, reject) => { malformed.once("error", reject); malformed.once("exit", resolve); });
  assert.notEqual(malformedCode, 0);
}));


test("active STOP proof receipt is wrapper-owned and leaves the Preview child live", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  // The staged launcher chain is static: start-test-artifact.mjs imports production-artifact-test-support.mjs,
  // which imports production-artifact.mjs, which imports closure staging and persona hygiene. A fixture
  // missing any of them dies with ERR_MODULE_NOT_FOUND before the wrapper can prove or relay anything.
  for (const script of [
    "active-stop-proof.mjs",
    "check-release-persona-hygiene.mjs",
    "production-artifact-closure-staging.mjs",
    "production-artifact.mjs",
    "voice-artifact-fixture-publisher.mjs",
    "production-artifact-esm-resolution-probe.mjs",
    "production-control-launch.mjs",
    "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs",
  ]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
    entryRoots: ["farmhand-companion-preview.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  })));
   const emitted = await emit(root);
   await rm(join(emitted, "browser"), { recursive: true, force: true });
   await rm(join(emitted, "native"), { recursive: true, force: true });
   await rm(join(emitted, "main.js"));
  const entry = join(emitted, "farmhand-companion-preview.js");
  const runtime = "a".repeat(64);
  const batch = "b".repeat(64);
  const stop = "c".repeat(64);
  const source = "d".repeat(64);
  await writeFile(entry, `import "typebox";
const binding = process.env.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256;
if (!/^[a-f0-9]{64}$/.test(binding ?? "")) process.exit(9);
// The wrapper must not treat child stdout as a proof authority.
process.stdout.write("active_stop_proof_verified\\n");
const base = Object.freeze({ schema: "gamebuddy-production-live-source-attestation/v1", protocolVersion: 1, evidenceClass: "production_live_source_attestation", launchBindingSha256: binding, runtimeInstanceSha256: ${JSON.stringify(runtime)}, sourceEventSha256: ${JSON.stringify(source)} });
const send = (kind, fields) => process.send?.({ schema: base.schema, evidence: { ...base, kind, ...fields } });
send("pi_turn_accepted", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: null, epoch: null, disposition: "steer", observationRevision: null });
send("native_stop_all_observed", { batchIdSha256: null, stopIdSha256: ${JSON.stringify(stop)}, epoch: null, disposition: null, observationRevision: null });
send("stop_sealed", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: null });
send("stop_settled", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: null });
send("old_epoch_quiet", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: 9 });
send("body_settled", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: 9 });
if (process.argv.includes("--exit-after-proof")) setTimeout(() => process.exit(0), 40);
else {
  setTimeout(() => process.send?.({ schema: "post-proof-ordinary-ipc", value: 1 }), 80);
  setInterval(() => undefined, 1_000);
}
`);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const wrapper = spawn(process.execPath, [
    join(root, "scripts", "start-test-artifact.mjs"),
    "farmhand-companion-preview.js",
    "--require-active-stop-proof",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "";
  let stderr = "";
  const messages = [];
  wrapper.on("message", (message) => { messages.push(message); });
  wrapper.stdout.setEncoding("utf8");
  wrapper.stderr.setEncoding("utf8");
  wrapper.stdout.on("data", (chunk) => { stdout += chunk; });
  wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve) => wrapper.stdout.on("data", () => {
        if (stdout === "active_stop_proof_verified\n") resolve();
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`proof receipt timeout: wrapper_exit=${String(wrapper.exitCode)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)), 5_000)),
    ]);
    assert.equal(stdout, "active_stop_proof_verified\n");
    assert.equal(wrapper.exitCode, null, `wrapper exited after proof: ${stderr}`);
    assert.equal(wrapper.killed, false);
    await Promise.race([
      new Promise((resolve) => wrapper.on("message", () => {
        if (messages.some((message) => message?.schema === "post-proof-ordinary-ipc" && message.value === 1)) resolve();
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`post-proof IPC timeout: messages=${JSON.stringify(messages)} stderr=${JSON.stringify(stderr)}`)), 5_000)),
    ]);
  } finally {
    wrapper.kill("SIGTERM");
    await waitForChildExit(wrapper, 5_000, () => `wrapper survived SIGTERM; stderr=${JSON.stringify(stderr)}`);
  }
  const exited = spawn(process.execPath, [
    join(root, "scripts", "start-test-artifact.mjs"),
    "farmhand-companion-preview.js",
    "--require-active-stop-proof",
    "--exit-after-proof",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let exitedStdout = "";
  let exitedStderr = "";
  exited.stdout.setEncoding("utf8");
  exited.stderr.setEncoding("utf8");
  exited.stdout.on("data", (chunk) => { exitedStdout += chunk; });
  exited.stderr.on("data", (chunk) => { exitedStderr += chunk; });
  const [exitCode] = await waitForChildExit(exited, 15_000, () => `stdout=${JSON.stringify(exitedStdout)} stderr=${JSON.stringify(exitedStderr)}`);
  assert.equal(exitCode, 1);
  assert.equal(exitedStdout, "active_stop_proof_verified\n");
  assert.equal(exitedStderr, "preview_exited_after_active_stop_proof\n");
}));


test("non-D0 starter relays ordinary child IPC and leaves the child live", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"])  await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  await writeFile(join(emitted, "main.js"), 'import "typebox"; process.on("message", (message) => process.send?.({ schema: "ordinary-parent-ipc-ack", received: message })); process.send?.({ schema: "ordinary-production-ipc", value: 1 }); setTimeout(() => process.exit(0), 80);');
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.send({ schema: "ordinary-parent-ipc", value: 2 });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  assert.equal(result, 0, `starter stderr: ${stderr}`);
  assert.deepEqual(messages, [
    { schema: "ordinary-production-ipc", value: 1 },
    { schema: "ordinary-parent-ipc-ack", received: { schema: "ordinary-parent-ipc", value: 2 } },
  ]);
}));


test("Task 9 starter relays one exact correlated task and one validated v2 terminal aggregate", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const nonceSha256 = "a".repeat(64);
  const ready = { schema: "gamebuddy-production-game-task-ingress/v1", kind: "ready", surface: "game", nonceSha256, gameSessionId: "game_session_01", piSessionId: "pi_session_01" };
  const dispatch = { ...ready, kind: "dispatch_task", task: "walk to the chest" };
  const terminal = {
    schema: "gamebuddy-game-operational-gate-evidence/v2",
    nonceSha256,
    piSessionId: ready.piSessionId,
    surface: "game",
    capabilityRevision: 3,
    capabilityCount: 4,
    transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
    terminalState: "completed",
    stopSettled: true,
  };
  await writeFile(join(emitted, "main.js"), `import "typebox";
process.send?.(${JSON.stringify(ready)});
process.on("message", (message) => {
  if (message?.kind !== "dispatch_task") process.exit(11);
  process.send?.(${JSON.stringify(terminal)});
  setTimeout(() => process.exit(0), 40);
});
`);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; let stderr = "";
  child.on("message", (message) => {
    messages.push(message);
    if (message?.kind === "ready") child.send(dispatch);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  assert.equal(result, 0, `starter stderr: ${stderr}`);
  assert.deepEqual(messages, [ready, terminal]);
}));


test("Task 9 starter rejects dispatch before ready and every malformed, foreign, or duplicate terminal protocol message", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const nonceSha256 = "b".repeat(64);
  const ready = { schema: "gamebuddy-production-game-task-ingress/v1", kind: "ready", surface: "game", nonceSha256, gameSessionId: "game_session_02", piSessionId: "pi_session_02" };
  const validDispatch = { ...ready, kind: "dispatch_task", task: "do the task" };
  const terminal = {
    schema: "gamebuddy-game-operational-gate-evidence/v2",
    nonceSha256,
    piSessionId: ready.piSessionId,
    surface: "game",
    capabilityRevision: 1,
    capabilityCount: 2,
    transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
    terminalState: "completed",
    stopSettled: true,
  };
  // The fixture child is one fixed module: each rejection relies on data that
  // already exists as JSON (the round trip has nothing to do with code), so
  // the ready/reply records arrive as a JSON document on the environment and
  // no value is ever interpolated into the emitted source.
  const task9FixtureSource = `import "typebox";
const fixture = JSON.parse(process.env.GAMEBUDDY_TASK9_FIXTURE_JSON);
const sendReady = () => process.send?.(fixture.ready);
if (typeof fixture.delayReadyMs === "number") setTimeout(sendReady, fixture.delayReadyMs);
else sendReady();
process.on("message", () => { for (const reply of fixture.replies ?? []) process.send?.(reply); });
`;
  async function runCase(fixtureData, parentMessage) {
    await writeFile(join(emitted, "main.js"), task9FixtureSource);
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = spawn(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], { cwd: root, env: { ...process.env, GAMEBUDDY_TASK9_FIXTURE_JSON: JSON.stringify(fixtureData) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const messages = []; let stderr = "";
    child.on("message", (message) => {
      messages.push(message);
      if (message?.kind === "ready") child.send(parentMessage);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (value) => resolve(value)); });
    assert.notEqual(code, 0, `starter unexpectedly accepted invalid Task 9 case: ${stderr}`);
    return messages;
  }
  const early = await (async () => {
    await writeFile(join(emitted, "main.js"), task9FixtureSource);
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = spawn(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], { cwd: root, env: { ...process.env, GAMEBUDDY_TASK9_FIXTURE_JSON: JSON.stringify({ ready, delayReadyMs: 100 }) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.send(validDispatch);
    return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => { assert.notEqual(code, 0); resolve(code); }); });
  })();
  assert.notEqual(early, 0);
  await runCase({ ready, replies: [terminal] }, { ...validDispatch, task: "\ud800" });
  await runCase({ ready, replies: [{ ...terminal, capabilityCount: 2, extra: true }] }, validDispatch);
  await runCase({ ready, replies: [{ ...terminal, nonceSha256: "c".repeat(64) }] }, validDispatch);
  await runCase({ ready, replies: [terminal, terminal] }, validDispatch);
}));


test("Task 9 starter terminates its direct child when the parent IPC disconnects", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"])
    await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const ready = { schema: "gamebuddy-production-game-task-ingress/v1", kind: "ready", surface: "game", nonceSha256: "d".repeat(64), gameSessionId: "game_session_disconnect", piSessionId: "pi_session_disconnect" };
  await writeFile(join(emitted, "main.js"), `import "typebox";
process.send?.(${JSON.stringify(ready)});
process.once("SIGTERM", () => process.exit(23));
setInterval(() => undefined, 1000);
`);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const wrapper = spawn(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.on("message", (message) => {
      if (message?.kind === "ready") resolve();
    });
  });
  wrapper.disconnect();
  const code = await new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("exit", resolve);
  });
  assert.notEqual(code, 0);
}));


test("starter forwards a fixed ingress stage from its immutable child stdout", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"])
    await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const stage = "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received";
  await writeFile(join(emitted, "main.js"), `import "typebox"; console.debug(${JSON.stringify(stage)});`);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });

  const child = await runChild(process.execPath, [join(root, "scripts", "start-test-artifact.mjs"), "main.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(child.code, 0, child.stderr.toString());
  assert.equal(child.stdout.toString("utf8"), `${stage}\n`);
  assert.doesNotMatch(child.stderr.toString("utf8"), new RegExp(stage));
}));


test("starter accepts exactly one configured root then forwards config arguments", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "check-release-persona-hygiene.mjs", "production-artifact-closure-staging.mjs", "voice-artifact-fixture-publisher.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-test-artifact.mjs", "start-artifact.internal.mjs", "production-artifact-test-support.mjs", "node-runtime-release-acquisition.mjs"])  await cp(join(scriptRoot, script), join(root, "scripts", script));
  // Use Host-local regular package directories in this isolated fixture.
  await installArtifactTestDependencies(root);
  const start = join(root, "scripts", "start-test-artifact.mjs");
  for (const entry of ["main.js", "farmhand-companion-preview.js"]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: [entry], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
    const emitted = join(root, `emitted-${entry}`); await mkdir(join(emitted, "tavern"), { recursive: true });
    for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS) {
      await mkdir(dirname(join(emitted, verificationRoot)), { recursive: true });
      await writeFile(join(emitted, verificationRoot), "export {};\n");
    }
    await mkdir(join(emitted, "bootstrap", "entry"), { recursive: true });
    await writeFile(join(emitted, "bootstrap", "entry", "desktop-host-entry.internal.js"), "export {};\n");
    await writeFile(join(emitted, entry), 'import "typebox"; process.stdout.write(JSON.stringify({ args: process.argv.slice(2), controlsPresent: Boolean(process.env.GAMEBUDDY_CONTROL_PIPE || process.env.GAMEBUDDY_CONTROL_TOKEN) }));');
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = await runChild(process.execPath, [start, entry, "--config", `${entry}.json`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(child.code, 0, child.stderr.toString());
    assert.deepEqual(JSON.parse(child.stdout.toString()), { args: ["--config", `${entry}.json`], controlsPresent: entry === "main.js" });
  }
  for (const entry of ["../main.js", "nested/main.js", "unknown.js"]) {
    await assert.rejects(runChild(process.execPath, [start, entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }), /test_runner_failed:code=1/);
  }
}));

