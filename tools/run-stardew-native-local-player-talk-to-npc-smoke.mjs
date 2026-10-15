import {
  assertRequiredCapabilities,
  classifyTopology,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeTopologySnapshot,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { isAdmissionHold } from "./lib/stardew-admission-hold-codes.mjs";

const ACTION = "talk_to_npc";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** A well-formed opaque id that was never published for any villager. */
const UNKNOWN_TARGET_ID = "npc_relationship_0000000000000000";

/**
 * The location the shared-world Given declares, read from the actor's OWN client and
 * never from the Host. `native_farmhand_talk_to_npc_v1` needs the bound Farmhand in
 * the Saloon one Chebyshev step from Gus: the native talk branch builds its dialogue
 * keys from `Game1.currentLocation.name.Value`, and no shipped villager dialogue table
 * has a key reachable from the Farm, the Cabin or the FarmHouse, so the Saloon is the
 * The WALK fallback's fixed goal. The warp-item route does NOT use this: it reads the destination
 * the Mod publishes for the totem the fixture armed (see SHARED_WORLD_WARP_ITEM_ACTION), so no
 * location name is written down for the route a live run actually takes.
 */
const SHARED_WORLD_DECLARED_LOCATION = "Saloon";

/**
 * The published capabilities the shared-world walk needs.
 *
 * `navigate_to_destination` is the product's own multi-hop cross-map navigation and is
 * the primary walk; `find_destination` is the read-only search that names the Saloon the
 * way the product names destinations, so no label or coordinate is guessed here. The
 * hop-by-hop fallback below additionally needs `move_to_tile`/`travel`/`enter_exit` and
 * says so by name if they are absent.
 */
const SHARED_WORLD_WALK_CAPABILITIES = ["find_destination", "navigate_to_destination"];

/**
 * The deadline handed to `navigate_to_destination`.
 *
 * Multi-hop navigation is the slowest thing this run does: the Mod's own watchdog for
 * the action is ten minutes, and a recorded live multi-hop run needed its deadline
 * relaxed to exactly that (`FarmHouse -> Farm -> BusStop -> Backwoods` settling
 * `succeeded / navigation_completed`). The smoke harness caps a request deadline here,
 * so this is the ceiling rather than an arbitrary wait.
 */
const SHARED_WORLD_NAVIGATION_TIMEOUT_MS = 600_000;

/**
 * The deadlines and budgets the walk works inside.
 *
 * A HOP IS ONE MAP. The product's navigation is hop-by-hop by design - the catalogue review
 * records it as "cross-map movement is executed ONE HOP AT A TIME with a fresh observe; do not
 * hardcode the map sequence, do not prebuild a reverse index" - so asking one call to cross
 * four maps is not a request the product answers, and the ordinary route from a Cabin to the
 * Saloon needs four hops (Cabin, Farm, Bus Stop, Town, Saloon). The attempt budget is a hop
 * budget plus the arrival: one attempt searches, navigates, and takes at most one hop.
 */
const SHARED_WORLD_STEP_TIMEOUT_MS = 20_000;
const SHARED_WORLD_MOVE_BUDGET = 8;
const SHARED_WORLD_NAVIGATION_ATTEMPTS = 6;

/**
 * The warp item that crosses maps in ONE action, and the destination it names.
 *
 * WHY THIS ROUTE EXISTS: measured live, the product cannot take this actor off the Farm
 * by walking. The Farm's exits to `BusStop` and `Forest` are published on the map's
 * impassable outer ring (`no_native_path` for every tile at x=79..80 and y=64..65, where the
 * actor must stand to be within Chebyshev-1 of the warp), and the navigation graph cannot
 * route either (`destination_unreachable`, because the intermediate locations are not loaded
 * in the client's process). A warp totem touches neither: it moves the actor in one action,
 * validated only by the totem's own mapped destination
 * (`farmhandexecutioncontroller.itemtileactions.cs:175-213`).
 */
const SHARED_WORLD_WARP_ITEM_ACTION = "use_warp_item";

/**
 * How many of a location's published transitions one hop decision will consider.
 *
 * IT USED TO BE 4, AND THAT TRUNCATION WAS A DEFECT. Measured live: the Farm publishes EIGHT
 * transitions - `BusStop@80,15 | BusStop@80,18 | BusStop@80,16 | BusStop@80,17 | Forest@40,65 |
 * Forest@41,65 | Forest@42,65 | FarmCave@34,5` - and the four that survived the slice were all in
 * the unreachable east strip, so `Forest` and `FarmCave` were never even proposed while the run
 * spent thirteen rejected moves on the same four tiles. The whole published list is therefore
 * considered, bounded well above any ordinary map's connectivity.
 */
const SHARED_WORLD_HOP_CANDIDATE_LIMIT = 16;

/**
 * The pause between two refused candidates of the same location.
 *
 * MEASURED, AND DELIBERATELY HONEST ABOUT WHAT IT IS FOR: the client log shows thirteen rejected
 * `move_to_tile` requests inside about 1.3 seconds, and the two entries that follow them are
 * `ai_player_control_pipe_reader_ended` and then `Disconnected: ClosedGame` - which is the gate's
 * own teardown of the two SMAPI children after the runner reported its non-zero result, NOT the
 * flood closing the client. So this pause is load mitigation, not a fix for a proven cause: each
 * rejected move is real work on the game thread (the same log shows a dozen bridge stages per
 * request), and pacing them keeps the flood from competing with the world it is walking through.
 */
const SHARED_WORLD_REJECTED_CANDIDATE_PAUSE_MS = 250;

/**
 * How many approach moves one transition may cost, not counting tiles the map cannot contain.
 *
 * A `no_native_path` refusal is the product saying the tile does not exist for it to path to - not
 * that the transition was attempted - so it does not spend this budget. Measured live: the Farm's
 * east gate burned this budget on `x=81`, a column the 80-wide map cannot have.
 */
const SHARED_WORLD_APPROACH_BUDGET = 4;

/**
 * The transitions are published at the MAP's edge, so the actor is not required to stand on one.
 *
 * A `location.warps` entry legitimately names an OFF-MAP edge tile - the Farm is 80x65 (measured
 * live in this project as `location=Farm map=80x65`) and its east gate is published at `x=80`,
 * where no tile is walkable - and the game never asks a player to stand there either: the warp
 * fires from the tile BESIDE it. The product's own range rule is Chebyshev-1
 * (`farmhandexecutioncontroller.movementactions.cs:320` gates travel on
 * `Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, player)`, characterised as Chebyshev-1 at
 * `farmhandexecutioncontroller.shopactions.cs:31`), so being in range is what the drive needs.
 * The range refusals themselves are used as a second signal: see `takeTransition`.
 */
const SHARED_WORLD_TRANSITION_RANGE_REASONS = ["warp_out_of_range", "door_out_of_range"];

/**
 * The blocked reasons that mean "not reachable in ONE call", which a hop answers.
 *
 * `destination_access_indeterminate` is what the graph gives from a place whose connectivity
 * it cannot derive (a farmhand Cabin interior, `acceptednavigationexecution.cs:129`).
 * `destination_unreachable` is what the route search gives when its BFS over the LOADED
 * ordinary-warp topology finds no path (`navigationrouteplanner.cs:207`) - and because a hop
 * is one map, a far destination is EXPECTED to answer exactly this. Measured live: from the
 * Farm, one call to the Saloon is four maps away and the product answered
 * `blocked / destination_unreachable`. Any other refusal is a fact about the destination
 * itself and stops the walk by name rather than being walked around.
 */
const SHARED_WORLD_HOP_REQUIRED_REASONS = ["destination_access_indeterminate", "destination_unreachable"];

/** How often the actionability wait re-reads the actor while a hold lasts. */
const SHARED_WORLD_ACTIONABLE_POLL_MS = 100;

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
export async function runTalkToNpcSmoke(client, receipts, config, { terminalTimeoutMs = 5_000, stepTimeoutMs = SHARED_WORLD_STEP_TIMEOUT_MS } = {}) {
  const trace = [];
  const topology = classifyTopology(config);
  try {
    const opening = await observeTopologySnapshot(client, topology);
    let snapshot = await waitForActionable(client, opening, 30_000).catch(() =>
      observeTopologySnapshot(client, topology, { actionable: true }),
    );
    assertRequiredCapabilities(
      snapshot,
      topology === "shared_world_farmhand" ? [...REQUIRED_CAPABILITIES, ...SHARED_WORLD_WALK_CAPABILITIES] : REQUIRED_CAPABILITIES,
    );
    // The actor's location is the CLIENT's own Given. In the shared world the Farmhand joins in its
    // own Cabin interior, and no shipped villager dialogue table has a key reachable from there - so
    // the run must first get the actor to where the content is. TWO ROUTES, in this order:
    //   * the warp item the Mod publishes (measured: the only route that leaves this Farm at all,
    //     because its exits sit on the map's impassable outer ring and the graph cannot route);
    //   * the walk, when the world advertises no usable totem - the honest second form, and the one
    //     the native-local lane's own worlds exercise.
    if (topology === "shared_world_farmhand") {
      const context = {
        phase: "start",
        attempt: 0,
        location: snapshot.location ?? null,
        tile: snapshot.tile ?? null,
        lastHop: "none",
      };
      const warpRoute = chooseWarpItemRoute(snapshot);
      trace.push({
        step: "route",
        route: warpRoute === null ? "walk" : "warp_item",
        from: snapshot.location ?? null,
        warp_targets: describeWarpItemTargets(snapshot),
      });
      if (warpRoute !== null) {
        if (!snapshot.capabilities.includes(SHARED_WORLD_WARP_ITEM_ACTION))
          throw new Error(
            `talk_to_npc_shared_world_warp_item_capability_missing:${SHARED_WORLD_WARP_ITEM_ACTION}:destination=${warpRoute.destination}`,
          );
        try {
          snapshot = await arriveByWarpItem(client, receipts, trace, { stepTimeoutMs, terminalTimeoutMs }, context);
        } catch (error) {
          throw nameWalkFailure(context, error);
        }
      } else {
        snapshot = await walkSharedWorldActorToTalk(client, receipts, trace, {
          navigationTimeoutMs: SHARED_WORLD_NAVIGATION_TIMEOUT_MS,
          stepTimeoutMs,
          navigationAttempts: SHARED_WORLD_NAVIGATION_ATTEMPTS,
        });
      }
    }
    const actorLocation = snapshot.location ?? null;
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
    const afterUnknown = await observeTopologySnapshot(client, topology, { actionable: true });
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

    // The recorded evidence rides on its own observation step, so tools/record-stardew-live-receipts.mjs can
    // extract the Mod's terminal field set from this run's artifact the way it does for clear_fish_pond.
    trace.push({ step: "observed", target: target.targetId, npc: target.npcName, evidence });

    // The world change, re-read after the terminal: the native dialog is really up, so the
    // Mod's own actionability projection says the actor is no longer free.
    const after = await observeTopologySnapshot(client, topology);
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
    // The refusal must be the ADMISSION's hold, not one chosen literal code: the naming wave made the code say
    // what holds the actor (`actor_held_by_modal` here), and an anonymous `player_not_actionable` covers only
    // the case where nothing more specific applies. An unrelated refusal still fails the run.
    if (!isAdmissionHold(repeatTerminal.reasonCode))
      throw new Error(`talk_to_npc_repeat_not_refused:${repeatTerminal.reasonCode}`);

    const final = await observeTopologySnapshot(client, topology);
    if (final.actionable !== false) throw new Error(`talk_to_npc_repeat_moved_world:${final.actionable}`);

    return {
      state: "passed",
      topology,
      reasonCode: "talk_to_npc_talked",
      actorLocation,
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
      topology,
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

/**
 * Walk the attached Farmhand to the villager the Host fixture placed, using ONLY the
 * product's own published locomotion.
 *
 * WHY A WALK IS PART OF THIS RUN
 * ------------------------------
 * A shared world's Farmhand joins in its own Cabin interior, and the native talk branch
 * builds its dialogue keys from `Game1.currentLocation.name.Value` (`NPC.cs:3938-3948`).
 * Decoding all 52 shipped villager dialogue tables shows NO table carries a key reachable
 * from the Cabin, the FarmHouse, the Farm, the Cellar or the Greenhouse, while the Saloon
 * carries plain location keys for Gus, Lewis, Marnie and Pam. Writing the bound actor's
 * saved location from the Host does not move the joined Farmhand (the join's own
 * `NetWorldState.ResetFarmhandState` returns it to its Cabin bed), so the approach is the
 * CLIENT's job - exactly as it is for a real companion - and the runner owns it here.
 *
 * HOW THE WALK CHOOSES A ROUTE (no coordinate and no map name is invented)
 * -----------------------------------------------------------------------
 *  1. `find_destination` - the product's own read-only destination search - is asked for
 *     the declared location, and whatever selector it returns (a `label` or an opaque
 *     `dr1_` ref) is handed straight to `navigate_to_destination`. That is the product's
 *     multi-hop cross-map navigation; how it crosses Town is the Mod's business.
 *  2. The hop itself is ONE MAP: the current location's published transitions (`warps` plus
 *     the `doorTargets` that share their fields) are read FRESH from the snapshot, the declared
 *     location wins if it is next door, and otherwise the first transition leading somewhere the
 *     walk has not already stood is driven with `enter_exit` then `travel` on its source tile.
 *     The landing location is the truth about whether the hop worked. The product's destination
 *     search is asked about each candidate and recorded, but it does not GATE the hop: measured
 *     live, it cannot name `Farm` at all while the Farm transition drives perfectly.
 *  3. When the declared location cannot be named at all, there is nothing to navigate TO, so the
 *     walk stops by name rather than guessing.
 *  3. Once in the Saloon the actor still has to be beside the villager: the villager's
 *     own published tile (`npcRelationshipTargets`, else `villagerWhereabouts`) is read
 *     from the snapshot and the actor walks onto a Chebyshev-1 neighbour of it.
 *
 * Every way the walk can fail is NAMED, and each one reports the location actually
 * reached and the transitions actually seen - a geographic blocker is a finding, whereas
 * a native `talk_to_npc_not_handled` reached from the wrong map looks like a product
 * defect.
 */
async function walkSharedWorldActorToTalk(client, receipts, trace, { navigationTimeoutMs, stepTimeoutMs, navigationAttempts }) {
  // One guard over the WHOLE walk, so every await inside it - the search, the navigation dispatch,
  // the drive, the approach, the adjacent move - is covered by construction. The context is
  // mutable and updated as the walk progresses, so whatever goes wrong can be reported with where
  // the walk had got to.
  const context = { phase: "start", attempt: 0, location: null, tile: null, lastHop: "none" };
  try {
    const arrived = await walkSharedWorldActorToDestination(client, receipts, trace, { navigationTimeoutMs, stepTimeoutMs, navigationAttempts }, context);
    context.phase = "stand_adjacent";
    return await standAdjacentToVillager(client, receipts, trace, arrived, { stepTimeoutMs });
  } catch (error) {
    throw nameWalkFailure(context, error);
  }
}

/**
 * The warp-item route: read the totem the Mod PUBLISHES, activate it, and confirm the arrival
 * it produced.
 *
 * The destination is never written here. The fixture arms one totem whose destination is a
 * location with a location-keyed villager line, and the snapshot's own `warpItemTargets`
 * carries that destination, its slot and its item id - the same projection the action executes
 * against, so the runner and the product cannot disagree about where the actor is going.
 *
 * Returns the fresh observation of the arrival; every stop is named, including the totem's own
 * refusal codes (`warp_item_not_usable_here` and friends, which say which context fact was
 * false) and the arrival check itself.
 */
async function arriveByWarpItem(client, receipts, trace, { stepTimeoutMs, terminalTimeoutMs }, context) {
  const before = await observeActionableActor(client, stepTimeoutMs);
  if (before.snapshot === null)
    throw new Error(
      `talk_to_npc_shared_world_walk_actor_not_actionable:${before.held.location}` +
        `:tile=${formatTile(before.held.tile)}:phase=warp_item:polls=${before.polls}:window_ms=${stepTimeoutMs}`,
    );
  const advertised = chooseWarpItemRoute(before.snapshot);
  if (advertised === null)
    throw new Error(
      `talk_to_npc_shared_world_warp_item_not_advertised:${before.snapshot.location ?? "unknown"}` +
        `:targets=${describeWarpItemTargets(before.snapshot)}`,
    );

  context.phase = "warp_item";
  const requestId = `native_local_talk_to_npc_warp_item_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: SHARED_WORLD_WARP_ITEM_ACTION,
    args: { slot: advertised.slot, expectedQualifiedItemId: advertised.qualifiedItemId },
    snapshot: before.snapshot,
    timeoutMs: stepTimeoutMs,
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  trace.push({
    step: "use_warp_item",
    slot: advertised.slot,
    item: advertised.qualifiedItemId,
    destination: advertised.destination,
    from: before.snapshot.location ?? null,
    receipt: summarizeReceipt(terminal),
    evidence: receiptEvidenceDetail(terminal),
  });
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "warp_item_arrived")
    throw new Error(
      `talk_to_npc_shared_world_warp_item_failed:${terminal.state}/${terminal.reasonCode}` +
        `:slot=${advertised.slot}:item=${advertised.qualifiedItemId}:destination=${advertised.destination}` +
        `:from=${before.snapshot.location ?? "unknown"}`,
    );

  // The world change, re-read after the terminal: the actor is IN the destination the totem
  // names. A same-frame read is not the arrival, so the observation is fresh and actionable.
  context.phase = "warp_item_arrival";
  const arrived = await observeActionableActor(client, stepTimeoutMs);
  if (arrived.snapshot === null)
    throw new Error(
      `talk_to_npc_shared_world_walk_actor_not_actionable:${arrived.held.location}` +
        `:tile=${formatTile(arrived.held.tile)}:phase=warp_item_arrival:polls=${arrived.polls}:window_ms=${stepTimeoutMs}`,
    );
  if (arrived.snapshot.location !== advertised.destination)
    throw new Error(
      `talk_to_npc_shared_world_warp_item_location_mismatch:${arrived.snapshot.location ?? "unknown"}` +
        `:expected=${advertised.destination}:tile=${formatTile(arrived.snapshot.tile)}`,
    );
  // The arrival is the destination the totem named, and the actor still has to be BESIDE the
  // villager: the totem lands on the location's own entry tile, which is wherever the game chose.
  context.phase = "stand_adjacent";
  return await standAdjacentToVillager(client, receipts, trace, arrived.snapshot, { stepTimeoutMs });
}

/**
 * The totem the Mod advertises for a destination the actor is NOT already standing in.
 *
 * The `destination !== location` filter is the action's own admission rule
 * (`farmhandexecutioncontroller.itemtileactions.cs:336-342` refuses a totem whose destination
 * is the current location), so choosing one that fails it would make the run fail for a
 * reason the request cannot fix.
 */
function chooseWarpItemRoute(snapshot) {
  const targets = Array.isArray(snapshot.warpItemTargets) ? snapshot.warpItemTargets : [];
  const usable = targets.filter(
    (entry) =>
      Number.isInteger(entry?.slot) &&
      entry.slot >= 0 &&
      typeof entry?.qualifiedItemId === "string" &&
      entry.qualifiedItemId.length > 0 &&
      typeof entry?.destination === "string" &&
      entry.destination.length > 0 &&
      entry.destination !== snapshot.location,
  );
  return usable.length === 0 ? null : usable[0];
}

function describeWarpItemTargets(snapshot) {
  const targets = Array.isArray(snapshot.warpItemTargets) ? snapshot.warpItemTargets : [];
  if (targets.length === 0) return "none";
  return targets.map((entry) => `${entry?.qualifiedItemId ?? "?"}@slot${entry?.slot ?? "?"}->${entry?.destination ?? "?"}`).join("|");
}

/**
 * Turn ANY throw from the walk into a failure that names the walk's own progress.
 *
 * WHY THIS EXISTS: a live run's result carried only the transport's error
 * (`bridge_disconnected:pipe_closed`) with a trace stopping mid-walk, so the whole run read as
 * "the bridge died" rather than "the walk tried X and failed because Y". In this repository a
 * runner that reports nothing is the worst outcome there is - it makes a runner fault look like a
 * product fault. The walk's own named failures pass through unchanged; anything else is wrapped
 * with the phase, the attempt, where the actor was, the last transition it tried, and the
 * original message, so the cause survives.
 */
function nameWalkFailure(context, error) {
  const message = String(error instanceof Error ? error.message : error);
  if (message.startsWith("talk_to_npc_shared_world_")) return error instanceof Error ? error : new Error(message);
  const route = String(context.phase).startsWith("warp_item") ? "warp_item" : "walk";
  return new Error(
    `talk_to_npc_shared_world_${route}_error:${context.phase}:attempt=${context.attempt}` +
      `:location=${context.location ?? "unknown"}:tile=${formatTile(context.tile)}` +
      `:last_hop=${context.lastHop}:cause=${message.slice(0, 160)}`,
  );
}

function formatTile(tile) {
  return Number.isInteger(tile?.x) && Number.isInteger(tile?.y) ? `${tile.x},${tile.y}` : "unknown";
}

/**
 * Reach the declared location ONE MAP AT A TIME, by the product's own navigation and search.
 *
 * WHY ONE HOP AT A TIME
 * ---------------------
 * The product's cross-map navigation is hop-by-hop by design: each hop is planned from a FRESH
 * world view, with no prebuilt route index. So a far destination is not something one call is
 * expected to solve - measured live, one call from the Farm to the Saloon (four maps away)
 * answered `blocked / destination_unreachable`, and from inside the Cabin it answered
 * `blocked / destination_access_indeterminate`. Both mean the same thing to the walk: not in
 * ONE call. The hop is therefore the unit of progress here, the destination is re-searched from
 * every new map, and the walk stops by name when it can no longer make progress.
 *
 * The retry is BOUNDED and every stop is named. The destination is re-searched on every attempt
 * instead of carrying the first answer across a location change: a `dr1_` handle is bound to the
 * destination set's generation and a five-minute window, so re-resolving from the map the actor
 * is actually standing on is the cheaper thing to reason about, and the trace records which
 * search answered which attempt, with the full answer.
 */
async function walkSharedWorldActorToDestination(client, receipts, trace, { navigationTimeoutMs, stepTimeoutMs, navigationAttempts }, context) {
  let current = await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs: stepTimeoutMs });
  if (current.location === SHARED_WORLD_DECLARED_LOCATION) return current;
  // Where the walk has already stood. A hop back into a map it left is how a bounded walk oscillates
  // instead of progressing, so a visited location is not a FORWARD hop target - but it may be
  // retreated to, once (see `chooseProductHop`): the point of `visited` is to stop oscillation, not
  // to forbid an honest retreat out of a dead end.
  const visited = new Set([current.location]);
  // Transitions this walk has already driven and been refused. A refusal is the product's verdict
  // about that transition where the actor stood, so re-driving it on the way back through costs a
  // flood of rejected requests for nothing - measured: thirteen refusals in ~1.3 s when the walk
  // re-walked the same east strip.
  const refusedTransitions = new Set();
  let cameFrom = null;
  let retreated = false;

  for (let attempt = 1; attempt <= navigationAttempts; attempt++) {
    context.attempt = attempt;
    context.location = current.location ?? null;
    context.tile = current.tile ?? null;
    if (current.location === SHARED_WORLD_DECLARED_LOCATION) {
      context.phase = "arrive_observe";
      return await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs: stepTimeoutMs });
    }

    context.phase = "search";
    const found = normalizeNavigationRead(
      await client.navigationRead({ operation: "find_destination", args: { query: SHARED_WORLD_DECLARED_LOCATION } }),
    );
    const selector = destinationSelectorFrom(found);
    trace.push({
      step: "find_destination",
      attempt,
      from: current.location ?? null,
      query: SHARED_WORLD_DECLARED_LOCATION,
      status: found?.status ?? null,
      reason: found?.reason ?? null,
      unlockState: found?.unlockState ?? null,
      destination: selector,
      labels: navigationReadLabels(found),
      candidates: navigationSearchCandidates(found),
    });

    if (selector === null) {
      // The product's own search does not name this location, so there is no selector to navigate
      // with - and no hop either: a hop into it would need the same name to resolve. Failing here
      // is the honest outcome, and the status/reason say which way the search declined.
      throw new Error(
        `talk_to_npc_shared_world_walk_destination_not_nameable:${current.location ?? "unknown"}` +
          `:tile=${current.tile?.x},${current.tile?.y}:query=${SHARED_WORLD_DECLARED_LOCATION}` +
          `:status=${found?.status ?? "unknown"}:reason=${found?.reason ?? "unknown"}`,
      );
    }

    context.phase = "navigate";
    // Fly the navigation from a FRESH ACTIONABLE observation, not from the snapshot the last hop
    // arrived on. Measured live: the actor warped into the Farm Cave with `can_move=False` (the fade)
    // and the product answered the next navigation `rejected / destination_locked`, which is exactly
    // `!PlayerActionable` (`navigationoutcomedecider.cs:79-81`).
    //
    // A hold that survives the whole window is NOT answered with a hop: every action needs a free
    // actor (`move_to_tile`, `enter_exit` and `travel` all admit on it), so a hop could not leave the
    // map either. What the walk owes the reader is the place and the duration, which is what this
    // failure names - and it replaces what used to look like a transport or bridge fault.
    const free = await observeActionableActor(client, stepTimeoutMs);
    if (free.snapshot === null)
      throw new Error(
        `talk_to_npc_shared_world_walk_actor_not_actionable:${free.held.location}` +
          `:tile=${formatTile(free.held.tile)}:attempt=${attempt}:polls=${free.polls}:window_ms=${stepTimeoutMs}`,
      );
    current = free.snapshot;
    const requestId = `native_local_talk_to_npc_navigate_${attempt}_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "navigate_to_destination",
      args: { destination: selector },
      snapshot: current,
      timeoutMs: navigationTimeoutMs,
    });
    const terminal = await waitForTerminal(receipts, accepted, navigationTimeoutMs);
    trace.push({
      step: "navigate_to_destination",
      attempt,
      from: current.location ?? null,
      destination: selector,
      receipt: summarizeReceipt(terminal),
    });

    if (terminal.state === "succeeded" && terminal.reasonCode === "navigation_completed") {
      context.phase = "navigate_arrival_observe";
      const at = await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs: stepTimeoutMs });
      if (at.location !== SHARED_WORLD_DECLARED_LOCATION)
        throw new Error(
          `talk_to_npc_shared_world_walk_navigation_location_mismatch:${at.location ?? "unknown"}` +
            `:expected=${SHARED_WORLD_DECLARED_LOCATION}:tile=${at.tile?.x},${at.tile?.y}`,
        );
      return at;
    }

    if (terminal.state !== "blocked" || !SHARED_WORLD_HOP_REQUIRED_REASONS.includes(terminal.reasonCode)) {
      const reached = await observeTopologySnapshot(client, "shared_world_farmhand", { timeoutMs: stepTimeoutMs });
      throw new Error(
        `talk_to_npc_shared_world_walk_navigation_failed:${terminal.state}/${terminal.reasonCode}` +
          `:destination=${describeSelector(selector)}:reached=${reached.location ?? "unknown"}:tile=${reached.tile?.x},${reached.tile?.y}`,
      );
    }

    // Not reachable in one call. Take exactly one map's worth of progress, chosen from the
    // product's own data, and ask again from there.
    context.phase = "hop_choose";
    const decision = await chooseProductHop(client, current, visited, trace, {
      cameFrom,
      retreatAllowed: !retreated,
      refusedTransitions,
    });
    if (decision.ordered.length === 0)
      throw new Error(
        `talk_to_npc_shared_world_walk_no_hop:${current.location ?? "unknown"}` +
          `:tile=${current.tile?.x},${current.tile?.y}:navigation=${terminal.state}/${terminal.reasonCode}` +
          `:retreated=${retreated}:candidates=${decision.candidates}`,
      );
    // This location may publish several ways on - the Farm's east gate is a four-tile strip, and
    // the native pathfinder refused the first one. A refusal is the product's verdict about THAT
    // tile, not about the map, so the walk tries the next candidate before it gives up.
    const tried = [];
    let arrived = null;
    for (const candidate of decision.ordered) {
      context.phase = "hop_drive";
      context.lastHop = `${candidate.entry.targetLocation}@${candidate.entry.sourceX},${candidate.entry.sourceY}`;
      const hop = await takeTransition(client, receipts, trace, candidate.entry, stepTimeoutMs, context);
      if (hop.arrived !== null) {
        arrived = hop.arrived;
        break;
      }
      tried.push({ target: candidate.entry.targetLocation, source: { x: candidate.entry.sourceX, y: candidate.entry.sourceY }, refusals: hop.refusals });
      refusedTransitions.add(`${candidate.entry.targetLocation}@${candidate.entry.sourceX},${candidate.entry.sourceY}`);
      // Pace the refusals: see SHARED_WORLD_REJECTED_CANDIDATE_PAUSE_MS.
      await delay(SHARED_WORLD_REJECTED_CANDIDATE_PAUSE_MS);
    }
    if (arrived === null) {
      // Every way out of this location was refused. The reason code names the location and lists
      // each refused candidate with its own state and reason code and its source tile; the
      // `hop_candidates` step just above carries the catalogue the choice came from, and the
      // `hop_refused` step carries this list unbounded.
      trace.push({ step: "hop_refused", from: current.location ?? null, tried });
      throw new Error(
        `talk_to_npc_shared_world_walk_transition_refused:${current.location ?? "unknown"}` +
          `:tile=${current.tile?.x},${current.tile?.y}:tried=${tried.length}` +
          `:refusals=${describeTriedHops(tried)}`,
      );
    }
    visited.add(current.location);
    cameFrom = current.location;
    if (decision.retreat) retreated = true;
    current = arrived;
  }

  throw new Error(
    `talk_to_npc_shared_world_walk_navigation_attempts_exhausted:${current.location ?? "unknown"}` +
      `:attempts=${navigationAttempts}:transitions=${describeTransitions(current)}`,
  );
}

