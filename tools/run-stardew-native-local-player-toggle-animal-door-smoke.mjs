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

const ACTION = "toggle_animal_door";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * toggle_animal_door live contract.
 *
 * The receipt is not the proof. Three things are observed directly:
 *   1. the declared Given is a coop/barn whose animal door is CLOSED and whose human door
 *      is one tile from the actor, so ONE real toggle opens it — the run then reads the
 *      door's own `isOpen` projection out of a FRESH snapshot, not out of the receipt;
 *   2. the published target identity CHANGES with the state, because the state is part of
 *      what the identity binds: the closed-door target is replaced by the open-door target
 *      at the same tile and no target is left claiming the old state;
 *   3. resubmitting the STALE id (the one that named a closed door) against the door that is
 *      now open must be REFUSED, and the world must not move. That is the negative case: an
 *      action that reports a second success there, or no-ops silently on a stale target,
 *      fails the run rather than passing on a green receipt.
 *
 * The runner never chooses the target tile: it comes from the `animalDoorTargets` discovery
 * projection the Mod publishes, and the Mod re-resolves it on the game thread.
 */
export async function runToggleAnimalDoorSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseAdjacentClosedTarget(snapshot);

    const requestId = `native_local_toggle_animal_door_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "toggle",
      action: ACTION,
      target: target.targetId,
      openBefore: target.isOpen,
      receipt: summarizeReceipt(accepted),
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("animal_door_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "animal_door_toggled")
      throw new Error(`animal_door_toggle_failed:${terminal.reasonCode}`);

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "animal_door_open_before", "false");
    assertEvidence(evidence, "animal_door_open_after", "true");
    assertEvidence(evidence, "animal_door_open_changed", "true");

    // The world change, re-read after the terminal: the same building now publishes an OPEN
    // door, and the identity moved with the state it names.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const toggled = animalDoorAt(after, target.x, target.y);
    if (toggled.isOpen !== true) throw new Error(`animal_door_world_unchanged:${toggled.isOpen}`);
    if (toggled.targetId === target.targetId) throw new Error(`animal_door_world_identity_stale:${toggled.targetId}`);

    // Negative case. The stale id named a CLOSED door; the door is open now, so the same
    // request must be refused and nothing may change. A success here (or a silent no-op
    // reported as success) is the failure.
    const negativeRequestId = `native_local_toggle_animal_door_stale_${Date.now()}`;
    const negativeAccepted = await executeFresh(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "toggle_stale_target",
      action: ACTION,
      target: target.targetId,
      receipt: summarizeReceipt(negativeAccepted),
    });
    const negativeTerminal = await waitForTerminal(receipts, negativeAccepted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected" || negativeTerminal.reasonCode !== "animal_door_target_changed")
      throw new Error(`animal_door_stale_target_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`);

    const unchanged = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(unchanged, REQUIRED_CAPABILITIES);
    const doorUnchanged = animalDoorAt(unchanged, target.x, target.y);
    if (doorUnchanged.isOpen !== true) throw new Error(`animal_door_stale_target_moved_world:${doorUnchanged.isOpen}`);
    if (doorUnchanged.targetId !== toggled.targetId)
      throw new Error(`animal_door_stale_target_moved_identity:${doorUnchanged.targetId}:${toggled.targetId}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "animal_door_toggled",
      target: target.targetId,
      building: target.buildingType,
      door: { before: target.isOpen, after: doorUnchanged.isOpen },
      targetAfter: doorUnchanged.targetId,
      negative: { reasonCode: negativeTerminal.reasonCode, isOpen: doorUnchanged.isOpen },
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

/** The animal door the fixture arms: an advertised target already in reach, closed. */
function chooseAdjacentClosedTarget(snapshot) {
  const targets = snapshot.animalDoorTargets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("animal_door_no_advertised_target");
  const adjacent = targets.filter(
    (entry) =>
      entry?.targetId &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1,
  );
  if (adjacent.length === 0) throw new Error("animal_door_no_adjacent_target");
  const closed = adjacent.filter((entry) => entry.isOpen === false);
  if (closed.length === 0) throw new Error("animal_door_declared_given_absent");
  return closed[0];
}

/** The named tile's own animal-door projection, read from a fresh observation. */
function animalDoorAt(snapshot, x, y) {
  const entry = (snapshot.animalDoorTargets ?? []).find((candidate) => candidate?.x === x && candidate?.y === y);
  if (entry === undefined) throw new Error(`animal_door_target_gone:${x},${y}`);
  if (typeof entry.isOpen !== "boolean" || typeof entry.targetId !== "string")
    throw new Error(`animal_door_target_projection_incomplete:${x},${y}`);
  return entry;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`animal_door_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
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
    const result = await runToggleAnimalDoorSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
