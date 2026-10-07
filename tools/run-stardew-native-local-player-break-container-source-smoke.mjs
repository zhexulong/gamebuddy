// Stardew-local break-container-source smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned teardown
// all come from the shared harness. Action-specific logic (which published target,
// which tool, what the receipt must have observed, and the negative cases) stays here.

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

const ACTION = "break_container_source";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "equip_tool", ACTION];
/** The fixture's breakable container: `BreakableContainer.barrelId` is "118". */
const CONTAINER_ITEM_ID = "(BC)118";
/** The fixture's placed machine: an object that is NOT a breakable container. */
const NON_CONTAINER_ITEM_ID = "(BC)12";

/**
 * break_container_source live contract.
 *
 * The native seam returns `false` even when it destroys the container
 * (`BreakableContainer.performToolAction` ends in `return false` after
 * `location.objects.Remove(...)`), so the receipt's return value could never be the
 * proof. Four things are observed instead:
 *   1. the target comes from the Mod's own `worldObjectTargets` projection and the tool
 *      slot from the Mod's own `toolSlots` projection;
 *   2. the container is GONE from the tile in a FRESH snapshot, which is the action's
 *      postcondition;
 *   3. the drops the game produced during the swing window are reported and their count
 *      is internally consistent (a receipt that claims drops without naming them, or
 *      names them without counting them, fails the run);
 *   4. an object that is not a container, and a tool slot that holds no tool, are each
 *      refused BY NAME rather than silently no-opping, and a stale target is refused
 *      after the container is gone.
 */
