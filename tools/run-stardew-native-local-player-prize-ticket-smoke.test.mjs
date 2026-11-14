/*
 * The redeem_prize_ticket live judgement, tested DIRECTLY, and the runner tested end to end.
 *
 * The judgement is pure, so the cases below drive `assertPrizeTicketRedemption` with the shapes a live run
 * could produce, one case per way that run could LIE. Every case that must fail is a state the Mod's own
 * success path cannot produce, and every one of them is a shape a receipt-only judgement would have
 * accepted:
 *
 *   - the ticket stack unchanged, or falling by two;
 *   - the prize never arriving, arriving short, or having been in the pack already;
 *   - the receipt's numbers disagreeing with the pack;
 *   - the receipt naming a level its own stat never held;
 *   - the stat not advancing;
 *   - a surface that cannot show the pack at all, which must read `not_checked` - never `true`, because
 *     "I could not look" and "the world did not move" must not read the same.
 *
 * The STALE REPLAY is no longer one of the pure function's inputs: the second request belongs to the
 * shared template's negative arm, so its two facts - the refusal by name, and the world it left behind -
 * are asserted by the runner cases at the bottom of this file, against the same fake-Mod shape the live
 * run produces.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPrizeTicketRedemption,
  runRedeemPrizeTicketSmoke,
} from "./run-stardew-native-local-player-prize-ticket-smoke.mjs";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";

const TICKET = "(O)PrizeTicket";
const PRIZE = "(O)688";

const pack = (...entries) =>
  entries.map(([qualifiedItemId, stack], slot) => ({ slot, qualifiedItemId, displayName: qualifiedItemId, stack }));
const before = () => pack([TICKET, 3], ["(O)388", 12]);
const after = () => pack([TICKET, 2], ["(O)388", 12], [PRIZE, 2]);
const evidence = (overrides = {}) => ({
  prize_level: "4",
  prize_item_id: PRIZE,
  prize_stack: "2",
  prize_held_before: "0",
  prize_held_after: "2",
  ticket_item_id: TICKET,
  tickets_before: "3",
  tickets_after: "2",
  prizes_claimed_before: "4",
  prizes_claimed_after: "5",
  prize_delivered: "true",
  ...overrides,
});
const judge = (overrides = {}) =>
  assertPrizeTicketRedemption({
    before: before(),
    after: after(),
    evidence: evidence(),
    ...overrides,
  });
const failed = (checks) =>
  Object.entries(checks)
    .filter(([, value]) => value === false || value === "not_checked")
    .map(([name]) => name);

test("the Mod's own success shape satisfies every check", () => {
  const checks = judge();
  assert.deepEqual(failed(checks), []);
  assert.equal(checks.prizeEnteredInventory, true);
  assert.equal(checks.ticketStackFellByOne, true);
  assert.equal(checks.claimedStatAdvanced, true);
});

test("a receipt whose ticket stack did not fall is refused", () => {
  const checks = judge({
    after: after().map((entry) => (entry.qualifiedItemId === TICKET ? { ...entry, stack: 3 } : entry)),
  });
  assert.equal(checks.ticketStackFellByOne, false);
  assert.ok(failed(checks).includes("ticketStackFellByOne"));
});

test("a receipt whose ticket stack fell by TWO is refused: that is destruction, not a redemption", () => {
  const checks = judge({
    after: after().map((entry) => (entry.qualifiedItemId === TICKET ? { ...entry, stack: 1 } : entry)),
  });
  assert.equal(checks.ticketStackFellByOne, false);
  assert.equal(checks.receiptAgreesWithWorld, false, "the receipt says 2 and the pack says 1");
});

test("a receipt whose prize never entered the pack is refused", () => {
  const checks = judge({ after: pack([TICKET, 2], ["(O)388", 12]) });
  assert.equal(checks.prizeEnteredInventory, false);
  assert.ok(failed(checks).includes("prizeEnteredInventory"));
});

test("a receipt whose prize arrived SHORT of the stack it named is refused", () => {
  const checks = judge({
    after: pack([TICKET, 2], [PRIZE, 1]),
    evidence: evidence({ prize_held_after: "1" }),
  });
  assert.equal(checks.prizeEnteredInventory, false);
});

test("a receipt naming a prize the pack ALREADY held proves nothing and is refused", () => {
  const checks = judge({
    before: pack([TICKET, 3], [PRIZE, 2]),
    after: pack([TICKET, 2], [PRIZE, 4]),
    evidence: evidence({ prize_held_before: "2", prize_held_after: "4" }),
  });
  assert.equal(checks.prizeEnteredInventory, false);
});

test("a receipt whose numbers disagree with the pack is refused", () => {
  const checks = judge({ evidence: evidence({ tickets_after: "0", prize_held_after: "9" }) });
  assert.equal(checks.receiptAgreesWithWorld, false);
  assert.equal(checks.prizeEnteredInventory, true, "the pack itself is fine; the receipt is the liar");
});

test("a receipt whose prize level is not the stat it claims to have read is refused", () => {
  const checks = judge({ evidence: evidence({ prize_level: "3" }) });
  assert.equal(checks.choiceNamed, false);
});

test("a receipt whose claimed stat did not advance is refused", () => {
  const checks = judge({ evidence: evidence({ prizes_claimed_after: "4" }) });
  assert.equal(checks.claimedStatAdvanced, false);
});

test("a surface that cannot show the pack reads not_checked, never true", () => {
  const checks = assertPrizeTicketRedemption({
    before: null,
    after: null,
    evidence: evidence(),
  });
  assert.equal(checks.ticketStackFellByOne, "not_checked");
  assert.equal(checks.prizeEnteredInventory, "not_checked");
  assert.equal(checks.receiptAgreesWithWorld, "not_checked");
  // The two facts the receipt alone carries are still judged, so a blind surface does not silently
  // turn the whole contract into a pass either.
  assert.equal(checks.choiceNamed, true);
  assert.deepEqual(failed(checks).sort(), ["prizeEnteredInventory", "receiptAgreesWithWorld", "ticketStackFellByOne"]);
});

test("a receipt that names no item, or a non-positive stack, is refused", () => {
  const unnamed = judge({ evidence: evidence({ prize_item_id: "", prize_stack: "0" }) });
  assert.equal(unnamed.prizeEnteredInventory, false);
  assert.equal(unnamed.choiceNamed, false);
  assert.equal(unnamed.receiptAgreesWithWorld, false);
});

/**
 * THE RUNNER ITSELF, driven end to end through the shared template.
 *
 * One fake Mod answers the same three calls the harness makes (`observe`, `execute`, and the receipt buffer the
 * terminal wait reads) and moves the pack the way the native exchange would: the first redemption spends the ticket
 * and delivers the prize, and the second request is the STALE REPLAY.
 */
