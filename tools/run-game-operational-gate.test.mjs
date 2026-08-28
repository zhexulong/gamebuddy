import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  OPERATIONAL_GATE_TIMEOUT_MS,
  parseArguments,
  prepareReportTarget,
  runOperationalGateIpc,
  terminateOwnedProcessTree,
  writeOperationalGateReport,
} from "./run-game-operational-gate.mjs";

const nonce = "a".repeat(64);
const ready = Object.freeze({
  schema: "gamebuddy-production-game-task-ingress/v1",
  kind: "ready",
  surface: "game",
  nonceSha256: nonce,
  gameSessionId: "game_session_01",
  piSessionId: "pi_session_01",
});
const terminal = Object.freeze({
  schema: "gamebuddy-game-operational-gate-evidence/v2",
  nonceSha256: nonce,
  piSessionId: ready.piSessionId,
  surface: "game",
  capabilityRevision: 3,
  capabilityCount: 4,
  transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
  terminalState: "completed",
  stopSettled: true,
});

function transportHarness({ stdout = "", terminateResult = true } = {}) {
  const emitter = new EventEmitter();
  let terminateCalls = 0;
  let dispatched;
  const transport = {
    send(message, callback) {
      dispatched = message;
      queueMicrotask(() => callback(null));
      return true;
    },
    onMessage(listener) {
      emitter.on("message", listener);
      return () => emitter.off("message", listener);
    },
    onDisconnect(listener) {
      emitter.on("disconnect", listener);
      return () => emitter.off("disconnect", listener);
    },
    onError(listener) {
      emitter.on("error", listener);
      return () => emitter.off("error", listener);
    },
    onExit(listener) {
      emitter.on("exit", listener);
      return () => emitter.off("exit", listener);
    },
    terminate() {
      terminateCalls += 1;
      if (terminateResult) queueMicrotask(() => emitter.emit("exit", 0, null));
      return terminateResult;
    },
  };
  return {
    transport,
    stdout,
    emit(message) { emitter.emit("message", message); },
    disconnect() { emitter.emit("disconnect"); },
    error() { emitter.emit("error", new Error("child_error")); },
    exit(code = 0, signal = null) { emitter.emit("exit", code, signal); },
    get dispatched() { return dispatched; },
    get terminateCalls() { return terminateCalls; },
  };
}

async function passed(harness, options = {}) {
  const result = runOperationalGateIpc({ transport: harness.transport, task: "inspect the chest", nonceSha256: nonce, timeoutMs: 200, teardownTimeoutMs: 200, ...options });
  harness.emit(ready);
  await new Promise((resolve) => setImmediate(resolve));
  harness.emit(terminal);
  return result;
}

test("parser accepts only config and optional report", () => {
  assert.deepEqual(parseArguments(["--config", "C:/gate.json"]), {
    configPath: resolve("C:/gate.json"),
    reportPath: undefined,
  });
  assert.throws(() => parseArguments([]), /usage:/);
  assert.throws(() => parseArguments(["--report", "x"]), /usage:/);
  assert.throws(() => parseArguments(["--config", "x", "--config", "y"]), /usage:/);
});

test("production IPC dispatches exactly one natural-language task and accepts one correlated terminal aggregate", async () => {
  const h = transportHarness();
  const result = await passed(h);
  assert.equal(result.state, "PASSED");
  assert.deepEqual(h.dispatched, {
    schema: "gamebuddy-production-game-task-ingress/v1",
    kind: "dispatch_task",
    surface: "game",
    nonceSha256: nonce,
    gameSessionId: ready.gameSessionId,
    piSessionId: ready.piSessionId,
    task: "inspect the chest",
  });
  assert.equal(result.dispatchCount, 1);
  assert.equal(result.terminalCount, 1);
  assert.equal(h.terminateCalls, 1);
});

test("malformed, foreign, duplicate, stdout-forged, timeout, disconnect, and teardown failures fail closed", async () => {
  const cases = [
    ["malformed ready", (h) => h.emit({ ...ready, extra: true }), "game_task_ready_invalid"],
    ["foreign nonce", (h) => h.emit({ ...ready, nonceSha256: "b".repeat(64) }), "game_task_ready_correlation_mismatch"],
    ["malformed terminal", async (h) => { h.emit(ready); await new Promise((resolve) => setImmediate(resolve)); h.emit({ ...terminal, transitions: {} }); }, "game_task_terminal_evidence_invalid"],
    ["foreign terminal", async (h) => { h.emit(ready); await new Promise((resolve) => setImmediate(resolve)); h.emit({ ...terminal, piSessionId: "foreign_pi" }); }, "game_task_terminal_evidence_correlation_mismatch"],
    ["duplicate ready", async (h) => { h.emit(ready); await new Promise((resolve) => setImmediate(resolve)); h.emit(ready); }, "game_task_ready_duplicate"],
    ["disconnect", (h) => h.disconnect(), "game_task_disconnect"],
    ["child error", (h) => h.error(), "production_wrapper_process_error"],
    ["stdout forgery", async (h) => { assert.match(h.stdout, /gamebuddy-game-operational-gate-evidence\/v2/); await new Promise((resolve) => setTimeout(resolve, 5)); }, "harness_timeout"],
  ];
  for (const [name, trigger, reason] of cases) {
    const h = transportHarness({ stdout: name === "stdout forgery" ? JSON.stringify(terminal) : "" });
    const resultPromise = runOperationalGateIpc({ transport: h.transport, task: "inspect", nonceSha256: nonce, timeoutMs: name === "stdout forgery" ? 20 : 200, teardownTimeoutMs: 30 });
    await trigger(h);
    const result = await resultPromise;
    assert.deepEqual(
      result,
      name === "stdout forgery"
        ? { state: "GATE_FAILED", reasonCode: reason }
        : { state: "BLOCKED", reasonCode: reason },
      name,
    );
    assert.equal(h.terminateCalls, 1, name);
  }

  const duplicateTerminal = transportHarness();
  const duplicateResult = runOperationalGateIpc({ transport: duplicateTerminal.transport, task: "inspect", nonceSha256: nonce, timeoutMs: 200, teardownTimeoutMs: 200 });
  duplicateTerminal.emit(ready);
  await new Promise((resolve) => setImmediate(resolve));
  duplicateTerminal.emit(terminal);
  duplicateTerminal.emit(terminal);
  assert.deepEqual(await duplicateResult, { state: "BLOCKED", reasonCode: "game_task_terminal_evidence_duplicate" });

  const timeout = transportHarness({ terminateResult: true });
  const timedOut = await runOperationalGateIpc({ transport: timeout.transport, task: "inspect", nonceSha256: nonce, timeoutMs: 5, teardownTimeoutMs: 30 });
  assert.deepEqual(timedOut, { state: "GATE_FAILED", reasonCode: "harness_timeout" });

  const teardown = transportHarness({ terminateResult: false });
  const teardownResult = await passed(teardown, { timeoutMs: 200, teardownTimeoutMs: 10 });
  assert.deepEqual(teardownResult, { state: "BLOCKED", reasonCode: "teardown_failure" });
});

