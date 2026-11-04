import { loadHostTestModule } from "./lib/host-test-module.mjs";
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  NativeSmokeHarnessError,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "break_resource_clump";
/** The action's own success word (`ExecuteBreakResourceClump`: `succeeded` only when the clump left the layer). */
const SUCCESS_CODE = "clump_broken";
/** The Given this slice arms: the fixture-owned intact 2x2 `parentSheetIndex=752` clump on the Farm. */
const FIXTURE_SCENARIO = "native_clear_debris_resource_clump_v1";
/**
 * The closed set the surface must carry.
 *
 * `inspect_self`/`cancel_active_execution` are the two fixed protocol controls
 * (`FarmhandCapabilitySet.ProtocolControls`), `break_resource_clump` is the
 * registration under test and `equip_tool` is what lets this slice establish
 * the wrong-tool precondition on purpose instead of hoping for it.
 *
 * `travel`/`move_to_tile` are the price of OBSERVING this action's own family:
 * the clump is on the Farm while the fixture world loads at FarmHouse, and
 * `DiscoverDebrisTargets` publishes a clump only from within
 * `TargetDiscoveryRadius` (6) of one of its footprint tiles. Without both, the
 * family is empty at every tile that is not already in reach, and a runner that
 * named coordinates it never observed would be inventing them.
 */
const REQUIRED_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "equip_tool",
  "move_to_tile",
  "travel",
  ACTION,
];
/**
 * The fixture's reviewed outside interaction tiles, tried in order.
 *
 * These are the same three tiles the `clear_debris` runner pins for the same
 * 2x2 footprint: each is a standing tile outside the clump that puts the actor
 * within the discovery radius. A rejected route is not expanded - the slice
 * stops with a named code rather than wandering the Farm.
 */
const APPROACH_TILES = Object.freeze([
  Object.freeze({ x: 61, y: 17 }),
  Object.freeze({ x: 64, y: 17 }),
  Object.freeze({ x: 62, y: 19 }),
]);

/**
 * Execute the break_resource_clump contract against an already-connected bridge session.
 *
 * The three facts this proves, in the order they can be wrong:
 *   1. the receipt is the action's own `succeeded/clump_broken`, correlated by
 *      the exact request/execution pair, while the actor held a tool the clump
 *      does NOT accept;
 *   2. the clump is GONE from the live location afterwards - read from a fresh
 *      observation, never from the receipt's own claim;
 *   3. the actor's own held tool is back where it was, again from the world and
 *      not only from the evidence string.
 */
