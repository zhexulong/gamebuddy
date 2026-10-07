import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "collect_building_chest_output";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * collect_building_chest_output live contract.
 *
 * The branch the world is in decides what must happen, and BOTH branches are asserted from the
 * world rather than from the receipt:
 *   * ONE stack: the collect must succeed, and the stack must be gone from the chest (re-read from
 *     a fresh snapshot) while the receipt's two halves agree — the chest lost `moved_count` of
 *     that item and the pack gained exactly as many. The slot count must have fallen too, because
 *     that is what the native branch counts before it decides anything.
 *   * TWO OR MORE stacks: the collect must be REFUSED BY NAME (`building_chest_requires_menu`) and
 *     must not move the world at all. The native branch would open `ItemGrabMenu` here, and this
 *     Mod has no container-menu driver, so a silent menu (or a `succeeded` claiming a transfer it
 *     did not make) is the failure this pins.
 *   * Either way, the WRONG BRANCH case runs first, while the world is untouched: a Load chest's
 *     own tile and id sent to collect, which must refuse with `building_chest_not_collectable`.
 *
 * The runner chooses neither the chest tile nor the branch: both come from the `buildingChestTargets`
 * entries the Mod publishes, and the Mod re-resolves the chest on the game thread.
 */
export async function runCollectBuildingChestOutputSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const opening = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(opening, REQUIRED_CAPABILITIES);
    const target = chooseCollectTarget(opening);
    const sibling = siblingLoadTarget(opening, target);
    trace.push({ step: "discovered", target: target.targetId, sibling: sibling.targetId, stacks: target.stackCount });

    // 1. WRONG BRANCH, first, while the world is still untouched: the Load chest's tile and id sent
    //    to the collect action. Collecting an Input chest is not what the native branch does there,
    //    so the action must refuse by name.
    const wrongBranch = await request(client, receipts, terminalTimeoutMs, {
      x: sibling.x,
      y: sibling.y,
      expectedTargetId: sibling.targetId,
    });
    trace.push({ step: "wrong_branch", receipt: summarizeReceipt(wrongBranch.terminal) });
    if (wrongBranch.terminal.state !== "rejected" || wrongBranch.terminal.reasonCode !== "building_chest_not_collectable")
      throw new Error(`building_chest_wrong_branch_not_refused:${wrongBranch.terminal.state}/${wrongBranch.terminal.reasonCode}`);
    await assertWorldUnchanged(client, sibling, "building_chest_wrong_branch_moved_world");

    if (target.stackCount >= 2) {
      // The declared Given is the >= 2-stack world: the refusal is the proof.
      const refused = await request(client, receipts, terminalTimeoutMs, { x: target.x, y: target.y, expectedTargetId: target.targetId });
      trace.push({ step: "menu_refusal", action: ACTION, target: target.targetId, receipt: summarizeReceipt(refused.terminal) });
      if (refused.terminal.state !== "rejected" || refused.terminal.reasonCode !== "building_chest_requires_menu")
        throw new Error(`building_chest_multi_stack_not_refused:${refused.terminal.state}/${refused.terminal.reasonCode}`);
      const evidence = parseEvidence(refused.terminal.evidence);
      assertEvidence(evidence, "native_menu_opened", "false");
      assertEvidence(evidence, "native_accepted", "false");
      await assertWorldUnchanged(client, target, "building_chest_menu_refusal_moved_world");
      return {
        state: "passed",
        topology: "native_local_player_fixture",
        reasonCode: "building_chest_requires_menu",
        target: target.targetId,
        building: target.buildingType,
        chest: { id: target.chestId, stacks: target.stackCount, items: target.itemCount },
        negative: { wrongBranch: wrongBranch.terminal.reasonCode, multiStack: refused.terminal.reasonCode },
        evidence,
        receipt: summarizeReceipt(refused.terminal),
        trace,
      };
    }

    if (target.stackCount !== 1)
      throw new Error(`building_chest_collect_declared_given_absent:stacks=${target.stackCount}`);

    // 2. The honest collect of the single advertised stack.
    const collected = await request(client, receipts, terminalTimeoutMs, { x: target.x, y: target.y, expectedTargetId: target.targetId });
    trace.push({ step: "collect", action: ACTION, target: target.targetId, receipt: summarizeReceipt(collected.terminal) });
    if (collected.terminal.state !== "succeeded" || collected.terminal.reasonCode !== "building_chest_output_collected")
      throw new Error(`building_chest_collect_failed:${collected.terminal.state}/${collected.terminal.reasonCode}`);
    const evidence = parseEvidence(collected.terminal.evidence);
    assertEvidence(evidence, "branch", "collect");
    assertEvidence(evidence, "native_accepted", "true");
    assertEvidence(evidence, "native_menu_opened", "false");
    const moved = positiveInteger(evidence.moved_count, "moved_count");
    const slotsBefore = integer(evidence.chest_slots_before, "chest_slots_before");
    const slotsAfter = integer(evidence.chest_slots_after, "chest_slots_after");
    if (slotsAfter >= slotsBefore) throw new Error(`building_chest_slot_half_mismatch:${slotsBefore}:${slotsAfter}`);
    const chestBefore = integer(evidence.chest_item_before, "chest_item_before");
    const chestAfter = integer(evidence.chest_item_after, "chest_item_after");
    if (chestBefore - chestAfter !== moved) throw new Error(`building_chest_chest_half_mismatch:${chestBefore}:${chestAfter}:${moved}`);
    const carriedBefore = integer(evidence.carried_before, "carried_before");
    const carriedAfter = integer(evidence.carried_after, "carried_after");
    if (carriedAfter - carriedBefore !== moved) throw new Error(`building_chest_carried_half_mismatch:${carriedBefore}:${carriedAfter}:${moved}`);

    // The world change, re-read after the terminal, by TILE rather than by id: the identity names
    // the chest, not its contents, so it must NOT have moved either.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const reread = chestTargetAtTile(after, target.x, target.y);
    if (reread.targetId !== target.targetId)
      throw new Error(`building_chest_world_identity_stale:${target.targetId}:${reread.targetId}`);
    if (reread.stackCount !== 0 || reread.itemCount !== 0)
      throw new Error(`building_chest_world_unchanged:${reread.stackCount}:${reread.itemCount}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "building_chest_output_collected",
      target: target.targetId,
      building: target.buildingType,
      chest: { id: target.chestId, stacksBefore: target.stackCount, stacksAfter: reread.stackCount, itemsAfter: reread.itemCount },
      moved,
      negative: { wrongBranch: wrongBranch.terminal.reasonCode },
      evidence,
      receipt: summarizeReceipt(collected.terminal),
      trace,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

let requestSequence = 0;

/** Observe, then submit one revision-bound request and wait for its own terminal. */
async function request(client, receipts, terminalTimeoutMs, args) {
  const snapshot = await observeFresh(client, { actionable: true });
  const requestId = `native_local_${ACTION}_${Date.now()}_${(requestSequence += 1)}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  // A request whose native work resolves synchronously answers with an immediate terminal instead
  // of `accepted`; waitForTerminal covers both shapes by searching the immediate receipt first.
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("native_local_terminal_identity_mismatch");
  return { snapshot, accepted, terminal };
}

