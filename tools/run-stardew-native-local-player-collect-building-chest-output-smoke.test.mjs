import assert from "node:assert/strict";
import test from "node:test";
import { runCollectBuildingChestOutputSmoke } from "./run-stardew-native-local-player-collect-building-chest-output-smoke.mjs";

const ACTION = "collect_building_chest_output";

/** The building's advertised Collect chest: `stackCount` selects which branch the world is in. */
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

/** The same building's advertised Load chest: the wrong-branch case names it. */
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
  ...overrides,
});

function makeClient({ collect = collectTarget(), load = loadTarget() } = {}) {
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
      buildingChestTargets: [{ ...world.load }, { ...world.collect }],
    };
  }
  return { client, receipts, world };
}

/** The Mod's own branch order: tile → identity → branch, then the Collect branch's own counts. */
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
  const identity = `tile=${args.x},${args.y};location=Farm;target=${args.expectedTargetId};building_type=Mill;building_origin=31,20`;
  if (named === undefined)
    return terminal("rejected", "building_chest_target_changed", `${identity};declared_chests=2;live_match=none`);
  if (named.branch !== "collect")
    return terminal("rejected", "building_chest_not_collectable", `${identity};chest_id=${named.chestId};branch=${named.branch};action=collect`);

  const item = "(O)262";
  const stacksBefore = named.stackCount;
  const itemsBefore = named.itemCount;
  if (stacksBefore === 0 || stacksBefore >= 2) {
    const reasonCode = stacksBefore === 0 ? "building_chest_empty" : "building_chest_requires_menu";
    return terminal(
      "rejected",
      reasonCode,
      `${identity};chest_id=${named.chestId};branch=collect;item=${stacksBefore === 0 ? "absent" : item}`
        + `;chest_slots_before=${stacksBefore};chest_slots_after=${stacksBefore};chest_item_before=${itemsBefore};chest_item_after=${itemsBefore}`
        + `;moved_count=0;carried_before=${world.carried};carried_after=${world.carried};native_accepted=false;native_menu_opened=false`,
    );
  }

  const moved = itemsBefore;
  world.collect.stackCount = 0;
  world.collect.itemCount = 0;
  world.carried += moved;
  return terminal(
    "succeeded",
    "building_chest_output_collected",
    `${identity};chest_id=${named.chestId};branch=collect;item=${item}`
      + `;chest_slots_before=${stacksBefore};chest_slots_after=0;chest_item_before=${itemsBefore};chest_item_after=0;moved_count=${moved}`
      + `;carried_before=${world.carried - moved};carried_after=${world.carried};native_accepted=true;native_menu_opened=false`,
  );
}

const run = (options) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runCollectBuildingChestOutputSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("collect_building_chest_output: the single advertised stack must leave the chest and arrive", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "building_chest_output_collected");
  assert.equal(result.chest.stacksBefore, 1);
  assert.equal(result.chest.stacksAfter, 0);
  assert.equal(result.chest.itemsAfter, 0);
  assert.deepEqual(result.negative, { wrongBranch: "building_chest_not_collectable" });
});

test("collect_building_chest_output: two stacks must be refused by name, and claiming success fails", async () => {
  // The declared Given of the multi-stack scenario: the refusal IS the proof. A success here (or a
  // silent no-op reported as success) is exactly what the owner's ruling forbids.
  const honest = run({ collect: collectTarget({ stackCount: 2, itemCount: 3 }) });
  const honestResult = await honest.result();
  assert.equal(honestResult.state, "passed");
  assert.equal(honestResult.reasonCode, "building_chest_requires_menu");
  assert.equal(honestResult.negative.wrongBranch, "building_chest_not_collectable");

  const forged = run({ collect: collectTarget({ stackCount: 2, itemCount: 3 }) });
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "building_chest_requires_menu") {
      receipt.state = "succeeded";
      receipt.reasonCode = "building_chest_output_collected";
    }
    return receipt;
  };
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked");
  assert.match(forgedResult.reasonCode, /building_chest_multi_stack_not_refused/);
});

test("collect_building_chest_output: a menu refusal that moved the world fails the run", async () => {
  const session = run({ collect: collectTarget({ stackCount: 2, itemCount: 3 }) });
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "building_chest_requires_menu") session.world.collect.stackCount = 1;
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_menu_refusal_moved_world/);
});

test("collect_building_chest_output: the wrong branch must be refused, and claiming success fails", async () => {
  const forged = run();
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "building_chest_not_collectable") {
      receipt.state = "succeeded";
      receipt.reasonCode = "building_chest_output_collected";
    }
    return receipt;
  };
  const result = await forged.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_wrong_branch_not_refused/);
});

test("collect_building_chest_output: a success that left the stack in the chest fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") {
      session.world.collect.stackCount = 1;
      session.world.collect.itemCount = 2;
    }
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_world_unchanged/);
});

test("collect_building_chest_output: a success that left a menu open fails the run", async () => {
  // The action's whole boundary is that the >= 2-stack case is refused rather than handed to
  // ItemGrabMenu; a receipt that reports the menu is not a collect this Mod performed.
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

test("collect_building_chest_output: a slot half that did not fall fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("chest_slots_after=0", "chest_slots_after=1") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_slot_half_mismatch/);
});

test("collect_building_chest_output: a receiving half that disagrees fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("carried_after=2", "carried_after=1") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_carried_half_mismatch/);
});

test("collect_building_chest_output: an identity that moves with the chest contents fails the run", async () => {
  // The stack left the chest, but the tile now advertises a DIFFERENT target for the same chest:
  // the run can no longer name what it just proved.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") session.world.collect.targetId = "building_chest_dddddddddddddddd";
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_world_identity_stale/);
});

test("collect_building_chest_output: a chest half that disagrees fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace("chest_item_after=0", "chest_item_after=1") };
    return receipt;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_chest_half_mismatch/);
});

test("collect_building_chest_output: an empty chest is not either declared Given", async () => {
  const session = run({ collect: collectTarget({ stackCount: 0, itemCount: 0 }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_collect_declared_given_absent:stacks=0/);
});

test("collect_building_chest_output: a world with no Collect chest is not the declared Given", async () => {
  const session = run({ collect: loadTarget() });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_collect_target_missing/);
});

test("collect_building_chest_output: a world with no Load sibling cannot prove the wrong-branch case", async () => {
  const session = run({ load: collectTarget({ chestId: "OutputTwo" }) });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /building_chest_load_sibling_missing/);
});
