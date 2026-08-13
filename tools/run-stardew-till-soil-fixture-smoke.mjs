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
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  let snapshot = await client.observe();
  for (const action of ["till_soil", "equip_tool", "move_to_tile", "travel"]) {
    if (!snapshot.capabilities.includes(action)) throw new Error(`fixture_${action}_capability_missing`);
  }
  const hoeSlot = snapshot.toolSlots?.find(
    (entry) => typeof entry.label === "string" && entry.label.toLowerCase().includes("hoe"),
  )?.slot;
  if (!Number.isInteger(hoeSlot)) throw new Error("hoe_not_found_in_live_tool_slots");
  const equipped = await client.execute({
    requestId: `till_fixture_equip_${Date.now()}`,
    idempotencyKey: `till_fixture_equip_idem_${Date.now()}`,
    action: "equip_tool",
    args: { slot: hoeSlot },
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "equip_hoe", slot: hoeSlot, receipt: summarizeReceipt(equipped) });
  if (equipped.state !== "succeeded") throw new Error(`hoe_equip_failed:${equipped.reasonCode}`);
  snapshot = await client.observe();
  if (!snapshot.currentTool?.toLowerCase().includes("hoe")) throw new Error("hoe_postcondition_missing");
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  // native_till_soil_v1 leaves bare diggable Farm ground. This is only a
  // bounded movement candidate, not an action input: the following fresh
  // production snapshot must independently publish soilTiles.
  snapshot = await move(snapshot, { x: 38, y: 19 }, "move_to_native_till_fixture_ground");
  snapshot = await waitForActionable(snapshot, 3_000);
  const target = chooseSoilTile(snapshot);
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_soil_tile",
        trace,
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `till_soil_fixture_${Date.now()}`,
      idempotencyKey: `till_soil_fixture_idem_${Date.now()}`,
      action: "till_soil",
      args: { x: target.x, y: target.y },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    trace.push({ phase: "till", target, receipt: summarizeReceipt(receipt) });
    const after = await client.observe();
    const evidence = parseEvidence(receipt.evidence);
    const targetGone = after.soilTiles?.every((entry) => entry.x !== target.x || entry.y !== target.y) === true;
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "soil_tilled" &&
      evidence.before === "none" &&
      evidence.after === "HoeDirt" &&
      targetGone;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "soil_tilled" : receipt.reasonCode,
        target,
        receipt: summarizeReceipt(receipt),
        evidence,
        targetGone,
        trace,
        before: summarize(snapshot),
        after: summarize(after),
        durationMs: Date.now() - startedAt,
      }),
    );
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state.latestReceipt),
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await client.execute({
    requestId: `till_fixture_travel_${Date.now()}`,
    idempotencyKey: `till_fixture_travel_idem_${Date.now()}`,
    action: "travel",
    args: { x: warp.sourceX, y: warp.sourceY },
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "travel", receipt: summarizeReceipt(accepted), warp });
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(
    accepted.executionId,
    (latest) => latest.location === "Farm" && latest.activeExecution == null,
    15_000,
  );
}
async function move(snapshot, target, phase) {
  const accepted = await client.execute({
    requestId: `${phase}_${Date.now()}`,
    idempotencyKey: `${phase}_idem_${Date.now()}`,
    action: "move_to_tile",
    args: target,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 45_000,
  });
  trace.push({ phase, receipt: summarizeReceipt(accepted), target });
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(
    accepted.executionId,
    (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
    55_000,
  );
}
async function waitForActionable(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest.actionable && latest.activeExecution == null) return latest;
    await delay(150);
    latest = await client.observe();
  }
  return latest;
}
async function waitForReceiptAndSnapshot(executionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const terminal = receipts.find(
      (receipt) => receipt.executionId === executionId && receipt.state !== "accepted" && isTerminal(receipt.state),
    );
    if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
    if (terminal?.state === "succeeded" && predicate(latest)) return latest;
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`navigation_timeout:${executionId}`);
}
function chooseSoilTile(snapshot) {
  return snapshot.soilTiles?.find((tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y)) ?? null;
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail
      .split(";")
      .map((part) => {
        const i = part.indexOf("=");
        return i > 0 ? [part.slice(0, i), part.slice(i + 1)] : null;
      })
      .filter(Boolean),
  );
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    soilTiles: snapshot.soilTiles?.length ?? 0,
    activeExecution: snapshot.activeExecution ?? null,
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
