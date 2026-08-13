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
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});
const startedAt = Date.now();
try {
  if (!client.state.capabilities.includes("pickup_item")) throw new Error("pickup_item_capability_missing");
  let before = await client.observe();
  if (!before.capabilities.includes("pickup_item")) throw new Error("snapshot_pickup_item_capability_missing");
  let target = chooseTarget(before);
  // Debris chunks are moving native entities. A short bounded re-read avoids
  // submitting a position already superseded by the next snapshot; it never
  // manufactures a target or extends the native lifetime.
  if (target !== null) {
    await delay(200);
    const fresh = await client.observe();
    const refreshed = fresh.itemTargets?.find((entry) => entry.targetId === target.targetId);
    if (refreshed) {
      before = fresh;
      target = refreshed;
    }
  }
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_item_target",
        snapshot: summarize(before),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const accepted = await client.execute({
      requestId: `pickup_item_${Date.now()}`,
      idempotencyKey: `pickup_item_idem_${Date.now()}`,
      action: "pickup_item",
      args: {
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      expectedRevision: before.revision,
      deadlineMs: Date.now() + 30_000,
    });
    if (accepted.state !== "accepted")
      throw new Error(`pickup_item_not_accepted:${accepted.state}:${accepted.reasonCode}`);
    const receipt = await waitForTerminalReceipt(client, receipts, accepted.executionId, 40_000);
    const after = await waitForActionable(client, 5_000);
    const stillPresent = after.itemTargets?.some((entry) => entry.targetId === target.targetId) === true;
    const evidence = parseEvidence(receipt.evidence);
    const inventoryBefore = Number(evidence.inventory_before);
    const inventoryAfter = Number(evidence.inventory_after);
    const inventoryDelta =
      Number.isSafeInteger(inventoryBefore) && Number.isSafeInteger(inventoryAfter)
        ? inventoryAfter - inventoryBefore
        : null;
    const evidenceMatches =
      evidence.location === before.location &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      Number(evidence.stack) === target.stack &&
      evidence.native_auto_collect === "true" &&
      evidence.chunk_removed === "true" &&
      inventoryDelta === target.stack;
    const passed =
      receipt.state === "succeeded" && receipt.reasonCode === "item_picked_up" && evidenceMatches && !stillPresent;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "item_picked_up" : receipt.reasonCode,
        target,
        receipt: summarizeReceipt(receipt),
        evidence,
        inventoryDelta,
        before: summarize(before),
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
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function isTerminalState(state) {
  return [
    "blocked",
    "invalidated",
    "succeeded",
    "partially_succeeded",
    "failed",
    "cancelled",
    "expired",
    "rejected",
    "uncertain",
  ].includes(state);
}

async function waitForTerminalReceipt(client, receipts, executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt =
      client.state.latestReceipt?.executionId === executionId
        ? client.state.latestReceipt
        : receipts.find((entry) => entry.executionId === executionId);
    if (receipt !== undefined && isTerminalState(receipt.state)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await client.observe();
    } catch {}
  }
  const finalReceipt =
    client.state.latestReceipt?.executionId === executionId
      ? client.state.latestReceipt
      : receipts.find((entry) => entry.executionId === executionId);
  if (finalReceipt !== undefined && isTerminalState(finalReceipt.state)) return finalReceipt;
  throw new Error("pickup_item_terminal_timeout");
}

async function waitForActionable(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await client.observe();
  while (Date.now() < deadline) {
    if (snapshot.actionable && snapshot.activeExecution == null) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 150));
    snapshot = await client.observe();
  }
  return snapshot;
}

function chooseTarget(snapshot) {
  if (!Array.isArray(snapshot.itemTargets)) return null;
  return (
    snapshot.itemTargets.find(
      (entry) =>
        typeof entry.targetId === "string" &&
        Number.isInteger(entry.x) &&
        Number.isInteger(entry.y) &&
        typeof entry.qualifiedItemId === "string" &&
        Number.isSafeInteger(entry.stack) &&
        entry.stack > 0,
    ) ?? null
  );
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    itemTargets: snapshot.itemTargets?.length ?? 0,
    inventorySlots: snapshot.inventorySlots ?? null,
  };
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
  return {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence ?? null,
  };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