/**
 * The next hop: ONE MAP of progress, driven with a transition the current location publishes.
 *
 * WHERE THE DECISION COMES FROM - and where it deliberately does not
 * ----------------------------------------------------------------
 * The CANDIDATES are the transitions the current location publishes (`warps` plus the
 * `doorTargets` that share their fields), read FRESH from the snapshot just observed, in the
 * order the map itself declares them. ALL of them are returned, ordered: the declared location's
 * neighbour first when one is identifiable, then the rest, minus anywhere the walk has already
 * stood. A location commonly publishes several ways on - the Farm's east gate is a four-tile
 * strip - and a refusal is the product's verdict about ONE tile, so the caller tries them in
 * turn rather than treating the first refusal as the end of the map.
 *
 * The product's destination SEARCH is asked about each candidate and its answer is recorded in
 * the trace, but it is NOT a gate. Measured live: the search cannot name `Farm` at all
 * (`destination_not_found`) while the Farm transition drives perfectly - it is the destination
 * set that does not cover that map's name, not the transition that is unusable. Gating on the
 * search answer therefore rejected a hop the product had just proven. What the search does
 * answer - the declared destination, every attempt - is what still decides the goal.
 *
 * `visited` is what stops oscillation: a transition back into a map the walk has already stood
 * in is never offered.
 *
 * WHAT THE PRODUCT STILL DOES NOT GIVE US: no route hint, so nothing here ranks two hops by
 * which is nearer the goal. A wrong-but-usable first hop is possible, which is why the hop
 * budget walks around a detour and why a walk that cannot progress stops with every candidate
 * and its search state named.
 */
