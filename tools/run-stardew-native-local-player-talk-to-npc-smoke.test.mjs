import assert from "node:assert/strict";
import test from "node:test";
import { runTalkToNpcSmoke } from "./run-stardew-native-local-player-talk-to-npc-smoke.mjs";
import { isAdmissionHold } from "./lib/stardew-admission-hold-codes.mjs";

const ACTION = "talk_to_npc";
const UNKNOWN_TARGET_ID = "npc_relationship_0000000000000000";
const VILLAGER = { targetId: "npc_relationship_abcdef0123456789", npcName: "Abigail", x: 31, y: 20 };

/**
 * The two topologies the SAME runner contract must serve. The native-local fixture
 * publishes exactly the surface the runner requires; the shared world publishes the
 * whole consented surface, so its capability check is required-subset and its observe
 * must tolerate the bridge's deliberate refusal to re-admit a revision it already
 * admitted.
 */
const NATIVE_LOCAL_CONFIG = Object.freeze({
  NativeLocalPlayerFixture: { Enable: true },
  FarmhandProvisioner: { Enable: false },
});
const SHARED_WORLD_CONFIG = Object.freeze({
  NativeLocalPlayerFixture: null,
  FarmhandProvisioner: { Enable: true },
});

/** A snapshot the runner can act on: one adjacent villager and a free actor. */
function snapshotWith({ revision, actionable = true, activeExecution = null, targets = [VILLAGER], location = "Town" }) {
  return {
    revision,
    location,
    tile: { x: 30, y: 21 },
    actionable,
    activeExecution,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    npcRelationshipTargets: targets,
  };
}

const TALK_EVIDENCE = (target, { dialogueUp = "true", boxUp = "true", handled = "true" } = {}) =>
  `location=Town;target=${target};npc=Abigail;tile=${VILLAGER.x},${VILLAGER.y}` +
  `;native_handled=${handled};dialogue_up_before=false;dialogue_up_after=${dialogueUp};` +
  `dialogue_box_after=${boxUp};menu_open_after=${boxUp === "true" ? "DialogueBox" : "none"};` +
  `talked_to_today_before=false;talked_to_today_after=true;points_before=100;points_after=120;` +
  `player_can_move_after=${dialogueUp === "true" ? "false" : "true"}`;

/**
 * The runner is the thing under test, so the client is a real one in shape: it answers the
 * same calls the harness makes and moves the world the way the native seam would. A talk
 * only succeeds when the actor is free and the request named a published villager, and it
 * leaves the actor inside the native DialogueBox — which is exactly the rule under test.
 */
function makeClient({ holdingItem = false, targets = [VILLAGER], location = "Town", notAdmittedOnce = false } = {}) {
  const receipts = [];
  let pendingNotAdmitted = notAdmittedOnce;
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, targets, location }) },
    observe: async () => {
      // The shared-world bridge refuses to re-admit a revision it already admitted;
      // that refusal is a `observe_snapshot_not_admitted` error, and the harness's
      // topology-aware observe falls back to the already-admitted projection.
      if (pendingNotAdmitted) {
        pendingNotAdmitted = false;
        throw new Error("observe_snapshot_not_admitted");
      }
      return client.state.snapshot;
    },
    execute: async (request) => {
      const live = client.state.snapshot;
      const base = { requestId: request.requestId, revision: live.revision + 1 };
      // An id nobody published: the Mod's own re-resolution refuses it and nothing moves.
      if (request.args.expectedTargetId === UNKNOWN_TARGET_ID) {
        const receipt = {
          ...base,
          executionId: "talk-execution-unknown-target",
          state: "rejected",
          reasonCode: "talk_to_npc_target_not_found",
          evidence: { detail: `target=${UNKNOWN_TARGET_ID};location=Town;villagers_present=1` },
        };
        receipts.push(receipt);
        return receipt;
      }
      if (!live.actionable) {
        const receipt = {
          ...base,
          executionId: "talk-execution-not-actionable",
          state: "rejected",
          // What the product ACTUALLY answers when the actor is held: the named hold, not the generic code
          // the naming wave replaced. The fake used to emit the old string, which is why this gate could fail
          // on correct behaviour without any test noticing.
          reasonCode: "actor_held_by_modal",
          evidence: { detail: null },
        };
        receipts.push(receipt);
        return receipt;
      }
      if (holdingItem) {
        const receipt = {
          ...base,
          executionId: "talk-execution-hands-not-empty",
          state: "rejected",
          reasonCode: "hands_not_empty",
          evidence: { detail: `target=${VILLAGER.targetId};npc=Abigail;hand_item=(O)24` },
        };
        receipts.push(receipt);
        return receipt;
      }
      const receipt = {
        ...base,
        executionId: "talk-execution",
        state: "succeeded",
        reasonCode: "talk_to_npc_talked",
        evidence: { detail: TALK_EVIDENCE(VILLAGER.targetId) },
      };
      client.state.snapshot = snapshotWith({
        revision: receipt.revision,
        actionable: false,
        targets,
        location,
      });
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

const run = (options, config = NATIVE_LOCAL_CONFIG) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runTalkToNpcSmoke(session.client, session.receipts, config, { terminalTimeoutMs: 1_000 }),
  };
};

/** Replace the client's answer for one predicate, keeping everything else real. */
function withForcedReceipt(session, predicate, change) {
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (predicate(receipt)) change(receipt, session);
    return receipt;
  };
}

