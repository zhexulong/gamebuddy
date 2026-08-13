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
  if (!client.state.capabilities.includes("till_soil")) throw new Error("till_soil_capability_missing");
  const initial = await client.observe();
  if (!initial.capabilities.includes("till_soil")) throw new Error("snapshot_till_soil_capability_missing");
  const hoeSlot = Number.isInteger(config.HoeSlot) ? config.HoeSlot : preparedToolSlot(initial);
  if (hoeSlot === null) throw new Error("hoe_not_found_in_live_tool_slots");
  const equipped = await client.execute({
    requestId: `till_soil_equip_${Date.now()}`,
    idempotencyKey: `till_soil_equip_idem_${Date.now()}`,
    action: "equip_tool",
    args: { slot: hoeSlot },
    expectedRevision: initial.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "equip_hoe", slot: hoeSlot, receipt: summarizeReceipt(equipped) });
  if (equipped.state !== "succeeded") throw new Error(`hoe_equip_failed:${equipped.state}:${equipped.reasonCode}`);
  const prepared = await client.observe();
  if (prepared.currentTool === null || !prepared.currentTool.toLowerCase().includes("hoe"))
    throw new Error("hoe_postcondition_missing");
  const target = chooseSoilTile(prepared);
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_soil_tile",
        snapshot: summarize(prepared),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const accepted = await client.execute({
      requestId: `till_soil_${Date.now()}`,
      idempotencyKey: `till_soil_idem_${Date.now()}`,
      action: "till_soil",
      args: { x: target.x, y: target.y },
      expectedRevision: prepared.revision,
      deadlineMs: Date.now() + 30_000,
    });
    trace.push({ phase: "accepted", target, receipt: summarizeReceipt(accepted), snapshot: summarize(prepared) });
    const evidence = detailEvidence(accepted.evidence);
    const after = await client.observe();
    const targetRemoved =
      !Array.isArray(after.soilTiles) || !after.soilTiles.some((tile) => tile?.x === target.x && tile?.y === target.y);
    const passed =
      accepted.state === "succeeded" &&
      accepted.reasonCode === "soil_tilled" &&
      evidence.before === "none" &&
      evidence.after === "HoeDirt" &&
      targetRemoved;
    trace.push({
      phase: "terminal",
      receipt: summarizeReceipt(accepted),
      evidence,
      targetRemoved,
      after: summarize(after),
    });
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "soil_tilled" : accepted.reasonCode,
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

function preparedToolSlot(snapshot) {
  if (!Array.isArray(snapshot.toolSlots)) return null;
  return (
    snapshot.toolSlots.find((entry) => typeof entry.label === "string" && entry.label.toLowerCase().includes("hoe"))
      ?.slot ?? null
  );
}

function chooseSoilTile(snapshot) {
  if (!Array.isArray(snapshot.soilTiles)) return null;
  return snapshot.soilTiles.find((tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y)) ?? null;
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    soilTiles: snapshot.soilTiles?.length ?? 0,
    currentTool: snapshot.currentTool ?? null,
  };
}
function detailEvidence(evidence) {
  const raw = evidence?.detail ?? evidence;
  if (typeof raw !== "string") return {};
  return Object.fromEntries(
    raw.split(";").map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
    }),
  );
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
