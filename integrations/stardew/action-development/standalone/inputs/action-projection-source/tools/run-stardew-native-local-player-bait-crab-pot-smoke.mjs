import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "bait_crab_pot";
const EXPECTED_ACTIONS = [ACTION];

/** Execute the bait-crab-pot contract against an already-connected bridge session. */
export async function runBaitCrabPotSmoke(client, config, { postconditionTimeoutMs = 5_000 } = {}) {
  validateConfig(config);
  const before = await observeFresh(client, { actionable: true });
  if (!before.capabilities.includes(ACTION)) throw new Error("production_capability_profile_invalid");
  const target = before.baitCrabPotTargets?.find(
    (entry) => Math.abs(entry.x - before.tile.x) <= 1 && Math.abs(entry.y - before.tile.y) <= 1,
  );
  if (
    !target ||
    target.baitQualifiedItemId !== "(O)685" ||
    target.qualifiedItemId !== "(O)710" ||
    target.baitStack !== 1
  )
    throw new Error("no_adjacent_unbaited_crab_pot_target");

  const requestId = `native_local_bait_crab_pot_${Date.now()}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: {
      slot: target.slot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: "(O)685",
      expectedTargetId: target.targetId,
    },
    snapshot: before,
    timeoutMs: 30_000,
  });
  const after = await waitForFreshSnapshot(client, {
    minRevision: receipt.revision,
    timeoutMs: postconditionTimeoutMs,
    requireActionable: true,
    check: (snapshot) => Array.isArray(snapshot.baitCrabPotResultTargets),
  });
  const evidence = parseEvidence(receipt.evidence?.detail);
  const result = after.baitCrabPotResultTargets.find((entry) => entry.targetId === target.targetId);
  const passed =
    receipt.requestId === requestId &&
    receipt.state === "succeeded" &&
    receipt.reasonCode === "crab_pot_baited" &&
    receipt.revision === after.revision &&
    after.revision > before.revision &&
    evidence.source === "(O)685" &&
    evidence.pot === "(O)710" &&
    evidence.bait_before === "none" &&
    evidence.bait_after === "(O)685" &&
    Number(evidence.x) === target.x &&
    Number(evidence.y) === target.y &&
    evidence.target === target.targetId &&
    Number(evidence.slot) === target.slot &&
    Number(evidence.inventory_before) === 1 &&
    Number(evidence.inventory_after) === 0 &&
    evidence.owner === target.ownerId &&
    result?.targetId === target.targetId &&
    result.location === target.location &&
    result.x === target.x &&
    result.y === target.y &&
    result.slot === target.slot &&
    result.qualifiedItemId === "(O)710" &&
    result.baitQualifiedItemId === "(O)685" &&
    result.ownerId === target.ownerId &&
    result.baitStack === 1 &&
    !after.baitCrabPotTargets?.some((entry) => entry.targetId === target.targetId);
  return {
    state: passed ? "passed" : "blocked",
    action: ACTION,
    requestId,
    target,
    receipt: summarizeReceipt(receipt),
    evidence,
    result: result ?? null,
    before: summarize(before),
    after: summarize(after),
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runBaitCrabPotSmoke(session.client, config);
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
  if (typeof detail !== "string") throw new Error("missing_bait_crab_pot_evidence");
  const out = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || out[part.slice(0, index)] !== undefined) throw new Error("malformed_bait_crab_pot_evidence");
    out[part.slice(0, index)] = part.slice(index + 1);
  }
  return out;
}

function summarize(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    baitCrabPotTargets: snapshot.baitCrabPotTargets?.length ?? 0,
    baitCrabPotResultTargets: snapshot.baitCrabPotResultTargets?.length ?? 0,
  };
}