async function chooseProductHop(client, snapshot, visited, trace, { cameFrom = null, retreatAllowed = false, refusedTransitions = new Set() } = {}) {
  const transitions = locationTransitions(snapshot)
    .slice(0, SHARED_WORLD_HOP_CANDIDATE_LIMIT)
    .filter((entry) => !refusedTransitions.has(`${entry.targetLocation}@${entry.sourceX},${entry.sourceY}`));
  const probes = [];
  for (const entry of transitions) probes.push({ entry, answer: await probeHopCandidate(client, entry) });
  const goal = probes.filter(({ entry }) => entry.targetLocation === SHARED_WORLD_DECLARED_LOCATION && !visited.has(entry.targetLocation));
  const forward = probes.filter(({ entry }) => !visited.has(entry.targetLocation) && entry.targetLocation !== SHARED_WORLD_DECLARED_LOCATION);
  // Prefer a target the product's own search can NAME. Reported per candidate in the trace, and it
  // is a preference and not a gate: measured live, the search answered `not_found` for a neighbour
  // whose transition drove perfectly, so an unnamed neighbour must still be taken when it is all
  // there is. Within each group the map's own published order is kept.
  const named = forward.filter(({ answer }) => answer.selector !== null);
  const unnamed = forward.filter(({ answer }) => answer.selector === null);
  // THE HONEST RETREAT: with nowhere forward left, the way back is a legitimate hop - a dead end
  // (the Farm Cave was one) must be leavable - but only once, so a bounded walk cannot oscillate.
  const retreat =
    goal.length === 0 && forward.length === 0 && retreatAllowed && cameFrom !== null
      ? probes.filter(({ entry }) => entry.targetLocation === cameFrom).slice(0, 1)
      : [];
  trace.push({
    step: "hop_candidates",
    from: snapshot.location ?? null,
    cameFrom,
    retreatOffered: retreat.length > 0,
    candidates: probes.map(({ entry, answer }) => ({
      targetLocation: entry.targetLocation,
      source: { x: entry.sourceX, y: entry.sourceY },
      status: answer.status,
      reason: answer.reason,
      unlockState: answer.unlockState,
      destination: answer.selector,
      labels: answer.labels,
      candidateStates: answer.candidateStates,
      // What the product's own search said about this target: information, not a gate.
      searchNamed: answer.selector !== null,
      visited: visited.has(entry.targetLocation),
      recent: entry.targetLocation === cameFrom,
    })),
  });
  const ordered = [...goal, ...named, ...unnamed, ...retreat];
  return { ordered, retreat: retreat.length > 0, candidates: describeHopCandidates(probes) };
}