test("talk_to_npc: the dialogue is asserted from the world, and both negatives hold", async () => {
  const session = run();
  const result = await session.result();

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "talk_to_npc_talked");
  assert.equal(result.npc, "Abigail");
  // The talk left the actor inside the native dialog, so the Mod's actionability projection
  // says the actor is no longer free.
  assert.equal(result.dialogue.actionableAfter, false);
  assert.equal(result.negatives.unknownTarget.reasonCode, "talk_to_npc_target_not_found");
  assert.equal(result.negatives.unknownTarget.actionable, true);
  // The gate's claim is about the HOLD, so the assertion is about the hold family - and the companion test
  // below still requires that an UNRELATED refusal fails the run.
  assert.equal(isAdmissionHold(result.negatives.repeat.reasonCode), true);
  assert.equal(result.negatives.repeat.reasonCode, "actor_held_by_modal", "the code the Mod names for a dialogue hold");
  assert.equal(result.negatives.repeat.actionable, false);
});

test("talk_to_npc: an unknown target that is not refused fails the run", async () => {
  // A forged success on an id nobody published is the failure this negative exists for.
  const session = run();
  withForcedReceipt(session, (receipt) => receipt.executionId === "talk-execution-unknown-target", (receipt) => {
    receipt.state = "succeeded";
    receipt.reasonCode = "talk_to_npc_talked";
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_unknown_target_not_refused/);
});

test("talk_to_npc: a claimed talk that left the world actionable fails the run", async () => {
  // The receipt says the dialog is up, but the Mod's own snapshot still says the actor is
  // free. A green receipt is not evidence.
  const session = run();
  withForcedReceipt(session, (receipt) => receipt.state === "succeeded", (receipt, current) => {
    current.client.state.snapshot = snapshotWith({ revision: receipt.revision, actionable: true });
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_world_unchanged/);
});

test("talk_to_npc: a successful repeat while the dialog is up fails the run", async () => {
  // Stacking a second conversation on an open DialogueBox is the failure this pins.
  const session = run();
  withForcedReceipt(
    session,
    (receipt) => isAdmissionHold(receipt.reasonCode),
    (receipt) => {
      receipt.state = "succeeded";
      receipt.reasonCode = "talk_to_npc_talked";
    },
  );
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_repeat_stacked_dialogue/);
});

test("talk_to_npc: a repeat refused for another reason fails the run", async () => {
  const session = run();
  withForcedReceipt(
    session,
    (receipt) => isAdmissionHold(receipt.reasonCode),
    (receipt) => {
      receipt.reasonCode = "talk_to_npc_target_not_found";
    },
  );
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_repeat_not_refused/);
});

test("talk_to_npc: a refusal that still released the dialog fails the run", async () => {
  // The repeat is refused honestly, but the world moved anyway: the first dialog was lost.
  const session = run();
  withForcedReceipt(
    session,
    (receipt) => isAdmissionHold(receipt.reasonCode),
    (receipt, current) => {
      current.client.state.snapshot = snapshotWith({ revision: receipt.revision, actionable: true });
    },
  );
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_repeat_moved_world/);
});

test("talk_to_npc: evidence that omits the observed dialogue fails the run", async () => {
  // The evidence is checked as evidence, separately from the world.
  const session = run();
  withForcedReceipt(session, (receipt) => receipt.state === "succeeded", (receipt) => {
    receipt.evidence = { detail: `location=Town;target=${VILLAGER.targetId};npc=Abigail;native_handled=true` };
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /talk_to_npc_evidence_dialogue_up_after/);
});

test("talk_to_npc: an actor who is holding something is the declared Given absent", async () => {
  // The talk branch is the EMPTY-HANDED half; with an object in hand native takes the gift
  // path instead. The fixture owes an empty-handed actor, so this is a run precondition,
  // not a product verdict.
  const session = run({ holdingItem: true });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "talk_to_npc_declared_given_absent:Abigail");
});

test("talk_to_npc: no adjacent advertised villager means the run cannot start", async () => {
  const far = { ...VILLAGER, x: 40, y: 40 };
  const session = run({ targets: [far] });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "talk_to_npc_no_adjacent_villager:tile=30,21;location=Town;actionable=true;targets=Abigail@40,40");
});

/**
 * A shared world in the shape the Mod publishes it.
 *
 * The actor joins in its own Cabin interior; each map publishes the transitions it owns
 * (`warps` and the `doorTargets` that share their fields), the destination search answers
 * the way the product's own `find_destination` does, and `navigate_to_destination` moves
 * the actor the way the native navigation seam would. The talk itself behaves exactly as
 * in `makeClient`, because that contract does not change with topology.
 */
const SHARED_WORLD_CAPABILITIES = Object.freeze([
  "cancel_active_execution",
  "enter_exit",
  "find_destination",
  "inspect_self",
  "move_to_tile",
  "navigate_to_destination",
  ACTION,
  "travel",
]);
const FARMHOUSE = "FarmHouseb7bb6250-7300-4ad8-b769-aabac1c518b9";
const SALOON_DESTINATION = Object.freeze({ kind: "ref", ref: "dr1_AAAAAAAAAAAAAAAAAAAAAA" });

/** One published transition. `warps` and `doorTargets` carry these same five fields. */
function transition(sourceX, sourceY, targetLocation, targetX = 0, targetY = 0) {
  return { sourceX, sourceY, targetLocation, targetX, targetY };
}

/** The ordinary route out of a Farmhand's Cabin: Cabin -> Farm -> Bus Stop -> Town -> Saloon. */
function sharedWorldMaps({ cabinWarps = [transition(6, 5, "Farm")], townTransitions = { warps: [transition(31, 12, "Farm")], doorTargets: [transition(14, 20, "Saloon")] } } = {}) {
  return {
    [FARMHOUSE]: { tile: { x: 5, y: 5 }, warps: cabinWarps },
    Farm: { tile: { x: 64, y: 15 }, warps: [transition(64, 16, "BusStop"), transition(32, 1, "Backwoods")] },
    BusStop: { tile: { x: 20, y: 12 }, warps: [transition(21, 12, "Town"), transition(10, 12, "Farm"), transition(20, 10, "Mountain")] },
    Backwoods: { tile: { x: 5, y: 5 }, warps: [] },
    Town: { tile: { x: 30, y: 21 }, ...townTransitions },
    Saloon: { tile: { x: 12, y: 17 }, warps: [transition(13, 17, "Town")] },
  };
}

