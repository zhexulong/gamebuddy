import assert from "node:assert/strict";
import test from "node:test";
import { runBreakContainerSourceSmoke } from "./run-stardew-native-local-player-break-container-source-smoke.mjs";

const ACTION = "break_container_source";
const CONTAINER_ITEM = "(BC)118";
const NON_CONTAINER_ITEM = "(BC)12";
const CONTAINER_TILE = { x: 21, y: 21 };
const KEG_TILE = { x: 20, y: 22 };
const PICKAXE_SLOT = 9;
const TAPPER_SLOT = 3;

/** The Mod's own identity rules: one per kind, both opaque. */
const containerTargetId = "breakable_container_barrel";
const nonContainerTargetId = "placed_item_keg";

function snapshotWith({ revision, containerPresent = true, drops = [] }) {
  return {
    revision,
    location: "Farm",
    tile: { x: 20, y: 21 },
    actionable: true,
    activeExecution: null,
    inventorySlots: 12,
    capabilities: ["cancel_active_execution", "inspect_self", "equip_tool", ACTION],
    worldObjectTargets: [
      ...(containerPresent
        ? [{ targetId: containerTargetId, kind: "breakable_container", location: "Farm", x: CONTAINER_TILE.x, y: CONTAINER_TILE.y, slot: PICKAXE_SLOT, qualifiedItemId: CONTAINER_ITEM, displayName: "Barrel" }]
        : []),
      { targetId: nonContainerTargetId, kind: "removable_object", location: "Farm", x: KEG_TILE.x, y: KEG_TILE.y, slot: PICKAXE_SLOT, qualifiedItemId: NON_CONTAINER_ITEM, displayName: "Keg" },
    ].filter(Boolean),
    toolSlots: [{ slot: PICKAXE_SLOT, label: "(T)Pickaxe" }],
    lastDrops: drops,
  };
}

/**
 * The runner is the thing under test, so the client answers the same calls the harness
 * makes and applies the rule the seam applies: only a breakable container can be broken,
 * the swing needs a heavy hitter in the named slot, and the container disappears when the
 * swing lands whatever the seam's own return value is.
 */
function makeClient({ drops = [] } = {}) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, drops }) },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const state = client.state.snapshot;
      const target = state.worldObjectTargets.find((entry) => entry.targetId === request.args.expectedTargetId);
      let receipt;
      if (request.action === "equip_tool") {
        receipt = {
          requestId: request.requestId,
          executionId: "break-container-equip",
          state: "succeeded",
          reasonCode: "tool_equipped",
          revision: state.revision + 1,
          evidence: { detail: `tool=${request.args.tool}` },
        };
      } else if (target == null) {
        receipt = {
          requestId: request.requestId,
          executionId: "break-container-refused",
          state: "rejected",
          reasonCode: "break_container_source_target_not_found",
          revision: state.revision + 1,
          evidence: { detail: `target=${request.args.x},${request.args.y};published=${request.args.expectedTargetId}` },
        };
      } else if (target.kind !== "breakable_container") {
        receipt = {
          requestId: request.requestId,
          executionId: "break-container-refused",
          state: "rejected",
          reasonCode: "break_container_source_not_a_container",
          revision: state.revision + 1,
          evidence: { detail: `target=${request.args.x},${request.args.y};item=${target.qualifiedItemId};type=Object` },
        };
      } else if (request.args.slot !== PICKAXE_SLOT) {
        receipt = {
          requestId: request.requestId,
          executionId: "break-container-refused",
          state: "rejected",
          reasonCode: "break_container_source_tool_not_equipped_in_requested_slot",
          revision: state.revision + 1,
          evidence: { detail: `slot=${request.args.slot};slot_item=empty;current_tool=(T)Pickaxe` },
        };
      } else {
        receipt = {
          requestId: request.requestId,
          executionId: "break-container-execution",
          state: "succeeded",
          reasonCode: "container_source_broken",
          revision: state.revision + 1,
          evidence: {
            detail:
              `target=${target.targetId};location=Farm;tile=${target.x},${target.y};item=${target.qualifiedItemId};type=BreakableContainer` +
              `;tool=(T)Pickaxe;slot=${request.args.slot};swings=3;container_gone=true;tile_object_after=none` +
              `;drops=${state.lastDrops.join("|")};drop_count=${state.lastDrops.length};stamina_before=100;stamina_after=94`,
          },
        };
        client.state.snapshot = snapshotWith({ revision: receipt.revision, containerPresent: false, drops: state.lastDrops });
      }
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

