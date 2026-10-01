import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_chop_tree_source_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "chop_tree_source"];
const REQUIRED_CAPABILITIES = [
  "cancel_active_execution",
  "chop_tree_source",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
].sort();

/**
 * Proves the shared tool-family approach leg (design 5.2) end to end against the
 * real game.
 *
 * The contract under test is NOT "a tool action succeeds when the actor stands
 * next to the target" -- the existing chop-tree-source runner covers that. It is
 * the geometry the native click path enforces and the bridge used to refuse:
 * `Game1.cs:11509` requires `tileWithinRadiusOfPlayer(grabTile, 1)` before
 * `checkAction`, and `Character.GetToolLocation` (`:1218-1228`) only returns the
 * clicked tile inside that radius. A real player walks into range.
 *
 * So this runner deliberately SEPARATES the actor from the tree first, then
 * issues `chop_tree_source` from out of range and asserts the three properties
 * that make the approach honest:
 *
 *   1. the request is ACCEPTED (an approach began) rather than refused with
 *      `target_out_of_range`, which is the behaviour this change replaces;
 *   2. the approach reports `tool_approach_completed` before anything native
 *      runs, so arrival is not mistaken for the action terminal;
 *   3. the terminal is still `tree_source_chopped` with the full stamina and
 *      target evidence, i.e. the post-approach execution re-entered the same
 *      native path a standing player would use.
 */
export async function runChopTreeSourceApproachSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (snapshot.location !== "FarmHouse") throw new Error("chop_tree_source_route_must_start_at_farmhouse");
    snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);

    // The fixture guarantees exactly one qualifying tree, discoverable from
    // inside the discovery radius. Standing anywhere with that single target
    // visible while Chebyshev-farther than 1 is the Given this contract needs.
    snapshot = await standOutsideInteractionRange(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    const target = chooseChopTree(snapshot);
    const distance = Math.max(Math.abs(snapshot.tile.x - target.x), Math.abs(snapshot.tile.y - target.y));
    if (distance <= 1) throw new Error(`approach_precondition_not_established:distance=${distance}`);

    const axe = chooseAxe(snapshot);
    const equipped = await execute(client, trace, "equip_axe", "equip_tool", { tool: "axe" }, snapshot);
    if (equipped.state !== "succeeded" || (equipped.reasonCode !== "tool_equipped" && equipped.reasonCode !== "already_equipped"))
      throw new Error(`axe_equip_failed:${equipped.reasonCode}`);
    snapshot = await observeFresh(client, { actionable: true });
    const freshTarget = findSameChopTree(snapshot, target);
    if (!freshTarget || freshTarget.health !== 1 || freshTarget.stump !== false)
      throw new Error("tree_chop_target_changed_after_equip");
    const equippedDistance = Math.max(Math.abs(snapshot.tile.x - freshTarget.x), Math.abs(snapshot.tile.y - freshTarget.y));
    if (equippedDistance <= 1) throw new Error(`approach_precondition_lost_after_equip:distance=${equippedDistance}`);

    // 1. Out of range: the bridge must accept an approach, not refuse.
    const accepted = await execute(
      client,
      trace,
      "chop_tree_source_out_of_range",
      "chop_tree_source",
      { slot: axe.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId },
      snapshot,
    );
    if (accepted.state !== "accepted")
      throw new Error(`approach_not_accepted:${accepted.state}:${accepted.reasonCode}`);

    // 2. The walk must announce its own completion separately from the action.
    const terminal = await waitForTerminal(receipts, accepted, moveTimeoutMs + terminalTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "tree_source_chopped")
      throw new Error(`chop_tree_source_failed:${terminal.state}:${terminal.reasonCode}`);

    const approachProgress = receipts
      .filter((entry) => entry.requestId === accepted.requestId)
      .map((entry) => entry.reasonCode);
    const announcedApproach = approachProgress.includes("tool_approach_completed");

    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForStableRevision(client, {
      revision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) => latest.actionable === true && latest.activeExecution == null,
    });
    const reread = findSameChopResult(after, freshTarget);
    // Report which clause failed rather than a bare "mismatch": the live evidence is
    // the only place this contract is observable, so a failure must be diagnosable
    // from the result alone.
    const clauses = {
      announcedApproach,
      revisionSettled: after.revision === terminal.revision,
      evidenceTarget: evidence.target === freshTarget.targetId,
      tool: evidence.tool === "axe",
      healthBefore: evidence.health_before === "1",
      healthAfter: evidence.health_after === "5",
      stumpBefore: evidence.stump_before === "false",
      stumpAfter: evidence.stump_after === "true",
      sourceTransformed: evidence.source_transformed === "true",
      staminaReported:
        evidence.stamina_before !== undefined
        && evidence.stamina_after !== undefined
        && evidence.stamina_delta !== undefined
        && evidence.expected_stamina_cost !== undefined,
      resultReadback: reread?.health === 5 && reread.stump === true,
    };
    const passed = Object.values(clauses).every(Boolean);

    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: !announcedApproach
        ? "approach_progress_receipt_missing"
        : passed
          ? "tree_source_chopped_via_approach"
          : `approach_postcondition_mismatch:${Object.entries(clauses).filter(([, ok]) => !ok).map(([name]) => name).join("+")}`,
      clauses,
      approach: {
        distanceBeforeChop: equippedDistance,
        progress: approachProgress,
      },
      target: freshTarget,
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
      before: summarizeWithChop(snapshot),
      after: summarizeWithChop(after),
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
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runChopTreeSourceApproachSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_chop_tree_approach_${phase}_${nonce}`;
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

async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const warp = resolveFarmWarp(fresh);
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await moveToTile(client, receipts, fresh, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp", trace, stabilizeTimeoutMs, terminalTimeoutMs);
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm" && latest.activeExecution == null,
  });
}

/**
 * Puts the actor on a tile that is inside the tree's DISCOVERY radius but outside
 * the INTERACTION radius, which is exactly the situation the native click path
 * resolves by walking. Movement failures for a single candidate are tolerated (a
 * tile may be unwalkable); the loop stops as soon as the target is visible from
 * Chebyshev-farther than 1.
 */
async function standOutsideInteractionRange(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  const tree = chooseChopTree(await observeFresh(client, { actionable: true }));
  for (let radius = 2; radius <= 5; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidate = { x: tree.x + dx, y: tree.y + dy };
        if (!validTile(candidate.x) || !validTile(candidate.y)) continue;
        try {
          const settled = await moveToTile(client, receipts, snapshot, candidate, "move_out_of_interaction_range", trace, stabilizeTimeoutMs, moveTimeoutMs);
          const visible = chopTreeCandidates(settled);
          if (visible.length === 1 && Math.max(Math.abs(settled.tile.x - visible[0].x), Math.abs(settled.tile.y - visible[0].y)) > 1)
            return settled;
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error);
          if (!reason.endsWith("no_native_path") && !reason.endsWith("target_reached")) {
            if (!/not_accepted|move_failed/.test(reason)) throw error;
          }
        }
        snapshot = await observeFresh(client, { actionable: true });
      }
    }
  }
  throw new Error("approach_precondition_unreachable:no_tile_outside_interaction_range_inside_discovery");
}

function chopTreeCandidates(snapshot) {
  return (snapshot.treeChopSourceTargets ?? []).filter((entry) => validChopTree(entry));
}

function chooseChopTree(snapshot) {
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
    && validTile(entry.x)
    && validTile(entry.y)
    && entry.health === 1
    && entry.stump === false
    && entry.moss === false
    && entry.tapped === false
  );
}

function chooseAxe(snapshot) {
  // The snapshot advertises equippable axes as tool slots, matching every other
  // native-local runner; `inventory` is not a projected field.
  const axes = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Axe");
  if (axes.length !== 1) throw new Error(axes.length ? "ambiguous_live_axe_slot" : "no_live_axe_slot");
  return axes[0];
}

function findSameChopTree(snapshot, target) {
  return (snapshot.treeChopSourceTargets ?? []).find(
    (entry) => entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validChopTree(entry),
  );
}

function findSameChopResult(snapshot, target) {
  // Matched by location/tile/treeType -- the same readback the in-range runner
  // uses -- because a tree and its stump are DIFFERENT entities with different
  // opaque identities (`tree_chop_source_*` -> `tree_chop_result_*`). Requiring the
  // id to survive would make this readback impossible; the claim being verified is
  // that the same tile now holds a stump of the same tree type.
  return (snapshot.treeChopResultTargets ?? []).find(
    (entry) =>
      entry?.location === target.location &&
      entry?.x === target.x &&
      entry?.y === target.y &&
      entry?.treeType === target.treeType,
  );
}

function resolveFarmWarp(snapshot) {
  const warps = (snapshot.warps ?? []).filter(
    (entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY),
  );
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return warps[0];
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
  });
}

function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}

function parseEvidence(evidence) {
  // The wire shape is `{ detail: "key=value;key=value" }`, matching every other
  // native-local runner.
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
    }),
  );
}

function summarizeWithChop(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    // Both chop projections are forwarded: the source list proves the tree was
    // consumed, and the result list is where the stump readback lives.
    treeChopSourceTargets: snapshot.treeChopSourceTargets ?? [],
    treeChopResultTargets: snapshot.treeChopResultTargets ?? [],
  };
}

function validateNativeLocalFixtureConfig(config) {
  // The tool family is no longer experimental, so the runner only has to prove the
  // policy does not deny the actions it drives.
  validateNativeLocalFixturePolicy(config, { requiredActions: EXPECTED_ACTIONS });
}
