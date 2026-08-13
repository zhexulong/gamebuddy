import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");
const path = process.argv[process.argv.indexOf("--client-config") + 1];
const config = JSON.parse(await readFile(path, "utf8"));
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
try {
  const snapshots = [];
  for (let i = 0; i < 6; i++) {
    const snapshot = await client.observe();
    snapshots.push({
      revision: snapshot.revision,
      location: snapshot.location,
      tile: snapshot.tile,
      actionable: snapshot.actionable,
      capabilities: snapshot.capabilities,
      targetCounts: {
        warps: snapshot.warps?.length ?? null,
        doorTargets: snapshot.doorTargets?.length ?? null,
        soilTiles: snapshot.soilTiles?.length ?? null,
        seedTargets: snapshot.seedTargets?.length ?? null,
        cropTargets: snapshot.cropTargets?.length ?? null,
        harvestTargets: snapshot.harvestTargets?.length ?? null,
        fertilizerTargets: snapshot.fertilizerTargets?.length ?? null,
        debrisTargets: snapshot.debrisTargets?.length ?? null,
        machineTargets: snapshot.machineTargets?.length ?? null,
        forageTargets: snapshot.forageTargets?.length ?? null,
        itemTargets: snapshot.itemTargets?.length ?? null,
        petTargets: snapshot.petTargets?.length ?? null,
        animalProductTargets: snapshot.animalProductTargets?.length ?? null,
        feedTroughTargets: snapshot.feedTroughTargets?.length ?? null,
        foodTargets: snapshot.foodTargets?.length ?? null,
        toolSlots: snapshot.toolSlots?.length ?? null,
      },
      activeExecution:
        snapshot.activeExecution == null
          ? null
          : {
              executionId: snapshot.activeExecution.executionId,
              requestId: snapshot.activeExecution.requestId,
              state: snapshot.activeExecution.state,
              reasonCode: snapshot.activeExecution.reasonCode,
            },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(JSON.stringify({ state: "passed", snapshots }));
} finally {
  client.close();
}
