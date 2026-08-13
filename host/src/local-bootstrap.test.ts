import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import test from "node:test";
import { connectLocalCompanion } from "./local-bootstrap.js";
import type { BridgeMessage } from "./protocol.js";
function frame(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.allocUnsafe(4); header.writeInt32LE(body.byteLength, 0); return Buffer.concat([header, body]); }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
test("local bootstrap mounts independently from Chat", async () => {
  const pipeName = `gamebuddy_bootstrap_${process.pid}_${Date.now()}`; const root = await mkdtemp(join(tmpdir(), "gamebuddy-bootstrap-")); const identity = { playerId: "farmhand_01", saveId: "save_01", worldId: "world_01", companionId: "companion_01", continuityId: "continuity_01" } as const; let peer: import("node:net").Socket | undefined;
  const server = createServer((socket) => { peer = socket; let buffer = Buffer.alloc(0); socket.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.byteLength >= 4) { const length = buffer.readInt32LE(0); if (buffer.byteLength < length + 4) return; const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as BridgeMessage; buffer = buffer.subarray(length + 4); const payload = request.type === "hello" ? { sessionId: "session_01", capabilities: ["move_to_tile"] } : { revision: 1, location: "Farm", tile: { x: 0, y: 0 }, stamina: 250, health: 100, actionable: true, currentTool: "Axe", inventorySlots: 12, capabilities: ["move_to_tile"], activeExecution: null }; socket.write(frame({ ...request, messageId: "reply", type: request.type === "hello" ? "hello_ack" : "snapshot", payload })); } }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()); });
  try { const connected = await connectLocalCompanion({ identity, pipeName, bridgeToken: "bootstrap_token_1234", runtimeRoot: root }); try { assert.equal(connected.surfaceSession?.surface, "game"); } finally { await connected.close(); } } finally { peer?.destroy(); await close(server); }
});
