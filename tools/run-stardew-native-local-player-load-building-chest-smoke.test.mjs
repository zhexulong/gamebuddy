import assert from "node:assert/strict";
import test from "node:test";
import { runLoadBuildingChestSmoke } from "./run-stardew-native-local-player-load-building-chest-smoke.mjs";

const ACTION = "load_building_chest";
const REQUIRED_COUNT = 5;

/** One advertised Load chest, whose own conversion needs {@link REQUIRED_COUNT} per quantum. */
const loadTarget = (overrides = {}) => ({
  targetId: "building_chest_aaaaaaaaaaaaaaaa",
  location: "Farm",
  x: 31,
  y: 20,
  buildingType: "Mill",
  chestId: "Input",
  branch: "load",
  stackCount: 0,
  itemCount: 0,
  loadInputSlot: 3,
  loadInputQualifiedItemId: "(O)262",
  loadInputStack: REQUIRED_COUNT + 1,
  ...overrides,
});

/** The same building's advertised Collect chest: the wrong-branch case names it. */
const collectTarget = (overrides = {}) => ({
  targetId: "building_chest_bbbbbbbbbbbbbbbb",
  location: "Farm",
  x: 32,
  y: 20,
  buildingType: "Mill",
  chestId: "Output",
  branch: "collect",
  stackCount: 1,
  itemCount: 2,
  ...overrides,
});

/**
 * The runner is the thing under test, so the client answers the same calls the harness makes and
 * moves the world the way the native branch would. The receipts are minted from the live
 * projection, and the world only moves when the request named the chest the world actually holds.
 */
function makeClient({ load = loadTarget(), collect = collectTarget() } = {}) {
  const world = { load: { ...load }, collect: { ...collect }, carried: 0 };
  const receipts = [];
  let revision = 1;
  const client = {
    state: { snapshot: null, latestReceipt: null },
    async observe() {
      return snapshot();
    },
    async execute(request) {
      const receipt = handle(request, world, revision + 1);
      revision = receipt.revision;
      receipts.push(receipt);
      client.state.latestReceipt = receipt;
      return receipt;
    },
  };
  client.state.snapshot = snapshot();

  function snapshot() {
    return {
      revision,
      location: "Farm",
      tile: { x: 30, y: 21 },
      actionable: true,
      activeExecution: null,
      capabilities: ["cancel_active_execution", "inspect_self", ACTION],
      // Cloned per observation: the runner must read the world, not a live reference.
      buildingChestTargets: [{ ...world.load }, { ...world.collect }],
    };
  }
  return { client, receipts, world, snapshot };
}

/** The Mod's own branch order: tile → identity → branch → slot, then the native call. */
function handle(request, world, revision) {
  const terminal = (state, reasonCode, evidence) => ({
    requestId: request.requestId,
    executionId: `execution-${request.requestId}`,
    state,
    reasonCode,
    revision,
    evidence: { detail: evidence },
  });
  const args = request.args;
  const atTile = [world.load, world.collect].filter((entry) => entry.x === args.x && entry.y === args.y);
  if (atTile.length === 0) return terminal("rejected", "building_chest_target_not_found", `tile=${args.x},${args.y};building=none`);
  const named = atTile.find((entry) => entry.targetId === args.expectedTargetId);
  if (named === undefined)
    return terminal(
      "rejected",
      "building_chest_target_changed",
      `tile=${args.x},${args.y};location=Farm;target=${args.expectedTargetId};building_type=Mill;declared_chests=2;live_match=none`,
    );
  if (named.branch !== "load")
    return terminal(
      "rejected",
      "building_chest_not_loadable",
      `tile=${args.x},${args.y};location=Farm;target=${args.expectedTargetId};building_type=Mill;chest_id=${named.chestId};branch=${named.branch};action=load`,
    );
  if (args.slot !== world.load.loadInputSlot)
    return terminal("rejected", "item_not_owned_in_slot", `tile=${args.x},${args.y};target=${args.expectedTargetId};chest_id=${named.chestId};slot=${args.slot}`);

  const moved = REQUIRED_COUNT;
  const heldBefore = world.load.loadInputStack;
  const heldAfter = heldBefore - moved;
  const chestBefore = world.load.itemCount;
  const chestAfter = chestBefore + moved;
  world.load.itemCount = chestAfter;
  world.load.stackCount = 1;
  // The remainder is below one quantum, so the published load hint disappears: the hint is only
  // published while a whole quantum is still holdable. The IDENTITY must not change.
  if (heldAfter < REQUIRED_COUNT) {
    delete world.load.loadInputSlot;
    delete world.load.loadInputQualifiedItemId;
    delete world.load.loadInputStack;
  }
  return terminal(
    "succeeded",
    "building_chest_loaded",
    `tile=${args.x},${args.y};location=Farm;target=${args.expectedTargetId};building_type=Mill;building_origin=31,20;chest_id=${named.chestId};branch=load`
      + `;item=(O)262;held_stack_before=${heldBefore};held_stack_after=${heldAfter}`
      + `;chest_item_before=${chestBefore};chest_item_after=${chestAfter};chest_slots_before=0;chest_slots_after=1`
      + `;moved_count=${moved};released_count=${moved};required_count=${REQUIRED_COUNT};chest_capacity_before=36`
      + ";item_accepted=true;native_accepted=true;native_refusal=none;native_menu_opened=false",
  );
}