export async function runBreakContainerSourceSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseProjectionEntry(snapshot, "breakable_container", CONTAINER_ITEM_ID, ACTION);
    const nonContainer = chooseProjectionEntry(snapshot, null, NON_CONTAINER_ITEM_ID, ACTION);

    // Negative 1: the container named through a slot that holds no tool at all.
    const emptySlot = firstNonToolSlot(snapshot);
    const emptySlotRequestId = `native_local_break_container_source_empty_slot_${Date.now()}`;
    const emptySlotAccepted = await executeFresh(client, {
      requestId: emptySlotRequestId,
      idempotencyKey: `${emptySlotRequestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, slot: emptySlot, expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    const emptySlotTerminal = await waitForTerminal(receipts, emptySlotAccepted, terminalTimeoutMs);
    trace.push({ step: "break_empty_slot", action: ACTION, target: target.targetId, slot: emptySlot, receipt: summarizeReceipt(emptySlotTerminal) });
    if (emptySlotTerminal.state !== "rejected" || emptySlotTerminal.reasonCode !== "break_container_source_tool_not_equipped_in_requested_slot")
      throw new Error(
        `break_container_source_empty_slot_not_refused:${emptySlotTerminal.state}/${emptySlotTerminal.reasonCode};slot=${emptySlot};slot_item=${describeSlot(snapshot, emptySlot)}`,
      );

    // Negative 2: the same action aimed at an object that is not a container.
    const pickaxeSlot = (await equipTool(client, receipts, trace, "pickaxe", terminalTimeoutMs)).slot;
    const notContainerRequestId = `native_local_break_container_source_not_container_${Date.now()}`;
    const notContainerAccepted = await executeFresh(client, {
      requestId: notContainerRequestId,
      idempotencyKey: `${notContainerRequestId}_idem`,
      action: ACTION,
      args: { x: nonContainer.x, y: nonContainer.y, slot: pickaxeSlot, expectedTargetId: nonContainer.targetId },
      snapshot: await observeFresh(client, { actionable: true }),
      timeoutMs: 30_000,
    });
    const notContainerTerminal = await waitForTerminal(receipts, notContainerAccepted, terminalTimeoutMs);
    trace.push({ step: "break_not_a_container", action: ACTION, target: nonContainer.targetId, receipt: summarizeReceipt(notContainerTerminal) });
    if (notContainerTerminal.state !== "rejected" || notContainerTerminal.reasonCode !== "break_container_source_not_a_container")
      throw new Error(
        `break_container_source_not_container_not_refused:${notContainerTerminal.state}/${notContainerTerminal.reasonCode};item=${nonContainer.qualifiedItemId};tile=${nonContainer.x},${nonContainer.y}`,
      );

    // The container itself.
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const freshTarget = chooseProjectionEntry(before, "breakable_container", CONTAINER_ITEM_ID, ACTION);
    if (freshTarget.targetId !== target.targetId)
      throw new Error(`break_container_source_target_changed_before_request:${target.targetId}:${freshTarget.targetId}`);
    const requestId = `native_local_break_container_source_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: freshTarget.x, y: freshTarget.y, slot: pickaxeSlot, expectedTargetId: freshTarget.targetId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    trace.push({ step: "break", action: ACTION, target: freshTarget.targetId, receipt: summarizeReceipt(terminal) });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "container_source_broken")
      throw new Error(
        `break_container_source_failed:${terminal.state}/${terminal.reasonCode};tile=${freshTarget.x},${freshTarget.y};slot=${pickaxeSlot};item=${freshTarget.qualifiedItemId}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "item", freshTarget.qualifiedItemId);
    assertEvidence(evidence, "container_gone", "true");
    assertEvidence(evidence, "tile_object_after", "none");
    assertEvidence(evidence, "target", freshTarget.targetId);
    const swings = Number(evidence.swings);
    if (!Number.isSafeInteger(swings) || swings < 1)
      throw new Error(`break_container_source_swings_unobserved:${evidence.swings ?? "missing"}`);
    const drops = parseDrops(evidence);

    // The world change, re-read after the terminal: the container is gone from that tile.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const stillThere = projectionEntryAt(after, freshTarget.x, freshTarget.y);
    if (stillThere != null)
      throw new Error(`break_container_source_world_unchanged:${stillThere.targetId};tile=${freshTarget.x},${freshTarget.y}`);

    // Negative 3: the same target against a tile that no longer holds anything.
    const staleRequestId = `native_local_break_container_source_stale_${Date.now()}`;
    const staleAccepted = await executeFresh(client, {
      requestId: staleRequestId,
      idempotencyKey: `${staleRequestId}_idem`,
      action: ACTION,
      args: { x: freshTarget.x, y: freshTarget.y, slot: pickaxeSlot, expectedTargetId: freshTarget.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    const staleTerminal = await waitForTerminal(receipts, staleAccepted, terminalTimeoutMs);
    trace.push({ step: "break_stale_target", action: ACTION, target: freshTarget.targetId, receipt: summarizeReceipt(staleTerminal) });
    if (staleTerminal.state !== "rejected" || staleTerminal.reasonCode !== "break_container_source_target_not_found")
      throw new Error(
        `break_container_source_stale_target_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode};tile=${freshTarget.x},${freshTarget.y};slot=${pickaxeSlot}`,
      );

    const final = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(final, REQUIRED_CAPABILITIES);
    if (projectionEntryAt(final, nonContainer.x, nonContainer.y)?.targetId !== nonContainer.targetId)
      throw new Error(`break_container_source_stale_target_moved_world:${nonContainer.x},${nonContainer.y}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "container_source_broken",
      target: freshTarget.targetId,
      item: freshTarget.qualifiedItemId,
      tile: { x: freshTarget.x, y: freshTarget.y },
      tool: { kind: "pickaxe", slot: pickaxeSlot },
      drops,
      negative: {
        emptySlot: emptySlotTerminal.reasonCode,
        notAContainer: notContainerTerminal.reasonCode,
        staleTarget: staleTerminal.reasonCode,
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

/** Equip one canonical tool category and return the slot the Mod published for it. */
async function equipTool(client, receipts, trace, tool, terminalTimeoutMs) {
  const snapshot = await observeFresh(client, { actionable: true });
  const requestId = `native_local_break_container_source_equip_${tool}_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: "equip_tool",
    args: { tool },
    snapshot,
    timeoutMs: 30_000,
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  trace.push({ step: `equip_${tool}`, action: "equip_tool", receipt: summarizeReceipt(terminal) });
  if (terminal.state !== "succeeded" || (terminal.reasonCode !== "tool_equipped" && terminal.reasonCode !== "already_equipped"))
    throw new Error(`break_container_source_equip_failed:${tool}:${terminal.state}/${terminal.reasonCode}`);
  const after = await observeFresh(client, { actionable: true });
  const slots = (after.toolSlots ?? []).filter((entry) => entry != null && entry.label === "(T)Pickaxe" && Number.isSafeInteger(entry.slot));
  if (slots.length !== 1)
    throw new Error(`break_container_source_tool_slot_ambiguous:${tool}:${slots.length};toolSlots=${describeToolSlots(after)}`);
  return { slot: slots[0].slot };
}

/** One published projection entry, optionally constrained by kind. */
function chooseProjectionEntry(snapshot, kind, qualifiedItemId, action) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null) throw new Error(`${action}_no_world_object_projection`);
  if (!Array.isArray(entries)) throw new Error(`${action}_world_object_projection_malformed`);
  const match = entries.find(
    (entry) => isProjectionEntry(entry) && entry.kind !== "placement_candidate" && entry.qualifiedItemId === qualifiedItemId && (kind == null || entry.kind === kind),
  );
  if (match == null)
    throw new Error(`${action}_declared_given_absent:kind=${kind ?? "any"};item=${qualifiedItemId};candidates=${describeCandidates(snapshot)}`);
  return match;
}

function projectionEntryAt(snapshot, x, y) {
  if (snapshot.worldObjectTargets == null || !Array.isArray(snapshot.worldObjectTargets)) return null;
  return (
    snapshot.worldObjectTargets.find(
      (entry) => isProjectionEntry(entry) && entry.kind !== "placement_candidate" && entry.x === x && entry.y === y,
    ) ?? null
  );
}

/** The first backpack slot the Mod did not report as holding a tool. */
function firstNonToolSlot(snapshot) {
  const slots = Number.isSafeInteger(snapshot.inventorySlots) ? snapshot.inventorySlots : 0;
  const toolSlots = new Set((snapshot.toolSlots ?? []).map((entry) => entry?.slot));
  for (let slot = 0; slot < slots; slot += 1) if (!toolSlots.has(slot)) return slot;
  throw new Error(`break_container_source_no_non_tool_slot:inventorySlots=${slots};toolSlots=${describeToolSlots(snapshot)}`);
}

function describeSlot(snapshot, slot) {
  const tool = (snapshot.toolSlots ?? []).find((entry) => entry?.slot === slot);
  return tool?.label ?? "non_tool_or_empty";
}

function describeToolSlots(snapshot) {
  return (snapshot.toolSlots ?? []).map((entry) => `${entry?.slot}:${entry?.label ?? "?"}`).join("|") || "none";
}

/** Loose optional-member rule: the Mod omits null members, so absent means absent, not null. */
function isProjectionEntry(entry) {
  return (
    entry != null &&
    typeof entry.targetId === "string" &&
    entry.targetId.length > 0 &&
    Number.isSafeInteger(entry.x) &&
    Number.isSafeInteger(entry.y) &&
    typeof entry.kind === "string" &&
    typeof entry.qualifiedItemId === "string" &&
    Number.isSafeInteger(entry.slot)
  );
}

function describeCandidates(snapshot) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null) return "none";
  if (!Array.isArray(entries)) return "malformed";
  return entries.map((entry) => `${entry?.kind ?? "?"}:${entry?.qualifiedItemId ?? "?"}@${entry?.x ?? "?"},${entry?.y ?? "?"}`).join("|") || "empty";
}

function parseDrops(evidence) {
  const raw = typeof evidence?.drops === "string" ? evidence.drops : "";
  const drops = raw.length === 0 ? [] : raw.split("|");
  const declared = Number(evidence?.drop_count);
  if (!Number.isSafeInteger(declared) || declared !== drops.length)
    throw new Error(`break_container_source_drop_count_mismatch:${evidence?.drop_count ?? "missing"}:${drops.length}`);
  return drops;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`break_container_source_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
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
    const result = await runBreakContainerSourceSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
