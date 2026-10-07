// equip_wearable live contract.
//
// The receipt is not the proof. Three things are observed directly:
//   1. the declared Given is an EMPTY body slot plus one wearable of the matching kind in a
//      named backpack slot, so ONE real equip moves the actor's attachment state. Both halves
//      come from the published projections (`wearableTargets` for the slot's current occupant,
//      `inventoryItemFacts` for the backpack side), never from a coordinate the runner invents;
//   2. the change is re-read from the world after the terminal: the named body slot now
//      publishes that wearable AND a DIFFERENT opaque target id — the identity binds the state,
//      so the empty-slot target the run acted on must be replaced by the filled-slot target and
//      the backpack slot must no longer hold the item;
//   3. two negatives. An opaque id that names no body slot must be REFUSED with
//      wearable_target_not_found and must not move the world; and a REPEAT of the request that
//      just succeeded must take the IDEMPOTENT path (`wearable_already_equipped`, `moved=false`)
//      rather than failing on the state change the first call caused.
//
// Shared harness helpers (bounded scope, revision-bound requests, exact receipt identity,
// terminal wait, owned teardown) come from `stardew-native-smoke-harness-v1.mjs`.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
// The native-local lane loads the compiled test artifact: the immutable production generation
// can predate the current protocol, which the Mod then rejects as invalid_hello_ack.
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "equip_wearable";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/** A well-formed opaque id from another target family: it names no wearable body slot. */
const UNKNOWN_TARGET_ID = "animal_door_0123456789abcdef";

/** The body slot a backpack item belongs to, read from the game's own item-type prefixes. */
export function bodySlotForQualifiedItemId(qualifiedItemId) {
  if (typeof qualifiedItemId !== "string") return null;
  if (qualifiedItemId.startsWith("(H)")) return "hat";
  if (qualifiedItemId.startsWith("(B)")) return "boots";
  if (qualifiedItemId.startsWith("(S)")) return "shirt";
  if (qualifiedItemId.startsWith("(P)")) return "pants";
  // Rings are ordinary `(O)` items in this build (Ring.cs TypeDefinitionId), so they cannot be
  // told apart by prefix and are deliberately not used as this runner's candidate.
  return null;
}

