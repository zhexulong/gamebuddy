import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0))
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
  const before = await client.observe();
  if (!before.actionable || before.activeExecution != null)
    throw new Error("native_local_equip_tool_player_not_actionable");
  if (!before.capabilities.includes("equip_tool")) throw new Error("native_local_equip_tool_capability_missing");
  const selected =
    before.toolSlots?.find(
      (entry) =>
        Number.isInteger(entry.slot) &&
        typeof entry.label === "string" &&
        entry.label.length > 0 &&
        entry.label !== before.currentTool,
    ) ??
    before.toolSlots?.find(
      (entry) => Number.isInteger(entry.slot) && typeof entry.label === "string" && entry.label.length > 0,
    );
  if (!selected) throw new Error("no_live_eligible_tool_slot");
  const selectedLabel = selected.label;
  const receipt = await client.execute({
    requestId: `native_local_equip_tool_${Date.now()}`,
    idempotencyKey: `native_local_equip_tool_idem_${Date.now()}`,
    action: "equip_tool",
    args: { slot: selected.slot },
    expectedRevision: before.revision,
    deadlineMs: Date.now() + 30_000,
  });
  const evidence = parseEvidence(receipt.evidence);
  const after = await client.observe();
  const expectedTool = evidence.expected;
  const passed =
    receipt.state === "succeeded" &&
    receipt.reasonCode === "tool_selected" &&
    typeof expectedTool === "string" &&
    expectedTool.length > 0 &&
    expectedTool === selectedLabel &&
    evidence.after === selectedLabel &&
    after.currentTool === selectedLabel;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "tool_selected" : receipt.reasonCode,
      selected: { slot: selected.slot, label: selected.label },
      receipt: summarizeReceipt(receipt),
      evidence,
      before: summarize(before),
      after: summarize(after),
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state.latestReceipt),
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    currentTool: snapshot.currentTool ?? null,
    toolSlots: snapshot.toolSlots ?? [],
  };
}
function summarizeReceipt(receipt) {
  return receipt
    ? {
        executionId: receipt.executionId,
        requestId: receipt.requestId,
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revision: receipt.revision,
        evidence: receipt.evidence ?? null,
      }
    : null;
}
