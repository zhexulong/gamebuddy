import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { BridgeMessage, Scope } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createStardewIntegrationLaunchHandleFromAuthenticatedBridge } from "./stardew-integration-launcher.js";

const scope: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_listener_failure",
  worldId: "world_listener_failure",
  playerId: "farmhand_listener_failure",
  companionId: "companion_listener_failure",
});
const token = "listener_failure_bridge_token_0123456789";
const testAdapter = STARDEW_GAME_INTEGRATION_ADAPTER;
const mockPolicyIdentity = Object.freeze({ value: "b".repeat(32), capabilityRevision: 1 });

/** How long a fact the product owes may take before the test fails instead of waiting for the suite's budget. */
const FACT_DEADLINE_MS = 5_000;
function factWithinDeadline<T>(pending: Promise<T>, factName: string): Promise<T> {
  return Promise.race([
    pending,
    new Promise<never>((_resolvePromise, rejectPromise) => {
      setTimeout(() => rejectPromise(new Error(`${factName}_timeout`)), FACT_DEADLINE_MS).unref();
    }),
  ]);
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}

/** A validated world_fact frame; `kind` is the semantic kind the Mod mints, which is what makes the fact nameable. */
function worldFactFrame(eventId: string, kind: string): Buffer {
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
      kind,
      observedTick: 100,
      gameTime: "0600",
      revision: 1,
      deduplicationKey: eventId,
      payload: { day: 1 },
    },
  });
}

/**
 * The launcher's OWN listener wrapper, driven through the real pipe.
 *
 * <p>
 * MEASURED 2026-11-17 (`round66`) and again on the two `fact_listener_failed` drops of that night: the run published the
 * bare code, and the artifact could not say which listener had thrown, over which fact, or why - the launcher wrote the
 * fact kind and the error to stderr and then closed the bridge on a reason that carried neither. The bridge's own
 * wrapper had the same gap, so every one of these drops read identically whether a projection, the event pump, a receipt
 * fold or a serialization fault was responsible.
 * </p>
 * <p>
 * This case is the second wrapper site: the fact listeners the LAUNCHER owns (the integration event source it hands to
 * the product) rather than the bridge's subscribers. A listener that throws there must publish a disconnect reason that
 * names the fact it was being handed and the error it threw, so the next occurrence names its own cause.
 * </p>
 */
test("a launcher-owned listener failure publishes a disconnect reason naming the fact and the error", async () => {
  const pipeName = `gamebuddy_launcher_listener_failed_${process.pid}_${Date.now()}`;
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
        if (request.type === "hello")
          socket.write(
            frame({
              ...request,
              messageId: "mod_hello_launcher_listener_failed",
              type: "hello_ack",
              payload: {
                sessionId: "session_launcher_listener_failed",
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
        else if (request.type === "observe_request")
          socket.write(
            frame({
              ...request,
              messageId: "mod_snapshot_launcher_listener_failed",
              type: "snapshot",
              payload: {
                revision: 1,
                location: "Farm",
                tile: { x: 5, y: 8 },
                stamina: 250,
                exhausted: false,
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
    });
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject),
  );
  try {
    const client = await LocalStardewBridgeClient.connect(scope, pipeName, token, testAdapter);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
      client,
      Object.freeze({
        playerId: "player_launcher_listener_failed",
        companionId: scope.companionId,
        continuityId: "continuity_launcher_listener_failed",
        saveId: scope.saveId,
        worldId: scope.worldId,
      }),
      { module: testAdapter },
    );
    const disconnected = new Promise<Readonly<{ state: string; reasonCode: string }>>((resolvePromise) => {
      launch.events.onLifecycle((event) => {
        if (event.state === "disconnected") resolvePromise(event);
      });
    });
    launch.events.onFact(() => {
      throw new Error("execution_receipt_replay_rejected:terminal_state_rewritten");
    });
    assert.ok(peer !== undefined);
    peer.write(worldFactFrame("fact_launcher_failed_01", "crop_harvested"));
    const published = await factWithinDeadline(disconnected, "lifecycle_fact");
    // WHICH fact (the semantic kind the Mod minted, not the transport's `world_fact`), WHICH id, and the error.
    assert.deepEqual(namedFactReason(published.reasonCode), {
      failure: "fact_listener_failed",
      factKind: "crop_harvested",
      factId: "fact_launcher_failed_01",
      error: "Error:execution_receipt_replay_rejected:terminal_state_rewritten",
    });
    assert.equal(client.state.connected, false);
  } finally {
    peer?.destroy();
    await close(server);
  }
});

/**
 * One published disconnect reason, read back as the four things it has to say.
 *
 * The assertion is on the FIELDS rather than on one literal string, because the literal is today's spelling of a
 * property: a reason that separates into a failure, a fact kind, a fact id and an error token answers "which listener
 * failed and why", and a test that pinned the whole line would go green on any re-spelling that kept the shape.
 */
function namedFactReason(reasonCode: string): Readonly<{
  failure: string;
  factKind: string;
  factId: string;
  error: string;
}> {
  const [failure, factKind, factId, ...error] = reasonCode.split(":");
  return { failure: failure ?? "", factKind: factKind ?? "", factId: factId ?? "", error: error.join(":") };
}
