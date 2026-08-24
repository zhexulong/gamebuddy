import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

const configPath = process.argv[process.argv.indexOf("--client-config") + 1];
if (!configPath) throw new Error("missing_client_config");
const config = JSON.parse(await readFile(configPath, "utf8"));
const timeoutMs = 20_000;
const withTimeout = async (promise, operation) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation}_timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const client = await withTimeout(
  LocalStardewBridgeClient.connect(
    {
      integrationId: "stardew",
      saveId: config.SaveId,
      worldId: config.WorldId,
      playerId: config.PlayerId,
      companionId: config.CompanionId,
    },
    config.PipeName,
    config.BridgeToken,
  ),
  "bridge_connect",
);
try {
  const deadline = Date.now() + 15_000;
  let snapshot;
  do {
    snapshot = await withTimeout(client.observe(), "bridge_observe");
    if (snapshot.actionable && (snapshot.animalProductTargets?.length ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  console.log(
    JSON.stringify(
      {
        state:
          snapshot.actionable && (snapshot.animalProductTargets?.length ?? 0) > 0
            ? "target_ready"
            : "target_unavailable",
        location: snapshot.location,
        tile: snapshot.tile,
        actionable: snapshot.actionable,
        animalProductTargets: snapshot.animalProductTargets ?? [],
        toolSlots: snapshot.toolSlots ?? [],
        capabilities: snapshot.capabilities,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