/** What the product's own search says about one published transition. */
async function probeHopCandidate(client, entry) {
  const answer = normalizeNavigationRead(
    await client.navigationRead({ operation: "find_destination", args: { query: entry.targetLocation } }),
  );
  return {
    status: answer?.status ?? null,
    reason: answer?.reason ?? null,
    // Recorded for the artifact but deliberately NOT used as a filter: in this generation the
    // producer hardcodes it (`destinationsearch.cs:159-163` builds every candidate with
    // "unknown") and the wire types it as that one literal (`protocol.ts:849`), so it carries no
    // signal yet. The status does, and the choice rests on that.
    unlockState: answer?.unlockState ?? null,
    labels: navigationReadLabels(answer),
    candidateStates: navigationSearchCandidates(answer),
    selector: destinationSelectorFrom(answer),
  };
}

/** Every candidate the hop decision saw, with the state that decided it. */
function describeHopCandidates(probes) {
  if (probes.length === 0) return "none";
  return probes
    .map(({ entry, answer }) => `${entry.targetLocation}@${entry.sourceX},${entry.sourceY}=${answer.status ?? "?"}/${answer.unlockState ?? "?"}`)
    .join("|");
}

/**
 * The transitions this location publishes, keyed by source tile.
 *
 * `warps` and `doorTargets` carry the same five fields and describe the same thing - a
 * tile that leads onward - so a walk that read only one of them could miss the door it
 * needs. Deduplicating on the source tile keeps a tile that appears in both lists from
 * being walked twice.
 */
