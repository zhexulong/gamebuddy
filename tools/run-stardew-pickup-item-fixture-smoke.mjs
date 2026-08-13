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
  for (const action of ["pickup_item", "move_to_tile", "travel"]) {
    if (!snapshot.capabilities.includes(action)) throw new Error(`fixture_${action}_capability_missing`);
  }
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  const target = await findTargetAfterBoundedApproach(snapshot);
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_item_target",
        trace,
        snapshot: summarize(await client.observe()),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    // The production adapter owns the bounded approach. Dispatch against the
    // last live target observation rather than walking beside it here: native
    // Debris will auto-collect as soon as the Farmhand reaches adjacency.
    const refreshed = target;
    const receipt = await client.execute({
      requestId: `pickup_item_fixture_${Date.now()}`,
      idempotencyKey: `pickup_item_fixture_idem_${Date.now()}`,
      action: "pickup_item",
      args: {
        x: refreshed.x,
        y: refreshed.y,
        expectedQualifiedItemId: refreshed.qualifiedItemId,
        expectedTargetId: refreshed.targetId,
      },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    trace.push({ phase: "pickup_item", target: refreshed, receipt: summarizeReceipt(receipt) });
    if (receipt.state !== "accepted") throw new Error(`pickup_item_not_accepted:${receipt.reasonCode}`);
    const terminal = await waitForTerminalReceiptAndSnapshot(receipt.executionId, 40_000);
    const terminalReceipt = terminal.receipt;
    const after = terminal.snapshot;
    const targetGone = after.itemTargets?.every((entry) => entry.targetId !== refreshed.targetId) === true;
    const evidence = parseEvidence(terminalReceipt.evidence);
    const inventoryBefore = Number(evidence.inventory_before);
    const inventoryAfter = Number(evidence.inventory_after);
    const inventoryDelta =
      Number.isSafeInteger(inventoryBefore) && Number.isSafeInteger(inventoryAfter)
        ? inventoryAfter - inventoryBefore
        : null;
    const evidenceMatches =
      evidence.location === snapshot.location &&
      evidence.target === refreshed.targetId &&
      evidence.tile === `${refreshed.x},${refreshed.y}` &&
      evidence.item === refreshed.qualifiedItemId &&
      Number(evidence.stack) === refreshed.stack &&
      evidence.native_auto_collect === "true" &&
      evidence.chunk_removed === "true" &&
      inventoryDelta === refreshed.stack;
    const passed =
      terminalReceipt.state === "succeeded" &&
      terminalReceipt.reasonCode === "item_picked_up" &&
      evidenceMatches &&
      targetGone;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "item_picked_up" : terminalReceipt.reasonCode,
        target: refreshed,
        receipt: summarizeReceipt(terminalReceipt),
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
    requestId: `item_fixture_travel_${Date.now()}`,
    idempotencyKey: `item_fixture_travel_idem_${Date.now()}`,
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
async function findTargetAfterBoundedApproach(snapshot) {
  // itemTargets are deliberately published out to the action's bounded
  // approach radius. The action—not this runner—must own final movement so
  // the subsequent native auto-collect is correlated to its execution.
  return chooseTarget(snapshot);
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
async function waitForTerminalReceiptAndSnapshot(executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const receipt = receipts.find((candidate) => candidate.executionId === executionId && isTerminal(candidate.state));
    if (receipt) return { receipt, snapshot: latest };
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`pickup_item_terminal_timeout:${executionId}`);
}
function chooseTarget(snapshot) {
  return (
    snapshot.itemTargets?.find(
      (entry) =>
        typeof entry.targetId === "string" &&
        Number.isInteger(entry.x) &&
        Number.isInteger(entry.y) &&
        typeof entry.qualifiedItemId === "string" &&
        Number.isInteger(entry.stack) &&
        entry.stack > 0,
    ) ?? null
  );
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
    itemTargets: snapshot.itemTargets?.length ?? 0,
    inventorySlots: snapshot.inventorySlots ?? null,
    activeExecution: snapshot.activeExecution ?? null,
  };
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
