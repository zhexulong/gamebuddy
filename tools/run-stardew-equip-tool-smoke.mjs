import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const configPath = option("--client-config");
const slot = Number(option("--slot"));
if (!Number.isInteger(slot) || slot < 0 || slot > 36) throw new Error("invalid_tool_slot");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (
  typeof config.SaveId !== "string" ||
  typeof config.WorldId !== "string" ||
  typeof config.PlayerId !== "string" ||
  typeof config.CompanionId !== "string" ||
  typeof config.PipeName !== "string" ||
  typeof config.BridgeToken !== "string"
)
  throw new Error("invalid_client_config");
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
try {
  const snapshot = await client.observe();
  if (!client.state.capabilities.includes("equip_tool") || !snapshot.capabilities.includes("equip_tool"))
    throw new Error("equip_tool_capability_missing");
  const receipt = await client.execute({
    requestId: `equip_tool_smoke_${Date.now()}`,
    idempotencyKey: `equip_tool_smoke_idem_${Date.now()}`,
    action: "equip_tool",
    args: { slot },
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  const evidenceDetail = typeof receipt.evidence?.detail === "string" ? receipt.evidence.detail : "";
  if (
    receipt.state !== "succeeded" ||
    receipt.reasonCode !== "tool_selected" ||
    !/before=.*;expected=.*;after=/.test(evidenceDetail)
  ) {
    throw new Error("equip_tool_postcondition_not_proven");
  }
  console.log(
    JSON.stringify(
      {
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revisionBefore: snapshot.revision,
        revisionAfter: receipt.revision,
        currentToolBefore: snapshot.currentTool ?? null,
        inventorySlots: snapshot.inventorySlots ?? null,
        evidence: receipt.evidence,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
