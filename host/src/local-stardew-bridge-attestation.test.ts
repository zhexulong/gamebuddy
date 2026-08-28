import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { assertReceiptBackedLaunch } from "./integration-launcher.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { BridgeMessage, Scope } from "./protocol.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";

const scope: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_attestation",
  worldId: "world_attestation",
  playerId: "farmhand_attestation",
  companionId: "companion_attestation",
});
const token = "farmhand_bridge_token_0123456789";
const generation = "ai-generation-attestation";

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
}

async function withHelloAck<T>(
  runtimeRole: "farmhand_client" | "native_local_fixture" | "unattested",
  launchGeneration: string | null,
  operation: (pipeName: string, peerClosed: Promise<void>) => Promise<T>,
): Promise<T> {
  const pipeName = `gamebuddy_farmhand_attestation_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let peer: Socket | undefined;
  let resolvePeerClosed!: () => void;
  const peerClosed = new Promise<void>((resolve) => { resolvePeerClosed = resolve; });
  const server = createServer((socket) => {
    peer = socket;
    socket.once("close", resolvePeerClosed);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (request.type === "hello")
          socket.write(frame({
            ...request,
            messageId: "mod_hello_attestation",
            type: "hello_ack",
            payload: {
              sessionId: "session_attestation",
              capabilities: ["move_to_tile"],
              catalogRevision: 1,
              enabledActionIds: ["move_to_tile"],
              presentationLocale: "en-US",
              registrations: [{
                actionId: "move_to_tile",
                familyId: "movement_navigation",
                identityVersion: 1,
                lifecycle: "published",
                kind: "execution",
              }],
              runtimeRole,
              launchGeneration,
            },
          }));
        else if (request.type === "observe_request")
          socket.write(frame({
            ...request,
            messageId: "mod_snapshot_attestation",
            type: "snapshot",
            payload: {
              revision: 1,
              location: "Farm",
              tile: { x: 5, y: 8 },
              stamina: 250,
              health: 100,
              actionable: true,
              capabilities: ["move_to_tile"],
              catalogRevision: 1,
              enabledActionIds: ["move_to_tile"],
              presentationLocale: "en-US",
              activeExecution: null,
            },
          }));
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, resolve).once("error", reject),
  );
  try {
    return await operation(pipeName, peerClosed);
  } finally {
    peer?.destroy();
    await closeServer(server);
  }
}

test("formal Farmhand bridge produces the existing receipt-backed Stardew launch handle", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const identity = Object.freeze({
      playerId: scope.playerId,
      companionId: scope.companionId,
      saveId: scope.saveId,
      worldId: scope.worldId,
    });
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, identity);
    assertReceiptBackedLaunch(STARDEW_INTEGRATION_LAUNCHER, launch, identity);
    assert.equal(launch.presentationBridge, client);
    launch.close();
  });
});

test("authenticated Stardew launch-handle producer rejects a forged bridge before adapter use", async () => {
  await assert.rejects(
    () =>
      createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        Object.freeze({ close() {} }) as unknown as LocalStardewBridgeClient,
        scope,
      ),
    /authenticated_stardew_bridge_required/,
  );
});

test("authenticated Stardew launch-handle producer closes an exact client on identity mismatch", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName, peerClosed) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    await assert.rejects(
      () => createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, { ...scope, playerId: "foreign_farmhand" }),
      /stardew_bridge_identity_scope_mismatch/,
    );
    await peerClosed;
  });
});

for (const mismatch of ["role", "generation"] as const) {
  test(`formal Farmhand bridge rejects ${mismatch} mismatch and closes transport`, async () => {
    await withHelloAck(
      mismatch === "role" ? "native_local_fixture" : "farmhand_client",
      mismatch === "generation" ? "different-generation" : null,
      async (pipeName, peerClosed) => {
        await assert.rejects(
          () => LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000),
          /bridge_runtime_attestation_mismatch/,
        );
        await peerClosed;
      },
    );
  });
}

test("formal Farmhand bridge rejects an invalid expected generation before pipe access", async () => {
  await assert.rejects(
    () => LocalStardewBridgeClient.connectFarmhand(
      scope,
      "unused-valid-pipe-name",
      token,
      "invalid generation",
      Date.now() + 5_000,
    ),
    /invalid_bridge_launch_generation/,
  );
});

test("formal Farmhand bridge closes the exact transport when hello misses its deadline", { timeout: 5_000 }, async () => {
  const pipeName = `gamebuddy_farmhand_deadline_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let resolvePeerClosed!: () => void;
  const peerClosed = new Promise<void>((resolve) => { resolvePeerClosed = resolve; });
  const server = createServer((socket) => {
    peer = socket;
    socket.on("data", () => undefined);
    socket.once("end", resolvePeerClosed);
    socket.once("close", resolvePeerClosed);
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, resolve).once("error", reject),
  );
  try {
    await assert.rejects(
      () => LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 50),
      /bridge_connect_deadline_exceeded/,
    );
    await Promise.race([
      peerClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("peer_close_timeout")), 1_000)),
    ]);
  } finally {
    peer?.destroy();
    server.close();
  }
});
