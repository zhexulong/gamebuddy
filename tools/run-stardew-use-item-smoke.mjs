import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");
import { createFormalActionGate, FormalActionGateError } from "./lib/stardew-formal-action-gate.mjs";
import { classifyStardewGateFailure } from "./lib/stardew-gate-failure-taxonomy.mjs";

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
const gate = createFormalActionGate(client);
const startedAt = Date.now();
try {
  if (!client.state.capabilities.includes("use_item")) throw new Error("use_item_capability_missing");
  const snapshot = await gate.waitForActionable({ timeoutMs: 10_000 });
  if (!snapshot.capabilities.includes("use_item")) throw new Error("snapshot_use_item_capability_missing");
  const target = Array.isArray(snapshot.foodTargets)
    ? (snapshot.foodTargets.find(
        (entry) =>
          Number.isInteger(entry.slot) &&
          typeof entry.qualifiedItemId === "string" &&
          entry.stack > 0 &&
          entry.edibility >= -299,
      ) ?? null)
    : null;
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_food_target",
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const result = await gate.executeAndAwaitTerminal(
      {
        requestId: `use_item_${Date.now()}`,
        idempotencyKey: `use_item_idem_${Date.now()}`,
        action: "use_item",
        args: { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
      },
      { terminalTimeoutMs: 40_000, settleTimeoutMs: 5_000 },
    );
    const receipt = result.terminalReceipt;
    const after = result.afterSnapshot;
    const evidence = typeof receipt.evidence?.detail === "string" ? parseEvidence(receipt.evidence.detail) : {};
    const stackAfter = Number.parseInt(evidence.stack_after ?? "NaN", 10);
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "item_used" &&
      evidence.animation_complete === "true" &&
      Number.isInteger(stackAfter) &&
      stackAfter === target.stack - 1 &&
      (stackAfter === 0
        ? after.foodTargets?.some(
            (entry) => entry.slot === target.slot && entry.qualifiedItemId === target.qualifiedItemId,
          ) !== true
        : after.foodTargets?.some(
            (entry) =>
              entry.slot === target.slot &&
              entry.qualifiedItemId === target.qualifiedItemId &&
              entry.stack === stackAfter,
          ) === true);
    const reasonCode = passed ? "item_used" : receipt.reasonCode;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode,
        failure: passed ? null : classifyStardewGateFailure(reasonCode, { nativeReasonCode: receipt.reasonCode }),
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
  const reasonCode =
    error instanceof FormalActionGateError
      ? error.reasonCode
      : String(error instanceof Error ? error.message : error).slice(0, 256);
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode,
      failure: classifyStardewGateFailure(reasonCode, {
        nativeReasonCode: client.state.latestReceipt?.reasonCode ?? null,
      }),
      details: error instanceof FormalActionGateError ? (error.details ?? null) : null,
      latestReceipt: client.state.latestReceipt,
    }),
  );
  process.exitCode = 2;
} finally {
  gate.close();
  client.close();
}

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    stamina: snapshot.stamina,
    health: snapshot.health,
    foodTargets: snapshot.foodTargets?.length ?? 0,
  };
}
function summarizeTarget(target) {
  return {
    slot: target.slot,
    qualifiedItemId: target.qualifiedItemId,
    stack: target.stack,
    edibility: target.edibility,
    isDrink: target.isDrink,
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