export async function runBreakResourceClumpSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000, navigationTimeoutMs = 55_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  let lastSnapshot = null;
  try {
    validateConfig(config);
    let snapshot = await observeFresh(client, { actionable: true });
    lastSnapshot = snapshot;
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

    snapshot = await ensureOnFarm(client, receipts, trace, snapshot, navigationTimeoutMs);
    lastSnapshot = snapshot;
    snapshot = await approachClump(client, receipts, trace, snapshot, navigationTimeoutMs);
    lastSnapshot = snapshot;
    const target = chooseOnlyClumpTarget(snapshot);

    // The wrong-tool precondition, established rather than hoped for: hold a
    // tool whose category is NOT the one this clump's own native switch demands.
    const wrongTool = chooseWrongTool(snapshot, target.toolKind);
    const equipped = await execute(
      client,
      trace,
      "equip_wrong_tool",
      "equip_tool",
      { tool: wrongTool.category },
      snapshot,
    );
    const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
    if (
      equipTerminal.state !== "succeeded" ||
      !["tool_equipped", "already_equipped"].includes(equipTerminal.reasonCode)
    )
      throw new Error(`wrong_tool_equip_failed:${equipTerminal.reasonCode}`);

    snapshot = await waitForFreshSnapshot(client, {
      minRevision: equipTerminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    lastSnapshot = snapshot;
    const held = heldTool(snapshot);
    if (held === null || held.category !== wrongTool.category)
      throw new Error(`held_tool_not_the_wrong_tool:${held?.category ?? "none"}:${wrongTool.category}`);
    if (held.category === target.toolKind) throw new Error(`held_tool_is_the_required_tool:${target.toolKind}`);

    // The clump is re-read from the post-equip snapshot so the request names a
    // target the observation that justified it actually carried.
    const fresh = findClumpTarget(snapshot, target.targetId);
    if (fresh === null) throw new Error("clump_target_disappeared_before_request");

    const requestId = `native_local_break_resource_clump_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      // No `slot`: the handler resolves the clump's own tool requirement,
      // selects that tool and restores the actor's selection afterwards.
      args: { x: fresh.x, y: fresh.y, expectedTargetId: fresh.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      action: ACTION,
      target: fresh.targetId,
      heldTool: held.category,
      receipt: summarizeReceipt(accepted),
    });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("break_resource_clump_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== SUCCESS_CODE)
      throw new Error(`break_resource_clump_failed:${terminal.state}:${terminal.reasonCode}`);

    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    lastSnapshot = after;
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);

    // The postcondition is the WORLD's: the clump this request named is no
    // longer in the published collection, and the actor's hand is back on the
    // tool it was holding. Both are read from `after`, never from `terminal`.
    const clumpGone = findClumpTarget(after, fresh.targetId) === null;
    const restored = heldTool(after);
    const toolRestored = restored !== null && restored.slot === held.slot && restored.category === held.category;
    const receiptMatchesWorld =
      evidence.target === fresh.targetId &&
      evidence.tile === `${fresh.x},${fresh.y}` &&
      evidence.parent === String(fresh.parentSheetIndex) &&
      // The tool the handler used is the CLUMP's answer, not the one in hand.
      evidence.tool === fresh.toolKind &&
      evidence.tool_selected === fresh.toolKind &&
      evidence.tool_before === held.category &&
      evidence.tool_restored === held.category &&
      evidence.clump_removed === "true" &&
      evidence.drop_observed === "true" &&
      Number(evidence.swings) >= 1 &&
      Number.isFinite(Number(evidence.health_before)) &&
      Number(evidence.health_after) === 0;

    const passed = after.revision >= terminal.revision && clumpGone && toolRestored && receiptMatchesWorld;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? SUCCESS_CODE : postconditionReason({ clumpGone, toolRestored, receiptMatchesWorld }),
      target: fresh,
      heldTool: held,
      receipt: summarizeReceipt(terminal),
      evidence,
      freshPostcondition: { clumpGone, toolRestored, revision: after.revision, held: restored },
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
      lastSnapshot: lastSnapshot
        ? {
            revision: lastSnapshot.revision,
            location: lastSnapshot.location,
            tile: lastSnapshot.tile,
            capabilities: lastSnapshot.capabilities,
            currentTool: lastSnapshot.currentTool ?? null,
            currentToolSlot: lastSnapshot.currentToolSlot ?? null,
            debrisTargets: lastSnapshot.debrisTargets ?? [],
            toolSlots: lastSnapshot.toolSlots ?? [],
          }
        : null,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectWithRetry(config, 15_000);
  try {
    const result = await runBreakResourceClumpSmoke(session.client, session.receipts, config);
    if (result.state === "passed") console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

/** The game creates its named pipe asynchronously after launch; retry ENOENT within a bounded window. */
async function connectWithRetry(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== FIXTURE_SCENARIO)
    throw new Error("native_local_break_resource_clump_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_break_resource_clump_action_policy_invalid");
  // `break_resource_clump` is an Experimental registration, so the fixture's
  // derived policy legitimately opts it in - and nothing else.
  validateNativeLocalFixturePolicy(value, {
    requiredActions: ["move_to_tile", "travel", "equip_tool", ACTION],
    experimentalActions: [ACTION],
  });
}

/** Leave FarmHouse for the Farm through the one warp the observation publishes. */
async function ensureOnFarm(client, receipts, trace, snapshot, navigationTimeoutMs) {
  if (snapshot.location === "Farm") return snapshot;
  const warps = (snapshot.warps ?? []).filter(
    (entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY),
  );
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(
      client,
      receipts,
      trace,
      snapshot,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      navigationTimeoutMs,
    );
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForNavigationTerminal(
    client,
    receipts,
    accepted,
    (latest) => latest.location === "Farm",
    navigationTimeoutMs,
  );
  return completion.snapshot;
}

/** Walk to the first reviewed anchor that publishes exactly one clump this action owns. */
async function approachClump(client, receipts, trace, snapshot, navigationTimeoutMs) {
  for (const approach of APPROACH_TILES) {
    try {
      if (sameTile(snapshot.tile, approach)) snapshot = await observeFresh(client, { actionable: true });
      else
        snapshot = await move(
          client,
          receipts,
          trace,
          snapshot,
          approach,
          "move_to_clump_approach",
          navigationTimeoutMs,
        );
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      if (
        !(
          reason.startsWith("move_to_clump_approach_not_accepted:no_native_path") ||
          reason.startsWith("navigation_failed:") ||
          reason.startsWith("navigation_timeout:")
        )
      )
        throw error;
      snapshot = await observeFresh(client, { actionable: true });
    }
    if (clumpTargets(snapshot).length === 1) return snapshot;
  }
  // What the world published matters: the slice reports the count it actually
  // observed rather than claiming the fixture was empty.
  throw new Error(`break_resource_clump_no_single_published_target_got_${clumpTargets(snapshot).length}`);
}

async function move(client, receipts, trace, snapshot, target, phase, navigationTimeoutMs) {
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForNavigationTerminal(
    client,
    receipts,
    accepted,
    (latest) => adjacent(latest.tile, target),
    navigationTimeoutMs,
  );
  return completion.snapshot;
}

/** Terminal wait with the harness's exact identity, then a fresh post-terminal observation. */
async function waitForNavigationTerminal(client, receipts, accepted, predicate, timeoutMs) {
  let terminal;
  try {
    terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  } catch (error) {
    if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
    throw error;
  }
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  let snapshot;
  try {
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs,
      requireActionable: true,
      check: predicate,
    });
  } catch (error) {
    if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
    throw error;
  }
  return { receipt: terminal, snapshot };
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_break_resource_clump_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

/**
 * Every published clump row this action addresses, without narrowing the family
 * to one hand-picked native index: the Mod publishes a row only for a clump
 * whose own tool requirement the pack can satisfy (`DiscoverDebrisTargets`), so
 * a well-formed row IS this action's target family.
 */
function clumpTargets(snapshot) {
  return (snapshot.debrisTargets ?? []).filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      entry.targetId.length > 0 &&
      validTile(entry.x) &&
      validTile(entry.y) &&
      Number.isInteger(entry.parentSheetIndex) &&
      (entry.toolKind === "axe" || entry.toolKind === "pickaxe") &&
      Number.isInteger(entry.requiredUpgradeLevel) &&
      entry.requiredUpgradeLevel >= 0 &&
      Number.isFinite(entry.health) &&
      entry.health > 0,
  );
}

function chooseOnlyClumpTarget(snapshot) {
  const targets = clumpTargets(snapshot);
  if (targets.length !== 1) throw new Error(`break_resource_clump_target_count_expected_1_got_${targets.length}`);
  return targets[0];
}

function findClumpTarget(snapshot, targetId) {
  return clumpTargets(snapshot).find((entry) => entry.targetId === targetId) ?? null;
}

/**
 * The tool slot the actor holds, resolved through the SAME published slot list
 * the request's own slot arguments read. `null` when the held slot holds
 * something that is not a tool.
 */
function heldTool(snapshot) {
  const slot = snapshot.currentToolSlot;
  if (!Number.isInteger(slot)) return null;
  const entry = (snapshot.toolSlots ?? []).find((candidate) => candidate?.slot === slot);
  if (entry === undefined || typeof entry.category !== "string") return null;
  return { slot: entry.slot, category: entry.category, label: entry.label };
}

/**
 * A tool whose category the clump does NOT accept.
 *
 * Preference order is fixed so a re-run names the same displaced tool, and the
 * choice is made from the live slot list - never assumed from the save.
 */
function chooseWrongTool(snapshot, requiredToolKind) {
  const preferred = ["axe", "hoe", "scythe", "watering_can", "fishing_rod", "shears", "milk_pail", "pan", "weapon"];
  const candidates = (snapshot.toolSlots ?? []).filter(
    (entry) =>
      Number.isInteger(entry?.slot) && typeof entry.category === "string" && entry.category !== requiredToolKind,
  );
  for (const category of preferred) {
    const match = candidates.find((entry) => entry.category === category);
    if (match !== undefined) return { slot: match.slot, category: match.category, label: match.label };
  }
  if (candidates.length > 0)
    return { slot: candidates[0].slot, category: candidates[0].category, label: candidates[0].label };
  throw new Error(`break_resource_clump_no_wrong_tool_available:${requiredToolKind}`);
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  const fields = Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
  return fields;
}

function postconditionReason({ clumpGone, toolRestored, receiptMatchesWorld }) {
  if (!clumpGone) return "break_resource_clump_postcondition_clump_still_present";
  if (!toolRestored) return "break_resource_clump_postcondition_tool_not_restored";
  if (!receiptMatchesWorld) return "break_resource_clump_receipt_disagrees_with_world";
  return "break_resource_clump_postcondition_mismatch";
}

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function sameTile(left, right) {
  return left.x === right.x && left.y === right.y;
}
