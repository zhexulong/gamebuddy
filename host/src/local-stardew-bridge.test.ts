import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { BridgeMessage, Scope } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

const testAdapter = STARDEW_GAME_INTEGRATION_ADAPTER;

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "farmhand_01",
  companionId: "companion_01",
};
const token = "phase2_test_token_1234";

/**
 * Validateable Mock Mod policy identity required by hello_ack and catalog_update
 * wire fixtures since the authenticated hello_ack projection (bb5e3d6). The
 * value must be a 32-char lowercase hex string like production Mods publish.
 */
const mockPolicyIdentity = Object.freeze({ value: "a".repeat(32), capabilityRevision: 1 });

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

/** A validated world_fact frame for inbound fact-listener coverage. */
function worldFactFrame(eventId: string): Buffer {
  return frame({
    protocolVersion: 1,
    messageId: eventId,
    correlationId: eventId,
    timestampMs: Date.now(),
    scope,
    type: "world_fact",
    payload: {
      eventId,
      sourceEventId: eventId,
      kind: "day_started",
      observedTick: 100,
      gameTime: "0600",
      revision: 1,
      deduplicationKey: eventId,
      payload: { day: 1 },
    },
  });
}

test("local Stardew bridge sends typed observe_scene requests only for Mod-published read-only capability", async () => {
  const pipeName = `gamebuddy_observe_scene_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let requestType: string | null = null;
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
          socket.write(frame({ ...request, messageId: "scene_hello", type: "hello_ack", payload: {
            sessionId: "scene_session", capabilities: ["observe_scene"], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: [],
            presentationLocale: "en-US", registrations: [{ actionId: "observe_scene", familyId: "world_perception", identityVersion: 1, lifecycle: "published", kind: "read_only" }],
            runtimeRole: "native_local_fixture", launchGeneration: null,
          }}));
          socket.write(frame({ ...request, messageId: "scene_snapshot", type: "snapshot", correlationId: "scene_snapshot", payload: {
            revision: 1, location: "Farm", tile: { x: 1, y: 1 }, stamina: 100, health: 100, actionable: true,
            capabilities: ["observe_scene"], catalogRevision: 1, enabledActionIds: [], presentationLocale: "en-US", activeExecution: null,
            timeOfDay: 600,
            dayOfMonth: 1,
            seasonIndex: 0,
            year: 1,
          }}));
        } else if (request.type === "observe_scene_request") {
          requestType = request.type;
          socket.write(frame({ ...request, messageId: "scene_result", type: "observe_scene_result", payload: {
           observationId: "observation_01", currentLocation: "Farm", currentRegion: "outdoor", affordances: [{ ref: "sr1_AAAAAAAAAAAAAAAA", kind: "chest", name: "Chest", distance: 1, direction: "East", actionHint: null }],
             summary: "A chest is nearby.", partial: false, truncatedReason: null,
          }}));
        }
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject));
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    const result = await client.observeScene();
    assert.equal(requestType, "observe_scene_request");
     assert.equal(result.observationId, "observation_01");
     assert.equal(result.affordances[0]?.ref, "sr1_AAAAAAAAAAAAAAAA");
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

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
    policyIdentity: mockPolicyIdentity,
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
            timeOfDay: 600,
            dayOfMonth: 1,
            seasonIndex: 0,
            year: 1,
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
            timeOfDay: 600,
            dayOfMonth: 1,
            seasonIndex: 0,
            year: 1,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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

test("local Stardew bridge advances the admitted snapshot revision on an unsolicited execution receipt", async () => {
  const pipeName = `gamebuddy_execution_receipt_revision_${process.pid}_${Date.now()}`;
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
            policyIdentity: mockPolicyIdentity,
            enabledActionIds: [],
            presentationLocale: "en-US",
            registrations: [
              {
                actionId: "navigate_to_destination",
                familyId: "world_navigation",
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
      const replies = new Map<string, (message: BridgeMessage) => void>();
      let executionCount = 0;
      replies.set("execution_request", (message) => {
        executionCount += 1;
        socket.write(
          frame({
            ...message,
            messageId: "mod_receipt_01",
            type: "execution_receipt",
            correlationId: message.correlationId,
            payload: {
              requestId: "request_receipt_01",
              executionId: "execution_receipt_01",
              actionId: "navigate_to_destination",
              state: "succeeded",
              reasonCode: "navigation_completed",
              revision: 9,
              evidence: { detail: "location=Farm;destination=Bus Stop" },
              observation: null,
            },
          }),
        );
      });
      replies.set("observe_request", (message) => {
        // After the execution receipt advanced the revision, the Mod serves a
        // fresh snapshot at that same revision with the real new location;
        // the placeholder must not reject it.
        const revision = executionCount > 0 ? 9 : 7;
        socket.write(
          frame({
            ...message,
            messageId: "snapshot_base",
            type: "snapshot",
            correlationId: message.correlationId,
            payload: {
              revision,
              location: revision === 9 ? "BusStop" : "Farm",
              tile: revision === 9 ? { x: 11, y: 23 } : { x: 64, y: 15 },
              stamina: 250,
              health: 100,
              actionable: true,
              capabilities: ["inspect_self"],
              catalogRevision: 1,
              enabledActionIds: [],
              presentationLocale: "en-US",
              timeOfDay: 600,
              dayOfMonth: 1,
              seasonIndex: 0,
              year: 1,
              activeExecution: null,
            },
          }),
        );
      });
      socket.on("data", (nextChunk: Buffer) => {
        try {
          const message = JSON.parse(nextChunk.subarray(4).toString("utf8")) as BridgeMessage;
          const responder = replies.get(message.type);
          if (responder !== undefined) responder(message);
        } catch {
          // Ignore malformed probe frames; the bridge itself fails closed.
        }
      });
      // Allow the client's first post-hello requests to flow.
      setTimeout(() => snapshotsWritten?.(), 20);
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    await client.observe();
    assert.equal(client.state.snapshot?.revision, 7);
    // Driving a native action yields an unsolicited terminal receipt with a
    // fresh Mod revision; the admitted snapshot revision must advance so a
    // subsequent presentation request can bind executions.Revision.
    await client.execute({
      requestId: "request_receipt_01",
      idempotencyKey: "idempotency_receipt_01",
      action: "navigate_to_destination",
      args: { destination: { kind: "label", label: "Bus Stop" } },
      expectedRevision: 7,
      deadlineMs: Date.now() + 30_000,
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.equal(client.state.snapshot?.revision, 9);
    assert.equal(client.state.latestReceipt?.reasonCode, "navigation_completed");
    // A fresh solicited observe at the placeholder revision carries the real
    // post-action world (BusStop); it must replace the stale placeholder
    // fields so the Agent never sees the pre-action location again.
    const fresh = await client.observe();
    assert.equal(fresh.revision, 9);
    assert.equal(client.state.snapshot?.revision, 9);
    assert.equal(client.state.snapshot?.location, "BusStop");
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge admits a repeat solicited snapshot at the same revision", async () => {
  // A live world moves while the companion does not. `revision` is the action
  // transaction version, so it does not advance when time passes, a villager
  // walks, or a Pet wanders. A solicited observe therefore legitimately returns
  // the same revision with DIFFERENT world fields, and refusing it would leave
  // the caller stuck on a projection the world has already left -- unable to see
  // that a moving target had settled, because no newer revision exists to chase.
  //
  // This asserts the observation channel is a read, not a write: the second frame
  // carries a new location at an unchanged revision and must be admitted.
  const pipeName = `gamebuddy_observe_same_revision_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    let observes = 0;
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
              messageId: "same_revision_hello",
              type: "hello_ack",
              payload: {
                sessionId: "session_01",
                capabilities: [],
                catalogRevision: 1,
                policyIdentity: mockPolicyIdentity,
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
        } else if (request.type === "observe_request") {
          observes++;
          // Same revision, different place: the world moved, the transaction did not.
          socket.write(
            frame({
              ...request,
              messageId: `observe_same_revision_${observes}`,
              type: "snapshot",
              payload: {
                revision: 7,
                location: "Farm",
                tile: observes === 1 ? { x: 0, y: 0 } : { x: 5, y: 9 },
                stamina: 100,
                health: 100,
                actionable: true,
                capabilities: [],
                catalogRevision: 1,
                enabledActionIds: [],
                presentationLocale: "en-US",
                timeOfDay: 600,
                dayOfMonth: 1,
                seasonIndex: 0,
                year: 1,
                activeExecution: null,
              },
            }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    const first = await client.observe();
    assert.deepEqual(first.tile, { x: 0, y: 0 });
    const second = await client.observe();
    assert.deepEqual(
      second.tile,
      { x: 5, y: 9 },
      "a same-revision solicited snapshot must be admitted so the caller can see the world move",
    );
    assert.equal(second.revision, 7);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge refuses a solicited snapshot whose catalogRevision was never published", async () => {
  const pipeName = `gamebuddy_observe_stale_${process.pid}_${Date.now()}`;
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
          socket.write(
            frame({
              ...request,
              messageId: "observe_stale_hello",
              type: "hello_ack",
              payload: {
    sessionId: "session_01",
    capabilities: [],
    catalogRevision: 1,
    policyIdentity: mockPolicyIdentity,
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
        } else if (request.type === "observe_request") {
          // The snapshot claims a catalogRevision this generation never published,
          // so admission must reject it and observe() must never resolve it.
          socket.write(
            frame({
              ...request,
              messageId: "observe_stale_snapshot",
              type: "snapshot",
              payload: {
                revision: 1,
                location: "Farm",
                tile: { x: 0, y: 0 },
                stamina: 100,
                health: 100,
                actionable: true,
                capabilities: [],
                catalogRevision: 2,
                enabledActionIds: [],
                presentationLocale: "en-US",
                timeOfDay: 600,
                dayOfMonth: 1,
                seasonIndex: 0,
                year: 1,
                activeExecution: null,
              },
            }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    await assert.rejects(client.observe(), /observe_snapshot_not_admitted/);
    // The stale payload was never admitted and never surfaced, so the bridge stays usable.
    assert.equal(client.state.snapshot, null);
    assert.equal(client.state.connected, true);
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
  let firstObserveRequest!: () => void;
  const firstObserveRequestSeen = new Promise<void>((resolvePromise) => {
    firstObserveRequest = resolvePromise;
  });
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
    policyIdentity: mockPolicyIdentity,
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
          if (observeRequests === 1) firstObserveRequest();
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
                  timeOfDay: 600,
                  dayOfMonth: 1,
                  seasonIndex: 0,
                  year: 1,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
          payload: { catalogRevision: revision, policyIdentity: { value: revision.toString(16).padStart(32, "0"), capabilityRevision: revision }, enabledActionIds: ["move_to_tile"] },
        }),
      );

    catalogUpdate(2);
    for (let attempt = 0; attempt < 20 && catalogRevision() !== 2; attempt++)
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    assert.equal(client.state.snapshot, null);
    assert.equal(catalogRevision(), 2);
    await firstObserveRequestSeen;
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
          timeOfDay: 600,
          dayOfMonth: 1,
          seasonIndex: 0,
          year: 1,
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
    policyIdentity: mockPolicyIdentity,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
                  payload: { sessionId: "session_player_control", capabilities: [], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: [], presentationLocale: "zh-CN", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
                    timeOfDay: 600,
                    dayOfMonth: 1,
                    seasonIndex: 0,
                    year: 1,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
             payload: { sessionId: "session_player_control_reject", capabilities: [], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: [], presentationLocale: "zh-CN", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
    policyIdentity: mockPolicyIdentity,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
              payload: { sessionId: "session_system_notice", capabilities: [], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: [], presentationLocale: "en-US", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
                 payload: { sessionId: "session_01", capabilities: ["move_to_tile"], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: ["move_to_tile"], presentationLocale: "en-US", registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }], runtimeRole: "native_local_fixture", launchGeneration: null },
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
                  timeOfDay: 600,
                  dayOfMonth: 1,
                  seasonIndex: 0,
                  year: 1,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
    policyIdentity: mockPolicyIdentity,
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
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
          socket.write(frame({ ...request, messageId: `hello_${name}`, type: "hello_ack", payload: { sessionId: `session_${name}`, capabilities: [], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: [], presentationLocale: "en-US", registrations: [{ actionId: "find_destination", familyId: "world_navigation", identityVersion: 1, lifecycle: "published", kind: "read_only" }], runtimeRole: "native_local_fixture", launchGeneration: null } }));
        } else if (request.type === "navigation_read_request") onNavigation(socket, request);
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise).once("error", reject));
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
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
    socket.write(frame({ ...request, messageId: "nav_wrong_snapshot", type: "snapshot", payload: { revision: 99, location: "Farm", tile: { x: 1, y: 1 }, stamina: 1, health: 1, actionable: true, capabilities: [], catalogRevision: 1, enabledActionIds: [], presentationLocale: "en-US", timeOfDay: 600, dayOfMonth: 1, seasonIndex: 0, year: 1, activeExecution: null } }));
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
    policyIdentity: mockPolicyIdentity,
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
    await run(await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter));
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
      payload: { programId: "foreign_program", code: "found", nextCursor: 1, highWater: 1, events: [{ cursor: 1, programId: "foreign_program", kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null }] },
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
        code: "found",
        nextCursor: 2,
        highWater: 2,
        events: [
          { cursor: 1, programId: request.payload.programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null },
          { cursor: 2, programId: request.payload.programId, kind: "running", catalogRevision: 1, nodeId: null, nodeAttempt: null },
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

test("body program accepts a legitimate empty events page above the event high-water", async () => {
  await withBodyProgramBridge("empty_page_above_highwater", (socket, request) => {
    socket.write(frame({
      ...request,
      messageId: "body_program_empty_page",
      type: "program_events_result",
      payload: { programId: request.payload.programId, code: "found", events: [], nextCursor: request.payload.cursor, highWater: request.payload.cursor - 5 },
    }));
  }, async (client) => {
    const result = await client.programEvents({ programId: "program_01", cursor: 100, pageSize: 32 });
    assert.deepEqual(result, { programId: "program_01", code: "found", events: [], nextCursor: 100, highWater: 95 });
    assert.equal(client.state.connected, true);
    client.close();
  });
});

test("body program still closes for a non-empty page whose high-water is below the requested cursor", async () => {
  await withBodyProgramBridge("nonempty_below_highwater", (socket, request) => {
    socket.write(frame({
      ...request,
      messageId: "body_program_nonempty_below",
      type: "program_events_result",
      payload: {
        programId: request.payload.programId,
        code: "found",
        nextCursor: 101,
        highWater: 100,
        events: [{ cursor: 101, programId: request.payload.programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null }],
      },
    }));
  }, async (client) => {
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    await assert.rejects(
      client.programEvents({ programId: "program_01", cursor: 100, pageSize: 1 }),
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
            sessionId: "body_program_session", capabilities: [], catalogRevision: 1, policyIdentity: mockPolicyIdentity, enabledActionIds: [], presentationLocale: "en-US",
            registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
            runtimeRole: "native_local_fixture", launchGeneration: null,
          } }));
          continue;
        }
        const bodyProgramRequest = request as Readonly<{
          type: "program_submit" | "program_status" | "program_events";
          payload: Readonly<{ programId: string; cursor?: number }>;
        }>;
        const nextCursor = (bodyProgramRequest.payload.cursor ?? 0) + 1;
        const payload = bodyProgramRequest.type === "program_status"
          ? { code: "found", snapshot: { programId: bodyProgramRequest.payload.programId, state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] } }
          : bodyProgramRequest.type === "program_events"
            ? { programId: bodyProgramRequest.payload.programId, code: "found", nextCursor, highWater: nextCursor, events: [{ cursor: nextCursor, programId: bodyProgramRequest.payload.programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null }] }
            : { code: "rejected", verification: { accepted: false, catalogRevision: 1, diagnostics: [] }, snapshot: null };
        const type = request.type === "program_submit" ? "program_submit_result" : request.type === "program_status" ? "program_status_result" : "program_events_result";
        socket.write(frame({ ...request, messageId: `body_program_${type}`, type, payload }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise).once("error", reject));
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
      const candidate = { programId: "program_01", nodes: [{ nodeId: "node_01", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }] } as const;
    assert.equal((await client.programSubmit(candidate)).code, "rejected");
    assert.equal((await client.programStatus({ programId: "program_01" })).snapshot?.catalogRevision, 1);
    assert.equal((await client.programEvents({ programId: "program_01", cursor: 0, pageSize: 1 })).nextCursor, 1);
    assert.deepEqual(requests.slice(1).map((request) => request.type), ["program_submit", "program_status", "program_events"]);
    for (const request of requests.slice(1)) assert.deepEqual(request.scope, scope);
    client.close();
    await assert.rejects(client.programStatus({ programId: "program_01" }), /bridge_not_authenticated/);
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge fails closed when a fact listener throws event_pump_event_overflow", async () => {
  const pipeName = `gamebuddy_listener_overflow_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let sendInbound: (() => void) | undefined;
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
        if (request.type !== "hello") continue;
        socket.write(
          frame({
            ...request,
            messageId: "mod_hello_listener_overflow",
            type: "hello_ack",
            payload: {
    sessionId: "session_listener_overflow",
    capabilities: [],
    catalogRevision: 1,
    policyIdentity: mockPolicyIdentity,
    enabledActionIds: [],
              presentationLocale: "en-US",
              registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
              runtimeRole: "native_local_fixture",
              launchGeneration: null,
            },
          }),
        );
        // Both frames in one buffer: the follow-up frame is parsed by the
        // transport in the same data event after the first one fails closed,
        // so the generation guard must drop it before any listener.
        sendInbound = () =>
          socket.write(Buffer.concat([worldFactFrame("fact_overflow_01"), worldFactFrame("fact_overflow_02")]));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    let listenerInvocations = 0;
    client.onFact(() => {
      listenerInvocations++;
      throw new Error("event_pump_event_overflow");
    });
    assert.ok(sendInbound !== undefined);
    sendInbound();
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "event_pump_event_overflow" });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    assert.equal(listenerInvocations, 1);
    assert.equal(client.state.connected, false);
    assert.equal(client.state.authenticated, false);
    assert.equal(client.state.latestReasonCode, "event_pump_event_overflow");
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Stardew bridge maps an arbitrary fact listener exception to fact_listener_failed", async () => {
  const pipeName = `gamebuddy_listener_failed_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let sendInbound: (() => void) | undefined;
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
        if (request.type !== "hello") continue;
        socket.write(
          frame({
            ...request,
            messageId: "mod_hello_listener_failed",
            type: "hello_ack",
            payload: {
    sessionId: "session_listener_failed",
    capabilities: [],
    catalogRevision: 1,
    policyIdentity: mockPolicyIdentity,
    enabledActionIds: [],
              presentationLocale: "en-US",
              registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
              runtimeRole: "native_local_fixture",
              launchGeneration: null,
            },
          }),
        );
        sendInbound = () => socket.write(worldFactFrame("fact_failed_01"));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    let throwingInvocations = 0;
    let laterListenerInvocations = 0;
    client.onFact(() => {
      throwingInvocations++;
      throw new Error("arbitrary listener failure");
    });
    client.onFact(() => laterListenerInvocations++);
    assert.ok(sendInbound !== undefined);
    sendInbound();
    // The exception never escaped receive(): the run stays alive, the thrower
    // ran once, and dispatch aborted before the later listener saw the fact.
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "fact_listener_failed" });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    assert.equal(throwingInvocations, 1);
    assert.equal(laterListenerInvocations, 0);
    assert.equal(client.state.connected, false);
    assert.equal(client.state.latestReasonCode, "fact_listener_failed");
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("a pending observe rejects through the normal close path when a fact listener fails", async () => {
  const pipeName = `gamebuddy_listener_pending_${process.pid}_${Date.now()}`;
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
          socket.write(
            frame({
              ...request,
              messageId: "mod_hello_listener_pending",
              type: "hello_ack",
              payload: {
    sessionId: "session_listener_pending",
    capabilities: [],
    catalogRevision: 1,
    policyIdentity: mockPolicyIdentity,
    enabledActionIds: [],
                presentationLocale: "en-US",
                registrations: [{ actionId: "move_to_tile", familyId: "movement_navigation", identityVersion: 1, lifecycle: "published", kind: "execution" }],
                runtimeRole: "native_local_fixture",
                launchGeneration: null,
              },
            }),
          );
        } else if (request.type === "observe_request") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_snapshot_listener_pending",
              type: "snapshot",
              payload: {
                revision: 1,
                location: "Farm",
                tile: { x: 0, y: 0 },
                stamina: 100,
                health: 100,
                actionable: true,
                capabilities: [],
                catalogRevision: 1,
                enabledActionIds: [],
                presentationLocale: "en-US",
                timeOfDay: 600,
                dayOfMonth: 1,
                seasonIndex: 0,
                year: 1,
                activeExecution: null,
              },
            }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) =>
      client.onConnectionFact(resolvePromise),
    );
    client.onFact(() => {
      throw new Error("arbitrary listener failure");
    });
    // The admitted snapshot would satisfy the pending observe, but the thrown
    // listener rejects it through the standard close cleanup instead of
    // resolving it or leaking it to the bridge_response_timeout.
    const observe = client.observe();
    await assert.rejects(observe, /bridge_disconnected:fact_listener_failed/);
    assert.deepEqual(await disconnected, { state: "disconnected", reasonCode: "fact_listener_failed" });
    assert.equal(client.state.connected, false);
    assert.equal(client.state.snapshot, null);
  } finally {
    peer?.destroy();
    await close(server);
  }
});