function makeSharedWorldClient({
  start = FARMHOUSE,
  maps = sharedWorldMaps(),
  villagerTile = { x: 12, y: 20 },
  locateVillagerByWhereabouts = true,
  findAnswer = { status: "resolved", reason: "exact_current_locale", destination: SALOON_DESTINATION },
  navigateLandsIn = "Saloon",
  navigateReasonCode = "navigation_completed",
  navigateBlockedCount = 0,
  navigateBlockedReasonCode = "destination_access_indeterminate",
  destinationAnswers = {},
  moveRefusals = [],
  rangeUnlessOnSource = false,
  notAdmittedOnce = false,
} = {}) {
  const receipts = [];
  const queries = [];
  const transitionsTaken = [];
  const dispatches = [];
  let navigations = 0;
  let pendingNotAdmitted = notAdmittedOnce;

  const snapshotAt = (location, tile, revision) => {
    const map = maps[location] ?? { tile: { x: 1, y: 1 }, warps: [] };
    // The family target list is Chebyshev-bounded to the actor's neighbourhood, exactly as
    // the Mod's own discovery is; the whereabouts projection reaches the whole loaded
    // world. The walk has to work from one or the other, never from the fixture.
    const near = Math.max(Math.abs(tile.x - villagerTile.x), Math.abs(tile.y - villagerTile.y)) <= 6;
    return {
      revision,
      location,
      tile,
      actionable: true,
      activeExecution: null,
      capabilities: [...SHARED_WORLD_CAPABILITIES],
      warps: map.warps ?? [],
      doorTargets: map.doorTargets ?? [],
      npcRelationshipTargets:
        location === "Saloon" && near
          ? [{ ...VILLAGER, npcName: "Gus", x: villagerTile.x, y: villagerTile.y }]
          : [],
      villagerWhereabouts: locateVillagerByWhereabouts
        ? [{ npcName: "Gus", displayName: "Gus", location: "Saloon", x: villagerTile.x, y: villagerTile.y, inCurrentLocation: location === "Saloon" }]
        : [],
    };
  };

  /** Settle one revision at a location (and optional exact tile). */
  const settle = ({ location, tile, revision, actionable = true }) => {
    const landed = tile ?? maps[location]?.tile ?? { x: 1, y: 1 };
    client.state.snapshot = { ...snapshotAt(location, landed, revision), actionable };
    return client.state.snapshot;
  };

  const client = {
    state: { snapshot: snapshotAt(start, maps[start]?.tile ?? { x: 1, y: 1 }, 1) },
    observe: async () => {
      if (pendingNotAdmitted) {
        pendingNotAdmitted = false;
        throw new Error("observe_snapshot_not_admitted");
      }
      return client.state.snapshot;
    },
    navigationRead: async (request) => {
      queries.push(request);
      if (request.operation !== "find_destination")
        return { status: "succeeded", reason: "world_map_observed", entries: [], nextCursor: null, candidates: null, destination: null, unlockState: null };
      // The goal query answers with the fixture's declared answer; any OTHER query is a hop
      // probe, and the default is that the product can name that neighbour - overridable per
      // query so a test can make a neighbour unnameable.
      const answer =
        request.args.query === "Saloon"
          ? findAnswer
          : destinationAnswers[request.args.query] ?? {
              status: "resolved",
              reason: "exact_current_locale",
              destination: { kind: "ref", ref: `dr1_${request.args.query}` },
            };
      return {
        status: answer.status,
        reason: answer.reason,
        entries: null,
        nextCursor: null,
        candidates: answer.candidates ?? null,
        destination: answer.destination ?? null,
        // Faithful to the wire: `unlockState` is "unknown" only on a resolved answer and null on
        // every decline (`protocol.ts:869`, `:880-888`).
        unlockState: answer.status === "resolved" ? (answer.unlockState ?? "unknown") : (answer.unlockState ?? null),
      };
    },
    execute: async (request) => {
      const live = client.state.snapshot;
      const base = { requestId: request.requestId, revision: live.revision + 1 };
      if (request.action === "move_to_tile") {
        // A tile the native pathfinder refuses: the product's own verdict about THAT tile
        // (`failed / no_native_path`, measured live on the Farm's east gate), not a code this
        // fake invents.
        if (moveRefusals.includes(`${request.args.x},${request.args.y}`)) {
          const refused = {
            ...base,
            executionId: `walk-move-refused-${request.args.x}-${request.args.y}-${receipts.length}`,
            state: "failed",
            reasonCode: "no_native_path",
            evidence: { detail: `target=${request.args.x},${request.args.y};reason=no_native_path` },
          };
          receipts.push(refused);
          return refused;
        }
        const receipt = {
          ...base,
          executionId: `walk-move-${request.args.x}-${request.args.y}-${receipts.length}`,
          state: "succeeded",
          reasonCode: "target_reached",
          evidence: { detail: `x=${request.args.x};y=${request.args.y}` },
        };
        receipts.push(receipt);
        settle({ location: live.location, tile: { x: request.args.x, y: request.args.y }, revision: receipt.revision });
        return receipt;
      }
      if (request.action === "enter_exit" || request.action === "travel") {
        // The product's own range rule: a form named for a source tile it cannot reach from where
        // the actor stands answers with its own out-of-range code.
        if (rangeUnlessOnSource && (live.tile.x !== request.args.x || live.tile.y !== request.args.y)) {
          const outOfRange = {
            requestId: request.requestId,
            revision: live.revision + 1,
            executionId: `walk-${request.action}-range-${receipts.length}`,
            state: "rejected",
            reasonCode: request.action === "enter_exit" ? "door_out_of_range" : "warp_out_of_range",
            evidence: { detail: `source=${request.args.x},${request.args.y}` },
          };
          receipts.push(outOfRange);
          return outOfRange;
        }
        // Both actions resolve the SAME published transition; which one owns a given tile
        // is the Mod's business, so the fake answers both and the runner's own order
        // decides. `enter_exit` carries the door form's refusal name and `travel` the
        // plain warp's, because the two are genuinely different native calls.
        const entry = [...(live.warps ?? []), ...(live.doorTargets ?? [])].find(
          (candidate) => candidate.sourceX === request.args.x && candidate.sourceY === request.args.y,
        );
        if (entry === undefined) {
          const receipt = {
            ...base,
            executionId: `walk-${request.action}-${receipts.length}`,
            state: "rejected",
            reasonCode: request.action === "enter_exit" ? "door_not_available" : "warp_not_available",
            evidence: { detail: `source=${request.args.x},${request.args.y}` },
          };
          receipts.push(receipt);
          return receipt;
        }
        transitionsTaken.push(entry);
        // What the runner asked the product to do, and where the actor stood when it asked: the
        // transition has to be driven with the WARP'S OWN coordinates, not with the tile the actor
        // happens to occupy.
        dispatches.push({ action: request.action, x: request.args.x, y: request.args.y, fromTile: live.tile });
        const receipt = {
          ...base,
          executionId: `walk-${request.action}-${entry.sourceX}-${entry.sourceY}-${receipts.length}`,
          state: "succeeded",
          // The live code for the door form, so the suite mirrors the artifact the run produces.
          reasonCode: request.action === "enter_exit" ? "enter_exit_completed" : `${request.action}_completed`,
          evidence: { detail: `target=${entry.targetLocation}` },
        };
        receipts.push(receipt);
        settle({ location: entry.targetLocation, tile: { x: entry.targetX, y: entry.targetY }, revision: receipt.revision });
        return receipt;
      }
      if (request.action === "navigate_to_destination") {
        navigations += 1;
        const selector = request.args.destination ?? {};
        if (navigations <= navigateBlockedCount) {
          // What the Mod really answers from INSIDE a farmhand Cabin interior: blocked on
          // the revision the actor is already on, having made no attempt at all. The world
          // does not move, so the revision does not either.
          const receipt = {
            requestId: request.requestId,
            revision: live.revision,
            executionId: `walk-navigate-blocked-${navigations}`,
            state: "blocked",
            reasonCode: navigateBlockedReasonCode,
            evidence: { detail: `destination=${selector.label ?? selector.ref ?? "none"};topology=${navigateBlockedReasonCode}` },
          };
          receipts.push(receipt);
          return receipt;
        }
        const matched =
          (SALOON_DESTINATION.kind === "ref" && selector.kind === "ref" && selector.ref === SALOON_DESTINATION.ref) ||
          (SALOON_DESTINATION.kind === "label" && selector.kind === "label" && selector.label === SALOON_DESTINATION.label);
        const succeeded = matched && navigateReasonCode === "navigation_completed";
        const receipt = {
          ...base,
          executionId: `walk-navigate-${receipts.length}`,
          state: succeeded ? "succeeded" : "failed",
          reasonCode: matched ? navigateReasonCode : "destination_selector_invalid",
          evidence: { detail: `destination=${selector.label ?? selector.ref ?? "none"};arrived=true;postcondition=true` },
        };
        receipts.push(receipt);
        if (succeeded) settle({ location: navigateLandsIn, revision: receipt.revision });
        return receipt;
      }
      // The talk contract itself, unchanged from the native-local fake.
      if (request.args.expectedTargetId === UNKNOWN_TARGET_ID) {
        const receipt = {
          ...base,
          executionId: "talk-execution-unknown-target",
          state: "rejected",
          reasonCode: "talk_to_npc_target_not_found",
          evidence: { detail: `target=${UNKNOWN_TARGET_ID};location=Saloon;villagers_present=1` },
        };
        receipts.push(receipt);
        return receipt;
      }
      if (!live.actionable) {
        const receipt = {
          ...base,
          executionId: "talk-execution-not-actionable",
          state: "rejected",
          reasonCode: "actor_held_by_modal",
          evidence: { detail: null },
        };
        receipts.push(receipt);
        return receipt;
      }
      const receipt = {
        ...base,
        executionId: "talk-execution",
        state: "succeeded",
        reasonCode: "talk_to_npc_talked",
        evidence: { detail: TALK_EVIDENCE(request.args.expectedTargetId) },
      };
      receipts.push(receipt);
      settle({ location: live.location, tile: live.tile, revision: receipt.revision, actionable: false });
      return receipt;
    },
  };
  return { client, receipts, queries, transitionsTaken, dispatches };
}

