import assert from "node:assert/strict";
import test from "node:test";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { runPlaceItemOnPedestalSmoke } from "./run-stardew-native-local-player-place-item-on-pedestal-smoke.mjs";

const ACTION = "place_item_on_pedestal";
const ITEM = "(O)388";
const SLOT = 1;
const TILE = { x: 14, y: 11 };
const PACK = 2;

/**
 * The id `BuildPedestalDepositTargetId` mints: location, tile and the pedestal's OWN item id, and nothing the deposit
 * changes - which is what makes it the same id on both sides of the refusal.
 */
const PEDESTAL_ID = "pedestal_deposit_0123456789abcdef";
const OTHER_PEDESTAL_ID = "pedestal_deposit_ffffffffffffffff";

/**
 * The world the runner reads. The pedestal row is published ONLY while the pedestal holds nothing, so the occupied world
 * carries no row for it: the row's presence is the emptiness fact, and its disappearance is the deposit's.
 */
function snapshotWith({ revision, empty = true, carried = PACK }) {
  return {
    revision,
    location: "Farm",
    tile: { x: TILE.x, y: TILE.y + 1 },
    actionable: true,
    activeExecution: null,
    inventorySlots: 12,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    // Only `kind`, `targetId` and the tile are this contract's; the row's item fields are the pedestal's own.
    worldObjectTargets: empty ? [{ targetId: PEDESTAL_ID, kind: "empty_pedestal", location: "Farm", x: TILE.x, y: TILE.y, slot: -1 }] : [],
    inventoryItemFacts: carried > 0 ? [{ slot: SLOT, qualifiedItemId: ITEM, stack: carried }] : [],
  };
}

/**
 * The runner is the unit under test, so the client answers the calls the harness makes and moves the world the way the
 * native branch would: the deposit lands only when the request named the id the pedestal on that tile actually answers,
 * and the pedestal's own publication stops naming it as empty exactly then.
 */
function makeClient({ empty = true } = {}) {
  const receipts = [];
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: snapshotWith({ revision: 1, empty }) },
    // Read through the client, not a closure: a test that rewrites state must change what the runner observes.
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const state = client.state.snapshot;
      const pedestal = (state.worldObjectTargets ?? []).find((row) => row.kind === "empty_pedestal");
      const carried = (state.inventoryItemFacts ?? []).find((row) => row.qualifiedItemId === ITEM);
      let receipt;
      if (request.args.expectedTargetId !== PEDESTAL_ID || pedestal === undefined) {
        // `TryDescribePedestal` re-derives the id from the pedestal standing on the tile and refuses one that differs,
        // before it looks at the pack or the pedestal's state.
        receipt = {
          requestId: request.requestId,
          executionId: "place-item-on-pedestal-execution-refused",
          state: "rejected",
          reasonCode: "pedestal_target_changed",
          revision: state.revision + 1,
          evidence: {
            detail: `target=${request.args.x},${request.args.y};location=Farm;published=${request.args.expectedTargetId};live=none`,
          },
        };
      } else {
        receipt = {
          requestId: request.requestId,
          executionId: "place-item-on-pedestal-execution",
          state: "succeeded",
          reasonCode: "pedestal_item_placed",
          revision: state.revision + 1,
          evidence: {
            detail:
              `target=${PEDESTAL_ID};tile=${TILE.x},${TILE.y};item=${ITEM};held=${ITEM};native_answered=true;` +
              `carried_before=${carried.stack};carried_after=${carried.stack - 1}`,
          },
        };
        client.state.snapshot = snapshotWith({ revision: receipt.revision, empty: false, carried: carried.stack - 1 });
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
    result: () => runPlaceItemOnPedestalSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

/** Rewrite the client's execute, keeping the honest behaviour available. */
function mutate(session, rewrite) {
  const original = session.client.execute;
  session.client.execute = async (request) => rewrite(await original(request), request, session);
}

test("place_item_on_pedestal: the pedestal's own row carries both states, and the stale address is refused", async () => {
  const result = await run().result();
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.reasonCode, "pedestal_item_placed");
  assert.equal(result.target, PEDESTAL_ID);
  assert.equal(result.item, ITEM);
  assert.equal(result.negative.staleTarget, "pedestal_target_changed");
});

test("place_item_on_pedestal: a deposit the world still advertises as empty fails the run", async () => {
  // The receipt claims the pedestal's heldObject is this item, and the world's own projection still publishes the
  // pedestal as empty. A green receipt is not evidence, and an assertion that read the pack alone would pass here.
  const session = run();
  mutate(session, (receipt, _request, current) => {
    if (receipt.state === "succeeded")
      current.client.state.snapshot = snapshotWith({ revision: receipt.revision, empty: true, carried: PACK - 1 });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_item_on_pedestal_pedestal_still_advertised_empty/);
});

test("place_item_on_pedestal: a refused stale address that moved the pedestal fails the run", async () => {
  // The refusal is honest and the pedestal stopped being advertised as empty anyway, which means something placed into
  // the tile the stale request named.
  const session = run();
  mutate(session, (receipt, _request, current) => {
    if (receipt.reasonCode === "pedestal_target_changed")
      current.client.state.snapshot = snapshotWith({ revision: receipt.revision, empty: false, carried: PACK });
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_item_on_pedestal_stale_target_moved_the_world/);
});

test("place_item_on_pedestal: a stale address reported as a success fails the run", async () => {
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.reasonCode === "pedestal_target_changed") {
      receipt.state = "succeeded";
      receipt.reasonCode = "pedestal_item_placed";
    }
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked", "a never-published target id must not be reported as a deposit");
  assert.match(result.reasonCode, /place_item_on_pedestal_stale_target_not_refused/);
});

test("place_item_on_pedestal: a receipt that did not spend a carried item fails the run", async () => {
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace(`carried_after=${PACK - 1}`, `carried_after=${PACK}`) };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_item_on_pedestal_pack_not_charged/);
});

test("place_item_on_pedestal: a receipt whose held item is not the deposited one fails the run", async () => {
  // The occupied side of this action has no publication of its own (no family names a pedestal holding an item in this
  // world), so the receipt's `held` reading is what names WHICH item the pedestal now holds. It is asserted, not trusted.
  const session = run();
  mutate(session, (receipt) => {
    if (receipt.state === "succeeded")
      receipt.evidence = { detail: receipt.evidence.detail.replace(`held=${ITEM}`, "held=(O)390") };
    return receipt;
  });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_item_on_pedestal_evidence_held/);
});

test("place_item_on_pedestal: a world that publishes two empty pedestals blocks the run", async () => {
  // The Given stages exactly one; a second row would mean the run is not about the world this contract describes.
  const session = run();
  session.client.state.snapshot = {
    ...session.client.state.snapshot,
    worldObjectTargets: [
      { targetId: PEDESTAL_ID, kind: "empty_pedestal", location: "Farm", x: TILE.x, y: TILE.y, slot: -1 },
      { targetId: OTHER_PEDESTAL_ID, kind: "empty_pedestal", location: "Farm", x: TILE.x + 2, y: TILE.y, slot: -1 },
    ],
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /place_item_on_pedestal_empty_pedestal_count:2/);
});
