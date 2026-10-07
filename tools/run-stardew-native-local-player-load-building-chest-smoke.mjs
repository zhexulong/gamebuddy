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

const ACTION = "load_building_chest";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
// The wire's maximum inventory slot. The pack holds at most 36 slots (0..35), so this index is
// always outside it: it is the runner's own way to name "a slot that holds nothing".
const EMPTY_SLOT = 36;

/**
 * load_building_chest live contract.
 *
 * The receipt is not the proof. The world is read before and after:
 *   1. the declared Given is a building whose data declares a Load chest and a Collect chest, the
 *      Load chest EMPTY, and the actor holding an item the Load chest's own conversion accepts
 *      one quantum above what that conversion requires, so ONE real load moves a whole quantum
 *      and must leave the remainder behind;
 *   2. the load's two halves are asserted independently: the chest's own count of that item rose
 *      (read out of a FRESH snapshot after the terminal) and the receipt's `moved_count` equals
 *      the held stack's fall AND a whole number of the conversion's `required_count`;
 *   3. the published identity must NOT move when the contents do — the id names the chest, not
 *      what is in it — or a second load could never be requested;
 *   4. the negative cases are the ones the action's own boundary states: the wrong branch (a
 *      Collect chest asked to LOAD, refused by name), a target id that does not describe the tree
 *      it is sent with, and a slot that holds nothing. Each must be refused and must NOT move the
 *      world.
 *
 * The runner never chooses the chest tile or the slot: both come from the `buildingChestTargets`
 * entries the Mod publishes, and the Mod re-resolves the chest on the game thread.
 */