function runShared(options = {}) {
  const session = makeSharedWorldClient(options);
  return {
    ...session,
    result: () => runTalkToNpcSmoke(session.client, session.receipts, SHARED_WORLD_CONFIG, { terminalTimeoutMs: 1_000 }),
  };
}

test("talk_to_npc: the shared-world lane reads through the topology-aware observe and reports its topology", async () => {
  // The two-process farmhand lane refuses to re-admit a revision it already admitted.
  // A runner that read it with the strict single-player observe would block for a
  // reason the action cannot fix, so the shared-world case is exercised here as the
  // client really behaves: one refused read, then the already-admitted projection.
  // The actor is already where the content is, so no walk is needed at all.
  const session = runShared({ start: "Saloon", villagerTile: { x: 12, y: 18 }, notAdmittedOnce: true });
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.topology, "shared_world_farmhand");
  assert.equal(result.reasonCode, "talk_to_npc_talked");
  // Where the actor stood is part of the result, because in this topology the client - not
  // the Host fixture - is what puts it there, and the run has to say where it landed.
  assert.equal(result.actorLocation, "Saloon");
  assert.deepEqual(session.queries, [], "an actor already at the content asks the product for no route");
});

test("talk_to_npc: a shared-world actor in its Cabin walks to the Saloon with the product's own navigation", async () => {
  const session = runShared();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.actorLocation, "Saloon");
  // The destination is named by the product's own search, not by a label this runner
  // invented: the query is the declared location and the selector is what came back.
  assert.deepEqual(session.queries, [{ operation: "find_destination", args: { query: "Saloon" } }]);
  const steps = result.trace.map((entry) => entry.step);
  assert.deepEqual(steps.slice(0, 2), ["find_destination", "navigate_to_destination"], "one search, one multi-hop navigation");
  assert.ok(steps.includes("stand_adjacent"), "the actor is walked beside the villager before talking");
  // The villager is still named through the Mod's own published target id, and the person
  // is the fixture's, so the walk did not change who gets talked to.
  assert.equal(result.npc, "Gus");
  assert.equal(result.target, VILLAGER.targetId);
});

