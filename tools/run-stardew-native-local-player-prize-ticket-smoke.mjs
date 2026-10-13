import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "redeem_prize_ticket";
const PRIZE_TICKET_ITEM_ID = "(O)PrizeTicket";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * redeem_prize_ticket live contract.
 *
 * The receipt is not the proof. Five things are observed directly:
 *
 *   1. BOTH halves of the exchange, read from FRESH snapshots and never from the receipt: the ticket
 *      stack fell by exactly one, AND the pack now holds exactly the prize stack the receipt named
 *      more than it did before. One half alone is the defect this contract exists to catch - the
 *      ticket half alone cannot tell a redemption from a loss, and the prize half alone cannot tell a
 *      redemption from a gift;
 *   2. the receipt's own numbers AGREE with what the snapshots say, so a receipt cannot name a world
 *      that is not there;
 *   3. the choice the exchange made is named: the level it read and the item the game derives from it
 *      (`PrizeTicketMenu.getPrizeItem`), so `prize_level` and `prizes_claimed_before` must be the same
 *      fact;
 *   4. the machine's own `ticketPrizesClaimed` stat advanced by exactly one;
 *   5. RESUBMITTING THE SAME REQUEST after the ticket was spent is refused by name
 *      (`prize_ticket_unavailable`) and moves nothing. That is the negative case: the state that made
 *      the action admissible is gone, so a second success there would be redeeming nothing and
 *      claiming it, and a silent success fails the run rather than passing on a green receipt.
 *
 * The runner never chooses the prize: the level comes from the actor's own live stat and the item from
 * the game's own track function. It does require the fixture's declared Given - exactly one ticket in
 * the pack - because check 5 is only meaningful when the single redemption spends it.
 */
export async function runRedeemPrizeTicketSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const before = inventoryFacts(snapshot);
  const ticketsBefore = countItem(before, PRIZE_TICKET_ITEM_ID);
  if (ticketsBefore !== 1)
    throw new Error(
      `redeem_prize_ticket needs the fixture's single-ticket Given, saw ${ticketsBefore}:${JSON.stringify(before)}`,
    );

  const requestId = `native_local_redeem_prize_ticket_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: {},
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ step: "redeem", action: ACTION, ticketsBefore, receipt: summarizeReceipt(accepted) });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("redeem_prize_ticket terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "prize_ticket_redeemed")
    throw new Error(
      `redeem_prize_ticket did not redeem: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const evidence = parseEvidence(terminal.evidence);
  const after = inventoryFacts(await observeFresh(client, { actionable: true }));

  // The negative case: the same request again, against the world the redemption left behind. The
  // pack holds no ticket now, so the only honest terminal is a refusal by name.
  const staleId = `native_local_redeem_prize_ticket_stale_${Date.now()}`;
  const stale = await executeFresh(client, {
    requestId: staleId,
    idempotencyKey: `${staleId}_idem`,
    action: ACTION,
    args: {},
    snapshot: await observeFresh(client, { actionable: true }),
    timeoutMs: 30_000,
  });
  const staleTerminal = await waitForTerminal(receipts, stale, terminalTimeoutMs);
  const staleAfter = inventoryFacts(await observeFresh(client, { actionable: true }));

  const checks = assertPrizeTicketRedemption({
    before,
    after,
    evidence,
    stale: {
      state: staleTerminal.state,
      reasonCode: staleTerminal.reasonCode,
      after: staleAfter,
    },
  });
  trace.push({
    step: "observed",
    evidence,
    checks,
    staleReceipt: summarizeReceipt(staleTerminal),
  });

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`redeem_prize_ticket live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "prize_ticket_redeemed", trace, checks, evidence };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the pack
 * before and after (as the snapshot's own `inventoryItemFacts`), the receipt's parsed evidence, and the
 * stale resubmission's terminal plus the pack it left behind.
 *
 * Every check that depends on the pack is `not_checked` - not `true` - when the snapshot does not carry
 * `inventoryItemFacts` at all, because "I could not look" and "the world did not move" must never read
 * the same, and the caller treats `not_checked` as a failure.
 */
export function assertPrizeTicketRedemption({ before, after, evidence, stale }) {
  const observable = Array.isArray(before) && Array.isArray(after);
  const ticketsBefore = observable ? countItem(before, PRIZE_TICKET_ITEM_ID) : null;
  const ticketsAfter = observable ? countItem(after, PRIZE_TICKET_ITEM_ID) : null;
  const prizeItemId = typeof evidence?.prize_item_id === "string" ? evidence.prize_item_id : "";
  const prizeStack = integerValue(evidence?.prize_stack);
  const heldBefore = observable && prizeItemId.length > 0 ? countItem(before, prizeItemId) : null;
  const heldAfter = observable && prizeItemId.length > 0 ? countItem(after, prizeItemId) : null;
  const staleObservable = Array.isArray(stale?.after);
  const staleTicketsAfter = staleObservable ? countItem(stale.after, PRIZE_TICKET_ITEM_ID) : null;
  const stalePrizeAfter = staleObservable && prizeItemId.length > 0 ? countItem(stale.after, prizeItemId) : null;
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
    choiceNamed: levelNamed !== null && claimedBefore !== null && levelNamed === claimedBefore && prizeItemId.length > 0 && prizeStack !== null && prizeStack >= 1,
    // 4. The machine's own stat moved with the redemption, by exactly one.
    claimedStatAdvanced: claimedBefore !== null && integerValue(evidence?.prizes_claimed_after) === claimedBefore + 1,
    // 5. The stale replay is refused by name, and the world it left behind is the world the redemption
    // left behind: no second prize, no second ticket spent.
    staleTicketRefused: stale?.state === "rejected" && stale?.reasonCode === "prize_ticket_unavailable",
    staleWorldUnchanged: staleObservable
      ? staleTicketsAfter === ticketsAfter && stalePrizeAfter === heldAfter
      : "not_checked",
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

/** An evidence/stack value as a non-negative integer, or null when it is not one. */
function integerValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d{1,9}$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `key=value;key=value` — the Mod's evidence shape. */
function parseEvidence(evidence) {
  const text = typeof evidence === "string" ? evidence : (evidence?.detail ?? "");
  const values = {};
  for (const field of String(text).split(";")) {
    const at = field.indexOf("=");
    if (at <= 0) continue;
    values[field.slice(0, at)] = field.slice(at + 1);
  }
  return values;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runRedeemPrizeTicketSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
