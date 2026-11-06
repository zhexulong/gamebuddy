// Stardew-local `open_geode` smoke.
//
// One geode cracked at the blacksmith's own counter, end to end, through the game's own
// `GeodeMenu`. The action owns the whole native lifecycle (menu open, cursor load, smash,
// animation, delivery, close); this runner's job is to prove the three facts a receipt
// cannot supply on its own:
//
//   1. the terminal is the action's own `succeeded/geode_opened` (or, when the engine
//      really did crack a geode into nothing, its own named `geode_result_not_observed`);
//   2. the WORLD agrees afterwards, read from a FRESH snapshot and never from the
//      receipt's claim: the geode left the pack and the treasure arrived in it;
//   3. no menu is left open - `actionable` is true and the actor carries no modal
//      disposition - because `menu_left_open` is the one terminal this action can reach
//      and still look successful to a caller that reads only the reasonCode.
//
// The travel leg is part of the trace on purpose: reaching the counter is a product
// action (`travel` through the published exit, then the counter's own reach check), so an
// Agent that has the fixture's Starting Given needs exactly one `open_geode` request and
// no invented coordinates.

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
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "open_geode";
/** The action's own success word (`ExecuteOpenGeode`: succeeded only when the delivery and the fee both landed). */
const SUCCESS_CODE = "geode_opened";
/** The engine's honest second outcome: the crack ran and the menu minted nothing to show for it. */
const EMPTY_RESULT_CODE = "geode_result_not_observed";
/** The terminal that says the menu this execution opened outlived it. */
const MENU_LEFT_OPEN_CODE = "menu_left_open";

/** The Given this slice arms: a geode in the pack and an exit that leads to the counter. */
const FIXTURE_SCENARIO = "native_open_geode_v1";

/** `ExecutionManager.GeodeCounterLocationName`: the one location whose counter processes geodes. */
const GEODE_COUNTER_LOCATION = "Blacksmith";

/**
 * The closed set the surface must carry.
 *
 * `inspect_self`/`cancel_active_execution` are the two fixed protocol controls
 * (`FarmhandCapabilitySet.ProtocolControls`), `open_geode` is the registration under test,
 * and `travel`/`move_to_tile` are the price of REACHING the counter: the fixture starts the
 * actor outside the shop, and a runner that named the door tile without observing it would
 * be inventing coordinates.
 */
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", ACTION];

/**
 * The engine's own geode set (`Utility.IsGeode`): ordinary, frozen, magma and omni. The
 * fixture supplies exactly one of them; accepting the whole set is derived from the
 * engine's predicate rather than pinned to whichever id the fixture happens to use.
 */
const GEODE_QUALIFIED_ITEM_IDS = Object.freeze(["(O)535", "(O)536", "(O)537", "(O)749"]);

