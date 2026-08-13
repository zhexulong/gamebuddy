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
const startedAt = Date.now();
const trace = [];
try {
  if (!client.state.capabilities.includes("water_crop")) throw new Error("water_crop_capability_missing");
  const initial = await client.observe();
  if (!initial.capabilities.includes("water_crop")) throw new Error("snapshot_water_crop_capability_missing");
  const canSlot = Number.isInteger(config.WateringCanSlot)
    ? config.WateringCanSlot
    : findToolSlot(initial, "wateringcan");
  if (canSlot === null) throw new Error("watering_can_not_found_in_live_tool_slots");
  const equipped = await client.execute({
    requestId: `water_crop_equip_${Date.now()}`,
    idempotencyKey: `water_crop_equip_idem_${Date.now()}`,
    action: "equip_tool",
    args: { slot: canSlot },
    expectedRevision: initial.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "equip_watering_can", slot: canSlot, receipt: summarizeReceipt(equipped) });
  if (equipped.state !== "succeeded")
    throw new Error(`watering_can_equip_failed:${equipped.state}:${equipped.reasonCode}`);
  const prepared = await client.observe();
  if (typeof prepared.currentTool !== "string" || !prepared.currentTool.toLowerCase().includes("wateringcan"))
    throw new Error("watering_can_postcondition_missing");
  const target = chooseTarget(prepared);
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_unwatered_crop",
        snapshot: summarize(prepared),
        durationMs: Date.now() - startedAt,
        trace,
      }),
    );
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `water_crop_${Date.now()}`,
      idempotencyKey: `water_crop_idem_${Date.now()}`,
      action: "water_crop",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: prepared.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const stillDry = after.cropTargets?.some((entry) => entry.targetId === target.targetId) === true;
    const passed = receipt.state === "succeeded" && receipt.reasonCode === "crop_watered" && !stillDry;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "crop_watered" : receipt.reasonCode,
        target,
        receipt: summarizeReceipt(receipt),
        before: summarize(prepared),
        after: summarize(after),
        durationMs: Date.now() - startedAt,
        trace,
      }),
    );
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: client.state.latestReceipt,
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function findToolSlot(snapshot, needle) {
  if (!Array.isArray(snapshot.toolSlots)) return null;
  return (
    snapshot.toolSlots.find(
      (entry) => typeof entry.label === "string" && entry.label.toLowerCase().replaceAll(" ", "").includes(needle),
    )?.slot ?? null
  );
}
function chooseTarget(snapshot) {
  if (!Array.isArray(snapshot.cropTargets)) return null;
  return (
    snapshot.cropTargets.find(
      (entry) => Number.isInteger(entry.x) && Number.isInteger(entry.y) && typeof entry.targetId === "string",
    ) ?? null
  );
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    cropTargets: snapshot.cropTargets?.length ?? 0,
    currentTool: snapshot.currentTool ?? null,
  };
}
function summarizeReceipt(receipt) {
  return {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence ?? null,
  };
}
