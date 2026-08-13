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
const trace = [];
try {
  let snapshot = await client.observe();
  for (const action of ["npc_relationship", "move_to_tile", "travel"]) {
    if (!snapshot.capabilities.includes(action)) throw new Error(`fixture_${action}_capability_missing`);
  }
  snapshot = await waitForActionable(snapshot, 5_000);
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);

  let target = chooseTarget(snapshot);
  if (target === null) {
    const candidates = farmhouseApproachCandidates(snapshot);
    if (candidates.length === 0) throw new Error("farmhouse_approach_missing");
    for (const candidate of candidates) {
      try {
        snapshot = await move(snapshot, candidate, "move_to_npc_fixture_approach");
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (!message.endsWith(":no_native_path")) throw error;
        snapshot = await client.observe();
        continue;
      }
      snapshot = await waitForActionable(snapshot, 3_000);
      target = chooseTarget(snapshot);
      if (target !== null) break;
    }
  }

  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_npc_relationship_target",
        trace,
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const before = snapshot;
    const receipt = await client.execute({
      requestId: `npc_relationship_fixture_${Date.now()}`,
      idempotencyKey: `npc_relationship_fixture_idem_${Date.now()}`,
      action: "npc_relationship",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: before.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const afterTarget = after.npcRelationshipTargets?.find((entry) => entry.targetId === target.targetId) ?? null;
    const evidence = parseEvidence(receipt.evidence);
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "npc_relationship_inspected" &&
      afterTarget !== null &&
      sameFacts(target, afterTarget) &&
      evidence.location === targetLocation(target, before) &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.npc === target.npcName &&
      evidence.points === String(target.friendshipPoints) &&
      evidence.status === target.friendshipStatus &&
      evidence.talked_to_today === String(target.talkedToToday) &&
      evidence.gifts_today === String(target.giftsToday) &&
      evidence.gifts_this_week === String(target.giftsThisWeek);
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "npc_relationship_inspected" : receipt.reasonCode,
        target,
        receipt: summarizeReceipt(receipt),
        evidence,
        afterTarget,
        trace,
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
      latestReceipt: summarizeReceipt(client.state.latestReceipt),
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function chooseTarget(snapshot) {
  return (
    snapshot.npcRelationshipTargets?.find(
      (entry) =>
        Number.isInteger(entry.x) &&
        Number.isInteger(entry.y) &&
        typeof entry.targetId === "string" &&
        typeof entry.npcName === "string",
    ) ?? null
  );
}
function sameFacts(left, right) {
  return (
    right !== null &&
    left.targetId === right.targetId &&
    left.x === right.x &&
    left.y === right.y &&
    left.npcName === right.npcName &&
    left.friendshipPoints === right.friendshipPoints &&
    left.friendshipStatus === right.friendshipStatus &&
    left.talkedToToday === right.talkedToToday &&
    left.giftsToday === right.giftsToday &&
    left.giftsThisWeek === right.giftsThisWeek
  );
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
    npcRelationshipTargets: snapshot.npcRelationshipTargets?.length ?? 0,
    activeExecution: snapshot.activeExecution ?? null,
  };
}
function targetLocation(target, snapshot) {
  return snapshot.location;
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function findReceipt(executionId) {
  return (
    receipts.find((receipt) => receipt.executionId === executionId) ??
    (client.state.latestReceipt?.executionId === executionId ? client.state.latestReceipt : null)
  );
}
function farmhouseApproachCandidates(snapshot) {
  // Called after travelToFarm, so the fresh snapshot tile is the native Farm
  // warp arrival used by the fixture initializer. Do not use a FarmHouse door's
  // target tile here: that target is inside the building, while the fixture NPC
  // intentionally lives on the Farm map.
  const source = { x: Math.round(snapshot.tile.x), y: Math.round(snapshot.tile.y) };
  // The fixture initializer places the NPC on a valid native Farm tile near
  // the FarmHouse/Cabin warp arrival. These are movement candidates only: the
  // production target is still selected exclusively from a fresh
  // npcRelationshipTargets snapshot.
  // The initializer searches a bounded 4-tile Chebyshev square around the
  // native Farm arrival. Search that same complete square here rather than
  // guessing cardinal/positive-Y offsets: the target-version collision map
  // may leave only a diagonal or negative-Y approach reachable. These are
  // movement candidates only; the NPC tile and opaque target must still come
  // from a fresh live snapshot before the production request.
  const radius = 4;
  const candidates = [];
  for (let offsetX = -radius; offsetX <= radius; offsetX++) {
    for (let offsetY = -radius; offsetY <= radius; offsetY++) {
      if (offsetX === 0 && offsetY === 0) continue;
      candidates.push({
        x: source.x + offsetX,
        y: source.y + offsetY,
        chebyshevDistance: Math.max(Math.abs(offsetX), Math.abs(offsetY)),
        manhattanDistance: Math.abs(offsetX) + Math.abs(offsetY),
      });
    }
  }
  candidates.sort(
    (left, right) =>
      left.chebyshevDistance - right.chebyshevDistance ||
      left.manhattanDistance - right.manhattanDistance ||
      left.y - right.y ||
      left.x - right.x,
  );
  return candidates.map(({ x, y }) => ({ x, y }));
}
async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await client.execute({
    requestId: `npc_fixture_travel_${Date.now()}`,
    idempotencyKey: `npc_fixture_travel_idem_${Date.now()}`,
    action: "travel",
    args: { x: warp.sourceX, y: warp.sourceY },
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "travel_to_farm", warp, receipt: summarizeReceipt(accepted) });
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return await waitFor(
    (latest) => latest.location === "Farm" && latest.activeExecution == null,
    accepted.executionId,
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
  trace.push({ phase, target, receipt: summarizeReceipt(accepted) });
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  return await waitFor(
    (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
    accepted.executionId,
    55_000,
  );
}
async function waitFor(predicate, executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const receipt = findReceipt(executionId);
    if (receipt && isTerminal(receipt.state)) {
      if (receipt.state !== "succeeded") throw new Error(`navigation_failed:${receipt.reasonCode}`);
      if (predicate(latest)) return latest;
    }
    if (predicate(latest)) return latest;
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`navigation_timeout:${executionId}`);
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
