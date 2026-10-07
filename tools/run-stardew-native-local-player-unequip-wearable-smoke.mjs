// unequip_wearable live contract.
//
// The receipt is not the proof, and this action's frozen rule is a REFUSAL, so the runner drives
// both declared Given variants of the same action and asserts the world, not the receipt:
//
//   * scenario `native_unequip_wearable_v1` — the actor wears one wearable and the backpack has a
//     free slot. The run asserts (1) an opaque id that names no body slot is REFUSED with
//     wearable_target_not_found and moves nothing, (2) a destination slot that is NOT free is
//     REFUSED with wearable_destination_slot_occupied and moves nothing, (3) the published target
//     really moves the wearable into the named backpack slot, re-read from the world afterwards —
//     the body slot's target id changes because the identity binds the state, and the backpack
//     projection shows the item in the named slot — and (4) a REPEAT of that same request is the
//     IDEMPOTENT `wearable_already_unequipped` success rather than an error.
//
//   * scenario `native_unequip_wearable_inventory_full_v1` — the actor wears one wearable and
//     every backpack slot is occupied, so the removed wearable would have nowhere to land (the
//     native exit-menu path drops it on the ground). The run asserts the FROZEN refusal
//     (`wearable_inventory_full`) AND that the world did not move: the wearable is still worn,
//     its target id is unchanged and no backpack slot became free.
//
// Shared harness helpers (bounded scope, revision-bound requests, exact receipt identity,
// terminal wait, owned teardown) come from `stardew-native-smoke-harness-v1.mjs`.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  executeFreshAfterReobserve,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "unequip_wearable";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/** The two declared Given variants this one action is gated on. */
export const SCENARIO_ORDINARY = "native_unequip_wearable_v1";
export const SCENARIO_INVENTORY_FULL = "native_unequip_wearable_inventory_full_v1";
/** A well-formed opaque id from another target family: it names no wearable body slot. */
const UNKNOWN_TARGET_ID = "animal_door_0123456789abcdef";