function locationTransitions(snapshot) {
  const bySource = new Map();
  for (const entry of [...(snapshot.warps ?? []), ...(snapshot.doorTargets ?? [])]) {
    if (typeof entry?.targetLocation !== "string" || entry.targetLocation.length === 0) continue;
    if (!Number.isInteger(entry.sourceX) || !Number.isInteger(entry.sourceY)) continue;
    bySource.set(`${entry.sourceX},${entry.sourceY}`, entry);
  }
  return [...bySource.values()];
}

/**
 * Get the actor within the product's own range of a transition's source tile.
 *
 * The tile itself is tried FIRST, because that is the tile the drive names, but an edge warp's own
 * tile is not walkable, so the walk falls back to the tiles AROUND it.
 *
 * THE NEIGHBOURHOOD IS PRUNED, and that is a measured correction. The Farm is 80x65 (measured in
 * this project's own live logs as `location=Farm map=80x65`) and its east gate is published at
 * x=80, so a plain Chebyshev-1 ring around that warp contains x=81 - a tile the map cannot have.
 * A live run asked the product to path to exactly that tile
 * (`request=native_local_talk_to_npc_move_..._81_16` -> `reason=no_native_path`) and spent
 * approach budget on it. The snapshot publishes no map extent (checked: no width/height field
 * anywhere on `BridgeSnapshot`), so this is a PRUNING rule rather than a bounds check: for each
 * axis, if the warp lies beyond the actor, tiles further beyond the warp are not proposed. The
 * actor is inside the map by construction, so the side it stands on always exists, and the warp's
 * own tile is never pruned - it is neither beyond nor before itself.
 *
 * The snapshot publishes no general passability fact either, so a remaining candidate's
 * standability is never assumed: each move is a real `move_to_tile` and the product's own verdict
 * decides. A tile the map cannot contain is refused for `no_native_path`, and that refusal is not
 * charged to the budget (see the loop): it is not an attempt at the transition, it is a tile the
 * world does not have.
 */
