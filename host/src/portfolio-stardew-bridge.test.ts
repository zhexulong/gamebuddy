import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { PortfolioStardewBridgeClient } from "./portfolio-stardew-bridge.js";
import { PORTFOLIO_INTEGRATION_ID, PORTFOLIO_SLEEP_DAY_PHASES, PORTFOLIO_TOPOLOGY, type PortfolioMessage } from "./portfolio-protocol.js";

const scope = {
  integrationId: PORTFOLIO_INTEGRATION_ID,
  topology: PORTFOLIO_TOPOLOGY,
  saveId: "save_01",
  worldId: "world_01",
  localPlayerId: "player_01",
  companionId: "companion_01",
  bindingGeneration: 1,
  bindingHash: "a".repeat(64),
} as const;
const token = "portfolio_test_token_1234";
const snapshot = {
  protocolVersion: 1,
  integrationId: PORTFOLIO_INTEGRATION_ID,
  topology: PORTFOLIO_TOPOLOGY,
  saveId: scope.saveId,
  worldId: scope.worldId,
  localPlayerId: scope.localPlayerId,
  companionId: scope.companionId,
  bindingGeneration: 1,
  bindingHash: scope.bindingHash,
  revision: 1,
  worldReady: true,
  singlePlayer: true,
  currentLocalPlayerMatches: true,
  state: "ready" as const,
  reasonCode: "accepted",
};
function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}
function mineRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: "select_mine_elevator_floor", requestId: "request_m8_test", traceId: "trace_m8_test", idempotencyKey: "idem_m8_test", selectedCheckpoint: 10, expectedRevision: 1, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_m8_test_token_1", scope, ...overrides };
}
function mineReceipt(request: Record<string, any>, state: string, reasonCode: string, executionId = "execution_m8_test"): Record<string, any> {
  const fresh = { requestId: request.requestId, traceId: request.traceId, executionId, phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" };
  const accepted = { ...fresh, phase: "accepted", reasonCode: "accepted" };
  const terminal = { ...accepted, phase: "terminal", reasonCode };
  return { requestId: request.requestId, traceId: request.traceId, executionId, state, revision: 1, reasonCode,
    evidence: { scope, phaseTrace: [fresh, accepted, terminal], entryObserved: false, currentFloorBefore: 5, lowestMineLevelBefore: 10, opaqueElevatorTarget: "mine_target", nativeElevatorTransitionObserved: false, currentFloorAfter: 5, lowestMineLevelAfter: 10, lowestMineLevelObserved: false },
    postcondition: { selectedCheckpoint: 10, actualCurrentFloor: 5, observedLowestMineLevel: 10, opaqueElevatorTarget: "mine_target", freshObservation: true, sameExecution: true } };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function assertReceiptCorrelationRejected(
  suffix: string,
  mutateReceipt: (receipt: Record<string, any>) => void,
): Promise<void> {
  const pipeName = `gamebuddy-stardew-portfolio-${suffix}_${process.pid}_${Date.now()}`;
  const phases = PORTFOLIO_SLEEP_DAY_PHASES.map((phase, index) => ({
    requestId: "request_mismatch",
    traceId: "trace_mismatch",
    executionId: "execution_mismatch",
    phase,
    revision: index < 3 ? 1 : 4,
    reasonCode: "observed",
  }));
  const receipt: Record<string, any> = {
    requestId: "request_mismatch",
    traceId: "trace_mismatch",
    executionId: "execution_mismatch",
    state: "succeeded",
    revision: 4,
    reasonCode: "single_player_sleep_and_advance_day_completed",
    evidence: {
      identity: {
        integrationId: PORTFOLIO_INTEGRATION_ID,
        topology: PORTFOLIO_TOPOLOGY,
        saveId: scope.saveId,
        worldId: scope.worldId,
        localPlayerId: scope.localPlayerId,
        companionId: scope.companionId,
        bindingGeneration: scope.bindingGeneration,
        bindingHash: scope.bindingHash,
      },
      phaseTrace: phases.map((phase) => ({ ...phase })),
      irreversiblePhase: "native_sleep_started",
      nativeSleepObserved: true,
      savingObserved: true,
      savedObserved: true,
      dayStartedObserved: true,
      newDayIdentity: "day_02",
      closeObserved: true,
      reopenObserved: true,
    },
    postcondition: {
      beforeRevision: 1,
      afterRevision: 4,
      dayAdvanced: true,
      freshDayStarted: true,
      reopened: true,
      newDayIdentity: "day_02",
    },
  };
  mutateReceipt(receipt);
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage;
        buffer = buffer.subarray(length + 4);
        if (request.type === "hello") {
          socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } }));
        } else if (request.type === "observe_request") {
          socket.write(frame({ ...request, type: "snapshot", payload: snapshot }));
        } else if (request.type === "sleep_day_request") {
          for (const phase of phases) socket.write(frame({ ...request, type: "sleep_day_phase", payload: phase }));
          socket.write(frame({ ...request, type: "sleep_day_receipt", payload: receipt }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token);
    await client.observe();
    await assert.rejects(
      () => client.sleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_mismatch", traceId: "trace_mismatch", idempotencyKey: "idem_mismatch", expectedRevision: 1, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_mismatch" }),
      /portfolio_bridge_closed:portfolio_sleep_day_correlation_mismatch/,
    );
  } finally {
    peer?.destroy();
    await close(server);
  }
}