/** The advertised Collect chest the fixture armed, or a named failure. */
function chooseCollectTarget(snapshot) {
  const targets = (snapshot.buildingChestTargets ?? []).filter(
    (entry) => entry?.branch === "collect" && typeof entry?.targetId === "string",
  );
  if (targets.length === 0)
    throw new Error(
      `building_chest_collect_target_missing:tile=${snapshot.tile?.x},${snapshot.tile?.y};location=${snapshot.location};candidates=${(snapshot.buildingChestTargets ?? []).length}`,
    );
  const target = targets[0];
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || !Number.isInteger(target.stackCount))
    throw new Error(`building_chest_collect_target_malformed:${target.targetId}`);
  return target;
}

/** The same building's advertised Load chest, which the wrong-branch case names. */
function siblingLoadTarget(snapshot, collect) {
  const target = (snapshot.buildingChestTargets ?? []).find(
    (entry) =>
      entry?.branch === "load" &&
      typeof entry?.targetId === "string" &&
      entry.buildingType === collect.buildingType &&
      entry.chestId !== collect.chestId,
  );
  if (target === undefined)
    throw new Error(
      `building_chest_load_sibling_missing:building=${collect.buildingType};candidates=${(snapshot.buildingChestTargets ?? []).length}`,
    );
  return target;
}

/** One advertised target as the world re-read it, found by the tile it was published at. */
function chestTargetAtTile(snapshot, x, y) {
  const entry = (snapshot.buildingChestTargets ?? []).find((candidate) => candidate?.x === x && candidate?.y === y);
  if (entry === undefined) throw new Error(`building_chest_target_gone:${x},${y}`);
  if (typeof entry.itemCount !== "number" || typeof entry.stackCount !== "number")
    throw new Error(`building_chest_target_projection_incomplete:${x},${y}`);
  return entry;
}

/** A refusal must not move the world: the target must still read exactly as it did. */
async function assertWorldUnchanged(client, target, code) {
  const after = await observeFresh(client, { actionable: true });
  const reread = chestTargetAtTile(after, target.x, target.y);
  if (reread.itemCount !== target.itemCount || reread.stackCount !== target.stackCount)
    throw new Error(`${code}:${target.itemCount}:${reread.itemCount}:${target.stackCount}:${reread.stackCount}`);
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`building_chest_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function integer(value, key) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
    throw new Error(`building_chest_evidence_${key}:${value ?? "missing"}`);
  return Number(value);
}

function positiveInteger(value, key) {
  const parsed = integer(value, key);
  if (parsed < 1) throw new Error(`building_chest_evidence_${key}:${value}`);
  return parsed;
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runCollectBuildingChestOutputSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
