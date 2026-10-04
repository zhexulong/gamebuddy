import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const SCENARIO = "native_wia_tool_approach_interrupt_v1";
const EXPECTED_ACTIONS = ["chop_tree_source", "dismiss_modal", "equip_tool"];
const REQUIRED_CAPABILITIES = [...EXPECTED_ACTIONS].sort();
// The tool-approach slot reports its own frozen disposition vocabulary
// (farmhandexecutioncontroller.cs `reach=1;approach=<...>`), NOT the item-use
// slot's `native_animation_pending`. Both values mean the same product fact here:
// a walk that was abandoned before any native tool call ran.
const APPROACH_DISPOSITIONS = new Set(["failed", "invalidated"]);
const TILE_TEXT = /^\d+(\.\d+)?,\d+(\.\d+)?$/;

/**
 * The interruption source of a WIA intent breakpoint.
 *
 * Read from either position the current contract can put it in: a top-level
 * `interrupted_by`, or the head of `body_evidence`. The live tool-approach
 * terminal forwards the body loop's breakpoint through `body_evidence`
 * (farmhandexecutioncontroller.cs:3630), and the flat evidence grammar leaves that
 * field's FIRST `key=value` un-split while the remaining breakpoint fields become
 * top-level entries. Accepting both positions keeps this check honest without
 * pinning the nesting that is already reported for repair.
 */
function readInterruptionSource(evidence) {
  if (typeof evidence.interrupted_by === "string") return evidence.interrupted_by;
  const body = typeof evidence.body_evidence === "string" ? evidence.body_evidence : "";
  const match = /^interrupted_by=([^;]*)$/.exec(body);
  return match === null ? null : match[1];
}

/**
 * WIA §4.1 ② live proof for the tool-approach slot (design 5.2's shared walk leg).
 *
 * The slot under test is neither `activeNavigate` (RUNBOOK §28) nor `activeItemUse`
 * (§32): `chop_tree_source` issued outside the native Chebyshev-1 interaction
 * radius begins an approach leg that owns the body for many ticks before the tool
 * call. The contract is therefore three properties the other two slots cannot
 * express:
 *
 *   1. the request is ACCEPTED as an approach (the actor is Chebyshev-2 from the
 *      tree, so the in-range path is impossible) and the world modal interrupts
 *      the WALK, mints `invalidated/modal_interrupted`, and carries the approach
 *      slot's own identity (`approach`, `reach=1`, `target`, `tile`) plus the WIA
 *      intent breakpoint (`interrupted_by` / `interrupted_at`). The item-use
 *      slot's `native_animation_pending` is deliberately NOT asserted: this slot
 *      never starts a native tool animation, and fabricating that field would be a
 *      false claim about the world;
 *   2. the slot is released with nothing native executed — the fresh snapshot has
 *      `activeExecution == null` AND the target tree is still intact, which is how
 *      "the walk changed the world by nothing" is observable;
 *   3. the re-issued SAME intent re-enters the approach leg
 *      (`tool_approach_completed` in its lineage) and settles
 *      `succeeded/tree_source_chopped`.
 */
export async function runWiaToolApproachInterruptSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 40_000, postconditionTimeoutMs = 15_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalToolApproachConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    if (before.location !== "Farm")
      throw new Error(`tool_approach_route_must_start_on_farm:${before.location}`);
    const target = chooseOnlyChopTreeTarget(before);
    const approachDistance = tileDistance(before.tile, target);
    if (approachDistance <= 1)
      throw new Error(`approach_precondition_not_established:distance=${approachDistance}`);

    const axe = chooseAxe(before);
    const equipped = await executeAction("equip", "equip_tool", { tool: "axe" }, before, trace, client);
    if (equipped.state !== "succeeded" || (equipped.reasonCode !== "tool_equipped" && equipped.reasonCode !== "already_equipped"))
      throw new Error(`axe_equip_failed:${equipped.reasonCode}`);

    // ---- phase 1: the approach walk is interrupted by a real native modal ----
    const ready = await observeFresh(client, { actionable: true });
    const freshTarget = findSameChopTree(ready, target);
    if (!freshTarget) throw new Error("tree_chop_target_changed_after_equip");
    const freshDistance = tileDistance(ready.tile, freshTarget);
    if (freshDistance <= 1) throw new Error(`approach_precondition_lost_after_equip:distance=${freshDistance}`);

    const interruptAccepted = await executeChop(freshTarget, axe.slot, "interrupt", ready, trace, client);
    if (interruptAccepted.state !== "accepted")
      throw new Error(`interrupt_not_accepted:${interruptAccepted.state}:${interruptAccepted.reasonCode}`);
    const interrupted = await waitForTerminal(receipts, interruptAccepted, terminalTimeoutMs);
    if (interrupted.state !== "invalidated" || interrupted.reasonCode !== "modal_interrupted")
      throw new Error(`interrupt_missing:state=${interrupted.state};reason=${interrupted.reasonCode}`);
    const interruptEvidence = parseStrictEvidence(interrupted.evidence);
    const interruptSlotShape = {
      approachReported: APPROACH_DISPOSITIONS.has(interruptEvidence.approach),
      reachOne: interruptEvidence.reach === "1",
      targetIdentity: interruptEvidence.target === freshTarget.targetId,
      targetTile: interruptEvidence.tile === `${freshTarget.x},${freshTarget.y}`,
    };
    if (!Object.values(interruptSlotShape).every(Boolean))
      throw new Error(`interrupt_slot_evidence_missing:${JSON.stringify(interruptEvidence)}`);
    const interruptBreakpoint = {
      modalSource: readInterruptionSource(interruptEvidence) === "DialogueBox",
      interruptedAtReported: TILE_TEXT.test(interruptEvidence.interrupted_at ?? ""),
    };
    if (!Object.values(interruptBreakpoint).every(Boolean))
      throw new Error(`interrupt_intent_breakpoint_missing:${JSON.stringify(interruptEvidence)}`);

    // ---- phase 2: the slot is released and the walk executed nothing native ----
    const released = await waitForFreshSnapshot(client, {
      minRevision: interrupted.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (candidate) =>
        candidate.activeExecution == null && findSameChopTree(candidate, target) !== undefined,
    });
    const releasedTarget = findSameChopTree(released, target);
    const releaseOk =
      released.activeExecution == null
      && releasedTarget !== undefined
      && releasedTarget.health === 1
      && releasedTarget.stump === false;
    if (!releaseOk) throw new Error("interrupt_slot_not_released");

    // ---- phase 3: dismiss the modal (instantaneous: the bridge response IS the terminal) ----
    const dismissAccepted = await executeAction("dismiss", "dismiss_modal", {}, released, trace, client, {
      requireActionable: false,
    });
    const dismissed =
      dismissAccepted.state === "succeeded" && dismissAccepted.reasonCode === "modal_dismissed"
        ? dismissAccepted
        : dismissAccepted.state === "accepted"
          ? await waitForTerminal(receipts, dismissAccepted, terminalTimeoutMs)
          : dismissAccepted;
    if (dismissed.state !== "succeeded" || dismissed.reasonCode !== "modal_dismissed")
      throw new Error(`dismiss_missing:state=${dismissed.state};reason=${dismissed.reasonCode}`);
    const dismissEvidence = parseStrictEvidence(dismissed.evidence);
    if (dismissEvidence.modal_type !== "DialogueBox" || dismissEvidence.dismissed !== "true")
      throw new Error("dismiss_evidence_missing");

    // ---- phase 4: the same tool intent re-enters the approach leg and completes ----
    const retryReady = await waitForFreshSnapshot(client, {
      minRevision: dismissed.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (candidate) => candidate.activeExecution == null,
    });
    const retryTarget = findSameChopTree(retryReady, target);
    if (!retryTarget) throw new Error("tree_chop_target_changed_after_dismiss");
    const retryDistance = tileDistance(retryReady.tile, retryTarget);
    if (retryDistance <= 1) throw new Error(`retry_approach_precondition_not_established:distance=${retryDistance}`);

    const retryAccepted = await executeChop(retryTarget, axe.slot, "retry", retryReady, trace, client);
    // A rejected retry with `body_owned` would mean the interrupted approach was
    // never released; the accepted state is part of the release proof.
    if (retryAccepted.state !== "accepted")
      throw new Error(`retry_not_accepted:${retryAccepted.state}:${retryAccepted.reasonCode}`);
    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== "tree_source_chopped")
      throw new Error(`retry_failed:state=${retry.state};reason=${retry.reasonCode}`);
    const retryEvidence = parseStrictEvidence(retry.evidence);
    const retryApproachAnnounced = receipts.some(
      (entry) =>
        entry?.requestId === retryAccepted.requestId
        && entry?.executionId === retryAccepted.executionId
        && entry?.reasonCode === "tool_approach_completed",
    );
    const after = await waitForFreshSnapshot(client, {
      minRevision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (candidate) => candidate.activeExecution == null,
    });
    const reread = findSameChopResult(after, retryTarget);
    const retryPostcondition =
      retryApproachAnnounced
      && after.activeExecution == null
      && retryEvidence.target === retryTarget.targetId
      && retryEvidence.tool === "axe"
      && retryEvidence.health_before === "1"
      && retryEvidence.health_after === "5"
      && retryEvidence.source_transformed === "true"
      && reread?.health === 5
      && reread.stump === true;
    if (!retryPostcondition) throw new Error("retry_chop_postcondition_mismatch");

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "wia_tool_approach_interrupt_retry_complete",
      target: retryTarget,
      approachDistance: freshDistance,
      phases: {
        interrupt: summarizeReceipt(interrupted),
        dismiss: summarizeReceipt(dismissed),
        retry: summarizeReceipt(retry),
      },
      interruptEvidence,
      interruptSlotShape,
      interruptBreakpoint,
      releaseOk,
      retryApproachAnnounced,
      retryEvidence,
      retryPostcondition,
      before: summarizeWithChop(before),
      released: summarizeWithChop(released),
      after: summarizeWithChop(after),
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWiaToolApproachInterruptSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function executeChop(target, slot, phase, snapshot, trace, client) {
  return executeAction(
    phase,
    "chop_tree_source",
    { slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
    trace,
    client,
  );
}

async function executeAction(phase, action, args, snapshot, trace, client, { requireActionable = true } = {}) {
  if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_tool_approach_${phase}_${nonce}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}

function validateNativeLocalToolApproachConfig(value) {
  const requiredFields = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredFields.some((key) => typeof value?.[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
  // Only the geometry the fixture is responsible for is asserted here; the modal
  // itself is staged by the fixture and observed through the receipt, never by the
  // bridge publication.
  if (
    value.NativeLocalPlayerFixture?.Enable !== true
    || value.NativeLocalPlayerFixture?.Bootstrap?.Enable === true
    || value.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO
  )
    throw new Error("native_local_wia_tool_approach_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true
    || value.HostAutomation?.Enable === true
    || value.HostFarmhandProvisioning?.Enable === true
    || value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}

function chopTreeCandidates(snapshot) {
  return (snapshot.treeChopSourceTargets ?? []).filter((entry) => validChopTree(entry));
}

function chooseOnlyChopTreeTarget(snapshot) {
  const targets = chopTreeCandidates(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length ? "ambiguous_live_tree_chop_target" : "no_live_tree_chop_target");
  return targets[0];
}

function validChopTree(entry) {
  return (
    entry !== null
    && typeof entry === "object"
    && typeof entry.targetId === "string"
    && entry.targetId.length > 0
    && typeof entry.location === "string"
    && entry.location.length > 0
    && Number.isInteger(entry.x)
    && Number.isInteger(entry.y)
    && typeof entry.treeType === "string"
    && entry.treeType.length > 0
    && entry.health === 1
    && entry.stump === false
    && entry.moss === false
    && entry.tapped === false
  );
}

function findSameChopTree(snapshot, target) {
  return (snapshot.treeChopSourceTargets ?? []).find(
    (entry) => entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validChopTree(entry),
  );
}

function findSameChopResult(snapshot, target) {
  // Matched by location/tile/treeType, exactly like the in-range and approach chop
  // runners: a tree and its stump are different entities with different opaque
  // identities, and the claim under test is that the same tile now holds a stump.
  return (snapshot.treeChopResultTargets ?? []).find(
    (entry) =>
      entry?.location === target.location
      && entry?.x === target.x
      && entry?.y === target.y
      && entry?.treeType === target.treeType
      && entry?.stump === true,
  );
}

function chooseAxe(snapshot) {
  const axes = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Axe");
  if (axes.length !== 1) throw new Error(axes.length ? "ambiguous_live_axe_slot" : "no_live_axe_slot");
  return axes[0];
}

function tileDistance(left, right) {
  if (!Number.isInteger(left?.x) || !Number.isInteger(left?.y) || !Number.isInteger(right?.x) || !Number.isInteger(right?.y))
    throw new Error("invalid_live_tile");
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0 || detail.length > 4_096) throw new Error("invalid_wia_tool_approach_evidence");
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_wia_tool_approach_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_wia_tool_approach_evidence");
    result[key] = value;
  }
  return result;
}

function summarizeWithChop(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    treeChopSourceTargets: snapshot.treeChopSourceTargets ?? [],
    treeChopResultTargets: snapshot.treeChopResultTargets ?? [],
  };
}