test("Portfolio bridge authenticates and exposes only observe snapshot", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-test_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage;
        buffer = buffer.subarray(length + 4);
        const payload =
          request.type === "hello"
            ? { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash }
            : {
                protocolVersion: 1,
                integrationId: PORTFOLIO_INTEGRATION_ID,
                topology: PORTFOLIO_TOPOLOGY,
                saveId: scope.saveId,
                worldId: scope.worldId,
                localPlayerId: scope.localPlayerId,
                companionId: scope.companionId,
                bindingGeneration: 1,
                bindingHash: scope.bindingHash,
                revision: 3,
                worldReady: true,
                singlePlayer: true,
                currentLocalPlayerMatches: true,
                state: "ready",
                reasonCode: "accepted",
              };
        socket.write(frame({ ...request, type: request.type === "hello" ? "hello_ack" : "snapshot", payload }));
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject),
  );
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token);
    const snapshot = await client.observe();
    assert.equal(client.state.authenticated, true);
    assert.equal(snapshot.state, "ready");
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("routes sleep/day phases, enforces correlation, and returns only reopened success evidence", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-sleep_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage;
        buffer = buffer.subarray(length + 4);
        if (request.type === "hello") {
          socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } }));
          continue;
        }
        if (request.type === "observe_request") {
          socket.write(frame({ ...request, type: "snapshot", payload: { ...snapshot, revision: 1 } }));
          continue;
        }
        if (request.type === "sleep_day_request") {
          const phases = ["fresh_observed", "accepted", "native_sleep_started", "saving", "saved", "day_started", "close_requested", "reopened", "terminal"] as const;
          for (const [index, phase] of phases.entries()) socket.write(frame({ ...request, type: "sleep_day_phase", payload: { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_01", phase, revision: index < 3 ? 1 : 4, reasonCode: "observed" } }));
          socket.write(frame({ ...request, type: "sleep_day_receipt", payload: { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_01", state: "succeeded", revision: 4, reasonCode: "single_player_sleep_and_advance_day_completed", evidence: { identity: { integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: scope.bindingGeneration, bindingHash: scope.bindingHash }, phaseTrace: phases.map((phase, index) => ({ requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_01", phase, revision: index < 3 ? 1 : 4, reasonCode: "observed" })), irreversiblePhase: "native_sleep_started", nativeSleepObserved: true, savingObserved: true, savedObserved: true, dayStartedObserved: true, newDayIdentity: "day_02", closeObserved: true, reopenObserved: true }, postcondition: { beforeRevision: 1, afterRevision: 4, dayAdvanced: true, freshDayStarted: true, reopened: true, newDayIdentity: "day_02" } } }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token);
    await client.observe();
    const receipt = await client.sleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_01", traceId: "trace_01", idempotencyKey: "idem_01", expectedRevision: 1, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_01" });
    assert.equal(receipt.postcondition.reopened, true);
    assert.deepEqual(receipt.evidence.phaseTrace.map(({ phase }) => phase), [...PORTFOLIO_SLEEP_DAY_PHASES]);
    client.close();
  } finally {
    await close(server);
  }
});