test("talk_to_npc: a declared location the product cannot name fails by name, before any hop", async () => {
  // `find_destination` is the only way a name becomes a navigation selector, so a goal the
  // search declines cannot be reached - and a hop INTO it would need the same name to resolve.
  // The run says so with the search's own status and reason rather than walking hopefully.
  const session = runShared({ findAnswer: { status: "not_found", reason: "destination_not_found", destination: null } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    `talk_to_npc_shared_world_walk_destination_not_nameable:${FARMHOUSE}:tile=5,5` +
      `:query=Saloon:status=not_found:reason=destination_not_found`,
  );
  assert.deepEqual(session.transitionsTaken, [], "nothing is driven toward an unnameable destination");
});

test("talk_to_npc: a neighbour the destination search cannot name is still a hop, because the transition drives", async () => {
  // The measured live shape: `find_destination("Farm")` answers `destination_not_found` - the
  // destination set does not cover that map's name - while the Farm transition drives perfectly.
  // The search answer is recorded as information; the HOP is decided by the published transition,
  // and the landing location is what says whether it worked.
  const session = runShared({
    navigateBlockedCount: 1,
    navigateBlockedReasonCode: "destination_access_indeterminate",
    destinationAnswers: { Farm: { status: "not_found", reason: "destination_not_found" } },
  });
  const result = await session.result();
  assert.equal(result.state, "passed", "an unnamed neighbour must not block the hop");
  assert.equal(result.actorLocation, "Saloon");
  assert.deepEqual(
    session.transitionsTaken.map((entry) => entry.targetLocation),
    ["Farm"],
    "the Cabin's own published transition is taken even though the search cannot name it",
  );
  const decision = result.trace.find((entry) => entry.step === "hop_candidates");
  assert.deepEqual(decision.candidates, [
    {
      targetLocation: "Farm",
      source: { x: 6, y: 5 },
      status: "not_found",
      reason: "destination_not_found",
      unlockState: null,
      destination: null,
      labels: [],
      candidateStates: [],
      searchNamed: false,
      visited: false,
    },
  ]);
  // The search was still asked - the answer is evidence, not a gate.
  assert.ok(session.queries.some((query) => query.args.query === "Farm"));
});

test("talk_to_npc: a warp published at the map's edge is driven from the tile beside it", async () => {
  // The measured live shape: the Farm is 80x65, so its east gate is published at x=80 where NO
  // tile is walkable, and the native pathfinder refuses every move onto that column. A player
  // triggers the warp from the tile BESIDE it, and the product's own range is Chebyshev-1, so the
  // walk approaches to an in-bounds neighbour and then drives the transition with the WARP'S OWN
  // coordinates.
  const maps = sharedWorldMaps({
    cabinWarps: [transition(3, 12, "Farm", 52, 16)],
    townTransitions: { warps: [transition(31, 12, "Farm", 52, 16)], doorTargets: [transition(14, 20, "Saloon", 12, 17)] },
  });
  maps.Farm = {
    tile: { x: 52, y: 16 },
    warps: [
      transition(80, 15, "BusStop", 20, 12),
      transition(80, 18, "BusStop", 20, 12),
      transition(79, 12, "Forest", 40, 65),
    ],
  };
  const session = runShared({
    maps,
    // The whole x=80 column is off-map, exactly as it is live: every tile in that column refuses.
    moveRefusals: ["80,15", "80,14", "81,15", "80,16"],
    navigateBlockedCount: 2,
    navigateBlockedReasonCode: "destination_unreachable",
  });
  const result = await session.result();
  assert.equal(result.state, "passed", "an edge warp must be reachable from beside it");
  assert.equal(result.actorLocation, "Saloon");
  const moves = result.trace
    .filter((entry) => entry.step === "move_to_tile")
    .map((entry) => `${entry.tile.x},${entry.tile.y}:${entry.receipt.state}/${entry.receipt.reasonCode}`);
  assert.deepEqual(
    moves.slice(1, 3),
    ["80,15:failed/no_native_path", "79,15:succeeded/target_reached"],
    "the warp's own tile, then the in-map neighbour: nothing outside the map is proposed",
  );
  // THE OFF-MAP DEFECT: a Chebyshev-1 ring around an edge warp reaches past the map, and a live run
  // asked the product to path to `81,16` - a column an 80-wide map cannot have.
  const proposedColumns = result.trace
    .filter((entry) => entry.step === "move_to_tile")
    .map((entry) => entry.tile.x);
  assert.equal(proposedColumns.filter((column) => column > 80).length, 0, "no tile beyond the warp is proposed");
  // The crux: the transition is driven with the warp's OWN coordinates, from the tile beside it.
  const edgeDispatch = session.dispatches.find((entry) => entry.x === 80 && entry.y === 15);
  assert.deepEqual(edgeDispatch.fromTile, { x: 79, y: 15 }, "dispatched from beside the edge warp");
  assert.ok(session.transitionsTaken.some((entry) => entry.sourceX === 80 && entry.sourceY === 15));
});

test("talk_to_npc: a transition refused for range is retried after the actor steps closer", async () => {
  // The product refuses `warp_out_of_range` while the actor is only beside the source tile: the walk
  // steps ONTO the tile and tries the SAME form again, rather than spending the candidate.
  const maps = sharedWorldMaps({
    cabinWarps: [transition(3, 12, "Farm", 79, 15)],
    townTransitions: { warps: [transition(31, 12, "Farm", 52, 16)], doorTargets: [transition(14, 20, "Saloon", 12, 17)] },
  });
  maps.Farm = { tile: { x: 79, y: 15 }, warps: [transition(80, 15, "BusStop", 20, 12)] };
  const session = runShared({
    maps,
    navigateBlockedCount: 2,
    navigateBlockedReasonCode: "destination_unreachable",
    // The product demands the source tile itself here, so the first dispatch is out of range.
    rangeUnlessOnSource: true,
  });
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.actorLocation, "Saloon");
  const forms = result.trace
    .filter((entry) => entry.step === "enter_exit" || entry.step === "travel")
    .map((entry) => `${entry.step}#${entry.attempt}:${entry.receipt.state}/${entry.receipt.reasonCode}`);
  assert.deepEqual(
    forms.slice(1, 3),
    ["enter_exit#0:rejected/door_out_of_range", "enter_exit#1:succeeded/enter_exit_completed"],
    "the same form is retried after the actor closes the range",
  );
  assert.ok(
    result.trace.some((entry) => entry.step === "move_to_tile" && entry.tile.x === 80 && entry.tile.y === 15),
    "the retry approached onto the warp's own tile",
  );
});

