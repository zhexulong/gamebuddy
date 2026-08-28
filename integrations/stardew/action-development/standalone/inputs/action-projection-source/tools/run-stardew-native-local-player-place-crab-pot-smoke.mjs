import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "place_crab_pot";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "place_crab_pot"];

/** Execute the place-crab-pot contract against an already-connected bridge session. */
export async function runPlaceCrabPotSmoke(client, config, { postconditionTimeoutMs = 5_000 } = {}) {
  validateConfig(config);
  const before = await observeFresh(client, { actionable: true });
  for (const action of EXPECTED_ACTIONS)
    if (!before.capabilities.includes(action)) throw new Error(`native_local_${action}_capability_missing`);
  const target = before.crabPotTargets?.find(
    (entry) => Math.abs(entry.x - before.tile.x) <= 1 && Math.abs(entry.y - before.tile.y) <= 1,
  );
  if (!target) throw new Error("no_adjacent_live_crab_pot_target");

  const requestId = `native_local_place_crab_pot_${Date.now()}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: {
      slot: target.slot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: target.qualifiedItemId,
      expectedTargetId: target.targetId,
    },
    snapshot: before,
    timeoutMs: 30_000,
  });
  const after = await waitForFreshSnapshot(client, {
    minRevision: receipt.revision,
    timeoutMs: postconditionTimeoutMs,
    requireActionable: true,
    check: (snapshot) => Array.isArray(snapshot.crabPotResultTargets),
  });
  const evidence = parseEvidence(receipt.evidence?.detail);
  const result = after.crabPotResultTargets?.find((entry) => entry.targetId === target.targetId);
  // Native CrabPot.updateOffset and getOverlayTiles can both legitimately
  // produce empty/zero facts for an all-water neighborhood. Require finite
  // offset coordinates and a well-formed (possibly empty) target-bound list.
  const overlayFacts =
    Array.isArray(result?.overlayTiles) &&
    result.overlayTiles.every(
      (tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y) && Number.isInteger(tile.count) && tile.count > 0,
    );
  const resultMatches =
    result !== undefined &&
    result.location === target.location &&
    result.x === target.x &&
    result.y === target.y &&
    result.slot === target.slot &&
    result.targetId === target.targetId &&
    result.qualifiedItemId === target.qualifiedItemId &&
    result.ownerId > 0 &&
    Number.isFinite(result.offsetX) &&
    Number.isFinite(result.offsetY) &&
    overlayFacts;
  const evidenceMatches =
    receipt.requestId === requestId &&
    receipt.state === "succeeded" &&
    receipt.reasonCode === "crab_pot_placed" &&
    typeof receipt.executionId === "string" &&
    receipt.executionId.length > 0 &&
    receipt.revision === after.revision &&
    evidence.source === "(O)710" &&
    evidence.location === target.location &&
    Number(evidence.x) === target.x &&
    Number(evidence.y) === target.y &&
    evidence.target === target.targetId &&
    evidence.item === target.qualifiedItemId &&
    Number(evidence.slot) === target.slot &&
    evidence.is_crab_pot === "true" &&
    Number(evidence.owner) === result?.ownerId &&
    Number(evidence.inventory_before) === 1 &&
    Number(evidence.inventory_after) === 0 &&
    evidence.overlay_tiles !== undefined &&
    evidence.offset_x === String(result?.offsetX) &&
    evidence.offset_y === String(result?.offsetY);
  const passed =
    evidenceMatches &&
    resultMatches &&
    before.crabPotTargets?.some((entry) => entry.targetId === target.targetId) &&
    !after.crabPotTargets?.some((entry) => entry.targetId === target.targetId) &&
    after.crabPotResultTargets?.some((entry) => entry.targetId === target.targetId) &&
    after.actionable &&
    after.activeExecution == null;
  return {
    state: passed ? "passed" : "blocked",
    action: ACTION,
    target,
    receipt: summarizeReceipt(receipt),
    evidence,
    result: result ?? null,
    evidenceMatches,
    resultMatches,
    before: summarize(before),
    after: summarize(after),
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runPlaceCrabPotSmoke(session.client, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "blocked",
        reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      }),
    );
    process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateConfig(config) {
  if (JSON.stringify(config.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS))
    throw new Error("production_capability_profile_invalid");
}

function parseEvidence(detail) {
  if (typeof detail !== "string") throw new Error("missing_crab_pot_evidence");
  const out = {};
  for (const part of detail.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0 || out[part.slice(0, i)] !== undefined) throw new Error("malformed_crab_pot_evidence");
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function summarize(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    crabPotTargets: snapshot.crabPotTargets?.length ?? 0,
    crabPotResultTargets: snapshot.crabPotResultTargets?.length ?? 0,
  };
}