export async function runLoadBuildingChestSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const opening = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(opening, REQUIRED_CAPABILITIES);
    const target = chooseLoadTarget(opening);
    const sibling = siblingCollectTarget(opening, target);
    trace.push({ step: "discovered", target: target.targetId, sibling: sibling.targetId, slot: target.loadInputSlot });

    // 1. WRONG BRANCH, first, while the world is still untouched: the Collect chest's own tile and
    //    id sent to the LOAD action. The native Load branch is not what would run there, so the
    //    action must refuse by name rather than load into a chest that is not its subject.
    const wrongBranch = await request(client, receipts, terminalTimeoutMs, ACTION, {
      x: sibling.x,
      y: sibling.y,
      slot: target.loadInputSlot,
      expectedTargetId: sibling.targetId,
    });
    trace.push({ step: "wrong_branch", receipt: summarizeReceipt(wrongBranch.terminal) });
    if (wrongBranch.terminal.state !== "rejected" || wrongBranch.terminal.reasonCode !== "building_chest_not_loadable")
      throw new Error(`building_chest_wrong_branch_not_refused:${wrongBranch.terminal.state}/${wrongBranch.terminal.reasonCode}`);
    await assertWorldUnchanged(client, sibling, "building_chest_wrong_branch_moved_world");

    // 2. A target id that does not describe the tree it is sent with: the LOAD chest's tile with the
    //    SIBLING's id. The identity binds the chest and its tile, so this is a mismatch, not a
    //    silent re-target.
    const mismatched = await request(client, receipts, terminalTimeoutMs, ACTION, {
      x: target.x,
      y: target.y,
      slot: target.loadInputSlot,
      expectedTargetId: sibling.targetId,
    });
    trace.push({ step: "mismatched_identity", receipt: summarizeReceipt(mismatched.terminal) });
    if (mismatched.terminal.state !== "rejected" || mismatched.terminal.reasonCode !== "building_chest_target_changed")
      throw new Error(`building_chest_mismatch_not_refused:${mismatched.terminal.state}/${mismatched.terminal.reasonCode}`);
    await assertWorldUnchanged(client, target, "building_chest_mismatch_moved_world");

    // 3. A slot that holds nothing. The native Load branch reads who.ActiveObject, so a request that
    //    names an empty slot has nothing to load and must be refused rather than do nothing quietly.
    const emptySlot = await request(client, receipts, terminalTimeoutMs, ACTION, {
      x: target.x,
      y: target.y,
      slot: EMPTY_SLOT,
      expectedTargetId: target.targetId,
    });
    trace.push({ step: "empty_slot", receipt: summarizeReceipt(emptySlot.terminal) });
    if (emptySlot.terminal.state !== "rejected" || emptySlot.terminal.reasonCode !== "item_not_owned_in_slot")
      throw new Error(`building_chest_empty_slot_not_refused:${emptySlot.terminal.state}/${emptySlot.terminal.reasonCode}`);
    await assertWorldUnchanged(client, target, "building_chest_empty_slot_moved_world");

    // 4. The honest load, with the slot the Mod itself published for this chest.
    const loaded = await request(client, receipts, terminalTimeoutMs, ACTION, {
      x: target.x,
      y: target.y,
      slot: target.loadInputSlot,
      expectedTargetId: target.targetId,
    });
    trace.push({ step: "load", action: ACTION, target: target.targetId, receipt: summarizeReceipt(loaded.terminal) });
    if (loaded.terminal.state !== "succeeded" || loaded.terminal.reasonCode !== "building_chest_loaded")
      throw new Error(`building_chest_load_failed:${loaded.terminal.state}/${loaded.terminal.reasonCode}`);
    const evidence = parseEvidence(loaded.terminal.evidence);
    assertEvidence(evidence, "branch", "load");
    assertEvidence(evidence, "native_accepted", "true");
    assertEvidence(evidence, "item_accepted", "true");
    assertEvidence(evidence, "native_refusal", "none");
    assertEvidence(evidence, "native_menu_opened", "false");
    const moved = positiveInteger(evidence.moved_count, "moved_count");
    const required = positiveInteger(evidence.required_count, "required_count");
    if (moved % required !== 0) throw new Error(`building_chest_quantum_mismatch:${moved}:${required}`);
    const heldBefore = integer(evidence.held_stack_before, "held_stack_before");
    const heldAfter = integer(evidence.held_stack_after, "held_stack_after");
    if (heldBefore - heldAfter !== moved) throw new Error(`building_chest_held_half_mismatch:${heldBefore}:${heldAfter}:${moved}`);
    const chestBefore = integer(evidence.chest_item_before, "chest_item_before");
    const chestAfter = integer(evidence.chest_item_after, "chest_item_after");
    if (chestAfter - chestBefore !== moved) throw new Error(`building_chest_chest_half_mismatch:${chestBefore}:${chestAfter}:${moved}`);

    // The world change, re-read after the terminal, by TILE rather than by id: if the identity had
    // followed the contents the old id would be gone, and that is itself the defect to report.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const reread = chestTargetAtTile(after, target.x, target.y);
    if (reread.targetId !== target.targetId)
      throw new Error(`building_chest_world_identity_stale:${target.targetId}:${reread.targetId}`);
    if (reread.itemCount !== target.itemCount + moved)
      throw new Error(`building_chest_world_unchanged:${target.itemCount}:${reread.itemCount}:${moved}`);
    if (reread.branch !== "load" || reread.chestId !== target.chestId)
      throw new Error(`building_chest_world_target_replaced:${reread.branch}:${reread.chestId}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "building_chest_loaded",
      target: target.targetId,
      building: target.buildingType,
      chest: { id: target.chestId, before: target.itemCount, after: reread.itemCount },
      moved,
      requiredCount: required,
      negative: {
        wrongBranch: wrongBranch.terminal.reasonCode,
        mismatchedIdentity: mismatched.terminal.reasonCode,
        emptySlot: emptySlot.terminal.reasonCode,
      },
      evidence,
      receipt: summarizeReceipt(loaded.terminal),
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

/** Observe, then submit one revision-bound request and wait for its own terminal. */
async function request(client, receipts, terminalTimeoutMs, action, args) {
  const snapshot = await observeFresh(client, { actionable: true });
  const requestId = `native_local_${action}_${Date.now()}_${(requestSequence += 1)}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
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

let requestSequence = 0;

/** The advertised Load chest the fixture armed, or a named failure. */
function chooseLoadTarget(snapshot) {
  const targets = (snapshot.buildingChestTargets ?? []).filter(
    (entry) => entry?.branch === "load" && typeof entry?.targetId === "string",
  );
  if (targets.length === 0)
    throw new Error(
      `building_chest_load_target_missing:tile=${snapshot.tile?.x},${snapshot.tile?.y};location=${snapshot.location};candidates=${(snapshot.buildingChestTargets ?? []).length}`,
    );
  const target = targets.find((entry) => Number.isInteger(entry.loadInputSlot));
  if (target === undefined)
    throw new Error(
      `building_chest_load_input_slot_missing:candidates=${targets.map((entry) => `${entry.chestId}:${entry.itemCount}`).join(",")}`,
    );
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y))
    throw new Error(`building_chest_load_target_malformed:${target.targetId}`);
  return target;
}

/** The same building's advertised Collect chest, which the wrong-branch case names. */
function siblingCollectTarget(snapshot, load) {
  const target = (snapshot.buildingChestTargets ?? []).find(
    (entry) =>
      entry?.branch === "collect" &&
      typeof entry?.targetId === "string" &&
      entry.buildingType === load.buildingType &&
      entry.chestId !== load.chestId,
  );
  if (target === undefined)
    throw new Error(
      `building_chest_collect_sibling_missing:building=${load.buildingType};candidates=${(snapshot.buildingChestTargets ?? []).length}`,
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
    const result = await runLoadBuildingChestSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