export async function runUnequipWearableSmoke(client, receipts, config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const scenario = config?.NativeLocalPlayerFixture?.FixtureScenario;
    if (scenario !== SCENARIO_ORDINARY && scenario !== SCENARIO_INVENTORY_FULL)
      throw new Error(`unequip_wearable_scenario_unsupported:${scenario ?? "none"}`);

    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const worn = chooseWornTarget(snapshot);
    const freeSlot = firstFreeInventorySlot(snapshot);

    if (scenario === SCENARIO_INVENTORY_FULL) {
      if (freeSlot !== null)
        throw new Error(
          `unequip_wearable_declared_given_absent:inventory_not_full;free_slot=${freeSlot};` +
            `inventory_slots=${snapshot.inventorySlots ?? "?"};occupied=${describeOccupied(snapshot)}`,
        );
      // Negative: a full backpack must REFUSE, and nothing may move — neither off the actor nor
      // into a slot, and nothing may reach the ground.
      const refusedRequestId = `native_local_unequip_wearable_full_${Date.now()}`;
      const refusedAccepted = await executeFreshAfterReobserve(client, {
        requestId: refusedRequestId,
        idempotencyKey: `${refusedRequestId}_idem`,
        action: ACTION,
        args: { slot: 0, expectedTargetId: worn.targetId },
        snapshot,
        timeoutMs: 30_000,
      });
      trace.push({
        step: "inventory_full_refusal",
        action: ACTION,
        target: worn.targetId,
        slot: 0,
        receipt: summarizeReceipt(refusedAccepted),
      });
      const refusedTerminal = await waitForTerminal(receipts, refusedAccepted, terminalTimeoutMs);
      if (refusedTerminal.state !== "rejected" || refusedTerminal.reasonCode !== "wearable_inventory_full")
        throw new Error(
          `unequip_wearable_full_inventory_not_refused:${refusedTerminal.state}/${refusedTerminal.reasonCode};` +
            `body_slot=${worn.bodySlot};occupant=${worn.occupantQualifiedItemId ?? "none"}`,
        );
      const after = await observeFresh(client, { actionable: true });
      assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
      const stillWorn = wearableTarget(after, worn.bodySlot);
      if (stillWorn.targetId !== worn.targetId || stillWorn.occupantQualifiedItemId !== worn.occupantQualifiedItemId)
        throw new Error(
          `unequip_wearable_full_inventory_moved_world:body_slot=${worn.bodySlot};` +
            `target=${stillWorn.targetId};occupant=${stillWorn.occupantQualifiedItemId ?? "none"}`,
        );
      if (firstFreeInventorySlot(after) !== null)
        throw new Error(`unequip_wearable_full_inventory_slot_opened:occupied=${describeOccupied(after)}`);
      return {
        state: "passed",
        topology: "native_local_player_fixture",
        reasonCode: "wearable_inventory_full",
        scenario,
        bodySlot: worn.bodySlot,
        item: worn.occupantQualifiedItemId,
        target: worn.targetId,
        refusal: { reasonCode: refusedTerminal.reasonCode, state: refusedTerminal.state, target: stillWorn.targetId },
        evidence: parseEvidence(refusedTerminal.evidence),
        receipt: summarizeReceipt(refusedTerminal),
        trace,
      };
    }

    if (freeSlot === null)
      throw new Error(
        `unequip_wearable_declared_given_absent:no_free_slot;inventory_slots=${snapshot.inventorySlots ?? "?"};` +
          `occupied=${describeOccupied(snapshot)}`,
      );

    // Negative 1. An id nobody published must be refused by the Mod's own target resolution.
    const unknownRequestId = `native_local_unequip_wearable_unknown_${Date.now()}`;
    const unknownAccepted = await executeFreshAfterReobserve(client, {
      requestId: unknownRequestId,
      idempotencyKey: `${unknownRequestId}_idem`,
      action: ACTION,
      args: { slot: freeSlot, expectedTargetId: UNKNOWN_TARGET_ID },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "unknown_target",
      action: ACTION,
      target: UNKNOWN_TARGET_ID,
      slot: freeSlot,
      receipt: summarizeReceipt(unknownAccepted),
    });
    const unknownTerminal = await waitForTerminal(receipts, unknownAccepted, terminalTimeoutMs);
    if (unknownTerminal.state !== "rejected" || unknownTerminal.reasonCode !== "wearable_target_not_found")
      throw new Error(
        `unequip_wearable_unknown_target_not_refused:${unknownTerminal.state}/${unknownTerminal.reasonCode};` +
          `body_slot=${worn.bodySlot};slot=${freeSlot}`,
      );
    const afterUnknown = await observeFresh(client, { actionable: true });
    const untouched = wearableTarget(afterUnknown, worn.bodySlot);
    if (untouched.targetId !== worn.targetId)
      throw new Error(`unequip_wearable_unknown_target_moved_world:target=${untouched.targetId};expected=${worn.targetId}`);

    // Negative 2. A destination that is not free would displace an item the request never named.
    const occupiedSlot = firstOccupiedInventorySlot(afterUnknown, freeSlot);
    let occupiedNegative;
    if (occupiedSlot === null) {
      // Stated, not skipped: an entirely empty backpack cannot exercise this refusal.
      occupiedNegative = { reasonCode: "not_applicable_empty_inventory" };
    } else {
      const occupiedRequestId = `native_local_unequip_wearable_occupied_${Date.now()}`;
      const occupiedAccepted = await executeFreshAfterReobserve(client, {
        requestId: occupiedRequestId,
        idempotencyKey: `${occupiedRequestId}_idem`,
        action: ACTION,
        args: { slot: occupiedSlot, expectedTargetId: worn.targetId },
        snapshot: afterUnknown,
        timeoutMs: 30_000,
      });
      trace.push({
        step: "occupied_destination",
        action: ACTION,
        target: worn.targetId,
        slot: occupiedSlot,
        receipt: summarizeReceipt(occupiedAccepted),
      });
      const occupiedTerminal = await waitForTerminal(receipts, occupiedAccepted, terminalTimeoutMs);
      if (occupiedTerminal.state !== "rejected" || occupiedTerminal.reasonCode !== "wearable_destination_slot_occupied")
        throw new Error(
          `unequip_wearable_occupied_destination_not_refused:${occupiedTerminal.state}/${occupiedTerminal.reasonCode};` +
            `slot=${occupiedSlot};occupant=${inventoryFactAt(afterUnknown, occupiedSlot)?.qualifiedItemId ?? "none"}`,
        );
      const afterOccupied = await observeFresh(client, { actionable: true });
      const stillWorn = wearableTarget(afterOccupied, worn.bodySlot);
      if (stillWorn.targetId !== worn.targetId)
        throw new Error(`unequip_wearable_occupied_destination_moved_world:target=${stillWorn.targetId}`);
      occupiedNegative = { reasonCode: occupiedTerminal.reasonCode, slot: occupiedSlot };
    }

    // Positive. The published target, into the free backpack slot the fixture left.
    const requestId = `native_local_unequip_wearable_${Date.now()}`;
    const accepted = await executeFreshAfterReobserve(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot: freeSlot, expectedTargetId: worn.targetId },
      snapshot: afterUnknown,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "unequip",
      action: ACTION,
      target: worn.targetId,
      bodySlot: worn.bodySlot,
      slot: freeSlot,
      receipt: summarizeReceipt(accepted),
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("unequip_wearable_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "wearable_unequipped")
      throw new Error(
        `unequip_wearable_failed:${terminal.state}/${terminal.reasonCode};` +
          `body_slot=${worn.bodySlot};slot=${freeSlot};item=${worn.occupantQualifiedItemId ?? "none"}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "body_slot", worn.bodySlot);
    assertEvidence(evidence, "destination_slot", String(freeSlot));
    assertEvidence(evidence, "occupant_before", worn.occupantQualifiedItemId);
    assertEvidence(evidence, "occupant_after", "none");
    assertEvidence(evidence, "removed", worn.occupantQualifiedItemId);
    assertEvidence(evidence, "destination_after", worn.occupantQualifiedItemId);
    assertEvidence(evidence, "landed", "true");

    // The world, re-read after the terminal.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const cleared = wearableTarget(after, worn.bodySlot);
    if (cleared.occupantQualifiedItemId != null)
      throw new Error(
        `unequip_wearable_world_unchanged:body_slot=${worn.bodySlot};occupant=${cleared.occupantQualifiedItemId}`,
      );
    if (cleared.targetId === worn.targetId)
      throw new Error(`unequip_wearable_world_identity_stale:body_slot=${worn.bodySlot};target=${cleared.targetId}`);
    const landedFact = inventoryFactAt(after, freeSlot);
    if (landedFact == null || landedFact.qualifiedItemId !== worn.occupantQualifiedItemId)
      throw new Error(
        `unequip_wearable_destination_empty:slot=${freeSlot};` +
          `item=${landedFact?.qualifiedItemId ?? "none"};expected=${worn.occupantQualifiedItemId}`,
      );

    // Negative 3. The SAME request again: already satisfied, so the idempotent success with
    // `moved=false` and no second world change.
    const repeatRequestId = `native_local_unequip_wearable_repeat_${Date.now()}`;
    const repeatAccepted = await executeFreshAfterReobserve(client, {
      requestId: repeatRequestId,
      idempotencyKey: `${repeatRequestId}_idem`,
      action: ACTION,
      args: { slot: freeSlot, expectedTargetId: worn.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "repeat_already_satisfied",
      action: ACTION,
      target: worn.targetId,
      slot: freeSlot,
      receipt: summarizeReceipt(repeatAccepted),
    });
    const repeatTerminal = await waitForTerminal(receipts, repeatAccepted, terminalTimeoutMs);
    if (repeatTerminal.state !== "succeeded" || repeatTerminal.reasonCode !== "wearable_already_unequipped")
      throw new Error(
        `unequip_wearable_repeat_not_idempotent:${repeatTerminal.state}/${repeatTerminal.reasonCode};` +
          `body_slot=${worn.bodySlot};target=${worn.targetId}`,
      );
    assertEvidence(parseEvidence(repeatTerminal.evidence), "moved", "false");

    const final = await observeFresh(client, { actionable: true });
    const finalTarget = wearableTarget(final, worn.bodySlot);
    if (finalTarget.targetId !== cleared.targetId || finalTarget.occupantQualifiedItemId != null)
      throw new Error(
        `unequip_wearable_repeat_moved_world:body_slot=${worn.bodySlot};` +
          `target=${finalTarget.targetId};occupant=${finalTarget.occupantQualifiedItemId ?? "none"}`,
      );

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "wearable_unequipped",
      scenario,
      bodySlot: worn.bodySlot,
      slot: freeSlot,
      item: worn.occupantQualifiedItemId,
      target: worn.targetId,
      targetAfter: cleared.targetId,
      negatives: {
        unknownTarget: { reasonCode: unknownTerminal.reasonCode, target: untouched.targetId },
        occupiedDestination: occupiedNegative,
        repeat: { reasonCode: repeatTerminal.reasonCode, moved: "false" },
      },
      evidence,
      receipt: summarizeReceipt(terminal),
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

/** The declared Given: a body slot the actor is actually wearing something in. */
function chooseWornTarget(snapshot) {
  const targets = Array.isArray(snapshot.wearableTargets) ? snapshot.wearableTargets : [];
  const worn = targets.find(
    (entry) => entry?.bodySlot && typeof entry.targetId === "string" && entry.occupantQualifiedItemId != null,
  );
  if (worn === undefined)
    throw new Error(`unequip_wearable_declared_given_absent:not_wearing_any_wearable;published=${describeTargets(targets)}`);
  return worn;
}

/** The first backpack slot the inventory projection does not list, or null when none is free. */
function firstFreeInventorySlot(snapshot) {
  const total = Number.isInteger(snapshot.inventorySlots) ? snapshot.inventorySlots : 0;
  if (total <= 0) return null;
  const occupied = new Set((snapshot.inventoryItemFacts ?? []).map((entry) => entry?.slot));
  for (let slot = 0; slot < total; slot++) if (!occupied.has(slot)) return slot;
  return null;
}

/** The first occupied slot other than the one the run reserved, or null when none exists. */
function firstOccupiedInventorySlot(snapshot, reservedSlot) {
  const entry = (snapshot.inventoryItemFacts ?? []).find(
    (candidate) => Number.isInteger(candidate?.slot) && candidate.slot !== reservedSlot,
  );
  return entry === undefined ? null : entry.slot;
}

function inventoryFactAt(snapshot, slot) {
  const entry = (snapshot.inventoryItemFacts ?? []).find((candidate) => candidate?.slot === slot);
  return entry ?? null;
}

function describeOccupied(snapshot) {
  const facts = snapshot.inventoryItemFacts;
  if (!Array.isArray(facts)) return "projection_absent";
  return facts.map((entry) => `${entry?.slot}:${entry?.qualifiedItemId ?? "?"}`).join("|");
}

function describeTargets(targets) {
  return targets.map((entry) => `${entry?.bodySlot ?? "?"}=${entry?.occupantQualifiedItemId ?? "empty"}`).join("|");
}

/** One published body-slot target, or a loud failure naming the slots that WERE published. */
function wearableTarget(snapshot, bodySlot) {
  const targets = snapshot.wearableTargets ?? [];
  const entry = targets.find((candidate) => candidate?.bodySlot === bodySlot);
  if (entry === undefined)
    throw new Error(`unequip_wearable_body_slot_not_advertised:${bodySlot};published=${describeTargets(targets)}`);
  if (typeof entry.targetId !== "string")
    throw new Error(`unequip_wearable_target_projection_incomplete:${bodySlot}`);
  return entry;
}

/** The wire carries the Mod's evidence string as `{ detail: "..." }`. */
export function parseEvidence(evidence) {
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

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`unequip_wearable_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runUnequipWearableSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