async function approachTransitionSource(client, receipts, trace, source, timeoutMs, refusals, { force = false } = {}) {
  const here = await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs });
  if (!force && inTransitionRange(here.tile, source)) return here;
  let spent = 0;
  for (const candidate of approachCandidates(source, here.tile)) {
    if (spent >= SHARED_WORLD_APPROACH_BUDGET) break;
    const moved = await moveActorOntoTile(client, receipts, trace, candidate, timeoutMs);
    if (moved.arrived === null) {
      refusals.push({ ...moved.refusal, beyondMap: moved.refusal.reasonCode === "no_native_path" });
      if (moved.refusal.reasonCode !== "no_native_path") spent++;
      continue;
    }
    if (inTransitionRange(moved.arrived.tile, source)) return moved.arrived;
  }
  return null;
}

/**
 * The tiles to try for a transition, in order: the warp's own tile, then the tiles around it that
 * the map can plausibly contain, nearest the actor first.
 *
 * `candidateStandingTiles` supplies the ring (Chebyshev-1, orthogonals before diagonals, the warp's
 * own tile first) and `canContain` prunes the side of the warp the actor is not on. Only
 * non-negative tiles are kept: a map never has a negative coordinate.
 */
function approachCandidates(source, actorTile) {
  const beyondWarp = (tile) => {
    if (tile.x === source.x && tile.y === source.y) return false;
    if (source.x > actorTile.x && tile.x > source.x) return true;
    if (source.x < actorTile.x && tile.x < source.x) return true;
    if (source.y > actorTile.y && tile.y > source.y) return true;
    if (source.y < actorTile.y && tile.y < source.y) return true;
    return false;
  };
  const distanceToActor = (tile) => Math.max(Math.abs(tile.x - actorTile.x), Math.abs(tile.y - actorTile.y));
  return candidateStandingTiles(source)
    .filter((tile) => tile.x >= 0 && tile.y >= 0 && !beyondWarp(tile))
    .sort((left, right) => {
      const leftIsSource = left.x === source.x && left.y === source.y;
      const rightIsSource = right.x === source.x && right.y === source.y;
      if (leftIsSource !== rightIsSource) return leftIsSource ? -1 : 1;
      return distanceToActor(left) - distanceToActor(right) || rank(left, source) - rank(right, source);
    });
}

/**
 * Observe UNTIL the actor is genuinely free to act, or report the hold with where it was.
 *
 * MEASURED, AND THE REASON THIS POLLS: the previous version sampled once - `observeTopologySnapshot`
 * rethrows `native_snapshot_not_actionable` immediately - so a live run that warped into the Farm
 * Cave reported `actor_not_actionable:FarmCave:tile=8,11:cause=native_snapshot_not_actionable` from a
 * SINGLE observation taken at the warp instant, and the topology was torn down about a second later.
 * The product's own field is `player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp`
 * (`game1navigationworldsource.cs:51`), and `CanMove` is false for the length of a warp FADE, which
 * is frames, not seconds. What made the old failure instant was the sampling, not the hold; a hold
 * that really never clears now ends at this deadline and says so.
 */
async function observeActionableActor(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let held = null;
  let polls = 0;
  while (Date.now() < deadline) {
    held = await observeTopologySnapshot(client, "shared_world_farmhand", { timeoutMs: Math.max(1, deadline - Date.now()) });
    polls++;
    if (held.actionable === true && held.activeExecution == null) return { snapshot: held, held: null, polls };
    await delay(SHARED_WORLD_ACTIONABLE_POLL_MS);
  }
  return { snapshot: null, held: { location: held?.location ?? "unknown", tile: held?.tile ?? null }, polls };
}