export async function runOpenGeodeSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 10_000, postconditionTimeoutMs = 10_000, navigationTimeoutMs = 55_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  let lastSnapshot = null;
  try {
    validateConfig(config);
    // The fixture places the actor at Clint's counter with `warpFarmer`, and that warp is ASYNC: the bridge
    // opens while the fade is still in flight, so an immediate observation reads `can_move=False` and the run
    // dies with `native_snapshot_not_actionable` (measured 2026-11-04: `fade=0.03;location=FarmHouse;
    // can_move=False` about 300 ms after the fixture logged its own Given). A warp in flight is not a world
    // that cannot act, so wait for the ability to act - bounded, and still fail-closed with the same named
    // code when the world never settles.
    let snapshot = await waitForActionable(client, await observeFresh(client), 30_000).catch(() =>
      observeFresh(client, { actionable: true }),
    );
    lastSnapshot = snapshot;
    // Record what was observed before any assertion can throw: an empty trace with a bare reasonCode cannot
    // tell a missing capability from a dead pipe.
    trace.push({
      phase: "observed",
      revision: snapshot.revision,
      location: snapshot.location,
      tile: snapshot.tile ?? null,
      actionable: snapshot.actionable,
      actorDispositionKind: snapshot.actorDispositionKind ?? null,
      capabilities: Array.isArray(snapshot.capabilities) ? [...snapshot.capabilities] : null,
      inventoryItemFactCount: Array.isArray(snapshot.inventoryItemFacts) ? snapshot.inventoryItemFacts.length : null,
    });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

    snapshot = await ensureAtGeodeCounter(client, receipts, trace, snapshot, navigationTimeoutMs);
    lastSnapshot = snapshot;
    const target = chooseGeode(snapshot);

    const requestId = `native_local_open_geode_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      // No coordinate: the counter is Clint's own dialogue case, and the Mod re-reads the
      // shop, the owner and the reach itself at admission.
      args: { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ phase: ACTION, action: ACTION, target, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("open_geode_terminal_identity_mismatch");

    const evidence = parseStrictEvidence(terminal.evidence);
    trace.push({
      phase: "observed_evidence",
      action: ACTION,
      state: terminal.state,
      reasonCode: terminal.reasonCode,
      evidence,
    });

    // The receipt is judged AFTER its evidence is on the trace, so a refusal reports what
    // the menu and the pack actually did instead of only its reasonCode.
    if (terminal.state !== "succeeded" || terminal.reasonCode !== SUCCESS_CODE) {
      throw new Error(
        `open_geode_terminal_mismatch:state=${terminal.state};reason=${terminal.reasonCode}` +
          `;evidence=${terminal.evidence?.detail ?? "(none)"}`,
      );
    }

    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    lastSnapshot = after;
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);

    // The postcondition is the WORLD's, read from `after` and never from `terminal`.
    const afterFacts = inventoryFacts(after);
    const geodeAfter = countOf(afterFacts, target.qualifiedItemId);
    const treasureItemId = evidence.treasure;
    const treasureAfter =
      treasureItemId === undefined || treasureItemId === "none" ? 0 : countOf(afterFacts, treasureItemId);
    const geodeConsumed = geodeAfter === target.before - 1;
    const treasureArrived = evidence.treasure !== "none" && evidence.treasure !== undefined && treasureAfter > 0;
    // `menu_left_open` is half the postcondition, and the snapshot is the only witness that
    // survives the execution: `actionable` alone can be true with a menu-owned disposition.
    const noMenuOpen = after.actionable === true && after.actorDispositionKind !== "modal";
    const receiptMatchesWorld =
      evidence.item === target.qualifiedItemId &&
      evidence.geode_owned_before === String(target.before) &&
      evidence.geode_owned_after === String(geodeAfter) &&
      evidence.crack_settled === "true" &&
      evidence.menu_closed === "true" &&
      evidence.fee_taken === "25" &&
      Number(evidence.delivered) === Number(evidence.treasure_stack);

    const passed =
      after.revision >= terminal.revision && geodeConsumed && treasureArrived && noMenuOpen && receiptMatchesWorld;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed
        ? SUCCESS_CODE
        : postconditionReason({ geodeConsumed, treasureArrived, noMenuOpen, receiptMatchesWorld }),
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      freshPostcondition: {
        revision: after.revision,
        location: after.location,
        tile: after.tile,
        actionable: after.actionable,
        actorDispositionKind: after.actorDispositionKind ?? null,
        geodeBefore: target.before,
        geodeAfter,
        treasureItemId: treasureItemId ?? null,
        treasureAfter,
        geodeConsumed,
        treasureArrived,
        noMenuOpen,
        receiptMatchesWorld,
      },
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 512),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      lastSnapshot: lastSnapshot
        ? {
            revision: lastSnapshot.revision,
            location: lastSnapshot.location,
            tile: lastSnapshot.tile,
            actionable: lastSnapshot.actionable,
            actorDispositionKind: lastSnapshot.actorDispositionKind ?? null,
            capabilities: lastSnapshot.capabilities,
            warps: lastSnapshot.warps ?? [],
            inventoryItemFacts: lastSnapshot.inventoryItemFacts ?? [],
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
    const result = await runOpenGeodeSmoke(session.client, session.receipts, config);
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
    throw new Error("native_local_open_geode_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_open_geode_action_policy_invalid");
  // `open_geode` is an Experimental registration, so the fixture's derived policy
  // legitimately opts it in - and nothing else.
  validateNativeLocalFixturePolicy(value, {
    requiredActions: ["move_to_tile", "travel", ACTION],
    experimentalActions: [ACTION],
  });
}

/**
 * Reach the blacksmith's counter: walk to the published exit and take it.
 *
 * A fixture that starts the actor inside the shop is reported as the Given it is; a
 * fixture that starts it outside uses the world's OWN published exit, so no coordinate in
 * this runner is invented. A location that publishes no exit to the shop is a fixture
 * problem named as such, not a wandering search.
 */
async function ensureAtGeodeCounter(client, receipts, trace, snapshot, navigationTimeoutMs) {
  if (snapshot.location === GEODE_COUNTER_LOCATION) {
    trace.push({ phase: "counter_reached", location: snapshot.location, via: "fixture_given", tile: snapshot.tile });
    return snapshot;
  }
  const exits = (snapshot.warps ?? []).filter(
    (entry) => entry?.targetLocation === GEODE_COUNTER_LOCATION && validTile(entry.sourceX) && validTile(entry.sourceY),
  );
  if (exits.length !== 1) {
    const published = [...new Set((snapshot.warps ?? []).map((entry) => entry?.targetLocation).filter(Boolean))];
    throw new Error(
      `geode_counter_exit_${exits.length === 0 ? "missing" : "ambiguous"}:location=${snapshot.location}:published=${published.join("/") || "none"}`,
    );
  }
  const exit = exits[0];
  trace.push({
    phase: "counter_exit",
    location: snapshot.location,
    tile: snapshot.tile,
    source: { x: exit.sourceX, y: exit.sourceY },
    targetLocation: exit.targetLocation,
  });
  if (!adjacent(snapshot.tile, { x: exit.sourceX, y: exit.sourceY }))
    snapshot = await move(
      client,
      receipts,
      trace,
      snapshot,
      { x: exit.sourceX, y: exit.sourceY },
      "move_to_counter_exit",
      navigationTimeoutMs,
    );
  const accepted = await execute(client, trace, "travel", "travel", { x: exit.sourceX, y: exit.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForNavigationTerminal(
    client,
    receipts,
    accepted,
    (latest) => latest.location === GEODE_COUNTER_LOCATION,
    navigationTimeoutMs,
  );
  trace.push({
    phase: "counter_reached",
    location: completion.snapshot.location,
    via: "travel",
    tile: completion.snapshot.tile,
  });
  return completion.snapshot;
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
  const requestId = `native_local_open_geode_${phase}_${Date.now()}_${trace.length}`;
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

/** The pack's own published facts, which the Mod publishes for this action's capability family. */
function inventoryFacts(snapshot) {
  const raw = snapshot?.inventoryItemFacts;
  return Array.isArray(raw) ? raw : [];
}

function countOf(facts, qualifiedItemId) {
  return facts
    .filter((entry) => entry?.qualifiedItemId === qualifiedItemId)
    .reduce((total, entry) => total + (Number.isFinite(entry?.stack) ? entry.stack : 0), 0);
}

/**
 * The one geode the fixture supplied, named by the slot the request must use.
 *
 * "Exactly one slot" is the fixture's contract: a pack with two partial geode stacks would
 * make "the geode count fell by one" ambiguous, and the ambiguity would be in the
 * observation, not in the action.
 */
function chooseGeode(snapshot) {
  const rows = inventoryFacts(snapshot).filter(
    (entry) =>
      Number.isInteger(entry?.slot) &&
      typeof entry?.qualifiedItemId === "string" &&
      GEODE_QUALIFIED_ITEM_IDS.includes(entry.qualifiedItemId) &&
      Number.isFinite(entry?.stack) &&
      entry.stack > 0,
  );
  if (rows.length !== 1)
    throw new Error(
      `open_geode_target_count_expected_1_got_${rows.length}:` +
        (rows.map((row) => `slot${row.slot}=${row.qualifiedItemId}x${row.stack}`).join(",") || "none"),
    );
  return {
    slot: rows[0].slot,
    qualifiedItemId: rows[0].qualifiedItemId,
    before: rows[0].stack,
    displayName: rows[0].displayName,
  };
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

function postconditionReason({ geodeConsumed, treasureArrived, noMenuOpen, receiptMatchesWorld }) {
  if (!noMenuOpen) return MENU_LEFT_OPEN_CODE;
  if (!geodeConsumed) return "open_geode_postcondition_geode_still_owned";
  if (!treasureArrived) return `open_geode_postcondition_${EMPTY_RESULT_CODE}`;
  if (!receiptMatchesWorld) return "open_geode_receipt_disagrees_with_world";
  return "open_geode_postcondition_mismatch";
}

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
