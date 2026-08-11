import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";
function option(name) { const i = process.argv.indexOf(name); if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`); return process.argv[i + 1]; }
const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0)) throw new Error("invalid_client_config");
if (JSON.stringify(config.EnabledActions) !== JSON.stringify(["move_to_tile", "travel", "place_crab_pot"])) throw new Error("fixture_capability_profile_invalid");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
try {
  const snapshot = await client.observe();
  for (const action of ["move_to_tile", "travel", "place_crab_pot"]) if (!snapshot.capabilities.includes(action)) throw new Error(`native_local_${action}_capability_missing`);
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("fixture_player_not_actionable");
  const target = snapshot.crabPotTargets?.find((entry) => Math.abs(entry.x - snapshot.tile.x) <= 1 && Math.abs(entry.y - snapshot.tile.y) <= 1);
  if (!target) throw new Error("no_adjacent_live_crab_pot_target");
  if (target.qualifiedItemId !== "(O)710") throw new Error("fixture_crab_pot_target_item_mismatch");
  console.log(JSON.stringify({ state: "fixture_prepared", action: "place_crab_pot", productionRequestSent: false, target, latestReceipt: snapshot.latestReceipt ?? null, contract: "fixture preparation only; production placement is verified by the separately mapped production runner" }));
} finally { client.close(); }