test("M8 probe correlates facts and cannot become a mutation request", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8-probe_${process.pid}_${Date.now()}`;
  const seen: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4); seen.push(request.type);
        if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } }));
        else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot }));
        else if (request.type === "mine_elevator_probe_request") socket.write(frame({ ...request, type: "mine_elevator_probe", payload: { requestId: request.payload.requestId, traceId: request.payload.traceId, scope, revision: 1, fresh: true, entryObserved: true, currentFloor: 5, lowestMineLevel: 10, targetUnlocked: true, selectedCheckpoint: request.payload.selectedCheckpoint } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe();
    const request = mineRequest();
    const probe = await client.probeMineElevator(request as any);
    assert.equal(probe.requestId, request.requestId); assert.equal(probe.revision, request.expectedRevision); assert.equal(probe.targetUnlocked, true);
    assert.deepEqual(seen, ["hello", "observe_request", "mine_elevator_probe_request"]);
    client.close();
  } finally { await close(server); }
});

test("M8 exposes accepted execution identity and resolves only delayed terminal receipt", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4);
        if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } }));
        else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot }));
        else if (request.type === "mine_elevator_request") {
          const phase = { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_m8", phase: "accepted", revision: 1, reasonCode: "accepted" };
          socket.write(frame({ ...request, type: "mine_elevator_phase", payload: phase }));
          setTimeout(() => socket.write(frame({ ...request, type: "mine_elevator_receipt", payload: { requestId: phase.requestId, traceId: phase.traceId, executionId: phase.executionId, state: "blocked", revision: 1, reasonCode: "adapter_unavailable", evidence: { scope, phaseTrace: [{ ...phase, phase: "fresh_observed", reasonCode: "fresh_observed" }, phase, { ...phase, phase: "terminal", reasonCode: "adapter_unavailable" }], entryObserved: false, currentFloorBefore: 5, lowestMineLevelBefore: 10, opaqueElevatorTarget: "mine_target", nativeElevatorTransitionObserved: false, currentFloorAfter: 5, lowestMineLevelAfter: 10, lowestMineLevelObserved: false }, postcondition: { selectedCheckpoint: 10, actualCurrentFloor: 5, observedLowestMineLevel: 10, opaqueElevatorTarget: "mine_target", freshObservation: true, sameExecution: true } } })), 20);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe();
    const started = await client.startMineElevator({ action: "select_mine_elevator_floor", requestId: "request_m8", traceId: "trace_m8", idempotencyKey: "idem_m8", selectedCheckpoint: 10, expectedRevision: 1, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_m8_token_1", scope });
    assert.equal(started.executionId, "execution_m8"); assert.equal((await started.terminal).state, "blocked"); client.close();
  } finally { await close(server); }
});

test("M8 start error rejects acceptance and terminal without an unhandled rejection", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8-start-error_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => { let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return; const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4); if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } })); else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot })); else if (request.type === "mine_elevator_request") socket.write(frame({ ...request, type: "error", payload: { reasonCode: "adapter_unavailable" } })); } }); });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try { const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe(); await assert.rejects(() => client.startMineElevator(mineRequest() as any), /portfolio_bridge_rejected:adapter_unavailable/); assert.equal(client.state.connected, false); } finally { await close(server); }
});

test("M8 rejects a terminal receipt that arrives before accepted", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8-before-accepted_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => { let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return; const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4); if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } })); else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot })); else if (request.type === "mine_elevator_request") socket.write(frame({ ...request, type: "mine_elevator_receipt", payload: mineReceipt(request.payload, "blocked", "adapter_unavailable") })); } }); });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  const onUnhandled = () => undefined;
  process.on("unhandledRejection", onUnhandled);
  try { const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe(); await assert.rejects(() => client.startMineElevator(mineRequest() as any), /portfolio_bridge_closed:portfolio_mine_elevator_receipt_before_acceptance/); } finally { process.off("unhandledRejection", onUnhandled); await close(server); }
});

test("M8 cancellation resolves the original terminal exactly once", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8-cancel_${process.pid}_${Date.now()}`; let terminalWrites = 0;
  const server = createServer((socket) => { let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return; const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4); if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } })); else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot })); else if (request.type === "mine_elevator_request") socket.write(frame({ ...request, type: "mine_elevator_phase", payload: { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_m8_cancel", phase: "accepted", revision: 1, reasonCode: "accepted" } })); else if (request.type === "mine_elevator_cancel_request") { const receipt = mineReceipt(request.payload, "cancelled", "cancelled", "execution_m8_cancel"); socket.write(frame({ ...request, type: "mine_elevator_receipt", payload: receipt })); setTimeout(() => { terminalWrites++; socket.write(frame({ ...request, type: "mine_elevator_receipt", payload: receipt })); }, 10); } } }); });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try { const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe(); const started = await client.startMineElevator(mineRequest() as any); const receipt = await client.cancelMineElevator({ action: "select_mine_elevator_floor", requestId: "request_m8_test", traceId: "trace_m8_test", executionId: started.executionId, cancellationToken: "cancel_m8_test_token_1", scope }); assert.equal(receipt.state, "cancelled"); assert.equal((await started.terminal).reasonCode, "cancelled"); await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(terminalWrites, 1); assert.equal(client.state.connected, false); } finally { await close(server); }
});

test("M8 cancel error rejects cancel and the original terminal, then closes the bridge", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8-cancel-error_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => { let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return; const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4); if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } })); else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot })); else if (request.type === "mine_elevator_request") socket.write(frame({ ...request, type: "mine_elevator_phase", payload: { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_m8_cancel_error", phase: "accepted", revision: 1, reasonCode: "accepted" } })); else if (request.type === "mine_elevator_cancel_request") socket.write(frame({ ...request, type: "error", payload: { reasonCode: "execution_not_active" } })); } }); });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try { const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe(); const started = await client.startMineElevator(mineRequest() as any); const cancel = client.cancelMineElevator({ action: "select_mine_elevator_floor", requestId: "request_m8_test", traceId: "trace_m8_test", executionId: started.executionId, cancellationToken: "cancel_m8_test_token_1", scope }); await assert.rejects(() => cancel, /portfolio_bridge_rejected:execution_not_active/); await assert.rejects(() => started.terminal, /portfolio_bridge_rejected:execution_not_active/); assert.equal(client.state.connected, false); } finally { await close(server); }
});

test("M8 duplicate terminal input fails closed after the original is settled", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-m8-duplicate_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => { let buffer = Buffer.alloc(0); socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const length = buffer.readInt32LE(0); if (buffer.length < length + 4) return; const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage; buffer = buffer.subarray(length + 4); if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } })); else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot })); else if (request.type === "mine_elevator_request") { const phase = { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_m8_duplicate", phase: "accepted", revision: 1, reasonCode: "accepted" }; const receipt = mineReceipt(request.payload, "blocked", "adapter_unavailable", phase.executionId); socket.write(frame({ ...request, type: "mine_elevator_phase", payload: phase })); socket.write(frame({ ...request, type: "mine_elevator_receipt", payload: receipt })); setTimeout(() => socket.write(frame({ ...request, type: "mine_elevator_receipt", payload: receipt })), 10); } } }); });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try { const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token); await client.observe(); const started = await client.startMineElevator(mineRequest() as any); await started.terminal; await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(client.state.connected, false); } finally { await close(server); }
});