test("process-tree termination uses the exact owned PID and fails closed when the tree reaper fails", async () => {
  const child = { pid: 4312 };
  const calls = [];
  const success = await terminateOwnedProcessTree(child, {
    platform: "win32",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const reaper = new EventEmitter();
      queueMicrotask(() => reaper.emit("close", 0, null));
      return reaper;
    },
  });
  assert.equal(success, true);
  assert.deepEqual(calls[0].command, "taskkill.exe");
  assert.deepEqual(calls[0].args, ["/PID", "4312", "/T", "/F"]);

  const failed = await terminateOwnedProcessTree(child, {
    platform: "win32",
    spawnProcess: () => {
      const reaper = new EventEmitter();
      queueMicrotask(() => reaper.emit("close", 1, null));
      return reaper;
    },
  });
  assert.equal(failed, false);
});

test("fixture contains only schema, natural language task, target facts, and environment facts", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/stardew/game-operational-task.example.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(fixture).sort(), ["environment", "profile", "schema", "targetVersion", "task"]);
  assert.equal(typeof fixture.task, "string");
  for (const key of ["actions", "routes", "tools", "capabilitySubset", "budget"]) assert.equal(Object.hasOwn(fixture, key), false);
  assert.equal(fixture.environment.platform, "windows");
});

test("runner source uses the production launcher-owned manifest and fresh STOP composition", async () => {
  const source = await readFile(new URL("./run-game-operational-gate.mjs", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../host/scripts/start-production-artifact.mjs", import.meta.url), "utf8");
  const controlLaunch = await readFile(new URL("../host/scripts/production-control-launch.mjs", import.meta.url), "utf8");
  const operatorSelection = await readFile(
    new URL(
      "../host/src/continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /start-production-artifact\.mjs/);
  assert.match(source, /GAME_OPERATIONAL_GATE_NONCE_SHA256/);
  assert.match(source, /gamebuddy-game-operational-gate-evidence\/v2/);
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /harness_timeout/);
  assert.match(source, /stdout.*never parsed/i);
  assert.doesNotMatch(source, /verifyGameOperationalGateMarkerReport/);
  assert.doesNotMatch(source, /game_operational_runtime_or_bridge_receipt_ipc_unavailable/);
  assert.match(source, /\[PRODUCTION_LAUNCHER, "main\.js", config\.gameOperatorConfigPath\]/);
  assert.match(launcher, /createProductionChildEnvironment\(entry, process\.env/);
  assert.match(controlLaunch, /GAMEBUDDY_CONTROL_PIPE/);
  assert.match(controlLaunch, /GAMEBUDDY_CONTROL_TOKEN/);
  assert.match(controlLaunch, /material \?\? mintProductionControlLaunch\(\)/);
  assert.match(operatorSelection, /const manifest = await loadHostDeploymentManifest\(selected\.manifestPath\)/);
  assert.match(operatorSelection, /createGameRuntimeBinding\([\s\S]*manifest,/);
  assert.equal(OPERATIONAL_GATE_TIMEOUT_MS, 60_000);
});

test("content-free PASSED report with action counts is exclusively writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "game-operational-report-test-"));
  try {
    const reportPath = join(root, "evidence.json");
    const safePath = await prepareReportTarget(reportPath);
    await writeOperationalGateReport(safePath, {
      schema: "gamebuddy-game-operational-gate/v1",
      runner: { id: "game-operational-gate", version: 2 },
      runId: "run_01",
      nonceSha256: nonce,
      artifact: { generation: "generation_01", inventoryDigest: "b".repeat(64) },
      target: { version: "1.6.8", profile: "stardew-farmhand-v1" },
      state: "PASSED",
      terminalEvidence: terminal,
      assertions: {
        readyObserved: true,
        dispatchCount: 1,
        terminalAggregateCount: 1,
        stdoutEvidenceAccepted: false,
        teardown: "clean",
      },
      scope: "production_wrapper_ipc",
    });
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).state, "PASSED");
    await assert.rejects(() => writeOperationalGateReport(reportPath, { state: "PASSED" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config remains separate from task fixture and is not allowed to supply nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "game-operational-gate-test-"));
  try {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ markerNonceSha256: nonce }), "utf8");
    assert.match(await readFile(configPath, "utf8"), /markerNonceSha256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