test("talk_to_npc: a refused transition is retried with the next candidate this location publishes", async () => {
  // Gate ONE of the Farm's east strip is unusable in every way - the native pathfinder refuses all
  // four tiles around it - while the map publishes further transitions. A refusal is the product's
  // verdict about ONE tile, so the walk records it and takes the next candidate.
  const maps = sharedWorldMaps({
    cabinWarps: [transition(3, 12, "Farm", 52, 16)],
    townTransitions: { warps: [transition(31, 12, "Farm", 52, 16)], doorTargets: [transition(14, 20, "Saloon", 12, 17)] },
  });
  maps.Farm = {
    tile: { x: 52, y: 16 },
    warps: [
      transition(80, 15, "BusStop", 20, 12),
      transition(80, 18, "BusStop", 20, 12),
      transition(80, 16, "BusStop", 20, 12),
      transition(80, 17, "BusStop", 20, 12),
      transition(40, 65, "Forest", 0, 0),
      transition(34, 5, "FarmCave", 0, 0),
    ],
  };
  const session = runShared({
    maps,
    navigateBlockedCount: 2,
    navigateBlockedReasonCode: "destination_unreachable",
    // Gate ONE is unapproachable - every tile on the map's side of it refuses - while gate TWO is
    // fine, which is what makes this a next-candidate test rather than an approach test. The tiles
    // listed are the PRUNED ring: nothing beyond x=80 is ever proposed.
    moveRefusals: ["80,15", "79,15", "79,16", "80,16"],
  });
  const result = await session.result();
  assert.equal(result.state, "passed", "one unusable gate must not end the walk");
  assert.equal(result.actorLocation, "Saloon");
  // The first gate is written off after its own pruned approach set refuses; the second is made and
  // driven.
  const moves = result.trace
    .filter((entry) => entry.step === "move_to_tile")
    .map((entry) => `${entry.tile.x},${entry.tile.y}:${entry.receipt.state}/${entry.receipt.reasonCode}`);
  assert.deepEqual(moves.slice(1, 6), [
    "80,15:failed/no_native_path",
    "79,15:failed/no_native_path",
    "79,16:failed/no_native_path",
    "80,16:failed/no_native_path",
    "80,18:succeeded/target_reached",
  ]);
  assert.deepEqual(
    session.transitionsTaken.map((entry) => `${entry.targetLocation}@${entry.sourceX},${entry.sourceY}`),
    ["Farm@3,12", "BusStop@80,18"],
    "the hop that worked is the second published gate tile",
  );
  assert.deepEqual(result.trace.filter((entry) => entry.step === "hop_refused"), [], "no map-wide refusal was recorded");
});

