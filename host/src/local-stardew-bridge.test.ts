import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { BridgeMessage, Scope } from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "farmhand_01",
  companionId: "companion_01",
};
const token = "phase2_test_token_1234";

function frame(value: unknown): Buffer {
  return rawFrame(JSON.stringify(value));
}

function rawFrame(json: string): Buffer {
  const payload = Buffer.from(json, "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}

test("local Stardew bridge keeps the newest snapshot revision from a delayed response", async () => {
  const pipeName = `gamebuddy_phase2_monotonic_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let snapshotsWritten: (() => void) | undefined;
  const written = new Promise<void>((resolvePromise) => {
    snapshotsWritten = resolvePromise;
  });
  const server = createServer((socket: Socket) => {
    peer = socket;
    socket.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.subarray(4).toString("utf8")) as BridgeMessage;
      socket.write(
        frame({
          ...request,
          messageId: "mod_hello_01",
          type: "hello_ack",
          payload: { sessionId: "session_01", capabilities: ["inspect_self"], presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published"}] },
        }),
      );
      socket.write(
        frame({
          ...request,
          messageId: "snapshot_new",
          type: "snapshot",
          correlationId: "snapshot_new",
          payload: {
            revision: 8,
            location: "Farm",
            tile: { x: 5, y: 8 },
            stamina: 250,
            health: 100,
            actionable: true,
            capabilities: ["inspect_self"],
            presentationLocale: "en-US",
            activeExecution: null,
          },
        }),
      );
      socket.write(
        frame({
          ...request,
          messageId: "snapshot_old",
          type: "snapshot",
          correlationId: "snapshot_old",
          payload: {
            revision: 7,
            location: "Farm",
            tile: { x: 4, y: 8 },
            stamina: 250,
            health: 100,
            actionable: true,
            capabilities: ["inspect_self"],
            presentationLocale: "en-US",
            activeExecution: null,
          },
        }),
        () => snapshotsWritten?.(),
      );
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    await written;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    assert.equal(client.state.snapshot?.revision, 8);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge rejects a duplicate-key raw named-pipe frame before JSON.parse can collapse it", async () => {
  const pipeName = `gamebuddy_duplicate_key_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let sendDuplicateInbound: (() => void) | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    socket.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.subarray(4).toString("utf8")) as BridgeMessage;
      socket.write(
        frame({
          ...request,
          messageId: "mod_hello_duplicate_key",
          type: "hello_ack",
          payload: { sessionId: "session_duplicate_key", capabilities: [], presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published"}] },
        }),
      );
    });
    sendDuplicateInbound = () =>
      socket.write(
        rawFrame(
          `{"protocolVersion":1,"messageId":"duplicate_key_01","correlationId":"duplicate_key_01","timestampMs":${Date.now()},"scope":{"integrationId":"stardew","saveId":"save_01","worldId":"world_01","playerId":"farmhand_01","companionId":"companion_01"},"type":"lifecycle","payload":{"state":"connected","state":"disconnected","reasonCode":"duplicate_key"}}`,
        ),
      );
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    assert.ok(sendDuplicateInbound !== undefined);
    sendDuplicateInbound();
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "malformed_inbound_json" });
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge forwards a validated player_input semantic event", async () => {
  const pipeName = `gamebuddy_player_control_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let sendInbound: ((message: unknown) => void) | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        socket.write(
          frame(
            request.type === "hello"
              ? {
                  ...request,
                  messageId: "mod_hello_player_control",
                  type: "hello_ack",
                  payload: { sessionId: "session_player_control", capabilities: [], presentationLocale: "zh-CN", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published"}] },
                }
              : {
                  ...request,
                  messageId: "mod_snapshot_player_control",
                  type: "snapshot",
                  payload: {
                    revision: 7,
                    location: "Farm",
                    tile: { x: 4, y: 8 },
                    stamina: 250,
                    health: 100,
                    actionable: true,
                    capabilities: [],
                    presentationLocale: "zh-CN",
                    activeExecution: null,
                  },
                },
          ),
        );
      }
    });
    sendInbound = (message) => socket.write(frame(message));
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const received = new Promise<Extract<BridgeMessage, { type: "semantic_event" }>>((resolvePromise) => {
      client.onFact((fact) => {
        if (fact.type === "semantic_event") resolvePromise(fact);
      });
    });
    const diagnostics: Readonly<{ stage: string; reasonCode: string }>[] = [];
    client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    assert.ok(sendInbound !== undefined);
    sendInbound({
      protocolVersion: 1,
      messageId: "player_event_01",
      correlationId: "player_control_01",
      timestampMs: Date.now(),
      scope,
      type: "semantic_event",
      payload: {
        kind: "player_input",
        revision: 7,
        activeExecution: null,
        reasonCode: "player_control",
        playerControl: {
          kind: "player_input",
          controlId: "control_01",
          sourceEventId: "source_01",
          text: "synthetic native player input",
          locale: "zh-CN",
          issuerPlayerId: "host_01",
        },
      },
    });
    const fact = await received;
    assert.equal(fact.payload.kind, "player_input");
    assert.equal(fact.payload.playerControl?.sourceEventId, "source_01");
    assert.deepEqual(diagnostics, [
      { stage: "native_chat_bridge_inbound_frame_received", reasonCode: "received" },
      { stage: "native_chat_bridge_player_control_validated", reasonCode: "accepted" },
    ]);
    assert.equal(client.state.connected, true);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge reports a fixed diagnostic then closes on rejected player control", async () => {
  const pipeName = `gamebuddy_player_control_reject_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let sendInbound: ((message: unknown) => void) | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        socket.write(
          frame({
            ...request,
            messageId: "mod_hello_player_control_reject",
            type: "hello_ack",
            payload: { sessionId: "session_player_control_reject", capabilities: [], presentationLocale: "zh-CN", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published"}] },
          }),
        );
      }
    });
    sendInbound = (message) => socket.write(frame(message));
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const diagnostics: Readonly<{ stage: string; reasonCode: string }>[] = [];
    let resolveRejectedDiagnostic: ((value: Readonly<{ stage: string; reasonCode: string }>) => void) | undefined;
    const rejectedDiagnostic = new Promise<Readonly<{ stage: string; reasonCode: string }>>((resolvePromise) => {
      resolveRejectedDiagnostic = resolvePromise;
    });
    client.onDiagnostic((diagnostic) => {
      diagnostics.push(diagnostic);
      if (diagnostic.stage === "native_chat_bridge_inbound_rejected") resolveRejectedDiagnostic?.(diagnostic);
    });
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    let facts = 0;
    client.onFact(() => facts++);
    assert.ok(sendInbound !== undefined);
    sendInbound({
      protocolVersion: 1,
      messageId: "player_event_reject_01",
      correlationId: "player_control_reject_01",
      timestampMs: Date.now(),
      scope,
      type: "semantic_event",
      payload: {
        kind: "player_input",
        revision: 7,
        activeExecution: null,
        reasonCode: "player_control",
        playerControl: {
          kind: "player_input",
          controlId: "control_reject_01",
          sourceEventId: "source_reject_01",
          text: "synthetic native player input",
          locale: "zh-CN",
          // Missing issuerPlayerId must remain a fail-closed shape rejection.
        },
      },
    });
    assert.deepEqual(await rejectedDiagnostic, {
      stage: "native_chat_bridge_inbound_rejected",
      reasonCode: "malformed_player_control",
    });
    assert.deepEqual(diagnostics, [
      { stage: "native_chat_bridge_inbound_frame_received", reasonCode: "received" },
      { stage: "native_chat_bridge_inbound_rejected", reasonCode: "malformed_player_control" },
    ]);
    assert.equal((await disconnected).reasonCode, "invalid_semantic_event");
    assert.equal(facts, 0);
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge delivers one exact-correlated terminal receipt across the actual named-pipe boundary", async () => {
  // This Node named-pipe peer is protocol-shaped test infrastructure only. It
  // proves neither C# LocalPipeBridge/coordinator outbound completion nor native
  // action, authorization, game-thread, postcondition, backpressure,
  // disconnect-recovery, or live-closure behavior.
  const pipeName = `gamebuddy_execution_receipt_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let receivedExecutionRequest: Extract<BridgeMessage, { type: "execution_request" }> | undefined;
  let terminalReceiptsWritten = 0;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (request.type === "hello") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_hello_execution_receipt",
              type: "hello_ack",
              payload: {
                sessionId: "session_execution_receipt",
                capabilities: ["move_to_tile"],
                presentationLocale: "en-US",
                registrations: [
                  { actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published" },
                ],
              },
            }),
          );
          continue;
        }
        if (request.type !== "execution_request") continue;
        receivedExecutionRequest = request;
        // Deliberately emit one response only, with the request's correlation
        // and request identity; this fixture never emits a wrong or duplicate receipt.
        terminalReceiptsWritten++;
        socket.write(
          frame({
            protocolVersion: 1,
            messageId: "mod_execution_receipt_01",
            correlationId: request.correlationId,
            timestampMs: Date.now(),
            scope,
            type: "execution_receipt",
            payload: {
              executionId: "execution_receipt_01",
              requestId: request.payload.requestId,
              state: "succeeded",
              reasonCode: "completed",
              revision: 7,
              evidence: { fixture: "protocol_shaped_named_pipe_peer" },
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const facts: Extract<BridgeMessage, { type: "execution_receipt" }>[] = [];
    let diagnostics = 0;
    let closes = 0;
    client.onFact((fact) => {
      if (fact.type === "execution_receipt") facts.push(fact);
    });
    client.onDiagnostic((diagnostic) => {
      if (diagnostic.stage === "native_chat_bridge_inbound_rejected") diagnostics++;
    });
    client.onConnectionFact(() => closes++);

    const receipt = await client.execute({
      requestId: "request_receipt_01",
      idempotencyKey: "idempotency_receipt_01",
      action: "move_to_tile",
      args: { x: 4, y: 8 },
      expectedRevision: 7,
      deadlineMs: Date.now() + 10_000,
    });

    assert.equal(terminalReceiptsWritten, 1);
    assert.equal(receivedExecutionRequest?.protocolVersion, 1);
    assert.deepEqual(receivedExecutionRequest?.scope, scope);
    assert.equal(receivedExecutionRequest?.correlationId, facts[0]?.correlationId);
    assert.equal(receivedExecutionRequest?.payload.requestId, "request_receipt_01");
    assert.equal(receivedExecutionRequest?.payload.idempotencyKey, "idempotency_receipt_01");
    assert.equal(receivedExecutionRequest?.payload.action, "move_to_tile");
    assert.deepEqual(receivedExecutionRequest?.payload.args, { x: 4, y: 8 });
    assert.equal(receivedExecutionRequest?.payload.expectedRevision, 7);
    assert.ok((receivedExecutionRequest?.payload.deadlineMs ?? 0) > Date.now());
    assert.equal(receipt.requestId, "request_receipt_01");
    assert.equal(receipt.executionId, "execution_receipt_01");
    assert.equal(receipt.state, "succeeded");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.payload.requestId, receipt.requestId);
    assert.equal(facts[0]?.payload.executionId, receipt.executionId);
    assert.equal(diagnostics, 0);
    assert.equal(closes, 0);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge delivers an exact-correlated system notice receipt", async () => {
  const pipeName = `gamebuddy_system_notice_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let receivedNotice: Extract<BridgeMessage, { type: "system_notice_request" }> | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (request.type === "hello") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_hello_system_notice",
              type: "hello_ack",
              payload: { sessionId: "session_system_notice", capabilities: [], presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published"}] },
            }),
          );
          continue;
        }
        if (request.type !== "system_notice_request") continue;
        receivedNotice = request;
        socket.write(
          frame({
            protocolVersion: 1,
            messageId: "mod_system_notice_receipt",
            correlationId: request.correlationId,
            timestampMs: Date.now(),
            scope,
            type: "system_notice_receipt",
            payload: { noticeId: request.payload.noticeId, revision: 19 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    await client.presentSystemNotice({
      noticeId: "stop_notice_01",
      key: "system.stop.active_turn_cancelled",
      text: "Generation stopped.",
      locale: "en-US",
    });
    assert.deepEqual(receivedNotice?.payload, {
      noticeId: "stop_notice_01",
      key: "system.stop.active_turn_cancelled",
      text: "Generation stopped.",
      locale: "en-US",
    });
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge authenticates and observes Mod-declared capabilities", async () => {
  const pipeName = `gamebuddy_phase2_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        const response =
          request.type === "hello"
            ? {
                ...request,
                messageId: "mod_hello_01",
                type: "hello_ack",
                payload: { sessionId: "session_01", capabilities: ["move_to_tile"], presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published"}] },
              }
            : {
                ...request,
                messageId: "mod_snapshot_01",
                type: "snapshot",
                payload: {
                  revision: 7,
                  location: "Farm",
                  tile: { x: 4, y: 8 },
                  stamina: 250,
                  health: 100,
                  actionable: true,
                  capabilities: ["move_to_tile"],
                  presentationLocale: "en-US",
                  activeExecution: null,
                },
              };
        socket.write(frame(response));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    assert.equal(client.state.authenticated, true);
    assert.deepEqual(client.state.capabilities, ["move_to_tile"]);
    const snapshot = await client.observe();
    assert.equal(snapshot.revision, 7);
    assert.deepEqual(snapshot.tile, { x: 4, y: 8 });
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge sends the typed cancel identity tuple for every cancel_request frame", async () => {
  const pipeName = `gamebuddy_cancel_identity_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  const cancelPayloads: Extract<BridgeMessage, { type: "cancel_request" }>["payload"][] = [];
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (request.type === "hello") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_hello_cancel_identity",
              type: "hello_ack",
              payload: {
                sessionId: "session_cancel_identity",
                capabilities: ["move_to_tile"],
                presentationLocale: "en-US",
                registrations: [
                  { actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published" },
                ],
              },
            }),
          );
          continue;
        }
        if (request.type !== "cancel_request") continue;
        cancelPayloads.push(request.payload);
        socket.write(
          frame({
            protocolVersion: 1,
            messageId: "mod_cancel_receipt_01",
            correlationId: request.correlationId,
            timestampMs: Date.now(),
            scope,
            type: "execution_receipt",
            payload: {
              executionId: request.payload.executionId,
              requestId: request.payload.requestId,
              state: "cancelled",
              reasonCode: "stop_requested",
              revision: 5,
              evidence: null,
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const first = await client.cancel("cancel_request_01", "cancel_execution_01", "stop_requested");

    const replay = await client.cancel("cancel_request_01", "cancel_execution_01", "stop_requested");
    const other = await client.cancel("cancel_request_02", "cancel_execution_02", "stop_requested");
    assert.equal(cancelPayloads.length, 3);
    // One stable cancelId per request; cancelEpoch strictly increases per attempt.
    assert.equal(cancelPayloads[0].cancelId, cancelPayloads[1].cancelId);
    assert.equal(cancelPayloads[0].cancelEpoch, 1);
    assert.equal(cancelPayloads[1].cancelEpoch, 2);
    assert.notEqual(cancelPayloads[2].cancelId, cancelPayloads[0].cancelId);
    assert.equal(cancelPayloads[2].cancelEpoch, 1);
    for (const payload of cancelPayloads) {
      assert.equal(
        payload.requestId,
        payload.executionId === "cancel_execution_01" ? "cancel_request_01" : "cancel_request_02",
      );
      assert.match(payload.cancelId, /^[A-Za-z0-9_-]{1,128}$/);
      assert.ok(Number.isSafeInteger(payload.cancelEpoch) && payload.cancelEpoch >= 1);
      assert.equal(payload.reasonCode, "stop_requested");
    }
    assert.equal(first.state, "cancelled");
    assert.equal(replay.state, "cancelled");
    assert.equal(other.state, "cancelled");
    assert.equal(client.state.latestReceipt?.executionId, "cancel_execution_02");
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});
