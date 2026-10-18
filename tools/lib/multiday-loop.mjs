/**
 * The multi-day loop: run one day, watch the night it ends in, and do it again.
 *
 * WHO DOES WHAT, because this is the whole design:
 *
 *   - The COMPANION decides its day and decides when the day is over, by dispatching `advance_day`
 *     through its own tool. The loop never dispatches a night on its own: a night it chose would be a
 *     scripted crossing, not the companion's.
 *   - The loop does the ONE thing the companion physically cannot. `advance_day` is in flight while the
 *     night's end-of-night menus are raised, so the Agent is blocked inside its own tool call at exactly
 *     the moment a menu holds the actor. A menu left standing makes the lifecycle's day-start budget
 *     expire and mints `blocked/day_start_not_observed`, which reads like a hang. So the loop observes the
 *     rollover concurrently and clears what the product's own `dismiss_modal` is allowed to clear - and
 *     records the receipt, so "the menu was closed" is a product fact rather than an inference.
 *
 * Everything here is written against a small injectable `world` so the loop can be exercised without a
 * game: `observe()`, `dismiss()`, and the receipt buffer the dismissal writes into.
 */

import {
  DISMISSIBLE_ROLLOVER_MENUS,
  LEVEL_UP_MENU,
  MAXIMUM_BASELINE_DAYS,
  MINIMUM_BASELINE_DAYS,
  WAIT_ROLLOVER_MENUS,
} from "./multiday-baseline.mjs";

/** Poll spacing while a night rolls over (the same cadence the deterministic crossing uses). */
const POLL_INTERVAL_MS = 250;

/** How many times ONE menu type may be dismissed before its persistence is a named stop. */
export const MAX_DISMISS_ATTEMPTS = 3;

/**
 * Does this dismissal's receipt say the ENGINE owns completing the close?
 *
 * `dismiss_modal` commits the settlement menu through the engine's own path (the outro), because that outro is the
 * only thing that creates `SaveGameMenu` - and therefore the only thing that saves the night. So the menu
 * legitimately REMAINS on screen while the engine finishes it, and the receipt says so with `clearing=true`.
 * Measured 2026-10-18 (g42stall): three successful dismissals of the same ShippingMenu exhausted the attempts, the
 * night was recorded as `rollover_menu_not_cleared:ShippingMenu`, and the Mod's own lifecycle then finished the day
 * eight seconds later - a harness verdict about a night that worked.
 */
export function closeIsEngineCommitted(receipt) {
  if (receipt === null || receipt === undefined) return false;
  const text = typeof receipt === "string" ? receipt : JSON.stringify(receipt);
  return /clearing=true|close_effect=engine_shipping_commit/u.test(text);
}

/** The menu the actor is held by, in the shape the Mod reports it. */
export function readHeldMenu(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return null;
  if (snapshot.actorDispositionKind !== "modal") return null;
  const detail = snapshot.actorDispositionDetail;
  // A modal whose class the Mod could not name is still a hold; naming it "unknown" is how it stops by
  // name instead of being assumed away.
  return typeof detail === "string" && detail.length > 0 ? detail : "unknown";
}

/**
 * What to do about the menu holding the actor.
 *
 * `wait` is for engine- or action-owned modals that exit on their own (`SaveGameMenu` is the day-end
 * save; `DialogueBox` is the native sleep prompt the lifecycle itself answers; `ReadyCheckDialog` is the
 * shared-world barrier). `dismiss` is the one a rollover raises and the product's own action closes.
 *
 * `respond_level_up` is the third shape, and it is NOT the same as `dismiss`: an ACTIVE `LevelUpMenu`
 * grants its perk when it closes (`LevelUpMenu.cs:629-635`), so it has no pure-cancel path - it needs
 * `respond_level_up`. For an ORDINARY level there is exactly one legal value (`confirm`), so the watcher
 * can pass it without taking a decision on the companion's behalf, the same division of labour that lets
 * it dismiss `ShippingMenu` while the companion is blocked inside `advance_day`.
 *
 * A MILESTONE (5/10) is the case NO proxy may take: the two branches are a permanent part of the
 * companion's growth path, so choosing one here would be the harness deciding for it. That is reported by
 * name instead, and a scenario that cannot afford the stop must exclude milestones in its declared Given
 * (the multi-day Given pins the five skills at 10 for exactly this reason).
 */
export function decideHeldMenu(menuType) {
  if (menuType === null) return Object.freeze({ kind: "none", menuType: null });
  if (WAIT_ROLLOVER_MENUS.includes(menuType)) return Object.freeze({ kind: "wait", menuType });
  if (DISMISSIBLE_ROLLOVER_MENUS.includes(menuType)) return Object.freeze({ kind: "dismiss", menuType });
  if (menuType === LEVEL_UP_MENU) return Object.freeze({ kind: "respond_level_up", menuType });
  return Object.freeze({ kind: "blocked", menuType, reasonCode: `actor_held_by_unclosable_menu:${menuType}` });
}

