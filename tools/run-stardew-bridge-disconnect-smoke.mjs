import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
if (
  ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some(
    (key) => typeof config[key] !== "string" || config[key].length === 0,
  )
) {
  throw new Error("invalid_client_config");
}
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
try {
  const initial = await client.observe();
  if (!client.state.capabilities.includes("move_to_tile") || !initial.capabilities.includes("move_to_tile"))
    throw new Error("move_to_tile_capability_missing");
  const target = { x: initial.tile.x, y: initial.tile.y === 9 ? 10 : 9 };
  const request = {
    requestId: `disconnect_smoke_${Date.now()}`,
    idempotencyKey: `disconnect_smoke_idem_${Date.now()}`,
    action: "move_to_tile",
    args: target,
    expectedRevision: initial.revision,
    deadlineMs: Date.now() + 30_000,
  };
  const accepted = await client.execute(request);
  if (accepted.state !== "accepted") throw new Error(`execution_not_accepted:${accepted.state}:${accepted.reasonCode}`);
  client.close();
  console.log(
    JSON.stringify({
      state: "accepted_then_disconnected",
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      action: request.action,
      args: request.args,
      expectedRevision: request.expectedRevision,
      executionId: accepted.executionId,
      target,
      revision: accepted.revision,
    }),
  );
} catch (error) {
  client.close();
  console.error(
    JSON.stringify({ state: "blocked", reasonCode: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 2;
}
