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

const ACTION = "talk_to_npc";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** A well-formed opaque id that was never published for any villager. */
const UNKNOWN_TARGET_ID = "npc_relationship_0000000000000000";

/**
 * talk_to_npc live contract.
 *
 * The receipt is not the proof. Three things are observed directly:
 *   1. the declared Given is an EMPTY-HANDED actor standing one tile from a named
 *      villager (the talk branch's own precondition: with an object in hand the native
 *      entry takes the gift path at NPC.cs:2760 instead, which is
 *      interact_npc_with_item's intent). A receipt that reports hands_not_empty means the
 *      fixture did not establish the Given, and the run says so instead of reading it as a
 *      product failure;
 *   2. the dialogue is asserted from the WORLD, not from the receipt: a talk leaves the
 *      actor inside the native DialogueBox, and the Mod's own snapshot actionability is
 *      `player.CanMove && activeClickableMenu is null && !eventUp`, so a FRESH observation
 *      after the terminal must report actionable=false with no active execution. A receipt
 *      that claims talk_to_npc_talked while the world still says the actor is free fails
 *      the run;
 *   3. two negatives. An opaque id that names no villager must be REFUSED with
 *      talk_to_npc_target_not_found and must not open a dialogue; and a second talk while
 *      the dialogue is up must be REFUSED (player_not_actionable) rather than stacking a
 *      second dialogue, with the world still showing the actor inside the first one.
 *
 * The runner never chooses the villager: the target comes from the `npcRelationshipTargets`
 * discovery projection the Mod publishes (the same list npc_relationship and
 * interact_npc_with_item read), and the Mod re-resolves the person on the game thread.
 */
export async function runTalkToNpcSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseAdjacentVillager(snapshot);

    // Negative 1. An id nobody published must be refused by the Mod's own target
    // re-resolution, and no dialogue may appear: the actor must stay actionable.
    const unknownRequestId = `native_local_talk_to_npc_unknown_${Date.now()}`;
    const unknownAccepted = await executeFresh(client, {
      requestId: unknownRequestId,
      idempotencyKey: `${unknownRequestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: UNKNOWN_TARGET_ID },
      snapshot,
      timeoutMs: 30_000,
    });
    const unknownTerminal = await waitForTerminal(receipts, unknownAccepted, terminalTimeoutMs);
    trace.push({
      step: "unknown_target",
      action: ACTION,
      target: UNKNOWN_TARGET_ID,
      receipt: summarizeReceipt(unknownAccepted),
    });
    if (unknownTerminal.state !== "rejected" || unknownTerminal.reasonCode !== "talk_to_npc_target_not_found")
      throw new Error(`talk_to_npc_unknown_target_not_refused:${unknownTerminal.state}/${unknownTerminal.reasonCode}`);
    const afterUnknown = await observeFresh(client, { actionable: true });
    villagerAt(afterUnknown, target.targetId);

    // Positive. The published target, from the same discovery projection.
    const requestId = `native_local_talk_to_npc_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: afterUnknown,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "talk",
      action: ACTION,
      target: target.targetId,
      npc: target.npcName,
      receipt: summarizeReceipt(accepted),
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("talk_to_npc_terminal_identity_mismatch");
    if (terminal.state === "rejected" && terminal.reasonCode === "hands_not_empty")
      throw new Error(`talk_to_npc_declared_given_absent:${target.npcName}`);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "talk_to_npc_talked")
      throw new Error(`talk_to_npc_talk_failed:${terminal.state}/${terminal.reasonCode}`);

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "native_handled", "true");
    assertEvidence(evidence, "dialogue_up_after", "true");
    assertEvidence(evidence, "dialogue_box_after", "true");
    assertEvidence(evidence, "player_can_move_after", "false");

    // The world change, re-read after the terminal: the native dialog is really up, so the
    // Mod's own actionability projection says the actor is no longer free.
    const after = await observeFresh(client);
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    // Loose comparison on purpose: the wire OMITS a null member, so "no active execution" is
    // `undefined` here, and `undefined !== null` would fail a correct run.
    if (after.activeExecution != null)
      throw new Error(
        `talk_to_npc_world_still_busy:${JSON.stringify({
          activeExecution: after.activeExecution,
          actionable: after.actionable,
          location: after.location,
          tile: after.tile,
        })}`,
      );
    if (after.actionable !== false) throw new Error(`talk_to_npc_world_unchanged:${after.actionable}`);

    // Negative 2. The dialogue is up, so a second talk is not a second dialogue: it must be
    // refused by admission and the world must stay exactly as the first talk left it.
    const repeatRequestId = `native_local_talk_to_npc_repeat_${Date.now()}`;
    const repeatAccepted = await executeFresh(client, {
      requestId: repeatRequestId,
      idempotencyKey: `${repeatRequestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "repeat_while_dialogue_open",
      action: ACTION,
      target: target.targetId,
      receipt: summarizeReceipt(repeatAccepted),
    });
    const repeatTerminal = await waitForTerminal(receipts, repeatAccepted, terminalTimeoutMs);
    if (repeatTerminal.state === "succeeded") throw new Error("talk_to_npc_repeat_stacked_dialogue");
    if (repeatTerminal.reasonCode !== "player_not_actionable")
      throw new Error(`talk_to_npc_repeat_not_refused:${repeatTerminal.reasonCode}`);

    const final = await observeFresh(client);
    if (final.actionable !== false) throw new Error(`talk_to_npc_repeat_moved_world:${final.actionable}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "talk_to_npc_talked",
      target: target.targetId,
      npc: target.npcName,
      dialogue: {
        up: evidence.dialogue_up_after,
        box: evidence.dialogue_box_after,
        actionableAfter: after.actionable,
      },
      negatives: {
        unknownTarget: { reasonCode: unknownTerminal.reasonCode, actionable: afterUnknown.actionable },
        repeat: { reasonCode: repeatTerminal.reasonCode, actionable: final.actionable },
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

/** The villager the fixture arms: an advertised family target already in native reach. */
function chooseAdjacentVillager(snapshot) {
  const targets = snapshot.npcRelationshipTargets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("talk_to_npc_no_advertised_target");
  const adjacent = targets.filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      typeof entry?.npcName === "string" &&
      Number.isInteger(entry?.x) &&
      Number.isInteger(entry?.y) &&
      Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1,
  );
  if (adjacent.length === 0)
    throw new Error(
      `talk_to_npc_no_adjacent_villager:tile=${snapshot.tile?.x},${snapshot.tile?.y};location=${snapshot.location ?? "?"};actionable=${snapshot.actionable};` +
        `targets=${targets.map((t) => `${t?.npcName ?? "?"}@${t?.x},${t?.y}`).join("|")}`,
    );
  return adjacent.find((entry) => entry.targetId !== UNKNOWN_TARGET_ID) ?? adjacent[0];
}

/** The published projection for one target id, read from a fresh observation. */
function villagerAt(snapshot, targetId) {
  const entry = (snapshot.npcRelationshipTargets ?? []).find((candidate) => candidate?.targetId === targetId);
  if (entry === undefined) throw new Error(`talk_to_npc_target_gone:${targetId}`);
  return entry;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`talk_to_npc_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
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
    const result = await runTalkToNpcSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
