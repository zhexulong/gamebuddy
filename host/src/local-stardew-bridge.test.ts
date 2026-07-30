import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import { type BridgeMessage, type Scope } from "./protocol.js";

const scope: Scope = { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "farmhand_01", companionId: "companion_01" };
const token = "phase2_test_token_1234";

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
}

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
        const response = request.type === "hello"
          ? { ...request, messageId: "mod_hello_01", type: "hello_ack", payload: { sessionId: "session_01", capabilities: ["move_to_tile"] } }
          : { ...request, messageId: "mod_snapshot_01", type: "snapshot", payload: { revision: 7, location: "Farm", tile: { x: 4, y: 8 }, stamina: 250, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null } };
        socket.write(frame(response));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise()).once("error", reject));
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
