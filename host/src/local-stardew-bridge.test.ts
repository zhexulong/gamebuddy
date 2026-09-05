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
          payload: {
            sessionId: "session_01",
            capabilities: ["inspect_self"],
            catalogRevision: 1,
            enabledActionIds: [],
            presentationLocale: "en-US",
            registrations: [
              {
                actionId: "move_to_tile",
                familyId: "movement_navigation",
                identityVersion: 1,
                    lifecycle: "published",
                    kind: "execution",
              },
            ],
            runtimeRole: "native_local_fixture",
            launchGeneration: null,
          },
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
            catalogRevision: 1,
            enabledActionIds: [],
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
            catalogRevision: 1,
            enabledActionIds: [],
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
    assert.equal(client.state.catalogRevision, 1);
    assert.deepEqual(client.state.enabledActionIds, []);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge coalesces catalog refreshes and rejects stale authority", async () => {
  const pipeName = `gamebuddy_catalog_refresh_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let observeRequests = 0;
  const observeResponses: Array<() => void> = [];
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
              messageId: "catalog_hello",
              type: "hello_ack",
              payload: {
                sessionId: "catalog_session",
                capabilities: ["inspect_self"],
                catalogRevision: 1,
                enabledActionIds: [],
                presentationLocale: "en-US",
                registrations: [
                  {
                    actionId: "move_to_tile",
                    familyId: "movement_navigation",
                    identityVersion: 1,
                    lifecycle: "published",
                    kind: "execution",
                  },
                ],
                runtimeRole: "native_local_fixture",
                launchGeneration: null,
              },
            }),
          );
          continue;
        }
        if (request.type === "observe_request") {
          observeRequests++;
          const catalogRevision = observeRequests === 1 ? 2 : 3;
          const snapshotRevision = observeRequests === 1 ? 20 : 21;
          observeResponses.push(() =>
            socket.write(
              frame({
                ...request,
                messageId: `catalog_snapshot_${catalogRevision}`,
                type: "snapshot",
                payload: {
                  revision: snapshotRevision,
                  location: "Farm",
                  tile: { x: 5, y: 8 },
                  stamina: 250,
                  health: 100,
                  actionable: true,
                  capabilities: ["inspect_self"],
                  catalogRevision,
                  enabledActionIds: ["move_to_tile"],
                  presentationLocale: "en-US",
                  activeExecution: null,
                },
              }),
            ),
          );
        }
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const catalogRevision = () => client.state.catalogRevision;
    const snapshotRevision = () => client.state.snapshot?.revision;
    const catalogUpdate = (revision: number) =>
      peer?.write(
        frame({
          protocolVersion: 1,
          messageId: `catalog_update_${revision}`,
          correlationId: `catalog_update_${revision}`,
          timestampMs: Date.now(),
          scope,
          type: "catalog_update",
          payload: { catalogRevision: revision, enabledActionIds: ["move_to_tile"] },
        }),
      );

    catalogUpdate(2);
    for (let attempt = 0; attempt < 20 && catalogRevision() !== 2; attempt++)
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    assert.equal(client.state.snapshot, null);
    assert.equal(catalogRevision(), 2);
    assert.equal(observeRequests, 1);
    const refresh1 = client.refreshAfterCatalogUpdate();
    const refresh2 = client.refreshAfterCatalogUpdate();
    assert.strictEqual(refresh1, refresh2);

    catalogUpdate(3);
    for (let attempt = 0; attempt < 20 && catalogRevision() !== 3; attempt++)
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    assert.equal(catalogRevision(), 3);
    assert.equal(observeRequests, 1);
    observeResponses[0]?.();
    for (let attempt = 0; attempt < 20 && observeRequests < 2; attempt++)
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    assert.equal(observeRequests, 2);
    observeResponses[1]?.();
    const snapshot = await refresh1;
    assert.equal(snapshot.catalogRevision, 3);
    assert.equal(snapshotRevision(), 21);

    peer?.write(
      frame({
        protocolVersion: 1,
        messageId: "catalog_snapshot_stale",
        correlationId: "catalog_snapshot_stale",
        timestampMs: Date.now(),
        scope,
        type: "snapshot",
        payload: {
          revision: 22,
          location: "Farm",
          tile: { x: 1, y: 1 },
          stamina: 1,
          health: 1,
          actionable: true,
          capabilities: ["inspect_self"],
          catalogRevision: 2,
          enabledActionIds: ["move_to_tile"],
          presentationLocale: "en-US",
          activeExecution: null,
        },
      }),
    );
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(snapshotRevision(), 21);

    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    catalogUpdate(3);
    assert.deepEqual(await disconnected, {
      state: "disconnected",
      reasonCode: "invalid_catalog_update_authority",
    });
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
          payload: {
            sessionId: "session_duplicate_key",
            capabilities: [],
            catalogRevision: 1,
            enabledActionIds: [],
            presentationLocale: "en-US",
            registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
            runtimeRole: "native_local_fixture",
            launchGeneration: null,
          },
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
                  payload: { sessionId: "session_player_control", capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "zh-CN", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
      { stage: "pipe_bytes_received", reasonCode: "observed" },
      { stage: "pipe_frame_header_accepted", reasonCode: "observed" },
      { stage: "pipe_frame_payload_complete", reasonCode: "observed" },
      { stage: "native_chat_bridge_inbound_frame_received", reasonCode: "received" },
      { stage: "native_chat_bridge_player_control_validated", reasonCode: "accepted" },
      { stage: "pipe_frame_dispatched", reasonCode: "observed" },
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
             payload: { sessionId: "session_player_control_reject", capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "zh-CN", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
      { stage: "pipe_bytes_received", reasonCode: "observed" },
      { stage: "pipe_frame_header_accepted", reasonCode: "observed" },
      { stage: "pipe_frame_payload_complete", reasonCode: "observed" },
      { stage: "native_chat_bridge_inbound_frame_received", reasonCode: "received" },
      { stage: "native_chat_bridge_inbound_rejected", reasonCode: "malformed_player_control" },
      { stage: "pipe_frame_dispatched", reasonCode: "observed" },
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
                 catalogRevision: 1,
                 enabledActionIds: ["move_to_tile"],
                 presentationLocale: "en-US",
                 registrations: [
                   { actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" },
                 ],
                 runtimeRole: "native_local_fixture",
                 launchGeneration: null,
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
              actionId: request.payload.action,
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
              payload: { sessionId: "session_system_notice", capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "en-US", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
                 payload: { sessionId: "session_01", capabilities: ["move_to_tile"], catalogRevision: 1, enabledActionIds: ["move_to_tile"], presentationLocale: "en-US", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
                  catalogRevision: 1,
                  enabledActionIds: ["move_to_tile"],
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
                catalogRevision: 1,
                enabledActionIds: ["move_to_tile"],
                presentationLocale: "en-US",
                registrations: [
                  { actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" },
                ],
                runtimeRole: "native_local_fixture",
                launchGeneration: null,
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
              actionId: "move_to_tile",
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


async function withNavigationBridge(
  name: string,
  onNavigation: (socket: Socket, request: Extract<BridgeMessage, { type: "navigation_read_request" }>) => void,
  run: (client: LocalStardewBridgeClient, peer: Socket) => Promise<void>,
): Promise<void> {
  const pipeName = `gamebuddy_navigation_${name}_${process.pid}_${Date.now()}`;
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
        if (request.type === "hello") {
          socket.write(frame({ ...request, messageId: `hello_${name}`, type: "hello_ack", payload: { sessionId: `session_${name}`, capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "en-US", registrations: [{ actionId: "find_destination", familyId: "world_navigation", identityVersion: 1, lifecycle: "published", kind: "read_only" }], runtimeRole: "native_local_fixture", launchGeneration: null } }));
        } else if (request.type === "navigation_read_request") onNavigation(socket, request);
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise).once("error", reject));
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    assert.ok(peer !== undefined);
    await run(client, peer);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
}

test("navigationRead dispatches an exact-correlated request without mutating bridge state or facts", async () => {
  let received: Extract<BridgeMessage, { type: "navigation_read_request" }> | undefined;
  await withNavigationBridge("success", (socket, request) => {
    received = request;
    socket.write(frame({ ...request, messageId: "nav_result_success", type: "navigation_read_result", payload: { status: "resolved", reason: "exact_current_locale", entries: null, nextCursor: null, candidates: null, destination: { kind: "label", label: "Farm", ref: null }, unlockState: "unknown" } }));
  }, async (client) => {
    const before = client.state;
    let facts = 0;
    client.onFact(() => facts++);
    const result = await client.navigationRead({ operation: "find_destination", args: { query: "Farm" } });
    assert.equal(received?.type, "navigation_read_request");
    assert.deepEqual(received?.payload, { operation: "find_destination", args: { query: "Farm" } });
    assert.equal(result.status, "resolved");
    assert.equal(facts, 0);
    assert.equal(client.state.snapshot, before.snapshot);
    assert.equal(client.state.latestReceipt, before.latestReceipt);
    assert.deepEqual(client.state.enabledActionIds, before.enabledActionIds);
  });
});

test("navigationRead rejects a wrong correlated response type without admitting its state", async () => {
  await withNavigationBridge("wrong_type", (socket, request) => {
    socket.write(frame({ ...request, messageId: "nav_wrong_snapshot", type: "snapshot", payload: { revision: 99, location: "Farm", tile: { x: 1, y: 1 }, stamina: 1, health: 1, actionable: true, capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "en-US", activeExecution: null } }));
  }, async (client) => {
    await assert.rejects(client.navigationRead({ operation: "inspect_world_map", args: {} }), /unexpected_navigation_read_response/);
    assert.equal(client.state.snapshot, null);
    assert.equal(client.state.latestReceipt, null);
  });
});

test("navigationRead rejects a wrong correlated receipt without mutating receipt state", async () => {
  await withNavigationBridge("wrong_receipt", (socket, request) => {
    socket.write(frame({ ...request, messageId: "nav_wrong_receipt", type: "execution_receipt", payload: { executionId: "wrong_execution", requestId: "wrong_request", actionId: "move_to_tile", state: "succeeded", reasonCode: "completed", revision: 1, evidence: {} } }));
  }, async (client) => {
    await assert.rejects(client.navigationRead({ operation: "inspect_world_map", args: {} }), /unexpected_navigation_read_response/);
    assert.equal(client.state.latestReceipt, null);
  });
});

test("local bridge rejects an inbound navigation_read_request", async () => {
  await withNavigationBridge("inbound", () => undefined, async (client, peer) => {
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) => client.onConnectionFact(resolvePromise));
    peer.write(frame({ protocolVersion: 1, messageId: "inbound_nav", correlationId: "inbound_nav", timestampMs: Date.now(), scope, type: "navigation_read_request", payload: { operation: "inspect_world_map", args: {} } }));
    assert.equal((await disconnected).reasonCode, "unexpected_inbound_request");
  });
});


async function withBodyProgramBridge(
  name: string,
  respond: (socket: Socket, request: Extract<BridgeMessage, { type: "program_events" }>) => void,
  run: (client: LocalStardewBridgeClient) => Promise<void>,
): Promise<void> {
  const pipeName = `gamebuddy_body_program_${name}_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(length + 4);
        if (request.type === "hello") {
          socket.write(frame({
            ...request,
            messageId: `body_program_hello_${name}`,
            type: "hello_ack",
            payload: {
              sessionId: `body_program_session_${name}`,
              capabilities: [],
              catalogRevision: 1,
              enabledActionIds: [],
              presentationLocale: "en-US",
              registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
              runtimeRole: "native_local_fixture",
              launchGeneration: null,
            },
          }));
        } else if (request.type === "program_events") {
          respond(socket, request);
        }
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise).once("error", reject));
  try {
    await run(await LocalStardewBridgeClient.connect(scope, pipeName, token));
  } finally {
    peer?.destroy();
    await close(server);
  }
}

