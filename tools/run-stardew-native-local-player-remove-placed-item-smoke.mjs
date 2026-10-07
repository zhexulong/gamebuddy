// Stardew-local remove-placed-item smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned teardown
// all come from the shared harness. Action-specific logic (which published target,
// which tool, what the receipt must have observed, and the negative cases) stays here.

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

const ACTION = "remove_placed_item";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "equip_tool", ACTION];
/** The fixture's placed removable object: an ordinary crafted machine (`Type == "Crafting"`). */
const PLACED_ITEM_ID = "(BC)12";
/** The fixture's twig: the native branch removes it with an AXE only (`IsTwig() && t is Axe`). */
const TWIG_ITEM_ID = "(O)294";

/**
 * remove_placed_item live contract.
 *
 * The receipt is not the proof. Five things are observed directly:
 *   1. the target comes from the Mod's own `worldObjectTargets` projection and the tool
 *      slot from the Mod's own `toolSlots` projection, so this runner never guesses
 *      either;
 *   2. the removal is proved by the object being GONE from the tile in a FRESH snapshot,
 *      not by the native return value;
 *   3. the removed object's own identity comes back as the drop the native path created
 *      for it (the axe/pickaxe drop the removed object), so the receipt reports what the
 *      game did with it;
 *   4. a WRONG TOOL is a named refusal, not a silent no-op: the native branch removes a
 *      twig only with an axe, so naming a pickaxe for that exact object must be refused
 *      and must leave the world untouched;
 *   5. a stale target and an empty tool slot are refused too, each with its own code.
 */
