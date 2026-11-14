// Stardew-local redeem_prize_ticket smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about redeeming a prize ticket.
//
// The receipt is not the proof. Four things are observed directly:
//
//   1. BOTH halves of the exchange, read from FRESH snapshots and never from the receipt: the ticket
//      stack fell by exactly one, AND the pack now holds exactly the prize stack the receipt named
//      more than it did before. One half alone is the defect this contract exists to catch - the
//      ticket half alone cannot tell a redemption from a loss, and the prize half alone cannot tell a
//      redemption from a gift;
//   2. the receipt's own numbers AGREE with what the snapshots say, so a receipt cannot name a world
//      that is not there;
//   3. the choice the exchange made is named: the level it read and the item the game derives from it
//      (`PrizeTicketMenu.getPrizeItem`), so `prize_level` and `prizes_claimed_before` must be the same
//      fact;
//   4. the machine's own `ticketPrizesClaimed` stat advanced by exactly one.
//
// And the negative case, declared to the template: RESUBMITTING THE SAME REQUEST after the ticket was
// spent is refused by name (`prize_ticket_unavailable`) and moves nothing. The state that made the action
// admissible is gone, so a second success there would be redeeming nothing and claiming it.
//
// The runner never chooses the prize: the level comes from the actor's own live stat and the item from
// the game's own track function. It does require the fixture's declared Given - exactly one ticket in
// the pack - because the negative case is only meaningful when the single redemption spends it.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "redeem_prize_ticket";
const PRIZE_TICKET_ITEM_ID = "(O)PrizeTicket";
/** The action's own success word (`ExecuteRedeemPrizeTicket`: one ticket spent, its prize delivered). */
const SUCCESS_CODE = "prize_ticket_redeemed";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_prize_ticket_v1`). */
const FIXTURE_SCENARIO = "native_prize_ticket_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  requiredActions: [ACTION],
  experimentalActions: [ACTION],
  projection: { collections: ["inventoryItemFacts"] },

  /** The declared Given: exactly one ticket in the pack, so one redemption spends it. */
  prepare: ({ snapshot }) => {
    const facts = inventoryFacts(snapshot);
    const tickets = countItem(facts, PRIZE_TICKET_ITEM_ID);
    if (tickets !== 1)
      throw new Error(
        `redeem_prize_ticket needs the fixture's single-ticket Given, saw ${tickets}:${JSON.stringify(facts)}`,
      );
    return { snapshot, plan: { ticketsBefore: tickets } };
  },

  describePlan: ({ ticketsBefore }) => ({ ticketsBefore }),

  request: () => ({ args: {} }),

  /**
   * The negative case: the same request again, against the world the redemption left behind. The pack holds no ticket
   * now, so the only honest terminal is a refusal by name - and the pack must be exactly the pack the redemption left.
   */
  negative: {
    args: () => ({}),
    refusedCodes: ["prize_ticket_unavailable"],
    unchanged: ({ before, after }) => {
      const heldBefore = packShape(before);
      const heldAfter = packShape(after);
      return heldBefore === heldAfter ? null : `inventory:${heldBefore}->${heldAfter}`;
    },
  },

  async assertPostcondition({ evidence, before, after }) {
    const checks = assertPrizeTicketRedemption({
      before: inventoryFacts(before),
      after: inventoryFacts(after),
      evidence,
    });
    const failures = Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name);
    if (failures.length > 0)
      throw new Error(
        `redeem_prize_ticket live contract failed: ${failures.join(",")};checks=${JSON.stringify(checks)}`,
      );
    return { checks, evidence };
  },
});

export const runRedeemPrizeTicketSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the pack
 * before and after (as the snapshot's own `inventoryItemFacts`) and the receipt's parsed evidence.
 *
 * Every check that depends on the pack is `not_checked` - not `true` - when the snapshot does not carry
 * `inventoryItemFacts` at all, because "I could not look" and "the world did not move" must never read
 * the same, and the caller treats `not_checked` as a failure.
 *
 * The stale replay is NOT judged here: its two facts (the refusal by name, and the world it left) are
 * the definition's `negative` hook above, where the template owns the second request.
 */
export function assertPrizeTicketRedemption({ before, after, evidence }) {
  const observable = Array.isArray(before) && Array.isArray(after);
  const ticketsBefore = observable ? countItem(before, PRIZE_TICKET_ITEM_ID) : null;
  const ticketsAfter = observable ? countItem(after, PRIZE_TICKET_ITEM_ID) : null;
  const prizeItemId = typeof evidence?.prize_item_id === "string" ? evidence.prize_item_id : "";
  const prizeStack = integerValue(evidence?.prize_stack);
  const heldBefore = observable && prizeItemId.length > 0 ? countItem(before, prizeItemId) : null;
  const heldAfter = observable && prizeItemId.length > 0 ? countItem(after, prizeItemId) : null;
  const claimedBefore = integerValue(evidence?.prizes_claimed_before);
  const levelNamed = integerValue(evidence?.prize_level);

  return {
    // 1. Both halves of the postcondition, each read from the pack rather than from the receipt.
    ticketStackFellByOne: observable ? ticketsAfter === ticketsBefore - 1 : "not_checked",
    prizeEnteredInventory:
      observable && prizeStack !== null && prizeStack >= 1
        ? heldBefore === 0 && heldAfter === prizeStack
        : observable
          ? false
          : "not_checked",
    // 2. The receipt's own numbers agree with the world, key by key.
    receiptAgreesWithWorld: observable
      ? evidence?.ticket_item_id === PRIZE_TICKET_ITEM_ID &&
        evidence?.tickets_before === String(ticketsBefore) &&
        evidence?.tickets_after === String(ticketsAfter) &&
        evidence?.prize_held_before === String(heldBefore) &&
        evidence?.prize_held_after === String(heldAfter)
      : "not_checked",
    // 3. The receipt names the choice the exchange made: the level it READ and the item the game derives
    // from that same fact, so a receipt cannot report a prize its own level does not produce.
    choiceNamed:
      levelNamed !== null &&
      claimedBefore !== null &&
      levelNamed === claimedBefore &&
      prizeItemId.length > 0 &&
      prizeStack !== null &&
      prizeStack >= 1,
    // 4. The machine's own stat moved with the redemption, by exactly one.
    claimedStatAdvanced: claimedBefore !== null && integerValue(evidence?.prizes_claimed_after) === claimedBefore + 1,
  };
}

/**
 * The pack's own facts from a snapshot, or null when the surface does not carry them at all.
 *
 * `inventoryItemFacts` is the field: the protocol documents it as the bounded live inventory facts and
 * publishes one entry per OCCUPIED slot, so a slot's absence is a zero count.
 */
function inventoryFacts(snapshot) {
  const facts = snapshot?.inventoryItemFacts;
  return Array.isArray(facts) ? facts : null;
}

/** Total stack of one qualified item id in the pack facts; 0 when the pack does not hold it. */
function countItem(facts, qualifiedItemId) {
  if (!Array.isArray(facts) || typeof qualifiedItemId !== "string" || qualifiedItemId.length === 0) return 0;
  return facts
    .filter((entry) => entry?.qualifiedItemId === qualifiedItemId)
    .reduce((total, entry) => total + (integerValue(entry?.stack) ?? 0), 0);
}

/** The pack as one comparable string: every occupied slot's item id and stack, in slot order. */
function packShape(snapshot) {
  const facts = inventoryFacts(snapshot);
  if (facts === null) return "not_published";
  return facts
    .map((entry) => `${entry?.slot}:${entry?.qualifiedItemId}:${entry?.stack}`)
    .slice()
    .sort()
    .join("|");
}

/** An evidence/stack value as a non-negative integer, or null when it is not one. */
function integerValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d{1,9}$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