test("body program closes the named pipe for a structurally valid wrong correlated response", async () => {
  await withBodyProgramBridge("wrong_correlated_response", (socket, request) => {
    socket.write(frame({
      ...request,
      messageId: "body_program_wrong_type",
      type: "program_status_result",
      payload: { programId: request.payload.programId, status: "accepted", catalogRevision: 1 },
    }));
  }, async (client) => {
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    await assert.rejects(
      client.programEvents({ programId: "program_01", cursor: 0, pageSize: 1 }),
      /body_program_protocol_invalid/,
    );
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "body_program_protocol_invalid" });
    assert.equal(client.state.connected, false);
  });
});

test("body program closes the named pipe for a wrong correlated programId", async () => {
  await withBodyProgramBridge("wrong_program_id", (socket, request) => {
    socket.write(frame({
      ...request,
      messageId: "body_program_wrong_program",
      type: "program_events_result",
      payload: { programId: "foreign_program", nextCursor: 1, events: [{ cursor: 1, kind: "accepted", catalogRevision: 1 }] },
    }));
  }, async (client) => {
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    await assert.rejects(
      client.programEvents({ programId: "program_01", cursor: 0, pageSize: 1 }),
      /body_program_protocol_invalid/,
    );
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "body_program_protocol_invalid" });
    assert.equal(client.state.connected, false);
  });
});