const RUNNER_CAPABILITIES = ["cancel_active_execution", "inspect_self", "redeem_prize_ticket"];

function validConfig() {
  return {
    DeniedActions: [],
    DeniedActionFamilies: [],
    ExperimentalActions: [],
    NativeLocalPlayerFixture: {
      Enable: true,
      Bootstrap: { Enable: false },
      FixtureScenario: "native_prize_ticket_v1",
    },
  };
}

function snapshotWith(facts, revision = 1) {
  return {
    revision,
    location: "Town",
    tile: { x: 30, y: 20 },
    actionable: true,
    activeExecution: null,
    capabilities: RUNNER_CAPABILITIES,
    inventoryItemFacts: facts,
  };
}

function createFakeClient({
  negative = { state: "rejected", reasonCode: "prize_ticket_unavailable" },
  negativeWorld = null,
} = {}) {
  const receipts = [];
  let executions = 0;
  const client = {
    state: {
      catalogRegistrations: publishedActionRegistrations(),
      snapshot: snapshotWith(pack([TICKET, 1], ["(O)388", 12])),
      latestReceipt: null,
    },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      executions += 1;
      const current = client.state.snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: `prize-ticket-execution-${executions}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: current.revision,
      };
      if (executions === 1) {
        assert.deepEqual(request.args, {});
        client.state.snapshot = snapshotWith(pack([PRIZE, 2], ["(O)388", 12]), current.revision + 1);
        receipts.push({
          ...accepted,
          state: "succeeded",
          reasonCode: "prize_ticket_redeemed",
          revision: client.state.snapshot.revision,
          evidence: {
            detail: Object.entries(
              evidence({
                tickets_before: "1",
                tickets_after: "0",
                prize_held_before: "0",
                prize_held_after: "2",
                prize_level: "4",
                prizes_claimed_before: "4",
                prizes_claimed_after: "5",
              }),
            )
              .map(([key, value]) => `${key}=${value}`)
              .join(";"),
          },
        });
        return accepted;
      }
      if (negative.state === "rejected") {
        if (negativeWorld !== null) client.state.snapshot = snapshotWith(negativeWorld, current.revision + 1);
        receipts.push({ ...accepted, ...negative, revision: current.revision });
        return accepted;
      }
      client.state.snapshot = snapshotWith(negativeWorld ?? pack([PRIZE, 2]), current.revision + 1);
      receipts.push({ ...accepted, ...negative, revision: client.state.snapshot.revision });
      return accepted;
    },
  };
  return { client, receipts };
}

test("prize-ticket runner: the template refuses an unarmed fixture config before anything is sent", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runRedeemPrizeTicketSmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "native_local_redeem_prize_ticket_fixture_config_invalid");
});

test("prize-ticket runner: both halves of the exchange are read from the pack, and the replay is refused", async () => {
  const { client, receipts } = createFakeClient();
  const result = await runRedeemPrizeTicketSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "passed", result.reasonCode);
  assert.equal(result.reasonCode, "prize_ticket_redeemed");
  assert.deepEqual(Object.values(result.checks), [true, true, true, true, true]);
  assert.equal(result.negative, "measured:prize_ticket_unavailable");
});

test("prize-ticket runner: a stale replay that SUCCEEDED is refused", async () => {
  // THE FALSIFIER FOR THE NEGATIVE ARM: the world looks green, the first redemption is honest, and the second send -
  // the one the empty pack must refuse - reports success.
  const { client, receipts } = createFakeClient({
    negative: { state: "succeeded", reasonCode: "prize_ticket_redeemed" },
  });
  const result = await runRedeemPrizeTicketSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "redeem_prize_ticket_negative_not_refused:succeeded/prize_ticket_redeemed");
});

test("prize-ticket runner: a refusal that moved the pack anyway fails the run", async () => {
  // "Refused" and "redeemed a second time" must not read the same: a second prize appeared after the refusal.
  const { client, receipts } = createFakeClient({ negativeWorld: pack([PRIZE, 4], ["(O)388", 12]) });
  const result = await runRedeemPrizeTicketSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reasonCode,
    "redeem_prize_ticket_negative_moved_world:inventory:0:(O)688:2|1:(O)388:12->0:(O)688:4|1:(O)388:12",
  );
});

test("prize-ticket runner: a pack without the declared single ticket is refused before the request", async () => {
  const { client, receipts } = createFakeClient();
  client.state.snapshot = snapshotWith(pack([TICKET, 2]));
  const result = await runRedeemPrizeTicketSmoke(client, receipts, validConfig(), { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /^redeem_prize_ticket needs the fixture's single-ticket Given, saw 2/u);
  assert.equal(receipts.length, 0, "nothing may be sent when the Given is absent");
});
