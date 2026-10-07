import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
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
/** The validated Mod policy identity every hello_ack fixture carries. */
const mockPolicyIdentity = Object.freeze({ value: "a".repeat(32), capabilityRevision: 1 });

/**
 * `stale_snapshot` is the Mod's revision CAS refusing a request BEFORE any side effect, and it has
 * exactly one meaning: the caller's view of the action-transaction revision is behind. The Mod mints
 * a fresh revision for every durable receipt, so a well-formed request can still arrive one revision
 * late (live evidence: a play session lost three harvest_crop dispatches to this). The client answers
 * it the way it is meant to be answered — re-observe ONCE, re-dispatch the same envelope with the
 * refreshed revision — and nothing else.
 */
function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

async function close(server: { close(callback: (error?: Error) => void): unknown }): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}

function snapshotPayload(revision: number) {
  return {
    revision,
    location: "Farm",
    tile: { x: 3, y: 9 },
    stamina: 100,
    exhausted: false,
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
  };
}

function helloAck(request: Extract<BridgeMessage, { type: "hello" }>) {
  return {
    ...request,
    messageId: "stale_retry_hello",
    type: "hello_ack",
    payload: {
      sessionId: "session_stale_retry",
      capabilities: ["move_to_tile"],
      catalogRevision: 1,
      policyIdentity: mockPolicyIdentity,
      enabledActionIds: ["move_to_tile"],
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
  };
}

type PeerBehaviour = {
  /** What the peer answers after the caller refreshes its view. */
  refreshedRevision: number;
  /** The refusal code the first dispatch gets. */
  firstRefusal: string;
};

async function runAgainstPeer(behaviour: PeerBehaviour) {
  const pipeName = `gamebuddy_stale_retry_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let peer: Socket | undefined;
  const dispatches: { expectedRevision: number; requestId: string; idempotencyKey: string }[] = [];
  let observes = 0;
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
          socket.write(frame(helloAck(request)));
          continue;
        }
        if (request.type === "observe_request") {
          observes += 1;
          socket.write(
            frame({ ...request, messageId: `observe_${observes}`, type: "snapshot", payload: snapshotPayload(behaviour.refreshedRevision) }),
          );
          continue;
        }
        if (request.type !== "execution_request") continue;
        dispatches.push({
          expectedRevision: request.payload.expectedRevision,
          requestId: request.payload.requestId,
          idempotencyKey: request.payload.idempotencyKey,
        });
        if (dispatches.length === 1) {
          socket.write(
            frame({
              protocolVersion: 1,
              messageId: "mod_execution_error_01",
              correlationId: request.correlationId,
              timestampMs: Date.now(),
              scope,
              type: "error",
              payload: { reasonCode: behaviour.firstRefusal },
            }),
          );
          continue;
        }
        socket.write(
          frame({
            protocolVersion: 1,
            messageId: "mod_execution_receipt_02",
            correlationId: request.correlationId,
            timestampMs: Date.now(),
            scope,
            type: "execution_receipt",
            payload: {
              executionId: "execution_stale_retry",
              requestId: request.payload.requestId,
              actionId: request.payload.action,
              state: "succeeded",
              reasonCode: "target_reached",
              revision: behaviour.refreshedRevision,
              evidence: { retried: true },
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
    const dispatch = () =>
      client.execute({
        requestId: "request_stale_retry",
        idempotencyKey: "idempotency_stale_retry",
        action: "move_to_tile",
        args: { x: 4, y: 8 },
        expectedRevision: 7,
        deadlineMs: Date.now() + 10_000,
      });
    try {
      const receipt = await dispatch();
      return { outcome: { kind: "receipt" as const, receipt }, dispatches, observes };
    } catch (error) {
      return { outcome: { kind: "error" as const, message: String((error as Error).message) }, dispatches, observes };
    } finally {
      client.close();
    }
  } finally {
    peer?.destroy();
    await close(server);
  }
}

test("a stale_snapshot refusal is answered with one re-observe and one re-dispatch at the refreshed revision", async () => {
  const { outcome, dispatches, observes } = await runAgainstPeer({ firstRefusal: "stale_snapshot", refreshedRevision: 8 });

  assert.equal(outcome.kind, "receipt", `expected the retry to deliver a receipt, got ${JSON.stringify(outcome)}`);
  assert.equal(observes, 1, "exactly one re-observe");
  assert.equal(dispatches.length, 2, "exactly one retry");
  assert.equal(dispatches[0]?.expectedRevision, 7);
  // The SAME envelope, with only the revision refreshed: the first attempt never ran, so the
  // idempotency identity it carries still has nothing to remember.
  assert.equal(dispatches[1]?.expectedRevision, 8);
  assert.equal(dispatches[1]?.requestId, dispatches[0]?.requestId);
  assert.equal(dispatches[1]?.idempotencyKey, dispatches[0]?.idempotencyKey);
});

test("a stale_snapshot refusal whose refreshed revision is unchanged is surfaced, not retried", async () => {
  const { outcome, dispatches, observes } = await runAgainstPeer({ firstRefusal: "stale_snapshot", refreshedRevision: 7 });

  assert.equal(outcome.kind, "error");
  assert.match(outcome.kind === "error" ? outcome.message : "", /bridge_rejected:stale_snapshot/);
  assert.equal(observes, 1, "the client still refreshed once, to find out");
  assert.equal(dispatches.length, 1, "an unchanged revision means the contract is broken, not a race: no retry");
});

test("every other refusal is surfaced unchanged, with no re-observe and no retry", async () => {
  const { outcome, dispatches, observes } = await runAgainstPeer({ firstRefusal: "body_owned", refreshedRevision: 8 });

  assert.equal(outcome.kind, "error");
  assert.match(outcome.kind === "error" ? outcome.message : "", /bridge_rejected:body_owned/);
  assert.equal(observes, 0, "only stale_snapshot justifies a re-observe");
  assert.equal(dispatches.length, 1, "an owned body is a real refusal: never re-dispatched");
});
