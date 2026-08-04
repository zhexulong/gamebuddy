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
const trace = [];
const startedAt = Date.now();
try {
  let snapshot = await client.observe();
  if (!snapshot.capabilities.includes("machine_inspect") || !snapshot.capabilities.includes("move_to_tile") || !snapshot.capabilities.includes("travel")) {
    throw new Error("fixture_navigation_or_machine_inspect_capability_missing");
  }
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  // SetupBigFarm's target-version Keg grid starts at x=3,y=36. The runner
  // searches only its four outside perimeter approach lines; production still
  // chooses the opaque target from the following fresh snapshot.
  snapshot = await moveToMachineApproach(snapshot, machineApproachCandidates());
  snapshot = await waitForActionable(snapshot, 3_000);
  const target = chooseMachineTarget(snapshot);
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_machine_target", trace, snapshot: summarizeSnapshot(snapshot), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `machine_inspect_fixture_${Date.now()}`,
      idempotencyKey: `machine_inspect_fixture_idem_${Date.now()}`,
      action: "machine_inspect",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const evidence = parseEvidence(receipt.evidence);
    const reread = after.machineTargets?.find((entry) => entry.targetId === target.targetId) ?? null;
    const sameLiveState = sameMachine(target, reread);
    const evidenceMatches = evidence.target === target.targetId
      && evidence.tile === `${target.x},${target.y}`
      && evidence.machine === target.qualifiedItemId
      && evidence.ready_for_harvest === String(target.readyForHarvest)
      && evidence.minutes_until_ready === String(target.minutesUntilReady)
      && evidence.held === (target.heldObjectQualifiedItemId ?? "none")
      && evidence.last_input === (target.lastInputQualifiedItemId ?? "none");
    const passed = receipt.state === "succeeded" && receipt.reasonCode === "machine_inspected" && evidenceMatches && sameLiveState;
    console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "machine_inspected" : receipt.reasonCode, target, receipt: summarizeReceipt(receipt), evidence, reread, sameLiveState, trace, before: summarizeSnapshot(snapshot), after: summarizeSnapshot(after), durationMs: Date.now() - startedAt }));
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally { client.close(); }

async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const receipt = await client.execute({ requestId: `machine_fixture_travel_${Date.now()}`, idempotencyKey: `machine_fixture_travel_idem_${Date.now()}`, action: "travel", args: { x: warp.sourceX, y: warp.sourceY }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  trace.push({ phase: "travel", receipt: summarizeReceipt(receipt), warp });
  if (receipt.state !== "accepted") throw new Error(`travel_not_accepted:${receipt.reasonCode}`);
  return waitForLocation("Farm", receipt.executionId, 15_000);
}
async function move(snapshot, target, phase) {
  const receipt = await client.execute({ requestId: `${phase}_${Date.now()}`, idempotencyKey: `${phase}_idem_${Date.now()}`, action: "move_to_tile", args: target, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 45_000 });
  trace.push({ phase, receipt: summarizeReceipt(receipt), target });
  if (receipt.state !== "accepted") throw new Error(`${phase}_not_accepted:${receipt.reasonCode}`);
  return waitForAdjacent(target, receipt.executionId, 55_000);
}
async function moveToMachineApproach(snapshot, candidates) {
  let latest = snapshot;
  for (const target of candidates) {
    try { return await move(latest, target, "move_to_native_machine"); }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.endsWith(":no_native_path")) throw error;
      latest = await client.observe();
    }
  }
  throw new Error("native_machine_approach_unreachable");
}
async function waitForLocation(location, executionId, timeoutMs) { return waitFor((snapshot) => snapshot.location === location && snapshot.activeExecution == null, executionId, timeoutMs); }
async function waitForAdjacent(target, executionId, timeoutMs) { return waitFor((snapshot) => snapshot.activeExecution == null && adjacent(snapshot.tile, target), executionId, timeoutMs); }
async function waitFor(predicate, executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const receipt = client.state.latestReceipt;
    if (receipt?.executionId === executionId && isTerminal(receipt.state) && receipt.state !== "succeeded") throw new Error(`navigation_failed:${receipt.reasonCode}`);
    if (predicate(latest)) return latest;
    await delay(200); latest = await client.observe();
  }
  throw new Error(`navigation_timeout:${executionId}`);
}
async function waitForActionable(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let latest = snapshot;
  while (Date.now() < deadline) { if (latest.actionable && latest.activeExecution == null) return latest; await delay(150); latest = await client.observe(); }
  return latest;
}
function machineApproachCandidates() {
  const candidates = [];
  for (let y = 36; y <= 44; y++) { candidates.push({ x: 2, y }, { x: 15, y }); }
  for (let x = 3; x <= 14; x++) { candidates.push({ x, y: 35 }, { x, y: 45 }); }
  return candidates;
}
function chooseMachineTarget(snapshot) { return snapshot.machineTargets?.find((entry) => Number.isInteger(entry.x) && Number.isInteger(entry.y) && typeof entry.targetId === "string" && typeof entry.qualifiedItemId === "string") ?? null; }
function sameMachine(left, right) { return right !== null && left.targetId === right.targetId && left.x === right.x && left.y === right.y && left.qualifiedItemId === right.qualifiedItemId && left.readyForHarvest === right.readyForHarvest && left.minutesUntilReady === right.minutesUntilReady && (left.heldObjectQualifiedItemId ?? null) === (right.heldObjectQualifiedItemId ?? null) && (left.lastInputQualifiedItemId ?? null) === (right.lastInputQualifiedItemId ?? null); }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function parseEvidence(evidence) { const detail = typeof evidence?.detail === "string" ? evidence.detail : ""; return Object.fromEntries(detail.split(";").map((part) => { const i = part.indexOf("="); return i > 0 ? [part.slice(0, i), part.slice(i + 1)] : null; }).filter(Boolean)); }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function summarizeSnapshot(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, machineTargets: snapshot.machineTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
