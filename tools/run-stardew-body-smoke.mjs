import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing_${name.slice(2)}`);
  }
  if (index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
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
const failures = [];
const trace = [];
const receiptFacts = [];
const startedAt = Date.now();
const unsubscribeReceiptFacts = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receiptFacts.push(fact.payload);
});

try {
  if (!client.state.capabilities.includes("move_to_tile")) throw new Error("move_capability_missing");
  const initial = await client.observe();
  if (!initial.capabilities.includes("move_to_tile")) throw new Error("snapshot_move_capability_missing");
  const target =
    process.argv.includes("--target-x") || process.argv.includes("--target-y")
      ? { x: Number(option("--target-x")), y: Number(option("--target-y")) }
      : chooseNearbyTarget(initial, 20);
  const requestId = `body_move_${Date.now()}`;
  const idempotencyKey = `body_move_idem_${Date.now()}`;
  const accepted = await client.execute({
    requestId,
    idempotencyKey,
    action: "move_to_tile",
    args: { x: target.x, y: target.y },
    expectedRevision: initial.revision,
    deadlineMs: Date.now() + 45_000,
  });
  if (accepted === undefined || accepted === null || typeof accepted !== "object")
    throw new Error(`move_response_missing:${JSON.stringify(client.state.latestReceipt)}`);
  trace.push({ phase: "accepted", receipt: summarizeReceipt(accepted), snapshot: summarizeSnapshot(initial), target });
  if (accepted.state !== "accepted") failures.push(`move_not_accepted:${accepted.state}:${accepted.reasonCode}`);

  const progress = await waitForActiveOrProgress(client, initial.revision, 12_000);
  trace.push({ phase: "progress_observed", snapshot: summarizeSnapshot(progress) });
  if (progress.revision <= initial.revision) failures.push("move_revision_did_not_advance");

  const replacementTarget = {
    x: clampTile(progress.tile.x <= 9 ? progress.tile.x + 1 : progress.tile.x - 1),
    y: clampTile(progress.tile.y),
  };
  const replacementRequestId = `body_replace_${Date.now()}`;
  const replacement = await client.execute({
    requestId: replacementRequestId,
    idempotencyKey: `body_replace_idem_${Date.now()}`,
    action: "move_to_tile",
    args: { x: replacementTarget.x, y: replacementTarget.y },
    expectedRevision: progress.revision,
    deadlineMs: Date.now() + 45_000,
  });
  if (replacement === undefined || replacement === null || typeof replacement !== "object")
    throw new Error(`replacement_response_missing:${JSON.stringify(client.state.latestReceipt)}`);
  trace.push({
    phase: "replacement",
    receipt: summarizeReceipt(replacement),
    snapshot: summarizeSnapshot(progress),
    target: replacementTarget,
  });
  const superseded = replacement.state === "accepted" && replacement.reasonCode === "accepted";
  if (!superseded) failures.push(`replacement_not_accepted:${replacement.state}:${replacement.reasonCode}`);
  const oldExecutionTerminal = await waitForReceiptEvent(
    client,
    accepted.executionId,
    "superseded_by_new_directive",
    8_000,
  );
  trace.push({ phase: "superseded_old_execution", receipt: oldExecutionTerminal });

  const active = await waitForActiveExecution(client, 8_000);
  trace.push({ phase: "replacement_active", snapshot: summarizeSnapshot(active) });
  if (active.activeExecution == null) failures.push("replacement_not_visible_as_active");

  const execution = active.activeExecution;
  if (execution != null) {
    const cancelled = await client.cancel(execution.requestId, execution.executionId, "body_smoke_cancel");
    if (cancelled === undefined || cancelled === null || typeof cancelled !== "object")
      throw new Error(`cancel_response_missing:${JSON.stringify(client.state.latestReceipt)}`);
    trace.push({ phase: "cancelled", receipt: summarizeReceipt(cancelled), snapshot: summarizeSnapshot(active) });
    if (cancelled.state !== "cancelled" && cancelled.state !== "invalidated")
      failures.push(`cancel_not_terminal:${cancelled.state}:${cancelled.reasonCode}`);
    const afterCancel = await waitForTerminalSnapshot(client, active.revision, 8_000);
    trace.push({ phase: "after_cancel", snapshot: summarizeSnapshot(afterCancel) });
    if (afterCancel.activeExecution != null) failures.push("active_execution_remains_after_cancel");
  }

  const passed = failures.length === 0;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      durationMs: Date.now() - startedAt,
      initial: summarizeSnapshot(initial),
      trace,
      failures,
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: client.state.latestReceipt,
      bridgeReason: client.state.latestReasonCode,
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribeReceiptFacts();
  client.close();
}

function chooseNearbyTarget(snapshot, distance) {
  // The current save opens the AI Farmhand in a farmhouse. Keep the probe
  // inside the local room and use the known adjacent floor tile from the
  // target-version save rather than testing map routing here.
  return { x: clampTile(snapshot.tile.x), y: clampTile(snapshot.tile.y === 9 ? 8 : 9) };
}
function clampTile(value) {
  return Math.max(0, Math.min(1000, Math.round(value)));
}
function summarizeSnapshot(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    activeExecution:
      snapshot.activeExecution == null
        ? null
        : {
            executionId: snapshot.activeExecution.executionId,
            requestId: snapshot.activeExecution.requestId,
            state: snapshot.activeExecution.state,
            reasonCode: snapshot.activeExecution.reasonCode,
          },
  };
}
function summarizeReceipt(receipt) {
  return {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence,
  };
}
async function waitForActiveOrProgress(client, revision, timeoutMs) {
  return waitUntil(
    client,
    (snapshot) => snapshot.revision > revision && snapshot.activeExecution !== null,
    timeoutMs,
    "move_progress_timeout",
  );
}
async function waitForReceiptEvent(_client, executionId, reasonCode, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = receiptFacts.find(
      (candidate) => candidate.executionId === executionId && candidate.reasonCode === reasonCode,
    );
    if (receipt !== undefined) return summarizeReceipt(receipt);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`receipt_event_timeout:${executionId}:${reasonCode}`);
}
async function waitForActiveExecution(client, timeoutMs) {
  return waitUntil(client, (snapshot) => snapshot.activeExecution !== null, timeoutMs, "replacement_active_timeout");
}
async function waitForTerminalSnapshot(client, revision, timeoutMs) {
  return waitUntil(
    client,
    (snapshot) => snapshot.activeExecution == null && snapshot.revision >= revision,
    timeoutMs,
    "cancel_terminal_timeout",
  );
}
async function waitUntil(client, predicate, timeoutMs, reasonCode) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await client.observe();
  }
  throw new Error(reasonCode);
}