const run = (options) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runLoadBuildingChestSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("load_building_chest: the quantised load is asserted from the world and from both halves", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "building_chest_loaded");
  assert.equal(result.moved, REQUIRED_COUNT);
  assert.equal(result.chest.before, 0);
  assert.equal(result.chest.after, REQUIRED_COUNT);
  // The four negatives all ran before the load and all named their own mode.
  assert.deepEqual(result.negative, {
    wrongBranch: "building_chest_not_loadable",
    mismatchedIdentity: "building_chest_target_changed",
    emptySlot: "item_not_owned_in_slot",
  });
});

test("load_building_chest: an identity that moves with the chest contents fails the run", async () => {
  // A target id that followed the contents would make a second load impossible, and it would also
  // mean the request named a different subject than the one it acted on.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      session.world.load.targetId = "building_chest_cccccccccccccccc";
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_world_identity_stale/);
});

test("load_building_chest: a success whose chest did not grow fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") session.world.load.itemCount = 0;
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_world_unchanged/);
});

test("load_building_chest: a success whose chest grew by the wrong amount fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") session.world.load.itemCount = 1;
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_world_unchanged/);
});

test("load_building_chest: the wrong branch must be refused, and claiming success on it fails the run", async () => {
  const forged = run();
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "building_chest_not_loadable") {
      receipt.state = "succeeded";
      receipt.reasonCode = "building_chest_loaded";
    }
    return receipt;
  };
  const result = await forged.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_wrong_branch_not_refused/);
});

test("load_building_chest: a wrong-branch refusal that moved the world fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "building_chest_not_loadable") session.world.collect.itemCount += 1;
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_wrong_branch_moved_world/);
});

test("load_building_chest: a mismatched identity must be refused, and claiming success on it fails the run", async () => {
  const forged = run();
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "building_chest_target_changed") {
      receipt.state = "succeeded";
      receipt.reasonCode = "building_chest_loaded";
    }
    return receipt;
  };
  const result = await forged.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_mismatch_not_refused/);
});

test("load_building_chest: an empty slot must be refused, and claiming success on it fails the run", async () => {
  const forged = run();
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "item_not_owned_in_slot") {
      receipt.state = "succeeded";
      receipt.reasonCode = "building_chest_loaded";
    }
    return receipt;
  };
  const result = await forged.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_empty_slot_not_refused/);
});

test("load_building_chest: evidence whose amount is not a whole quantum fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = {
        detail: receipt.evidence.detail
          .replace("moved_count=5", "moved_count=3")
          .replace("released_count=5", "released_count=3")
          .replace("held_stack_after=1", "held_stack_after=3")
          .replace("chest_item_after=5", "chest_item_after=3"),
      };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_quantum_mismatch/);
});

test("load_building_chest: evidence whose two halves disagree fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("chest_item_after=5", "chest_item_after=4") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_chest_half_mismatch/);
});

test("load_building_chest: evidence whose held half disagrees fails the run", async () => {
  // Only the held side disagrees: the chest gained a whole quantum while the hand did not fall by
  // it. Without this the receipt could claim a transfer the actor never paid for.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("held_stack_after=1", "held_stack_after=0") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_held_half_mismatch/);
});

test("load_building_chest: a re-published chest that is no longer the same subject fails the run", async () => {
  // The tile still advertises a target, but it is no longer the chest the run loaded.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") session.world.load.branch = "collect";
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_world_target_replaced/);
});

test("load_building_chest: a chest that vanished from the world fails the run", async () => {
  // The re-read finds no target at the tile at all, which is not a successful load.
  const session = run();
  const originalExecute = session.client.execute;
  const originalObserve = session.client.observe;
  let loaded = false;
  session.client.execute = async (request) => {
    const receipt = await originalExecute(request);
    if (receipt.state === "succeeded") loaded = true;
    return receipt;
  };
  session.client.observe = async () => {
    const snapshot = await originalObserve();
    return loaded
      ? { ...snapshot, buildingChestTargets: snapshot.buildingChestTargets.filter((entry) => entry.x !== 31) }
      : snapshot;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_target_gone:31,20/);
});

test("load_building_chest: a refusal story in a success receipt fails the run", async () => {
  // The three native Load gates are labelled by the data field whose message the game posts; a
  // success that still names one of them did not load anything.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("native_refusal=none", "native_refusal=InvalidItemMessage") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_evidence_native_refusal/);
});

test("load_building_chest: a success that opened a container menu fails the run", async () => {
  // The Load branch must never open a menu: a receipt that reports one is not a load this Mod
  // performed.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("native_menu_opened=false", "native_menu_opened=true") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_evidence_native_menu_opened/);
});

test("load_building_chest: a success whose native branch did not accept the item fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("item_accepted=true", "item_accepted=false") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_evidence_item_accepted/);
});

test("load_building_chest: a success whose native call was refused fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("native_accepted=true", "native_accepted=false") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_evidence_native_accepted/);
});

test("load_building_chest: a target with no loadable slot is not the declared Given", async () => {
  const session = run({ load: loadTarget({ loadInputSlot: undefined, loadInputQualifiedItemId: undefined, loadInputStack: undefined }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_load_input_slot_missing/);
});

test("load_building_chest: a world with no Load chest is not the declared Given", async () => {
  const session = run({ load: collectTarget() });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_load_target_missing/);
});

test("load_building_chest: a world with no Collect sibling cannot prove the wrong-branch case", async () => {
  const session = run({ collect: loadTarget({ chestId: "InputTwo" }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_collect_sibling_missing/);
});