const run = (options = {}) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runBreakContainerSourceSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

function mutate(session, rewrite) {
  const original = session.client.execute;
  session.client.execute = async (request) => rewrite(await original(request), request, session);
}

test("break_container_source: the container being GONE is the postcondition, and its drops are reported", async () => {
  const session = run({ drops: ["(O)390", "(O)382"] });
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "container_source_broken");
  assert.equal(result.item, CONTAINER_ITEM);
  assert.deepEqual(result.drops, ["(O)390", "(O)382"]);
});

test("break_container_source: a container that survived the swing fails the run", async () => {
  // The seam returns false even when it destroys the container, so a receipt that reads its
  // own success out of that return value is exactly the failure this pins.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "container_source_broken")
      session.client.state.snapshot = snapshotWith({ revision: receipt.revision, containerPresent: true });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /break_container_source_world_unchanged/);
});

test("break_container_source: a drop count that disagrees with the named drops fails the run", async () => {
  const session = run({ drops: ["(O)390"] });
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "container_source_broken")
      receipt.evidence = { detail: receipt.evidence.detail.replace("drop_count=1", "drop_count=3") };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /break_container_source_drop_count_mismatch/);
});

test("break_container_source: the not-a-container negative is asserted, and claiming a break fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.notAContainer, "break_container_source_not_a_container");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "break_container_source_not_a_container") {
      receipt.state = "succeeded";
      receipt.reasonCode = "container_source_broken";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "an object that is not a container must not be reported as broken");
});

test("break_container_source: the empty-slot negative is asserted, and a success on it fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.emptySlot, "break_container_source_tool_not_equipped_in_requested_slot");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "break_container_source_tool_not_equipped_in_requested_slot") {
      receipt.state = "succeeded";
      receipt.reasonCode = "container_source_broken";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a slot that holds no tool must not break anything");
});

test("break_container_source: the stale-target negative is asserted, and a success on it fails the run", async () => {
  const honest = run();
  const result = await honest.result();
  assert.equal(result.state, "passed");
  assert.equal(result.negative.staleTarget, "break_container_source_target_not_found");

  const forged = run();
  mutate(forged, (receipt) => {
    if (receipt.reasonCode === "break_container_source_target_not_found") {
      receipt.state = "succeeded";
      receipt.reasonCode = "container_source_broken";
    }
    return receipt;
  });
  const forgedResult = await forged.result();
  assert.equal(forgedResult.state, "blocked", "a target that is gone must not be reported as broken");
});

test("break_container_source: a stale-target refusal that moved the world fails the run", async () => {
  // The refusal is honest, but the Keg the run was still tracking disappeared with it.
  const session = run();
  mutate(session, (receipt, request) => {
    if (receipt.reasonCode === "break_container_source_target_not_found") {
      void request;
      session.client.state.snapshot = {
        ...session.client.state.snapshot,
        worldObjectTargets: session.client.state.snapshot.worldObjectTargets.filter((entry) => entry.targetId !== nonContainerTargetId),
      };
    }
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /break_container_source_stale_target_moved_world/);
});

test("break_container_source: a swing count that was never observed fails the run", async () => {
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "container_source_broken")
      receipt.evidence = { detail: receipt.evidence.detail.replace("swings=3", "swings=0") };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /break_container_source_swings_unobserved/);
});

test("break_container_source: a declared Given that is absent blocks the run", async () => {
  const session = run();
  session.client.state.snapshot = snapshotWith({ revision: 1, containerPresent: false });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /break_container_source_declared_given_absent/);
});