/** A hold the Mod reports through its own disposition vocabulary (not a menu, so nothing to dismiss). */
export function classifyActorHold(snapshot) {
  const kind = typeof snapshot?.actorDispositionKind === "string" ? snapshot.actorDispositionKind : null;
  if (kind === "event") return Object.freeze({ hold: "cutscene", reasonCode: "actor_held_by_cutscene" });
  if (kind === "pass_out") return Object.freeze({ hold: "pass_out", reasonCode: "actor_passed_out" });
  return Object.freeze({ hold: null, reasonCode: null });
}

/**
 * Watch a night while the companion's own `advance_day` is in flight, clearing the menu it raises.
 *
 * The night is over when the actor becomes free again: either a new day has started (the snapshot's day
 * moved) or the actor is actionable with nothing holding it. The bounded wait is the caller's, and an
 * expired wait returns a NAMED reason rather than a result that looks like a pass.
 */
export async function watchRollover(
  world,
  {
    dayBefore,
    timeoutMs,
    pollIntervalMs = POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Asked first, every pass. A transport that died cannot support any claim about the night, so waiting out
    // the night budget would turn a dead pipe into a TIME-OUT that reads like a slow game (measured 2026-10-17:
    // the bridge died 15s into the first multi-day run and the loop waited minutes for a night that could
    // never arrive).
    abort = null,
  } = {},
) {
  const menus = [];
  const attempts = new Map();
  // Menu types whose close the ENGINE is completing: waited for, never re-sent.
  const committed = new Set();
  const deadline = now() + timeoutMs;
  for (;;) {
    const aborted = abort === null ? null : abort();
    if (aborted !== null && aborted !== undefined) {
      return Object.freeze({ crossed: false, reasonCode: aborted, menus });
    }
    const snapshot = await world.observe();
    const dayNow = typeof snapshot?.dayOfMonth === "number" ? snapshot.dayOfMonth : null;
    const menuType = readHeldMenu(snapshot);
    const decision = decideHeldMenu(menuType);
    if (menuType !== null && !menus.some((entry) => entry.menuType === menuType)) {
      menus.push({ menuType, decision: decision.kind });
    }
    if (decision.kind === "blocked") return Object.freeze({ crossed: false, reasonCode: decision.reasonCode, menus });
    const hold = classifyActorHold(snapshot);
    if (hold.reasonCode !== null) return Object.freeze({ crossed: false, reasonCode: hold.reasonCode, menus });

    if (decision.kind === "respond_level_up") {
      // The ordinary/milestone split is the whole point: `confirm` takes no decision, a branch would.
      // The world decides which one this is; a milestone comes back named and stops the run.
      const sent = attempts.get(menuType) ?? 0;
      if (sent >= MAX_DISMISS_ATTEMPTS) {
        return Object.freeze({ crossed: false, reasonCode: `rollover_level_up_not_resolved:${menuType}`, menus });
      }
      attempts.set(menuType, sent + 1);
      const outcome = await world.respondLevelUp();
      const entry = menus.find((candidate) => candidate.menuType === menuType);
      entry.respondReceipt = outcome?.receipt ?? null;
      entry.respondReasonCode = outcome?.reasonCode ?? null;
      entry.respondChoice = outcome?.choice ?? null;
      entry.levelUp = outcome?.levelUp ?? null;
      if (outcome?.reasonCode !== null && outcome?.reasonCode !== undefined) {
        return Object.freeze({ crossed: false, reasonCode: outcome.reasonCode, menus });
      }
    }

    if (decision.kind === "dismiss") {
      // A committed close is WAITED FOR. Re-sending it would stack outro commits on a menu the engine is already
      // closing, and counting those as failed attempts is what recorded a working night as uncleared.
      if (committed.has(menuType)) {
        if (now() >= deadline) {
          return Object.freeze({ crossed: false, reasonCode: `rollover_menu_not_cleared:${menuType}`, menus });
        }
        await sleep(pollIntervalMs);
        continue;
      }
      const sent = attempts.get(menuType) ?? 0;
      if (sent >= MAX_DISMISS_ATTEMPTS) {
        return Object.freeze({ crossed: false, reasonCode: `rollover_menu_not_cleared:${menuType}`, menus });
      }
      attempts.set(menuType, sent + 1);
      const outcome = await world.dismiss(menuType);
      const entry = menus.find((candidate) => candidate.menuType === menuType);
      entry.dismissReceipt = outcome.receipt ?? null;
      entry.dismissReasonCode = outcome.reasonCode ?? null;
      // A refusal is reported, not retried into a loop: the product's own receipt is the answer.
      if (outcome.reasonCode !== null && outcome.reasonCode !== undefined) {
        return Object.freeze({ crossed: false, reasonCode: outcome.reasonCode, menus });
      }
      // ...and a close the engine owns is not a failure: stop dispatching and let it complete.
      if (closeIsEngineCommitted(outcome?.receipt)) committed.add(menuType);
    }

    // The night is over once the world says so. A menu still holding the actor is not over, whatever the
    // calendar says - that ordering is the whole reason this loop exists.
    if (decision.kind === "none" && snapshot?.actionable === true && snapshot.activeExecution == null) {
      if (dayNow !== null && dayNow !== dayBefore) {
        return Object.freeze({ crossed: true, reasonCode: null, menus, dayAfter: dayNow, snapshot });
      }
    }
    if (now() >= deadline) {
      return Object.freeze({
        crossed: false,
        reasonCode: `night_not_observed:${String(snapshot?.actorDispositionKind ?? "unknown")}:${String(snapshot?.actorDispositionDetail ?? "none")}`,
        menus,
        dayAfter: dayNow,
      });
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Cross `crossNights` consecutive nights, each one a companion turn that ends in the companion's own night.
 *
 * The unit here is the NIGHT, not the day, because the night is what the baseline counts: a run of N days
 * ends N-1 nights, so asking for "two days" and asserting two crossings is off by one and is exactly the
 * kind of arithmetic that would make a passing run look red. `crossNights` is validated against the
 * baseline's own window so the two cannot drift.
 *
 * `runDay(index)` delivers a day's turn and returns what that day accomplished; `watchNight(index)` observes
 * the night that turn ends in. Both are injected, so this function holds only the sequencing and the record
 * shape - and the record is what the baseline gate judges.
 * THE ORDERING THAT MATTERS: a day's turn and its night's rollover OVERLAP. The companion ends its day by
 * dispatching `advance_day` inside its own turn, so the night begins while the Agent is still blocked in that
 * tool call - and that is exactly the window in which the settlement menu is raised. Awaiting the turn first
 * and watching the night afterwards would observe a night that had already stalled. The two therefore run
 * CONCURRENTLY, and that concurrency is this loop's whole reason to exist.
 *
 * N nights need N+1 day turns (the closing day the run works after the last night), and a day's work is what
 * proves the day it FOLLOWS was crossed by a companion that kept working. `crossNights` is validated against
 * the baseline's own window so the two cannot drift.
 */
export async function runMultiDayLoop({ crossNights, dayTurn, nightWatch, onDay = () => {} } = {}) {
  if (!Number.isInteger(crossNights) || crossNights < MINIMUM_BASELINE_DAYS || crossNights > MAXIMUM_BASELINE_DAYS) {
    throw new Error(`multiday_crossings_out_of_range:${String(crossNights)}`);
  }
  if (typeof dayTurn !== "function" || typeof nightWatch !== "function") throw new Error("multiday_callbacks_required");
  const dayRecords = [];
  for (let index = 0; index < crossNights; index += 1) {
    const day = index + 1;
    // Started together, on purpose: the night happens DURING the day's turn.
    const [worked, night] = await Promise.all([dayTurn(day), nightWatch(day)]);
    // This day's work is the work of the day AFTER the previous night, so it belongs on THAT record: the
    // baseline asks whether the loop kept going, and this is the evidence it asks for.
    if (dayRecords.length > 0)
      dayRecords[dayRecords.length - 1].nextDayAccomplishedActionIds = worked?.accomplishedActionIds ?? [];
    const record = {
      day,
      terminal: night.terminal ?? null,
      after: night.after ?? null,
      menus: night.menus ?? [],
      // Filled by the loop below once the day after this night has been played.
      nextDayAccomplishedActionIds: [],
    };
    dayRecords.push(record);
    onDay(record);
    if (night.reasonCode !== null && night.reasonCode !== undefined) {
      return Object.freeze({
        completed: false,
        dayRecords,
        reasonCode: night.reasonCode,
        daysCrossed: dayRecords.length - 1,
      });
    }
  }
  // The closing day: N nights end N+1 days, and the last night's record needs the day it opened.
  if (dayRecords.length > 0 && crossNights > 0) {
    const closing = await dayTurn(crossNights + 1);
    dayRecords[dayRecords.length - 1].nextDayAccomplishedActionIds = closing?.accomplishedActionIds ?? [];
  }
  return Object.freeze({
    completed: dayRecords.length === crossNights,
    dayRecords,
    reasonCode: null,
    daysCrossed: dayRecords.length,
  });
}
