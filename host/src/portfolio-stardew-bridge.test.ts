import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { PortfolioStardewBridgeClient } from "./portfolio-stardew-bridge.js";
import { PORTFOLIO_INTEGRATION_ID, PORTFOLIO_TOPOLOGY, type PortfolioMessage } from "./portfolio-protocol.js";

const scope = { integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: "save_01", worldId: "world_01", localPlayerId: "player_01", companionId: "companion_01", bindingGeneration: 1, bindingHash: "a".repeat(64) } as const;
const token = "portfolio_test_token_1234";
function frame(value: unknown): Buffer { const payload = Buffer.from(JSON.stringify(value)); const header = Buffer.allocUnsafe(4); header.writeInt32LE(payload.byteLength, 0); return Buffer.concat([header, payload]); }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }

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
        const payload = request.type === "hello"
          ? { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash }
          : { protocolVersion: 1, integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: 1, bindingHash: scope.bindingHash, revision: 3, worldReady: true, singlePlayer: true, currentLocalPlayerMatches: true, state: "ready", reasonCode: "accepted" };
        socket.write(frame({ ...request, type: request.type === "hello" ? "hello_ack" : "snapshot", payload }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
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
        const payload = request.type === "hello"
          ? { sessionId: "session_01", bindingGeneration: 1, bindingHash: scope.bindingHash }
          : { protocolVersion: 1, integrationId: PORTFOLIO_INTEGRATION_ID, topology: PORTFOLIO_TOPOLOGY, saveId: scope.saveId, worldId: scope.worldId, localPlayerId: scope.localPlayerId, companionId: scope.companionId, bindingGeneration: 1, bindingHash: scope.bindingHash, revision: 4, worldReady: false, singlePlayer: true, currentLocalPlayerMatches: false, state: "invalidated", reasonCode: "portfolio_saving" };
        socket.write(frame({ ...request, type: request.type === "hello" ? "hello_ack" : "snapshot", payload }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject));
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