/** The product's own refusal/terminal detail, verbatim and unsummarised. */
function receiptEvidenceDetail(receipt) {
  return typeof receipt?.evidence?.detail === "string" ? receipt.evidence.detail : null;
}

/**
 * The product's own transition range: Chebyshev-1 of the warp's source tile.
 */
function inTransitionRange(tile, source) {
  return adjacentTile(tile, source);
}

/**
 * Drive one transition, from within the product's range of its source tile.
 *
 * Returns the arrival snapshot, or the refusals that stopped it - one entry per native form tried,
 * each carrying THAT call's own reason code and the source tile it was aimed at. A refusal here is
 * a different finding from a location that publishes no transition at all, so it is reported
 * rather than collapsed.
 *
 * The transition is always driven with the WARP'S OWN coordinates, never with the tile the actor
 * happens to be standing on: `travel` resolves the warp by source tile
 * (`farmhandexecutioncontroller.movementactions.cs:317`), so the approach exists only to satisfy
 * its range check. A range refusal is the product saying "not from here", so the actor is walked
 * onto the source tile and the SAME form is tried once more before it counts as a refusal for this
 * candidate - and any other refusal counts immediately.
 */
async function takeTransition(client, receipts, trace, transition, timeoutMs, context) {
  const source = { x: transition.sourceX, y: transition.sourceY };
  const refusals = [];
  let here = await approachTransitionSource(client, receipts, trace, source, timeoutMs, refusals);
  if (here === null) return { arrived: null, refusals };
  // Report the tile the drive is dispatched from, not the one the attempt began on: if anything
  // throws from here on, this is the position that makes the failure readable.
  context.tile = here.tile;

  for (const action of ["enter_exit", "travel"]) {
    // Re-read before each form: the previous form may have moved the actor (its range retry does),
    // and a request bound to a snapshot the world has already left is not the request the
    // observation justified.
    let snapshot = await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs });
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestId = `native_local_talk_to_npc_${action}_${attempt}_${Date.now()}`;
      const accepted = await executeFresh(client, {
        requestId,
        idempotencyKey: `${requestId}_idem`,
        action,
        args: { x: source.x, y: source.y },
        snapshot,
        timeoutMs,
      });
      const terminal = await waitForTerminal(receipts, accepted, timeoutMs);
      trace.push({ step: action, source, attempt, receipt: summarizeReceipt(terminal) });
      if (terminal.state !== "succeeded") {
        if (attempt === 0 && SHARED_WORLD_TRANSITION_RANGE_REASONS.includes(terminal.reasonCode)) {
          const closer = await approachTransitionSource(client, receipts, trace, source, timeoutMs, refusals, { force: true });
          if (closer !== null) {
            snapshot = closer;
            continue;
          }
        }
        refusals.push({ action, state: terminal.state, reasonCode: terminal.reasonCode, sourceX: source.x, sourceY: source.y });
        break;
      }
      const after = await observeTopologySnapshot(client, "shared_world_farmhand", { timeoutMs });
      if (after.location === transition.targetLocation) return { arrived: after, refusals };
      // The call succeeded and the actor is somewhere else: name where it went instead of
      // reading as a refusal.
      refusals.push({ action, state: terminal.state, reasonCode: `arrived_at_${after.location ?? "unknown"}`, sourceX: source.x, sourceY: source.y });
      break;
    }
  }
  return { arrived: null, refusals };
}

/**
 * Walk onto one exact tile in the actor's current location.
 *
 * Returns the arrival snapshot, or the refusal that stopped it carrying THAT receipt's own state
 * and reason code - the product's verdict about this tile (measured live: `failed /
 * no_native_path` for the Farm's east gate) rather than a code invented here.
 */