test("body program closes the named pipe when events exceed the requested page size", async () => {
  await withBodyProgramBridge("page_size", (socket, request) => {
    socket.write(frame({
      ...request,
      messageId: "body_program_excess_events",
      type: "program_events_result",
      payload: {
        programId: request.payload.programId,
        nextCursor: 2,
        events: [
          { cursor: 1, kind: "accepted", catalogRevision: 1 },
          { cursor: 2, kind: "running", catalogRevision: 1 },
        ],
      },
    }));
  }, async (client) => {
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    await assert.rejects(
      client.programEvents({ programId: "program_01", cursor: 0, pageSize: 1 }),
      /body_program_protocol_invalid/,
    );
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "body_program_protocol_invalid" });
    assert.equal(client.state.connected, false);
  });
});

test("body program requests forward exact authenticated messages and retain modeled rejections", async () => {
  const pipeName = `gamebuddy_body_program_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  const requests: BridgeMessage[] = [];
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(length + 4);
        requests.push(request);
        if (request.type === "hello") {
          socket.write(frame({ ...request, messageId: "body_program_hello", type: "hello_ack", payload: {
            sessionId: "body_program_session", capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "en-US",
            registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
            runtimeRole: "native_local_fixture", launchGeneration: null,
          } }));
          continue;
        }
        const bodyProgramRequest = request as Readonly<{
          type: "program_verify" | "program_submit" | "program_status" | "program_events";
          payload: Readonly<{ programId: string; cursor?: number }>;
        }>;
        const payload = bodyProgramRequest.type === "program_status"
          ? { programId: bodyProgramRequest.payload.programId, status: "accepted", catalogRevision: 1 }
          : bodyProgramRequest.type === "program_events"
            ? { programId: bodyProgramRequest.payload.programId, nextCursor: (bodyProgramRequest.payload.cursor ?? 0) + 1, events: [{ cursor: (bodyProgramRequest.payload.cursor ?? 0) + 1, kind: "accepted", catalogRevision: 1 }] }
            : { programId: bodyProgramRequest.payload.programId, status: "rejected", diagnostics: ["program_id_conflict"] };
        const type = request.type === "program_verify" ? "program_verify_result" : request.type === "program_submit" ? "program_submit_result" : request.type === "program_status" ? "program_status_result" : "program_events_result";
        socket.write(frame({ ...request, messageId: `body_program_${type}`, type, payload }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise).once("error", reject));
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token);
    const candidate = { programId: "program_01", nodes: [{ nodeId: "node_01", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {}, deadlineMs: Date.now() + 10_000 }] } as const;
    assert.equal((await client.programVerify(candidate)).status, "rejected");
    assert.equal((await client.programSubmit(candidate)).status, "rejected");
    assert.equal((await client.programStatus({ programId: "program_01" })).catalogRevision, 1);
    assert.equal((await client.programEvents({ programId: "program_01", cursor: 0, pageSize: 1 })).nextCursor, 1);
    assert.deepEqual(requests.slice(1).map((request) => request.type), ["program_verify", "program_submit", "program_status", "program_events"]);
    for (const request of requests.slice(1)) assert.deepEqual(request.scope, scope);
    client.close();
    await assert.rejects(client.programStatus({ programId: "program_01" }), /bridge_not_authenticated/);
  } finally {
    peer?.destroy();
    await close(server);
  }
});