test("talk_to_npc: only after every published candidate is refused does the walk fail, listing each", async () => {
  // The whole east gate refused: the walk tries every candidate this location publishes and then
  // reports the map dead, with each refusal's own reason code and source tile.
  const maps = sharedWorldMaps({
    cabinWarps: [transition(3, 12, "Farm", 52, 16)],
  });
  maps.Farm = {
    tile: { x: 52, y: 16 },
    warps: [transition(80, 15, "BusStop", 20, 12), transition(80, 16, "BusStop", 20, 12)],
  };
  const session = runShared({
    maps,
    navigateBlockedCount: 2,
    navigateBlockedReasonCode: "destination_unreachable",
    // Both gates' PRUNED approach sets refused: neither can be reached from anywhere on the map,
    // which is the only way this map can dead-end. Nothing beyond x=80 appears.
    moveRefusals: ["80,15", "79,15", "79,16", "80,16", "80,18", "79,17", "79,18", "80,17"],
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    "talk_to_npc_shared_world_walk_transition_refused:Farm:tile=52,16:tried=2" +
      ":refusals=BusStop@80,15:failed/no_native_path" +
      "|BusStop@80,16:failed/no_native_path",
  );
  assert.ok(result.reasonCode.length <= 256, "the named failure has to survive the runner's own bound");
  const recorded = result.trace.find((entry) => entry.step === "hop_refused");
  assert.equal(recorded.tried.length, 2, "the trace keeps every refused candidate of this location");
  assert.deepEqual(recorded.tried.map((entry) => entry.source), [{ x: 80, y: 15 }, { x: 80, y: 16 }]);
  assert.equal(
    recorded.tried[0].refusals.length,
    4,
    "and every per-call refusal each candidate produced, unbounded by the reason code",
  );
});

test("talk_to_npc: an error thrown inside a hop becomes a named walk failure, not a silent death", async () => {
  // A live run died mid-walk and its result carried only the transport's own error
  // (`bridge_disconnected:pipe_closed`) with a trace that stopped mid-walk, so the whole run read
  // as "the bridge died" rather than "the walk tried X and failed because Y". Every await in the
  // walk is inside one guard that names the phase, the attempt, where the actor was, the transition
  // it was driving and the original cause - so a transport fault can no longer masquerade as a
  // product fault, and the runner cannot exit without a report.
  const session = runShared({ navigateBlockedCount: 1, navigateBlockedReasonCode: "destination_unreachable" });
  const original = session.client.execute;
  session.client.execute = async (request) => {
    if (request.action === "enter_exit" || request.action === "travel") throw new Error("bridge_disconnected:pipe_closed");
    return await original(request);
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    `talk_to_npc_shared_world_walk_error:hop_drive:attempt=1:location=${FARMHOUSE}:tile=5,5` +
      `:last_hop=Farm@6,5:cause=bridge_disconnected:pipe_closed`,
  );
  // The walk's own named failures are NOT rewritten by the guard.
  const refused = runShared({ navigateBlockedCount: 1, navigateBlockedReasonCode: "destination_locked" });
  assert.match((await refused.result()).reasonCode, /^talk_to_npc_shared_world_walk_navigation_failed:/u);
  // And the trace still comes back with the failure, so a reader sees how far the walk got.
  assert.ok(result.trace.some((entry) => entry.step === "find_destination"));
  assert.ok(result.trace.some((entry) => entry.step === "navigate_to_destination"));
});

test("talk_to_npc: a location with no transition at all fails by name", async () => {
  // The Cabin publishes no exit: the walk has nothing to hop to, so it reports exactly that
  // instead of surfacing later as a native refusal from the wrong map.
  const session = runShared({
    maps: sharedWorldMaps({ cabinWarps: [] }),
    navigateBlockedCount: 1,
    navigateBlockedReasonCode: "destination_unreachable",
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    `talk_to_npc_shared_world_walk_no_hop:${FARMHOUSE}:tile=5,5` +
      `:navigation=blocked/destination_unreachable:candidates=none`,
    "the location reached, the tile it reached it on and the candidates it saw",
  );
});

test("talk_to_npc: a hop back to a map the walk already stood in is never taken, so it cannot loop", async () => {
  // Two maps that only lead to each other. `visited` is what makes the walk stop at the dead end
  // instead of bouncing between them until the hop cap, and the stop names the candidate it saw.
  const cycle = {
    LoopA: { tile: { x: 5, y: 5 }, warps: [transition(6, 5, "LoopB", 7, 7)] },
    LoopB: { tile: { x: 7, y: 7 }, warps: [transition(8, 7, "LoopA", 5, 5)] },
  };
  const session = runShared({
    start: "LoopA",
    maps: cycle,
    navigateBlockedCount: Number.POSITIVE_INFINITY,
    navigateBlockedReasonCode: "destination_access_indeterminate",
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    `talk_to_npc_shared_world_walk_no_hop:LoopB:tile=7,7` +
      `:navigation=blocked/destination_access_indeterminate:candidates=LoopA@8,7=resolved/unknown`,
  );
  assert.equal(session.transitionsTaken.length, 1, "one hop, then the only way back is refused by the walk itself");
});

test("talk_to_npc: a refused hop on the way to a far destination names the refusal, not the walk", async () => {
  // The navigation is blocked - the live `destination_unreachable` for a far destination - and
  // the transition the hop would use is refused by both native forms: the walk says WHICH hop was
  // refused, from which tile, and what each form answered, instead of collapsing it into a walk
  // failure.
  const session = runShared({ navigateBlockedCount: 1, navigateBlockedReasonCode: "destination_unreachable" });
  const original = session.client.execute;
  session.client.execute = async (request) => {
    if (request.action === "enter_exit" || request.action === "travel") {
      const receipt = {
        requestId: request.requestId,
        revision: session.client.state.snapshot.revision + 1,
        executionId: `walk-refused-${request.action}`,
        state: "rejected",
        reasonCode: request.action === "enter_exit" ? "door_out_of_range" : "warp_out_of_range",
        evidence: { detail: `source=${request.args.x},${request.args.y}` },
      };
      session.receipts.push(receipt);
      return receipt;
    }
    return await original(request);
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    `talk_to_npc_shared_world_walk_transition_refused:${FARMHOUSE}:tile=5,5:tried=1` +
      `:refusals=Farm@6,5:rejected/warp_out_of_range`,
  );
  assert.deepEqual(
    result.trace.filter((entry) => entry.step === "hop_refused").map((entry) => entry.tried.length),
    [1],
    "the refused candidate is recorded as a list, even when there is only one",
  );
});

test("talk_to_npc: an interior block is left by the interior's own warp and the navigation is retried", async () => {
  // The live shape: the search resolves the Saloon, and the navigation answers
  // `blocked / destination_access_indeterminate` from inside the Cabin without moving.
  // That is not the end of the walk - the actor leaves the interior and asks again.
  const session = runShared({ navigateBlockedCount: 1 });
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.actorLocation, "Saloon");
  // The destination is re-searched on EVERY attempt, from the map the actor is on now.
  const searches = result.trace.filter((entry) => entry.step === "find_destination");
  assert.equal(searches.length, 2, "one search per attempt");
  assert.deepEqual(searches.map((entry) => entry.from), [FARMHOUSE, "Farm"], "the second search runs from the map outside");
  const navigations = result.trace.filter((entry) => entry.step === "navigate_to_destination");
  assert.deepEqual(
    navigations.map((entry) => `${entry.receipt.state}/${entry.receipt.reasonCode}`),
    ["blocked/destination_access_indeterminate", "succeeded/navigation_completed"],
  );
  assert.deepEqual(
    session.transitionsTaken.map((entry) => entry.targetLocation),
    ["Farm"],
    "the interior block is left by the Cabin's own single published warp",
  );
});

test("talk_to_npc: the walk hops one map at a time and stops at its own hop cap", async () => {
  // A chain of maps that never reaches the declared location: the walk keeps taking one hop per
  // attempt - each chosen because the product names it - and stops at the cap with where it got.
  const chain = {};
  for (let index = 0; index < 8; index++)
    chain[`Hop${index}`] = {
      tile: { x: index, y: 0 },
      warps: index < 7 ? [transition(index + 1, 0, `Hop${index + 1}`)] : [],
    };
  const session = runShared({
    start: "Hop0",
    maps: chain,
    navigateBlockedCount: Number.POSITIVE_INFINITY,
    navigateBlockedReasonCode: "destination_access_indeterminate",
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    "talk_to_npc_shared_world_walk_navigation_attempts_exhausted:Hop6:attempts=6:transitions=Hop7@7,0",
  );
  assert.equal(result.trace.filter((entry) => entry.step === "navigate_to_destination").length, 6);
  assert.equal(session.transitionsTaken.length, 6, "one hop per attempt, never more");
});

test("talk_to_npc: a product navigation that does not arrive fails by name, before any talk", async () => {
  const session = runShared({ navigateReasonCode: "navigation_blocked", navigateLandsIn: FARMHOUSE });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    `talk_to_npc_shared_world_walk_navigation_failed:failed/navigation_blocked:destination=ref:${SALOON_DESTINATION.ref}:reached=${FARMHOUSE}:tile=5,5`,
  );
});

test("talk_to_npc: a far destination the product determines unreachable earns ONE hop, then the same call succeeds", async () => {
  // The measured live answer from the Farm, and the product's own design behind it: cross-map
  // movement is hop-by-hop, so one call to a far destination is EXPECTED to answer unreachable.
  // The walk takes exactly one map's worth of progress and re-searches from there.
  const session = runShared({ navigateBlockedCount: 1, navigateBlockedReasonCode: "destination_unreachable" });
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.actorLocation, "Saloon");
  const navigations = result.trace.filter((entry) => entry.step === "navigate_to_destination");
  assert.deepEqual(
    navigations.map((entry) => `${entry.from}:${entry.receipt.state}/${entry.receipt.reasonCode}`),
    [`${FARMHOUSE}:blocked/destination_unreachable`, "Farm:succeeded/navigation_completed"],
    "one refusal from the Cabin, then the same call succeeds from the map next door",
  );
  assert.deepEqual(
    session.transitionsTaken.map((entry) => entry.targetLocation),
    ["Farm"],
    "exactly one hop, chosen from the transition the Cabin publishes",
  );
  // The hop decision itself is visible, with the product's own verdict on every candidate.
  const decision = result.trace.find((entry) => entry.step === "hop_candidates");
  assert.deepEqual(decision.candidates, [
    {
      targetLocation: "Farm",
      source: { x: 6, y: 5 },
      status: "resolved",
      reason: "exact_current_locale",
      unlockState: "unknown",
      destination: { kind: "ref", ref: "dr1_Farm" },
      labels: [],
      candidateStates: [],
      searchNamed: true,
      visited: false,
    },
  ]);
});

test("talk_to_npc: a blocked code that is not a hop signal fails by name without hopping", async () => {
  // Only the two "not reachable in ONE call" reasons earn a hop. A blocked code that names a
  // fact about the destination itself - the kind a shut door or a busy destination produces -
  // must stop the walk where it stands, so it is reported instead of being walked around.
  for (const reasonCode of ["destination_temporarily_unavailable", "destination_locked"]) {
    const session = runShared({ navigateBlockedCount: 1, navigateBlockedReasonCode: reasonCode });
    const result = await session.result();
    assert.equal(result.state, "blocked", `${reasonCode} must not be retried`);
    assert.equal(
      result.reasonCode,
      `talk_to_npc_shared_world_walk_navigation_failed:blocked/${reasonCode}` +
        `:destination=ref:${SALOON_DESTINATION.ref}:reached=${FARMHOUSE}:tile=5,5`,
    );
    assert.deepEqual(session.transitionsTaken, [], `${reasonCode} must not trigger a hop`);
  }
});

test("talk_to_npc: a shared-world villager the snapshot cannot locate fails by name", async () => {
  // The actor is in the Saloon, but no published projection names the villager there (too
  // far for the bounded family list, absent from the whereabouts projection), so the walk
  // has no tile to approach. That is the fixture's Given, reported as such rather than as
  // a native refusal.
  const session = runShared({ start: "Saloon", locateVillagerByWhereabouts: false, villagerTile: { x: 40, y: 40 } });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    "talk_to_npc_shared_world_walk_villager_not_locatable:Gus:location=Saloon:tile=12,17",
  );
});