test("rejects a receipt with mismatched evidence identity", async () => {
  await assertReceiptCorrelationRejected("identity-mismatch", (receipt) => {
    receipt.evidence.identity.saveId = "other_save";
  });
});

test("rejects a receipt with mismatched ordered phase trace", async () => {
  await assertReceiptCorrelationRejected("trace-mismatch", (receipt) => {
    receipt.evidence.phaseTrace[1].reasonCode = "accepted";
  });
});

test("rejects a receipt from another execution", async () => {
  await assertReceiptCorrelationRejected("execution-mismatch", (receipt) => {
    receipt.executionId = "other_execution";
    receipt.evidence.phaseTrace = receipt.evidence.phaseTrace.map((phase: Record<string, any>) => ({ ...phase, executionId: "other_execution" }));
  });
});

test("rejects a receipt with a trace ID different from its observed phases", async () => {
  await assertReceiptCorrelationRejected("receipt-trace-mismatch", (receipt) => {
    receipt.traceId = "other_trace";
    receipt.evidence.phaseTrace = receipt.evidence.phaseTrace.map((phase: Record<string, any>) => ({ ...phase, traceId: "other_trace" }));
  });
});

test("correlates a receipt execution ID when no phase preceded the receipt", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-receipt_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage;
        buffer = buffer.subarray(length + 4);
        if (request.type === "hello") socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } }));
        else if (request.type === "observe_request") socket.write(frame({ ...request, type: "snapshot", payload: snapshot }));
        else if (request.type === "sleep_day_request") socket.write(frame({ ...request, type: "sleep_day_receipt", payload: { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_receipt_only", state: "blocked", revision: 1, reasonCode: "adapter_unavailable", evidence: { identity: { integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: scope.bindingGeneration, bindingHash: scope.bindingHash }, phaseTrace: [{ requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_receipt_only", phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" }, { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_receipt_only", phase: "terminal", revision: 1, reasonCode: "adapter_unavailable" }], irreversiblePhase: "none", nativeSleepObserved: false, savingObserved: false, savedObserved: false, dayStartedObserved: false, newDayIdentity: "none", closeObserved: false, reopenObserved: false }, postcondition: { beforeRevision: 1, afterRevision: 1, dayAdvanced: false, freshDayStarted: false, reopened: false, newDayIdentity: "none" } } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token);
    await client.observe();
    const receipt = await client.sleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_receipt", traceId: "trace_receipt", idempotencyKey: "idem_receipt", expectedRevision: 1, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_receipt" });
    assert.equal(receipt.executionId, "execution_receipt_only");
    client.close();
  } finally {
    await close(server);
  }
});