export async function runEquipWearableSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const candidate = chooseEmptyBodySlotCandidate(snapshot);

    // Negative 1. An id nobody published must be refused by the Mod's own target resolution, and
    // the body slot must stay exactly as the fixture armed it.
    const unknownRequestId = `native_local_equip_wearable_unknown_${Date.now()}`;
    const unknownAccepted = await executeFresh(client, {
      requestId: unknownRequestId,
      idempotencyKey: `${unknownRequestId}_idem`,
      action: ACTION,
      args: { slot: candidate.slot, expectedQualifiedItemId: candidate.qualifiedItemId, expectedTargetId: UNKNOWN_TARGET_ID },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "unknown_target",
      action: ACTION,
      target: UNKNOWN_TARGET_ID,
      slot: candidate.slot,
      receipt: summarizeReceipt(unknownAccepted),
    });
    const unknownTerminal = await waitForTerminal(receipts, unknownAccepted, terminalTimeoutMs);
    if (unknownTerminal.state !== "rejected" || unknownTerminal.reasonCode !== "wearable_target_not_found")
      throw new Error(
        `equip_wearable_unknown_target_not_refused:${unknownTerminal.state}/${unknownTerminal.reasonCode};` +
          `body_slot=${candidate.bodySlot};slot=${candidate.slot}`,
      );
    const afterUnknown = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(afterUnknown, REQUIRED_CAPABILITIES);
    const untouched = wearableTarget(afterUnknown, candidate.bodySlot);
    if (untouched.occupantQualifiedItemId != null)
      throw new Error(
        `equip_wearable_unknown_target_moved_world:body_slot=${candidate.bodySlot};` +
          `occupant=${untouched.occupantQualifiedItemId}`,
      );

    // Positive. The published target, from the same discovery projection.
    const requestId = `native_local_equip_wearable_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot: candidate.slot, expectedQualifiedItemId: candidate.qualifiedItemId, expectedTargetId: candidate.targetId },
      snapshot: afterUnknown,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "equip",
      action: ACTION,
      target: candidate.targetId,
      bodySlot: candidate.bodySlot,
      slot: candidate.slot,
      item: candidate.qualifiedItemId,
      receipt: summarizeReceipt(accepted),
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("equip_wearable_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "wearable_equipped")
      throw new Error(
        `equip_wearable_failed:${terminal.state}/${terminal.reasonCode};` +
          `body_slot=${candidate.bodySlot};slot=${candidate.slot};item=${candidate.qualifiedItemId}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "body_slot", candidate.bodySlot);
    assertEvidence(evidence, "source_slot", String(candidate.slot));
    assertEvidence(evidence, "requested", candidate.qualifiedItemId);
    assertEvidence(evidence, "occupant_before", "none");
    assertEvidence(evidence, "occupant_after", candidate.qualifiedItemId);
    assertEvidence(evidence, "displaced", "none");
    assertEvidence(evidence, "pack_slot_after", "none");

    // The world, re-read after the terminal: the slot holds the item, the identity moved with
    // the state it names, and the item really left the backpack.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const moved = wearableTarget(after, candidate.bodySlot);
    if (moved.occupantQualifiedItemId !== candidate.qualifiedItemId)
      throw new Error(
        `equip_wearable_world_unchanged:body_slot=${candidate.bodySlot};` +
          `occupant=${moved.occupantQualifiedItemId ?? "none"};expected=${candidate.qualifiedItemId}`,
      );
    if (moved.targetId === candidate.targetId)
      throw new Error(`equip_wearable_world_identity_stale:body_slot=${candidate.bodySlot};target=${moved.targetId}`);
    if (inventoryFactAt(after, candidate.slot) != null)
      throw new Error(
        `equip_wearable_pack_slot_not_cleared:slot=${candidate.slot};` +
          `item=${inventoryFactAt(after, candidate.slot)?.qualifiedItemId ?? "none"}`,
      );

    // Negative 2. The SAME request again — same slot, same item, same (now stale) target id. The
    // action is already satisfied, so this must be an idempotent success and must not move the
    // world a second time.
    const repeatRequestId = `native_local_equip_wearable_repeat_${Date.now()}`;
    const repeatAccepted = await executeFresh(client, {
      requestId: repeatRequestId,
      idempotencyKey: `${repeatRequestId}_idem`,
      action: ACTION,
      args: { slot: candidate.slot, expectedQualifiedItemId: candidate.qualifiedItemId, expectedTargetId: candidate.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "repeat_already_satisfied",
      action: ACTION,
      target: candidate.targetId,
      slot: candidate.slot,
      receipt: summarizeReceipt(repeatAccepted),
    });
    const repeatTerminal = await waitForTerminal(receipts, repeatAccepted, terminalTimeoutMs);
    if (repeatTerminal.state !== "succeeded" || repeatTerminal.reasonCode !== "wearable_already_equipped")
      throw new Error(
        `equip_wearable_repeat_not_idempotent:${repeatTerminal.state}/${repeatTerminal.reasonCode};` +
          `body_slot=${candidate.bodySlot};target=${candidate.targetId}`,
      );
    assertEvidence(parseEvidence(repeatTerminal.evidence), "moved", "false");

    const final = await observeFresh(client, { actionable: true });
    const finalTarget = wearableTarget(final, candidate.bodySlot);
    if (finalTarget.targetId !== moved.targetId || finalTarget.occupantQualifiedItemId !== candidate.qualifiedItemId)
      throw new Error(
        `equip_wearable_repeat_moved_world:body_slot=${candidate.bodySlot};` +
          `target=${finalTarget.targetId};occupant=${finalTarget.occupantQualifiedItemId ?? "none"}`,
      );

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "wearable_equipped",
      bodySlot: candidate.bodySlot,
      slot: candidate.slot,
      item: candidate.qualifiedItemId,
      target: candidate.targetId,
      targetAfter: moved.targetId,
      negatives: {
        unknownTarget: { reasonCode: unknownTerminal.reasonCode, occupant: untouched.occupantQualifiedItemId ?? "none" },
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

/**
 * The candidate the fixture declares: a backpack slot holding a wearable whose own body slot is
 * currently EMPTY. Every rejection names the observed facts, because "no candidate" alone cannot
 * tell a wrong fixture from an unpublished projection.
 */
function chooseEmptyBodySlotCandidate(snapshot) {
  const facts = Array.isArray(snapshot.inventoryItemFacts) ? snapshot.inventoryItemFacts : [];
  const targets = Array.isArray(snapshot.wearableTargets) ? snapshot.wearableTargets : [];
  const candidates = [];
  for (const fact of facts) {
    const bodySlot = bodySlotForQualifiedItemId(fact?.qualifiedItemId);
    if (bodySlot === null) continue;
    const target = targets.find((entry) => entry?.bodySlot === bodySlot);
    if (target === undefined || typeof target.targetId !== "string") continue;
    if (target.occupantQualifiedItemId != null) continue;
    candidates.push({ slot: fact.slot, qualifiedItemId: fact.qualifiedItemId, bodySlot, targetId: target.targetId });
  }
  if (candidates.length === 0)
    throw new Error(
      `equip_wearable_declared_given_absent:location=${snapshot.location ?? "?"};` +
        `tile=${snapshot.tile?.x ?? "?"},${snapshot.tile?.y ?? "?"};actionable=${snapshot.actionable};` +
        `inventory_facts=${Array.isArray(snapshot.inventoryItemFacts) ? facts.length : "absent"};` +
        `wearable_targets=${Array.isArray(snapshot.wearableTargets) ? describeTargets(targets) : "absent"};` +
        `slots=${facts.map((fact) => `${fact?.slot}:${fact?.qualifiedItemId ?? "?"}`).join("|")}`,
    );
  return candidates[0];
}

/** One published body-slot target, or a loud failure naming the slots that WERE published. */
function wearableTarget(snapshot, bodySlot) {
  const targets = snapshot.wearableTargets ?? [];
  const entry = targets.find((candidate) => candidate?.bodySlot === bodySlot);
  if (entry === undefined)
    throw new Error(`equip_wearable_body_slot_not_advertised:${bodySlot};published=${describeTargets(targets)}`);
  if (typeof entry.targetId !== "string")
    throw new Error(`equip_wearable_target_projection_incomplete:${bodySlot}`);
  return entry;
}

/** The backpack entry at one slot, or null when that slot is empty. */
function inventoryFactAt(snapshot, slot) {
  const entry = (snapshot.inventoryItemFacts ?? []).find((candidate) => candidate?.slot === slot);
  return entry ?? null;
}

function describeTargets(targets) {
  return targets
    .map((entry) => `${entry?.bodySlot ?? "?"}=${entry?.occupantQualifiedItemId ?? "empty"}`)
    .join("|");
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
    throw new Error(`equip_wearable_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runEquipWearableSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