export async function runRemovePlacedItemSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseExistingObject(snapshot, PLACED_ITEM_ID, "remove_placed_item");
    const twig = chooseExistingObject(snapshot, TWIG_ITEM_ID, "remove_placed_item");

    // Negative 1 first, because it must be refused BEFORE the removable object is gone.
    const pickaxeSlot = (await equipTool(client, receipts, trace, "pickaxe", terminalTimeoutMs)).slot;
    const wrongToolRequestId = `native_local_remove_placed_item_wrong_tool_${Date.now()}`;
    const wrongToolAccepted = await executeFreshAfterReobserve(client, {
      requestId: wrongToolRequestId,
      idempotencyKey: `${wrongToolRequestId}_idem`,
      action: ACTION,
      args: { x: twig.x, y: twig.y, slot: pickaxeSlot, expectedTargetId: twig.targetId },
      snapshot: await observeFresh(client, { actionable: true }),
      timeoutMs: 30_000,
    });
    const wrongToolTerminal = await waitForTerminal(receipts, wrongToolAccepted, terminalTimeoutMs);
    trace.push({ step: "remove_wrong_tool", action: ACTION, target: twig.targetId, tool: "pickaxe", receipt: summarizeReceipt(wrongToolTerminal) });
    if (wrongToolTerminal.state !== "rejected" || wrongToolTerminal.reasonCode !== "remove_placed_item_tool_cannot_remove_target")
      throw new Error(
        `remove_placed_item_wrong_tool_not_refused:${wrongToolTerminal.state}/${wrongToolTerminal.reasonCode};item=${twig.qualifiedItemId};tool=pickaxe;slot=${pickaxeSlot};tile=${twig.x},${twig.y}`,
      );

    const afterWrongTool = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(afterWrongTool, REQUIRED_CAPABILITIES);
    if (existingObjectAt(afterWrongTool, twig.x, twig.y)?.targetId !== twig.targetId)
      throw new Error(`remove_placed_item_wrong_tool_moved_world:${twig.x},${twig.y}`);

    // The removable object itself, through the axe.
    const axeSlot = (await equipTool(client, receipts, trace, "axe", terminalTimeoutMs)).slot;
    const freshTarget = chooseExistingObject(afterWrongTool, PLACED_ITEM_ID, "remove_placed_item");
    if (freshTarget.targetId !== target.targetId)
      throw new Error(`remove_placed_item_target_changed_before_request:${target.targetId}:${freshTarget.targetId}`);
    const requestId = `native_local_remove_placed_item_${Date.now()}`;
    const accepted = await executeFreshAfterReobserve(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: freshTarget.x, y: freshTarget.y, slot: axeSlot, expectedTargetId: freshTarget.targetId },
      snapshot: afterWrongTool,
      timeoutMs: 30_000,
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    trace.push({ step: "remove", action: ACTION, target: freshTarget.targetId, tool: "axe", receipt: summarizeReceipt(terminal) });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "placed_item_removed")
      throw new Error(
        `remove_placed_item_failed:${terminal.state}/${terminal.reasonCode};tile=${freshTarget.x},${freshTarget.y};slot=${axeSlot};item=${freshTarget.qualifiedItemId}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "item", freshTarget.qualifiedItemId);
    assertEvidence(evidence, "tool_kind", "axe");
    assertEvidence(evidence, "removed", "true");
    assertEvidence(evidence, "tile_object_after", "none");
    assertEvidence(evidence, "target", freshTarget.targetId);
    const swings = Number(evidence.swings);
    if (!Number.isSafeInteger(swings) || swings < 1)
      throw new Error(`remove_placed_item_swings_unobserved:${evidence.swings ?? "missing"}`);
    const drops = parseDrops(evidence);
    if (!drops.includes(freshTarget.qualifiedItemId))
      throw new Error(`remove_placed_item_drop_unobserved:drops=${evidence.drops ?? "missing"};expected=${freshTarget.qualifiedItemId}`);

    // The world change, re-read after the terminal: the object is gone from that tile.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const gone = existingObjectAt(after, freshTarget.x, freshTarget.y);
    if (gone != null) throw new Error(`remove_placed_item_world_unchanged:${gone.targetId};tile=${freshTarget.x},${freshTarget.y}`);

    // Negative 2: the same target against a tile that no longer holds an object.
    const staleRequestId = `native_local_remove_placed_item_stale_${Date.now()}`;
    const staleAccepted = await executeFreshAfterReobserve(client, {
      requestId: staleRequestId,
      idempotencyKey: `${staleRequestId}_idem`,
      action: ACTION,
      args: { x: freshTarget.x, y: freshTarget.y, slot: axeSlot, expectedTargetId: freshTarget.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    const staleTerminal = await waitForTerminal(receipts, staleAccepted, terminalTimeoutMs);
    trace.push({ step: "remove_stale_target", action: ACTION, target: freshTarget.targetId, receipt: summarizeReceipt(staleTerminal) });
    if (staleTerminal.state !== "rejected" || staleTerminal.reasonCode !== "remove_placed_item_target_not_found")
      throw new Error(
        `remove_placed_item_stale_target_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode};tile=${freshTarget.x},${freshTarget.y};slot=${axeSlot}`,
      );

    // Negative 3: the still-present twig, named through a slot that holds no tool at all.
    const unchanged = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(unchanged, REQUIRED_CAPABILITIES);
    const emptySlot = firstNonToolSlot(unchanged);
    const emptySlotRequestId = `native_local_remove_placed_item_empty_slot_${Date.now()}`;
    const emptySlotAccepted = await executeFreshAfterReobserve(client, {
      requestId: emptySlotRequestId,
      idempotencyKey: `${emptySlotRequestId}_idem`,
      action: ACTION,
      args: { x: twig.x, y: twig.y, slot: emptySlot, expectedTargetId: twig.targetId },
      snapshot: unchanged,
      timeoutMs: 30_000,
    });
    const emptySlotTerminal = await waitForTerminal(receipts, emptySlotAccepted, terminalTimeoutMs);
    trace.push({ step: "remove_empty_slot", action: ACTION, target: twig.targetId, slot: emptySlot, receipt: summarizeReceipt(emptySlotTerminal) });
    if (emptySlotTerminal.state !== "rejected" || emptySlotTerminal.reasonCode !== "remove_placed_item_tool_not_equipped_in_requested_slot")
      throw new Error(
        `remove_placed_item_empty_slot_not_refused:${emptySlotTerminal.state}/${emptySlotTerminal.reasonCode};slot=${emptySlot};slot_item=${describeSlot(unchanged, emptySlot)}`,
      );

    const final = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(final, REQUIRED_CAPABILITIES);
    if (existingObjectAt(final, twig.x, twig.y)?.targetId !== twig.targetId)
      throw new Error(`remove_placed_item_empty_slot_moved_world:${twig.x},${twig.y}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "placed_item_removed",
      target: freshTarget.targetId,
      item: freshTarget.qualifiedItemId,
      tile: { x: freshTarget.x, y: freshTarget.y },
      tool: { kind: "axe", slot: axeSlot },
      drops,
      negative: {
        wrongTool: wrongToolTerminal.reasonCode,
        staleTarget: staleTerminal.reasonCode,
        emptySlot: emptySlotTerminal.reasonCode,
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
  const requestId = `native_local_remove_placed_item_equip_${tool}_${Date.now()}`;
  const accepted = await executeFreshAfterReobserve(client, {
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
    throw new Error(`remove_placed_item_equip_failed:${tool}:${terminal.state}/${terminal.reasonCode}`);
  const after = await observeFresh(client, { actionable: true });
  const label = tool === "axe" ? "(T)Axe" : "(T)Pickaxe";
  const slots = (after.toolSlots ?? []).filter((entry) => entry != null && entry.label === label && Number.isSafeInteger(entry.slot));
  if (slots.length !== 1)
    throw new Error(`remove_placed_item_tool_slot_ambiguous:${tool}:${slots.length};toolSlots=${describeToolSlots(after)}`);
  return { slot: slots[0].slot };
}

/** The object the world publishes on a tile, or a named failure when the Given is absent. */
function chooseExistingObject(snapshot, qualifiedItemId, action) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null) throw new Error(`${action}_no_world_object_projection`);
  if (!Array.isArray(entries)) throw new Error(`${action}_world_object_projection_malformed`);
  const match = entries.find((entry) => isProjectionEntry(entry) && entry.kind !== "placement_candidate" && entry.qualifiedItemId === qualifiedItemId);
  if (match == null)
    throw new Error(`${action}_declared_given_absent:item=${qualifiedItemId};candidates=${describeCandidates(snapshot)}`);
  return match;
}

function existingObjectAt(snapshot, x, y) {
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
  throw new Error(`remove_placed_item_no_non_tool_slot:inventorySlots=${slots};toolSlots=${describeToolSlots(snapshot)}`);
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
    throw new Error(`remove_placed_item_drop_count_mismatch:${evidence?.drop_count ?? "missing"}:${drops.length}`);
  return drops;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`remove_placed_item_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
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
    const result = await runRemovePlacedItemSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