test("binds cancellation to the pending request trace, execution, and token", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-cancel_${process.pid}_${Date.now()}`;
  let cancelPayload: Record<string, unknown> | undefined;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage;
        buffer = buffer.subarray(length + 4);
        if (request.type === "hello") {
          socket.write(frame({ ...request, type: "hello_ack", payload: { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash } }));
        } else if (request.type === "observe_request") {
          socket.write(frame({ ...request, type: "snapshot", payload: snapshot }));
        } else if (request.type === "sleep_day_request") {
          socket.write(frame({ ...request, type: "sleep_day_receipt", payload: {
            requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_cancel",
            state: "uncertain", revision: 1, reasonCode: "execution_armed",
            evidence: { identity: { integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: scope.bindingGeneration, bindingHash: scope.bindingHash }, phaseTrace: [
              { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_cancel", phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" },
              { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: "execution_cancel", phase: "terminal", revision: 1, reasonCode: "execution_armed" },
            ], irreversiblePhase: "none", nativeSleepObserved: false, savingObserved: false, savedObserved: false, dayStartedObserved: false, newDayIdentity: "none", closeObserved: false, reopenObserved: false },
            postcondition: { beforeRevision: 1, afterRevision: 1, dayAdvanced: false, freshDayStarted: false, reopened: false, newDayIdentity: "none" },
          } }));
        } else if (request.type === "sleep_day_cancel_request") {
          cancelPayload = request.payload;
          socket.write(frame({ ...request, type: "sleep_day_receipt", payload: {
            requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: request.payload.executionId,
            state: "cancelled", revision: 1, reasonCode: "cancelled",
            evidence: { identity: { integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: scope.bindingGeneration, bindingHash: scope.bindingHash }, phaseTrace: [
              { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: request.payload.executionId, phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" },
              { requestId: request.payload.requestId, traceId: request.payload.traceId, executionId: request.payload.executionId, phase: "terminal", revision: 1, reasonCode: "cancelled" },
            ], irreversiblePhase: "none", nativeSleepObserved: false, savingObserved: false, savedObserved: false, dayStartedObserved: false, newDayIdentity: "none", closeObserved: false, reopenObserved: false },
            postcondition: { beforeRevision: 1, afterRevision: 1, dayAdvanced: false, freshDayStarted: false, reopened: false, newDayIdentity: "none" },
          } }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token);
    await client.observe();
    await assert.rejects(() => client.cancelSleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_cancel", traceId: "trace_cancel", executionId: "execution_cancel", cancellationToken: "cancel_cancel" }), /portfolio_sleep_day_cancel_not_pending/);
    await client.sleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_cancel", traceId: "trace_cancel", idempotencyKey: "idem_cancel", expectedRevision: 1, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_cancel" });
    await assert.rejects(() => client.cancelSleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_cancel", traceId: "wrong_trace", executionId: "execution_cancel", cancellationToken: "cancel_cancel" }), /portfolio_sleep_day_cancel_not_pending/);
    const receipt = await client.cancelSleepAndAdvanceDay({ action: "single_player_sleep_and_advance_day", requestId: "request_cancel", traceId: "trace_cancel", executionId: "execution_cancel", cancellationToken: "cancel_cancel" });
    assert.equal(receipt.state, "cancelled");
    assert.deepEqual(cancelPayload, { action: "single_player_sleep_and_advance_day", requestId: "request_cancel", traceId: "trace_cancel", executionId: "execution_cancel", cancellationToken: "cancel_cancel" });
    client.close();
  } finally {
    await close(server);
  }
});

test("emits native invalidation snapshot and closes the observe session", async () => {
  const pipeName = `gamebuddy-stardew-portfolio-invalidation_${process.pid}_${Date.now()}`;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()) as PortfolioMessage;
        buffer = buffer.subarray(length + 4);
        const payload =
          request.type === "hello"
            ? { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash }
            : {
                protocolVersion: 1,
                integrationId: PORTFOLIO_INTEGRATION_ID,
                topology: PORTFOLIO_TOPOLOGY,
                saveId: scope.saveId,
                worldId: scope.worldId,
                localPlayerId: scope.localPlayerId,
                companionId: scope.companionId,
                bindingGeneration: 1,
                bindingHash: scope.bindingHash,
                revision: 4,
                worldReady: false,
                singlePlayer: true,
                currentLocalPlayerMatches: false,
                state: "invalidated",
                reasonCode: "portfolio_saving",
              };
        socket.write(frame({ ...request, type: request.type === "hello" ? "hello_ack" : "snapshot", payload }));
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject),
  );
  try {
    const client = await PortfolioStardewBridgeClient.connect(scope, pipeName, token);
    const snapshots: string[] = [];
    const closes: string[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot.state));
    client.onClose((reason) => closes.push(reason));
    await assert.rejects(() => client.observe(), /native_invalidation:portfolio_saving|portfolio_bridge_closed/);
    assert.equal(snapshots.at(-1), "invalidated");
    assert.equal(closes.at(-1), "native_invalidation:portfolio_saving");
  } finally {
    await close(server);
  }
});
