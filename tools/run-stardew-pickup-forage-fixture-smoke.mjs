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
  for (const action of ["pickup_forage", "move_to_tile", "travel"]) {
    if (!snapshot.capabilities.includes(action)) throw new Error(`fixture_${action}_capability_missing`);
  }
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);

  // The initializer derives the target from the native Cabin warp and places it
  // within one tile of the Farm arrival. This is only a bounded navigation
  // hint; production selects the target exclusively from fresh forageTargets.
  const candidate = snapshot.location === "Farm" ? chooseArrivalCandidate(snapshot) : null;
  if (candidate !== null && !adjacent(snapshot.tile, candidate)) {
    snapshot = await moveToArrivalCandidate(snapshot, candidate);
    snapshot = await waitForActionable(snapshot, 3_000);
  }

  const target = chooseForageTarget(snapshot);
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_forage_target",
        trace,
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const beforeCount = countQualifiedItem(snapshot, target.qualifiedItemId);
    const receipt = await client.execute({
      requestId: `pickup_forage_fixture_${Date.now()}`,
      idempotencyKey: `pickup_forage_fixture_idem_${Date.now()}`,
      action: "pickup_forage",
      args: {
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    trace.push({ phase: "pickup_forage", target, receipt: summarizeReceipt(receipt) });
    const after = await client.observe();
    const evidence = parseEvidence(receipt.evidence);
    const targetGone = after.forageTargets?.every((entry) => entry.targetId !== target.targetId) === true;
    const evidenceMatches =
      evidence.location === snapshot.location &&
      evidence.target === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      evidence.removed === "True";
    const beforeEvidence = Number(evidence.inventory_before);
    const afterEvidence = Number(evidence.inventory_after);
    const inventoryDelta =
      Number.isSafeInteger(beforeEvidence) && Number.isSafeInteger(afterEvidence)
        ? afterEvidence - beforeEvidence
        : null;
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "forage_picked_up" &&
      evidenceMatches &&
      inventoryDelta === 1 &&
      targetGone;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "forage_picked_up" : receipt.reasonCode,
        target,
        beforeCount,
        receipt: summarizeReceipt(receipt),
        evidence,
        inventoryDelta,
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
  const receipt = await client.execute({
    requestId: `forage_fixture_travel_${Date.now()}`,
    idempotencyKey: `forage_fixture_travel_idem_${Date.now()}`,
    action: "travel",
    args: { x: warp.sourceX, y: warp.sourceY },
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "travel", receipt: summarizeReceipt(receipt), warp });
  if (receipt.state !== "accepted") throw new Error(`travel_not_accepted:${receipt.reasonCode}`);
  return waitForReceiptAndSnapshot(
    receipt.executionId,
    (latest) => latest.location === "Farm" && latest.activeExecution == null,
    15_000,
  );
}
async function move(snapshot, target, phase) {
  const receipt = await client.execute({
    requestId: `${phase}_${Date.now()}`,
    idempotencyKey: `${phase}_idem_${Date.now()}`,
    action: "move_to_tile",
    args: target,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 45_000,
  });
  trace.push({ phase, receipt: summarizeReceipt(receipt), target });
  if (receipt.state !== "accepted") throw new Error(`${phase}_not_accepted:${receipt.reasonCode}`);
  return waitForReceiptAndSnapshot(
    receipt.executionId,
    (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
    55_000,
  );
}
async function moveToArrivalCandidate(snapshot, arrival) {
  let latest = snapshot;
  const candidates = [];
  for (let offsetX = -1; offsetX <= 1; offsetX++) {
    for (let offsetY = -1; offsetY <= 1; offsetY++) {
      if (offsetX !== 0 || offsetY !== 0) candidates.push({ x: arrival.x + offsetX, y: arrival.y + offsetY });
    }
  }
  for (const target of candidates) {
    if (adjacent(latest.tile, target)) return latest;
    try {
      return await move(latest, target, "move_to_native_forage_fixture");
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.endsWith(":no_native_path")) throw error;
      latest = await client.observe();
    }
  }
  throw new Error("native_forage_approach_unreachable");
}
function chooseArrivalCandidate(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (warp === undefined) return null;
  return { x: warp.targetX, y: warp.targetY };
}
function chooseForageTarget(snapshot) {
  return (
    snapshot.forageTargets?.find(
      (entry) =>
        typeof entry.targetId === "string" &&
        Number.isInteger(entry.x) &&
        Number.isInteger(entry.y) &&
        typeof entry.qualifiedItemId === "string" &&
        entry.qualifiedItemId.length > 0,
    ) ?? null
  );
}
function countQualifiedItem(snapshot, qualifiedItemId) {
  // The bridge intentionally exposes only inventory slot count, not inventory
  // contents. The authoritative before/after counts are checked from receipt
  // evidence; this value is retained only as a bounded trace field.
  return null;
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
    const receipt = receipts.find((candidate) => candidate.executionId === executionId && isTerminal(candidate.state));
    if (receipt && receipt.state !== "succeeded") throw new Error(`navigation_failed:${receipt.reasonCode}`);
    if (receipt?.state === "succeeded" && predicate(latest)) return latest;
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`navigation_timeout:${executionId}`);
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
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    forageTargets: snapshot.forageTargets?.length ?? 0,
    inventorySlots: snapshot.inventorySlots ?? null,
    activeExecution: snapshot.activeExecution ?? null,
  };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
