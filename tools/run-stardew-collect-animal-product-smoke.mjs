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
  if (!client.state.capabilities.includes("collect_animal_product"))
    throw new Error("collect_animal_product_capability_missing");
  let snapshot = await client.observe();
  const readyDeadline = Date.now() + 10_000;
  while (!snapshot.actionable && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await client.observe();
  }
  if (!snapshot.capabilities.includes("collect_animal_product"))
    throw new Error("snapshot_collect_animal_product_capability_missing");
  const target = Array.isArray(snapshot.animalProductTargets)
    ? (snapshot.animalProductTargets.find(
        (entry) =>
          Number.isInteger(entry.slot) &&
          Number.isInteger(entry.x) &&
          Number.isInteger(entry.y) &&
          typeof entry.targetId === "string" &&
          typeof entry.qualifiedProduceItemId === "string" &&
          (entry.toolKind === "milk_pail" || entry.toolKind === "shears") &&
          (entry.produceStack === 1 || entry.produceStack === 2),
      ) ?? null)
    : null;
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_animal_product_target",
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const accepted = await client.execute({
      requestId: `collect_animal_product_${Date.now()}`,
      idempotencyKey: `collect_animal_product_idem_${Date.now()}`,
      action: "collect_animal_product",
      args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    if (accepted.state !== "accepted")
      throw new Error(`collect_animal_product_not_accepted:${accepted.state}:${accepted.reasonCode}`);
    const receipt = await waitForTerminalReceipt(client, receipts, accepted.executionId, 40_000);
    const after = await waitForActionable(client, 5_000);
    const evidence = typeof receipt.evidence?.detail === "string" ? parseEvidence(receipt.evidence.detail) : {};
    const targetGone = after.animalProductTargets?.some((entry) => entry.targetId === target.targetId) !== true;
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "animal_product_collected" &&
      evidence.produce === target.qualifiedProduceItemId &&
      evidence.tool === target.toolKind &&
      evidence.produce_stack === String(target.produceStack) &&
      evidence.produce_cleared === "true" &&
      evidence.inventory_gained === "true" &&
      evidence.animation_complete === "true" &&
      targetGone;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "animal_product_collected" : receipt.reasonCode,
        target: summarizeTarget(target),
        receipt: summarizeReceipt(receipt),
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
      latestReceipt: client.state.latestReceipt,
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
  throw new Error("collect_animal_product_terminal_timeout");
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

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    animalProductTargets: snapshot.animalProductTargets?.length ?? 0,
  };
}
function summarizeTarget(target) {
  return {
    targetId: target.targetId,
    slot: target.slot,
    x: target.x,
    y: target.y,
    animalType: target.animalType,
    qualifiedProduceItemId: target.qualifiedProduceItemId,
    toolKind: target.toolKind,
    produceStack: target.produceStack,
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
function parseEvidence(detail) {
  return Object.fromEntries(
    detail.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      return separator < 1 ? [] : [[part.slice(0, separator), part.slice(separator + 1)]];
    }),
  );
}
