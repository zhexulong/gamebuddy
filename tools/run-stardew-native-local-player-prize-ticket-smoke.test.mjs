/*
 * The redeem_prize_ticket live judgement, tested DIRECTLY.
 *
 * No transport, no fake Mod: the cases drive `assertPrizeTicketRedemption` with the shapes a live run
 * could produce, one case per way that run could LIE. Every case that must fail is a state the Mod's
 * own success path cannot produce, and every one of them is a shape a receipt-only judgement would have
 * accepted:
 *
 *   - the ticket stack unchanged, or falling by two;
 *   - the prize never arriving, arriving short, or having been in the pack already;
 *   - the receipt's numbers disagreeing with the pack;
 *   - the receipt naming a level its own stat never held;
 *   - the stat not advancing;
 *   - a stale replay that succeeded, or that was refused while the world moved anyway;
 *   - a surface that cannot show the pack at all, which must read `not_checked` - never `true`, because
 *     "I could not look" and "the world did not move" must not read the same.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { assertPrizeTicketRedemption } from "./run-stardew-native-local-player-prize-ticket-smoke.mjs";

const TICKET = "(O)PrizeTicket";
const PRIZE = "(O)688";

const pack = (...entries) => entries.map(([qualifiedItemId, stack], slot) => ({ slot, qualifiedItemId, displayName: qualifiedItemId, stack }));
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
const stale = (overrides = {}) => ({
  state: "rejected",
  reasonCode: "prize_ticket_unavailable",
  after: after(),
  ...overrides,
});
const judge = (overrides = {}) =>
  assertPrizeTicketRedemption({
    before: before(),
    after: after(),
    evidence: evidence(),
    stale: stale(),
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
  assert.equal(checks.staleTicketRefused, true);
});

test("a receipt whose ticket stack did not fall is refused", () => {
  const checks = judge({ after: after().map((entry) => (entry.qualifiedItemId === TICKET ? { ...entry, stack: 3 } : entry)) });
  assert.equal(checks.ticketStackFellByOne, false);
  assert.ok(failed(checks).includes("ticketStackFellByOne"));
});

test("a receipt whose ticket stack fell by TWO is refused: that is destruction, not a redemption", () => {
  const checks = judge({ after: after().map((entry) => (entry.qualifiedItemId === TICKET ? { ...entry, stack: 1 } : entry)) });
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

test("a stale replay that SUCCEEDED is refused, however green its world looks", () => {
  const checks = judge({ stale: stale({ state: "succeeded", reasonCode: "prize_ticket_redeemed" }) });
  assert.equal(checks.staleTicketRefused, false);
});

test("a stale replay that was refused while the world moved anyway is refused", () => {
  const checks = judge({ stale: stale({ after: pack([TICKET, 1], [PRIZE, 4]) }) });
  assert.equal(checks.staleWorldUnchanged, false);
});

test("a surface that cannot show the pack reads not_checked, never true", () => {
  const checks = assertPrizeTicketRedemption({ before: null, after: null, evidence: evidence(), stale: { state: "rejected", reasonCode: "prize_ticket_unavailable", after: null } });
  assert.equal(checks.ticketStackFellByOne, "not_checked");
  assert.equal(checks.prizeEnteredInventory, "not_checked");
  assert.equal(checks.receiptAgreesWithWorld, "not_checked");
  assert.equal(checks.staleWorldUnchanged, "not_checked");
  // The two facts the receipt alone carries are still judged, so a blind surface does not silently
  // turn the whole contract into a pass either.
  assert.equal(checks.choiceNamed, true);
  assert.deepEqual(failed(checks).sort(), ["prizeEnteredInventory", "receiptAgreesWithWorld", "staleWorldUnchanged", "ticketStackFellByOne"]);
});

test("a receipt that names no item, or a non-positive stack, is refused", () => {
  const unnamed = judge({ evidence: evidence({ prize_item_id: "", prize_stack: "0" }) });
  assert.equal(unnamed.prizeEnteredInventory, false);
  assert.equal(unnamed.choiceNamed, false);
  assert.equal(unnamed.receiptAgreesWithWorld, false);
});
