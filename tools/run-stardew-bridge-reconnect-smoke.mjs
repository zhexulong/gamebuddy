import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const requestId = option("--request-id");
const idempotencyKey = option("--idempotency-key");
const expectedExecutionId = option("--execution-id");
const expectedRevision = Number(option("--expected-revision"));
const targetX = Number(option("--target-x"));
const targetY = Number(option("--target-y"));
if (!Number.isSafeInteger(expectedRevision) || !Number.isInteger(targetX) || !Number.isInteger(targetY)) throw new Error("invalid_replay_arguments");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const deadline = Date.now() + 20_000;
let client;
try {
  let lastError = "pipe_not_available";
  while (Date.now() < deadline) {
    try {
      client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (client === undefined) throw new Error(`reconnect_timeout:${lastError}`);
  const snapshot = await client.observe();
  const replay = await client.execute({
    requestId,
    idempotencyKey,
    action: "move_to_tile",
    args: { x: targetX, y: targetY },
    expectedRevision,
    deadlineMs: Date.now() + 30_000,
  });
  const passed = replay.executionId === expectedExecutionId
    && replay.state === "invalidated"
    && replay.reasonCode === "bridge_disconnected";
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reconnectRevision: snapshot.revision, replay: { executionId: replay.executionId, requestId: replay.requestId, state: replay.state, reasonCode: replay.reasonCode, revision: replay.revision }, expectedExecutionId }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
} finally {
  client?.close();
}