async function moveActorOntoTile(client, receipts, trace, tile, timeoutMs) {
  const snapshot = await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs });
  if (snapshot.tile?.x === tile.x && snapshot.tile?.y === tile.y) return { arrived: snapshot, refusal: null };
  const requestId = `native_local_talk_to_npc_move_${Date.now()}_${tile.x}_${tile.y}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: "move_to_tile",
    args: { x: tile.x, y: tile.y },
    snapshot,
    timeoutMs,
  });
  const terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  // Carry the product's OWN diagnosis of a refusal, not just its code. Measured: every refused
  // `move_to_tile` in a live run was `no_native_path`, and the Mod's refusal already names WHY
  // (`StardewBodyController.cs:130-160`): `target_standable`, `target_walkable`, `blocked_by`,
  // `target_enclosed`, `route_exists_cardinal`, `component_tiles`. Summarising the receipt threw
  // all of it away, which is why the terrain question stayed open across three rounds while the
  // answer rode on every refusal.
  trace.push({ step: "move_to_tile", tile, receipt: summarizeReceipt(terminal), evidence: receiptEvidenceDetail(terminal) });
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    return {
      arrived: null,
      refusal: { action: "move_to_tile", state: terminal.state, reasonCode: terminal.reasonCode, sourceX: tile.x, sourceY: tile.y, evidence: receiptEvidenceDetail(terminal) },
    };
  return { arrived: await observeTopologySnapshot(client, "shared_world_farmhand", { actionable: true, timeoutMs }), refusal: null };
}

/**
 * Walk the actor onto a tile Chebyshev-1 from the villager the Host fixture placed.
 *
 * The villager's tile is read from the snapshot the Mod publishes - the family target list
 * first, then the whole-world whereabouts projection - so the runner takes the placement from
 * the world rather than reproducing the fixture's own arithmetic, and it takes the PERSON from
 * there too: whichever villager the world publishes in this location IS the fixture's, because
 * the fixture refuses to arm a run with a second target in reach.
 */
async function standAdjacentToVillager(client, receipts, trace, snapshot, { stepTimeoutMs }) {
  const located = locateVillagerTile(snapshot);
  if (located === null)
    throw new Error(
      `talk_to_npc_shared_world_walk_villager_not_locatable:${snapshot.location ?? "unknown"}` +
        `:tile=${formatTile(snapshot.tile)}:published=${describePublishedVillagers(snapshot)}`,
    );
  if (adjacentTile(snapshot.tile, located.tile)) {
    trace.push({ step: "stand_adjacent", villager: located.npcName, tile: located.tile, source: located.source, actorTile: snapshot.tile });
    return snapshot;
  }
  const candidates = candidateStandingTiles(located.tile).filter(
    (tile) => tile.x >= 0 && tile.y >= 0 && (tile.x !== located.tile.x || tile.y !== located.tile.y),
  );
  for (const candidate of candidates.slice(0, SHARED_WORLD_MOVE_BUDGET)) {
    const moved = await moveActorOntoTile(client, receipts, trace, candidate, stepTimeoutMs);
    if (moved.arrived === null) continue;
    const after = moved.arrived;
    const fresh = locateVillagerTile(after) ?? located;
    if (adjacentTile(after.tile, fresh.tile)) {
      trace.push({ step: "stand_adjacent", villager: fresh.npcName, tile: fresh.tile, source: fresh.source, actorTile: after.tile });
      return after;
    }
  }
  throw new Error(
    `talk_to_npc_shared_world_walk_no_standing_tile:villager=${located.npcName}` +
      `:tile=${located.tile.x},${located.tile.y}:actor_tile=${formatTile(snapshot.tile)}`,
  );
}

/**
 * The villager's own published tile, the projection it came from, and the person it names.
 *
 * No name is written down here: the fixture arms exactly one villager and asserts no second
 * published target is in reach, so the first villager the world publishes in the current
 * location is the one under test.
 */
function locateVillagerTile(snapshot) {
  const target = (snapshot.npcRelationshipTargets ?? []).find(
    (entry) => typeof entry?.npcName === "string" && Number.isInteger(entry.x) && Number.isInteger(entry.y),
  );
  if (target !== undefined) return { tile: { x: target.x, y: target.y }, source: "npcRelationshipTargets", npcName: target.npcName };
  const whereabouts = (snapshot.villagerWhereabouts ?? []).find(
    (entry) =>
      typeof entry?.npcName === "string" &&
      entry.location === snapshot.location &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y),
  );
  if (whereabouts !== undefined)
    return { tile: { x: whereabouts.x, y: whereabouts.y }, source: "villagerWhereabouts", npcName: whereabouts.npcName };
  return null;
}

/** Every villager the snapshot publishes here, for a named failure. */
function describePublishedVillagers(snapshot) {  const near = (snapshot.npcRelationshipTargets ?? []).map((entry) => `${entry?.npcName ?? "?"}@${entry?.x},${entry?.y}`);
  const world = (snapshot.villagerWhereabouts ?? [])
    .filter((entry) => entry?.location === snapshot.location)
    .map((entry) => `${entry?.npcName ?? "?"}@${entry?.x},${entry?.y}`);
  const all = [...near, ...world];
  return all.length === 0 ? "none" : all.join("|");
}

/** The eight Chebyshev-1 tiles of a target, orthogonal neighbours before diagonals. */
function candidateStandingTiles(target) {
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push({ x: target.x + dx, y: target.y + dy });
  // Prefer the orthogonal neighbours, then the diagonals; the target's own tile is
  // excluded by the caller because a standing villager collides there.
  return tiles.sort((left, right) => rank(left, target) - rank(right, target));
}

function rank(tile, target) {
  const distance = Math.max(Math.abs(tile.x - target.x), Math.abs(tile.y - target.y));
  const orthogonal = (tile.x === target.x) !== (tile.y === target.y) ? 0 : 1;
  return distance * 10 + orthogonal;
}

/** Chebyshev adjacency, matching the Mod's own interaction radius. */
function adjacentTile(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) <= 1
  );
}

/** The Mod's navigation read answer, whichever envelope shape the client returns. */
function normalizeNavigationRead(result) {
  const payload = result?.payload ?? result;
  return payload !== null && typeof payload === "object" ? payload : null;
}

/**
 * The search's answer as an execution-contract selector, or null when it named none.
 *
 * The Mod's own wire shape is exactly `{kind,label}` or `{kind,ref}` (`BridgeProtocol.
 * IsExactNavigationDestinationSelector`), and its selector parser refuses a value that
 * carries both, so the field it did not use is dropped rather than sent as null.
 */
function destinationSelectorFrom(found) {
  const resolved = found?.status === "resolved" ? found.destination : null;
  const candidate = resolved ?? (Array.isArray(found?.candidates) ? found.candidates[0]?.destination : null);
  if (candidate?.kind === "label" && typeof candidate.label === "string" && candidate.label.length > 0)
    return { kind: "label", label: candidate.label };
  if (candidate?.kind === "ref" && typeof candidate.ref === "string" && candidate.ref.length > 0)
    return { kind: "ref", ref: candidate.ref };
  return null;
}

/** Every destination label the search answered with, for a named failure. */
function navigationReadLabels(found) {
  const labels = [];
  if (typeof found?.destination?.label === "string") labels.push(found.destination.label);
  for (const entry of found?.candidates ?? []) if (typeof entry?.label === "string") labels.push(entry.label);
  return labels;
}

/**
 * The candidates a search answered with, each with its own unlock state.
 *
 * Recorded whether or not anything is read from it: a reader of the run artifact has to be able
 * to see what the product offered before a hop was chosen from it.
 */
function navigationSearchCandidates(found) {
  return (found?.candidates ?? []).map((entry) => ({
    label: entry?.label ?? null,
    contextLabel: entry?.contextLabel ?? null,
    unlockState: entry?.unlockState ?? null,
  }));
}

function describeSelector(selector) {
  return selector.kind === "label" ? `label:${selector.label}` : `ref:${selector.ref}`;
}

/** Every native form a hop tried, with ITS OWN reason code and the tile it aimed at. */
function describeRefusals(refusals) {
  if (refusals.length === 0) return "none";
  return refusals.map((entry) => `${entry.action}:${entry.state}/${entry.reasonCode}@${entry.sourceX},${entry.sourceY}`).join("|");
}

/**
 * Every candidate this location was refused, one entry each.
 *
 * The shape is `<target>@<source tile>:<state>/<reason code>` - so a reader can see the walk tried
 * the Farm's 80,15 gate, was refused, and moved on to 80,16. Each entry carries the candidate's
 * FINAL refusal, which is what made it unusable (an approach that gave up, or a drive the product
 * refused); the full per-call list for every candidate is in the `hop_refused` trace step, because
 * the runner's own reason code convention is bounded.
 */
function describeTriedHops(tried) {
  if (tried.length === 0) return "none";
  return tried
    .map(({ target, source, refusals }) => {
      const last = refusals[refusals.length - 1];
      const verdict = last === undefined ? "unknown" : `${last.state}/${last.reasonCode}`;
      return `${target}@${source.x},${source.y}:${verdict}`;
    })
    .join("|");
}

/** Every transition this location publishes, for a named failure. */
function describeTransitions(snapshot) {
  const transitions = locationTransitions(snapshot).map(
    (entry) => `${entry.targetLocation}@${entry.sourceX},${entry.sourceY}`,
  );
  return transitions.length === 0 ? "none" : transitions.join("|");
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
  let session = null;
  try {
    const config = await readNativeClientConfig();
    session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    const result = await runTalkToNpcSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } catch (error) {
    // A runner that exits without a result makes its own fault look like a product or transport
    // fault: the Mod sees only its pipe closing. So the entry point reports on every failure path,
    // including the ones outside the contract (config read, connect).
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: `native_local_runner_failed:${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
      }),
    );
    process.exitCode = 2;
  } finally {
    // Teardown failure must not kill the report: `close()` can itself reject once the bridge is
    // already gone, and an unhandled rejection here would end the process with no output.
    if (session !== null) await session.close().catch(() => {});
  }
}
