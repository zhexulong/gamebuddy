import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0)) throw new Error("invalid_client_config");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});
const startedAt = Date.now();
try {
  if (!client.state.capabilities.includes("feed_animal")) throw new Error("feed_animal_capability_missing");
  let snapshot = await client.observe();
  const readyDeadline = Date.now() + 10_000;
  while (!snapshot.actionable && Date.now() < readyDeadline) {
    await delay(250);
    snapshot = await client.observe();
  }
  if (!snapshot.capabilities.includes("feed_animal")) throw new Error("snapshot_feed_animal_capability_missing");
  const target = Array.isArray(snapshot.feedTroughTargets)
    ? snapshot.feedTroughTargets.find((entry) => Number.isInteger(entry.slot)
      && Number.isInteger(entry.x) && Number.isInteger(entry.y)
      && typeof entry.targetId === "string" && Number.isInteger(entry.hayStack) && entry.hayStack > 0) ?? null
    : null;
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_empty_feed_trough_target", snapshot: summarize(snapshot), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const accepted = await client.execute({
      requestId: `feed_animal_${Date.now()}`,
      idempotencyKey: `feed_animal_idem_${Date.now()}`,
      action: "feed_animal",
      args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    if (accepted.state !== "succeeded" || accepted.reasonCode !== "hay_placed_in_trough") {
      throw new Error(`feed_animal_not_succeeded:${accepted.state}:${accepted.reasonCode}`);
    }
    const after = await waitForActionable(client, 5_000);
    const evidence = typeof accepted.evidence?.detail === "string" ? parseEvidence(accepted.evidence.detail) : {};
    const targetGone = after.feedTroughTargets?.some((entry) => entry.targetId === target.targetId) !== true;
    const passed = evidence.tile === `${target.x},${target.y}`
      && evidence.native_handled === "true"
      && evidence.trough_filled === "true"
      && evidence.hay_consumed === "true"
      && Number(evidence.hay_before) === target.hayStack
      && Number(evidence.hay_after) === target.hayStack - 1
      && targetGone;
    console.log(JSON.stringify({
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "hay_placed_in_trough" : accepted.reasonCode,
      target: { targetId: target.targetId, slot: target.slot, x: target.x, y: target.y, hayStack: target.hayStack },
      receipt: summarizeReceipt(accepted), before: summarize(snapshot), after: summarize(after), durationMs: Date.now() - startedAt,
    }));
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: client.state.latestReceipt }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForActionable(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await client.observe();
  while (Date.now() < deadline) {
    if (snapshot.actionable && snapshot.activeExecution == null) return snapshot;
    await delay(150);
    snapshot = await client.observe();
  }
  return snapshot;
}
function summarize(snapshot) {
  return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, feedTroughTargets: snapshot.feedTroughTargets?.length ?? 0 };
}
function summarizeReceipt(receipt) {
  return { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null };
}
function parseEvidence(detail) {
  return Object.fromEntries(detail.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator < 1 ? [] : [[part.slice(0, separator), part.slice(separator + 1)]];
  }));
}
