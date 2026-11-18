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
  NIGHT_CAUSE_PASS_OUT,
  WAIT_ROLLOVER_MENUS,
} from "./multiday-baseline.mjs";

/**
 * The longest the watcher will go without looking at the world, when nothing wakes it sooner.
 *
 * It used to be 250 ms, and that cadence was measured on `round56`: **742** observations inside ONE night window of
 * 208.6 s (period median 289 ms, longest run 208.6 s unbroken), to detect an event - a day rollover - that happens about
 * once per twenty real minutes. The product has no publisher timer (the Mod publishes when asked, or on a real
 * transition), so those 742 asks bought 742 rebuilds of a whole snapshot on the game thread and nothing else: 618 of the
 * run's 624 suppressed flushes carried no fact at all, and each of them was one of these asks.
 *
 * Two seconds is a third of the engine's own clock tick (ten in-game minutes is about seven real seconds at the shipped
 * rate), so a clock that moved is still sampled at least three times before the next tick, and it is one sixtieth of the
 * shortest hold this loop waits out (`eventWaitMs` = 120 s). A caller that has the world's facts passes `waitForLook`
 * (`worldFactWake`), and then this is not the cadence at all - it is the ceiling a silent world falls back to.
 */
const LOOK_CEILING_MS = 2_000;

/** How many times ONE menu type may be dismissed before its persistence is a named stop. */
const MAX_DISMISS_ATTEMPTS = 3;

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
  // The settlement summary's commit lives in `SleepAndAdvanceDayLifecycle`, so this loop waits for it rather than
  // clicking it. Waiting is not ignoring: a summary that stands with nothing changing behind it expires as
  // `rollover_menu_deadlock` (`unattendedHoldReason`), not as a slow night.
  if (DISMISSIBLE_ROLLOVER_MENUS.includes(menuType)) return Object.freeze({ kind: "wait", menuType });
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
 * The facts one observation publishes, as one comparable string.
 *
 * A menu standing is not by itself a stall: a save on a big farm stands for a while with the game's own clock
 * running behind it. What separates "slow" from "nothing owns this" is that every published fact stops moving at
 * once, so the comparison covers what the Mod actually sends each pass rather than the menu type alone.
 */
function observedFactsKey(snapshot) {
  return JSON.stringify([
    snapshot?.dayOfMonth ?? null,
    snapshot?.timeOfDay ?? null,
    snapshot?.actionable === true,
    snapshot?.actorDispositionKind ?? null,
    snapshot?.actorDispositionDetail ?? null,
    snapshot?.activeExecution == null ? null : true,
  ]);
}

/**
 * Name a spent budget for what it watched, when what it watched was a deadlock.
 *
 * `541775c2` moved the settlement summary's commit into `SleepAndAdvanceDayLifecycle`, and that is why this loop
 * waits instead of clicking it: a harness that clicks proves the harness. But the lifecycle exists only when
 * `advance_day` started one. Measured 2026-10-28 (`round6`): the companion never dispatched it, the engine's 02:00
 * pass-out took the night, the day began with the summary standing, and the wait spent 31 of that run's 45.79
 * minutes before answering `night_never_started` - a word that reads exactly like a slow night. The evidence that
 * distinguishes the two was already in hand: the same menu type, without one published fact moving, and nothing in
 * flight. This names it, and it does NOT close the menu - the owner is the lifecycle's, and a harness that dismisses
 * it measures itself.
 *
 * The population comes from the loop's OWN decision rather than a second list: `wait` is exactly the set of menus
 * nothing here will ever close, which is what makes "unattended" a fact about this loop rather than a guess about the
 * game. `respond_level_up` is acted on, and `blocked` stops at once, so neither can stand unattended.
 */
function unattendedHoldReason({ hold, actionableChanged, inFlight, at }) {
  if (hold === null) return null;
  if (decideHeldMenu(hold.menuType).kind !== "wait") return null;
  // One observation is not "unchanged": there is nothing to have stayed the same across.
  if (hold.unchangedObservations < 2) return null;
  // An execution in flight IS an owner. The world may be stalled for some other reason, and the deadlock word would be
  // a claim about a menu nothing observed to be unattended.
  if (inFlight !== null && inFlight !== undefined) return null;
  return [
    `rollover_menu_deadlock:${hold.menuType}`,
    `held_ms=${String(at - hold.since)}`,
    `unchanged_ms=${String(at - hold.unchangedSince)}`,
    `unchanged_observations=${String(hold.unchangedObservations)}`,
    `actionable_changed=${String(actionableChanged)}`,
  ].join(":");
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
    // The longest the loop will go without looking again; `waitForLook` is what normally ends the wait sooner.
    lookCeilingMs = LOOK_CEILING_MS,
    // WHAT WAKES THE LOOP. A timer by default; a caller holding the world's own facts passes a function that resolves
    // on the next statement the world makes and falls back to the ceiling (see `worldFactWake`). The distinction is not
    // stylistic: the timer is why a night was observed at 3.56 Hz for 208.6 s, and the fact is the event it was
    // watching for. Resolved below rather than here, because a destructuring default cannot read `sleep`.
    waitForLook = null,
    // How long an `event` hold may stand before it is a named stop rather than a world still loading. A day-start
    // transition is the common case and clears in about two seconds; a SAVE can hold it for tens of seconds, so the
    // bound is generous and the calendar (above) is what decides a crossing, not this clock.
    eventWaitMs = 120_000,
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
  // The cadence: the caller's trigger when it has one, else the interval between two looks.
  const lookWhen = waitForLook ?? sleep;
  // Menu types whose close the ENGINE is completing: waited for, never re-sent.
  const deadline = now() + timeoutMs;
  // The hold under watch and the facts under it: how long the same menu has stood, how long NOTHING the Mod publishes
  // has changed, and whether the actor was ever free. Together these are what tells a slow night from one nothing is
  let cutsceneSince = null;
  // closing, and the expiry at the bottom of this loop reports the difference by name.
  let holdUnderWatch = null;
  let actionableAtFirstObservation = null;
  let actionableChanged = false;
  for (;;) {
    const aborted = abort === null ? null : abort();
    if (aborted !== null && aborted !== undefined) {
      return Object.freeze({ crossed: false, reasonCode: aborted, menus });
    }
    const snapshot = await world.observe();
    const dayNow = typeof snapshot?.dayOfMonth === "number" ? snapshot.dayOfMonth : null;
    const menuType = readHeldMenu(snapshot);
    const decision = decideHeldMenu(menuType);
    const observedNow = now();
    const factsKey = observedFactsKey(snapshot);
    if (menuType === null) {
      holdUnderWatch = null;
    } else if (holdUnderWatch === null || holdUnderWatch.menuType !== menuType) {
      holdUnderWatch = {
        menuType,
        since: observedNow,
        factsKey,
        unchangedSince: observedNow,
        unchangedObservations: 1,
      };
    } else if (holdUnderWatch.factsKey !== factsKey) {
      holdUnderWatch.factsKey = factsKey;
      holdUnderWatch.unchangedSince = observedNow;
      holdUnderWatch.unchangedObservations = 1;
    } else {
      holdUnderWatch.unchangedObservations += 1;
    }
    const actionable = snapshot?.actionable === true;
    if (actionableAtFirstObservation === null) actionableAtFirstObservation = actionable;
    else if (actionable !== actionableAtFirstObservation) actionableChanged = true;
    // A menu that was HELD and is now gone was closed by whoever owns it. That is the only observation the harness has
    // for the shipping summary now that the night lifecycle commits it: the loop does not click, so a receipt would be a
    // fiction, but "it was there and now it is not" is a fact the world hands over for free.
    for (const entry of menus) {
      if (entry.clearedAt === undefined && entry.menuType !== menuType) entry.clearedAt = now();
    }
    if (menuType !== null && !menus.some((entry) => entry.menuType === menuType)) {
      menus.push({ menuType, decision: decision.kind });
    }
    if (decision.kind === "blocked") return Object.freeze({ crossed: false, reasonCode: decision.reasonCode, menus });
    // A day-start transition publishes itself as an `event` hold, and the loop used to answer it at once - measured
    // 2026-11-09 (round40): six seconds into day 6, while the world was still fading in (heartbeat `can_move=False`,
    // `fade=0.76`, then `fade=-0.01` two seconds later), the run was declared `actor_held_by_cutscene` and stopped with
    // one of two nights crossed. Nothing was wrong with the world; the watcher sampled a transition and called it a
    // verdict. An event that clears on its own is a WAIT, and the bound below is what makes "it cleared" and "it never
    // will" two different answers. `timeoutMs <= 0` keeps the old immediate answer, because a caller that asked for no
    // waiting at all is asking a different question.
    const hold = classifyActorHold(snapshot);
    if (hold.reasonCode !== null) {
      // AN EVENT HOLD DOES NOT OUTRANK THE CALENDAR.
      //
      // Measured 2026-11-09 (round40, second attempt): the companion slept at 21:40, the night advanced, and the watcher
      // then spent its whole event budget watching the new day's own transition - `actor_held_by_cutscene:waited_ms=20124`
      // - and reported the night as uncrossed, on a day record whose own terminal said `day_advanced`. A menu may hold
      // the night because the harness must not close it; a cutscene has already let the world move, and the day moving
      // IS the crossing. So for an event hold the calendar is consulted FIRST, and only a calendar that has not moved
      // keeps the watcher waiting.
      const calendarMoved = dayNow !== null && dayNow !== dayBefore;
      const waitable = hold.hold === "cutscene" && timeoutMs > 0;
      if (calendarMoved && hold.hold === "cutscene") {
        return Object.freeze({ crossed: true, reasonCode: null, menus, dayAfter: dayNow, snapshot });
      }
      if (!waitable) return Object.freeze({ crossed: false, reasonCode: hold.reasonCode, menus });
      if (cutsceneSince === null) cutsceneSince = observedNow;
      const waitedMs = observedNow - cutsceneSince;
      if (waitedMs >= eventWaitMs) {
        return Object.freeze({
          crossed: false,
          reasonCode: `${hold.reasonCode}:waited_ms=${String(waitedMs)}`,
          menus,
        });
      }
    } else {
      cutsceneSince = null;
    }

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

    // `ShippingMenu` used to be dismissed from HERE, while the companion was blocked inside `advance_day`. That made a
    // run report "the companion crossed the night" while the harness clicked the menu - it proved the harness. The
    // lifecycle now commits the summary itself (`SleepAndAdvanceDayLifecycle.CommitShippingSummary`), so this loop only
    // WAITS: a summary still standing after the product's own path could not close it is a named stop, not a task.

    // The night is over once the world says so. A menu still holding the actor is not over, whatever the
    // calendar says - that ordering is the whole reason this loop exists.
    if (decision.kind === "none" && snapshot?.actionable === true && snapshot.activeExecution == null) {
      if (dayNow !== null && dayNow !== dayBefore) {
        return Object.freeze({ crossed: true, reasonCode: null, menus, dayAfter: dayNow, snapshot });
      }
    }
    if (now() >= deadline) {
      // Two different worlds can spend the same budget, and they used to share one word: a night that is genuinely
      // slow, and a menu that stood for the whole watch with nothing moving behind it. The second has an owner that
      // does not exist, and the reader of the result must not have to guess which happened.
      const deadlock = unattendedHoldReason({
        hold: holdUnderWatch,
        actionableChanged,
        inFlight: snapshot?.activeExecution ?? null,
        at: now(),
      });
      return Object.freeze({
        crossed: false,
        reasonCode:
          deadlock ??
          `night_not_observed:${String(snapshot?.actorDispositionKind ?? "unknown")}:${String(snapshot?.actorDispositionDetail ?? "none")}`,
        menus,
        dayAfter: dayNow,
      });
    }
    await lookWhen(lookCeilingMs);
  }
}

/**
 * Wake the watcher on a FACT, so its cadence is the world's rather than a timer's.
 *
 * <p>
 * The loop's own record is the argument. `round56` observed one night 742 times at 3.56 Hz over 208.6 s, and 618 of the
 * run's 624 suppressed flushes carried no fact at all - the reader asking, over and over, while the Mod had nothing to
 * say. The Mod does speak when something happens (`time_milestone` every ten game minutes, `snapshot_changed` on a warp,
 * `night_ended_pass_out` at 02:00, `day_started` at the boundary), so a fact is the event the watcher is actually
 * waiting for, and a timer is only the answer to a world that has gone quiet.
 * </p>
 * <p>
 * `factPublished()` is called from the run's fact listener and `wait(ceilingMs)` is `watchRollover`'s `waitForLook`. A
 * statement that arrives while nobody is waiting is REMEMBERED, so one that lands between the observe and the wait cannot
 * be lost and cost a full ceiling of latency; and a statement that arrives while a waiter stands wakes exactly that
 * waiter, so the loop looks once per statement instead of once per tick.
 * </p>
 */
export function worldFactWake() {
  const waiting = new Set();
  let arrived = false;
  return Object.freeze({
    factPublished() {
      // Nobody waiting means the loop is between a look and its own wait; the flag is what that next wait reads.
      if (waiting.size === 0) {
        arrived = true;
        return;
      }
      for (const wake of [...waiting]) wake();
    },
    wait(ceilingMs) {
      if (arrived) {
        arrived = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const wake = () => {
          waiting.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, ceilingMs);
        waiting.add(wake);
      });
    },
  });
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
    // THE NIGHTS THIS LOOP WATCHED, which is not the same number as the nights the run lived: the closing day above
    // ends in a night of its own, and by then no watcher is running. `crossingsFromEvidence` is what counts crossings.
    daysCrossed: dayRecords.length,
  });
}

/** The Mod's own word for a night that crossed - the reason a `sleep` terminal and the timeline's receipt both carry. */
const CROSSING_REASON = "day_advanced";

/** One crossing per request: a redelivered terminal is the same night, a second request would be a second night. */
function distinctRequests(receipts) {
  const seen = new Set();
  let unidentified = 0;
  for (const receipt of receipts) {
    const requestId = typeof receipt?.requestId === "string" && receipt.requestId.length > 0 ? receipt.requestId : null;
    if (requestId === null) unidentified += 1;
    else seen.add(requestId);
  }
  return seen.size + unidentified;
}

/**
 * HOW a night was crossed, as the evidence that witnessed it names it.
 *
 * A crossing always has a cause, and the run used to record only the nights her own sleep ended: measured 2026-11-11
 * (`round45`, `2026-11-10T22-13-25-922Z-multiday_routine`), the world published `day_started_day_5`/`_6`/`_7` and
 * `night_ended_pass_out_day_5`/`_6`, while exactly ONE `sleep` receipt reached `day_advanced` - so the sleep receipts
 * could not add up to the days the world opened and the pairing answered `null`. Two of those three nights the engine
 * ended itself (`Game1.PassOutNewDay()` calls `NewDay(0f)`, so the day REALLY starts), and a count that refuses them is
 * refusing nights the run lived.
 */
export const CROSSED_BY = Object.freeze({
  /** Her own `advance_day` lifecycle crossed it: the `sleep` receipt whose reason is `day_advanced`. */
  sleep: "sleep",
  /** The ENGINE crossed it, and the Mod's `night_ended_pass_out` fact names the night it collapsed on. */
  passOut: "pass_out",
  /** The calendar moved and nothing in this run says how: a crossing whose cause nobody recorded. */
  other: "other",
});

/**
 * The nights a run crossed, from what the run recorded had HAPPENED rather than from the nights a watcher saw.
 *
 * WHY THIS IS NOT THE LOOP'S OWN COUNT. Measured 2026-11-10 (round44, `2026-11-10T11-30-16-268Z-multiday_routine`): her
 * `sleep` reached `state=passed;reason=day_advanced` three times (1794310882971, 1794311627708, 1794312231618), the world
 * published `day_started_day_5`/`_6`/`_7` once each, and the artifact reported `crossings: 2` - because the third
 * crossing happened inside the CLOSING day's turn, after which no night watcher runs. The number was labelled with the
 * nights that happened and counted the nights that were watched, which is the whole defect: two honest numbers, one
 * false claim.
 *
 * FIVE SOURCES, each with its own file and its own sentence:
 *   - `sleepReceipts`: the timeline's execution receipts whose reason is `day_advanced`, one per request. This is the Mod
 *     saying a lifecycle crossed a night, and it is the only source that says that SHE crossed it;
 *   - `worldNightEndings`: the Mod's own `night_ended_*` facts (`worldNightEndingsFromFacts` in
 *     `multiday-baseline.mjs`). `night_ended_pass_out` is the ENGINE crossing the night, which is a crossing;
 *   - `dayStartedDays`: the world's own `day_started_day_<n>` facts, distinct by day. The crossing witness that cannot
 *     be hidden by which dispatch channel carried the night, and the POPULATION every attribution must add up to;
 *   - `dayRecords`: the loop's iterations - one per night the watcher saw. It is the WATCH, not the run;
 *   - `recorded`: the number the artifact published, kept so a reader can see what was claimed.
 *
 * `null` is "could not be read" and an empty array is "read, and the run crossed nothing" - the two are never merged,
 * because a count nobody could read must not be judged as a count of none.
 *
 * THE CAUSES ADD UP, OR THE RUN HAS NO NUMBER. A sleep receipt and a pass-out fact are both crossings with a cause, and
 * their sum is the attribution. When the attribution is at or below the days the world opened, the world's own count is
 * the answer and the difference is `other` - a crossing the calendar proves and nothing explains. When the attribution
 * EXCEEDS the days the world opened, two sources cannot both be right and the crossings are `null` rather than picked.
 * The loop's own records and the artifact's published number never decide the count: they are the watch and the claim,
 * and when they differ from the evidence the disagreement names them by name.
 */
export function crossingsFromEvidence({
  sleepReceipts = null,
  worldNightEndings = null,
  dayStartedDays = null,
  dayRecords = null,
  recorded = null,
} = {}) {
  const sleepCrossings =
    sleepReceipts === null
      ? null
      : distinctRequests(
          (Array.isArray(sleepReceipts) ? sleepReceipts : []).filter(
            (receipt) => receipt?.reasonCode === CROSSING_REASON,
          ),
        );
  const passOutCrossings =
    worldNightEndings === null
      ? null
      : new Set(
          (Array.isArray(worldNightEndings) ? worldNightEndings : [])
            .filter((ending) => ending?.cause === NIGHT_CAUSE_PASS_OUT && Number.isInteger(ending?.day))
            .map((ending) => ending.day),
        ).size;
  // A crossing is ATTRIBUTED only when both of its cause witnesses could be read: one unreadable half would make a sum
  // that silently omits the nights it would have named.
  const attributed = sleepCrossings === null || passOutCrossings === null ? null : sleepCrossings + passOutCrossings;
  const ATTRIBUTED_WITNESS = "sleep_receipts+night_endings";
  const startedCrossings =
    dayStartedDays === null
      ? null
      : new Set((Array.isArray(dayStartedDays) ? dayStartedDays : []).filter((day) => Number.isInteger(day))).size;
  const watchedCrossings = Array.isArray(dayRecords) ? dayRecords.length : null;
  const recordedCrossings = Number.isInteger(recorded) ? recorded : null;

  const sources = Object.freeze([
    Object.freeze({
      name: "sleep_receipts",
      crossings: sleepCrossings,
      source: "timeline.jsonl execution receipts with reasonCode day_advanced, one per requestId",
    }),
    Object.freeze({
      name: "night_endings",
      crossings: passOutCrossings,
      source: "timeline.jsonl world facts, one per distinct night_ended_pass_out_day_<n> (the engine's own crossing)",
    }),
    Object.freeze({
      name: "day_started_facts",
      crossings: startedCrossings,
      source: "timeline.jsonl world facts, one per distinct day_started_day_<n>",
    }),
    Object.freeze({
      name: "day_records",
      crossings: watchedCrossings,
      source: "result.json multiday.dayRecords - one per night the watcher saw",
    }),
    Object.freeze({ name: "recorded", crossings: recordedCrossings, source: "result.json multiday.crossings" }),
  ]);

  let crossings = null;
  let witness = null;
  // The crossings nothing in this run explains, once the count is decided and both cause witnesses were read.
  let otherCrossings = null;
  if (attributed !== null) {
    if (startedCrossings === null) {
      crossings = attributed;
      witness = ATTRIBUTED_WITNESS;
    } else if (attributed <= startedCrossings) {
      // THE WORLD'S COUNT IS THE POPULATION, and the attribution is how much of it is explained.
      crossings = startedCrossings;
      witness = `${ATTRIBUTED_WITNESS}+day_started_facts`;
      otherCrossings = startedCrossings - attributed;
    }
    // MORE ATTRIBUTED NIGHTS THAN THE WORLD OPENED DAYS: two evidence sources, two numbers, no crossing count.
  } else if (sleepCrossings !== null && startedCrossings !== null) {
    if (sleepCrossings <= startedCrossings) {
      crossings = startedCrossings;
      witness = "sleep_receipts+day_started_facts";
    }
    // A night her own sleep crossed but the world never opened a day for: not a count to state.
  } else if (startedCrossings !== null) {
    crossings = startedCrossings;
    witness = "day_started_facts";
  } else if (sleepCrossings !== null) {
    crossings = sleepCrossings;
    witness = "sleep_receipts";
  } else if (recordedCrossings !== null) {
    crossings = recordedCrossings;
    witness = "recorded";
  } else if (watchedCrossings !== null) {
    crossings = watchedCrossings;
    witness = "day_records";
  }

  const watched = watchedCrossings ?? 0;
  const observed =
    crossings === null
      ? []
      : Array.from({ length: crossings }, (_, index) => (index < watched ? "watch" : "post_watch"));

  // EVERY SOURCE THAT CLAIMS A COUNT OF ITS OWN IS NAMED WHEN IT DISAGREES WITH THE DECIDED ONE. The two attribution
  // sources and the calendar are reconciled by the rule above - that is what `crossedBy` publishes - so they are not
  // compared one by one: a run with one sleep and two pass-outs is three nights, not three disagreements. What is left
  // is the WATCH (`day_records`) and the CLAIM (`recorded`), which never decide a count and routinely fall short of it
  // (round44: `crossings: 2` beside three evidence crossings). When NO count could be decided, the evidence sources are
  // named instead - they are the ones in conflict - and the claim is printed above them anyway.
  const CLAIM_SOURCES = new Set(["day_records", "recorded"]);
  const EVIDENCE_SOURCES = new Set(["sleep_receipts", "night_endings", "day_started_facts"]);
  const readable = sources.filter((entry) => entry.crossings !== null);
  const differing =
    crossings === null
      ? readable.filter((entry) => EVIDENCE_SOURCES.has(entry.name))
      : readable.filter((entry) => CLAIM_SOURCES.has(entry.name) && entry.crossings !== crossings);
  const disagreement =
    differing.length === 0
      ? null
      : `crossings_disagree:${differing.map((entry) => `${entry.name}=${String(entry.crossings)}`).join(":")}`;

  return Object.freeze({
    crossings,
    witness,
    observed: Object.freeze(observed),
    watched: observed.filter((entry) => entry === "watch").length,
    postWatch: observed.filter((entry) => entry === "post_watch").length,
    // What each crossing was caused by, as the count rather than as a per-night list: the sources do not carry a shared
    // night identity, so a list would be an ordering nobody witnessed. `other` is the crossings the calendar proves and
    // no receipt or night-ending fact explains, and `null` means nobody could say.
    crossedBy: Object.freeze({
      sleep: sleepCrossings,
      pass_out: passOutCrossings,
      other: otherCrossings,
    }),
    sources,
    disagreement,
  });
}

/**
 * THE WAKE DECISION: whether a settlement is a reason to think.
 *
 * Measured 2026-11-10 (`round44`): 109 prompt turns for four days, 2035.8 s of wall of which 1912.8 s (94%) was model
 * time, and 73 of those turns dispatched nothing at all. The harness re-prompted the moment a turn settled, so the model
 * was woken roughly 1.3 times per programme at about 18 s a wake, to be told only "carry on".
 *
 * A settlement is not a reason. It is the moment the harness learns that what it was waiting for has stopped, and the
 * only thing that makes the stop interesting is that the body has no pass left to continue AND something has happened
 * that she has to answer. Anything else waits - the Mod's own pass owns the next move.
 *
 * THERE USED TO BE A CLOCK HERE, AND IT IS GONE. Measured 2026-11-13 (`round47`, 64 delivered turns): 523.2 s of a
 * 1,153.8 s run was idle between turns, and 16 of the 30 idle gaps after turn 34 sat in a 19-22 s band - the quiet bound
 * below elapsing and then prompting her to carry on, for a world that had published nothing. A milestone is a thing that
 * happened; a twenty-second clock is the absence of a thing happening, and paying a model turn for that absence is the
 * harness deciding when a companion should have thought of something. What may open a turn is a fact - a stall, a stale
 * reading, the evening's own question, the player - and the reasons below are those facts and no others.
 *
 * THE REASONS ARE A CLOSED SET, and
 * `tools/live-run/game/run-stardew-native-local-agent-ab-live.test.mjs` refuses a member with no producer: every prompt
 * call site in the runner must declare one of these, and each one must have a producer a test can reach. Adding a reason
 * is therefore a change to this set, not a string at a call site.
 */
export const WAKE_REASON = Object.freeze({
  /** A day (or the run) begins: the harness asks her what she will do. Never caused by a settlement. */
  dayStart: "day_start",
  /** The Host published `execution_stalled`: the body is NOT continuing, so she is the only thing left that can decide. */
  stallWake: "stall_wake",
  /**
   * The Host published `world_state_stale`: the world she would be given is older than the declared bound.
   *
   * Measured 2026-11-10 (`round45`): the block froze at `revision 352` and was re-stated for 50 turns - 30 minutes -
   * while the clock walked through two 02:00 pass-outs and two day starts. Every one of those turns was issued as
   * `continuation`, which asked her to carry on from a day-old picture; she carried on, in prose, and dispatched
   * nothing. A stale reading is not a quiet world: it is a world nobody has looked at, and the one move that fixes it
   * is an observation. Naming it `continuation` would be a reason that lies about its own precondition.
   */
  staleWorld: "stale_world",
  /** A turn the player asked for, carrying player text. */
  playerInput: "player_input",
  /**
   * The day's work is done and the day is nearly over: offered once, and it ASKS - it never dispatches `sleep`.
   *
   * It exists because the day's objective can be met hours before the night, and the loop never dispatches a night: a
   * companion whose work is finished still has to decide to end her own day. Suppressing every wake once the objective
   * is met would leave the engine's 02:00 pass-out to take the night, which is a different companion and a different
   * measurement. Naming the offer `continuation` would be a reason that lies about its own precondition.
   */
  dayEndOffer: "day_end_offer",
  /**
   * The day is past its evening and the objective has not advanced for a measured span: it is not going to be done
   * today, so the only decision left is what to do with the rest of the day.
   *
   * Measured 2026-11-11 (`round45`, `2026-11-10T22-13-25-922Z-multiday_routine`): day 2 was `a_fish_from_the_water` and
   * its admitted actions were `enter_exit` and `move_to_tile` - there was no `fish_here` in that day's reach - so the
   * purpose judge answered `not_achieved` for 60 wakes, through two 02:00 pass-outs, and the day-end branch was never
   * entered because it required `objectiveMet === true`. `not_achieved` conflates "still working on it" with "cannot be
   * done today", and only the second one makes the rest of the day a decision. Naming this `continuation` would be a
   * reason that lies about its own precondition: nothing about that day was continuing.
   */
  objectiveUnreachableForToday: "objective_unreachable_for_today",
});

export const WAKE_REASONS = Object.freeze(Object.values(WAKE_REASON));

/**
 * The reasons the DAY LOOP's decider can answer with, as opposed to the ones a call site declares.
 *
 * `player_input` is a turn the player asked for and no decision of this loop can produce it; `day_start` is
 * `decideDayWake`'s own opening. Both are declared reasons, and neither is a settlement question - which is why the
 * population a run's wake account is judged against is this narrower set, and why `wakeReasonReachability` prints it.
 */
export const DECIDER_WAKE_REASONS = Object.freeze(WAKE_REASONS.filter((reason) => reason !== WAKE_REASON.playerInput));

/**
 * Why a settlement did NOT produce a prompt. Closed for the same reason the wake reasons are, and reported by name so
 * "the harness waited" is never read as "the harness was never asked".
 */
export const WAKE_SUPPRESSION = Object.freeze({
  /** The day's task purpose is achieved and the day is not near its end. */
  objectiveMet: "objective_met",
  /** A programme is running, or an admission has no terminal yet: the Mod's pass will re-enter on its own. */
  bodyStillWorking: "body_still_working",
  /** The day-end offer was already made and is unanswered: an offer repeated until answered is the ping this removes. */
  alreadyOffered: "already_offered",
  /**
   * Nothing has stopped and nothing has happened: the harness has nothing to add, so no prompt is owed.
   *
   * This is what the quiet bound used to answer with a wake after twenty seconds. A companion whose body is idle and
   * whose objective is open is not thereby owed a turn - she is owed one when the world says something (a stall, a stale
   * reading) or when the day's own shape asks a question (the evening's offer). While none of that is true, the honest
   * reading is this one, and the run account counts it so a long silence is visible rather than indistinguishable from a
   * stall.
   */
  waitingForTheWorld: "waiting_for_the_world",
});

export const WAKE_SUPPRESSION_REASONS = Object.freeze(Object.values(WAKE_SUPPRESSION));

/**
 * The day's objective, in three states rather than two.
 *
 * The purpose judge answers one question - did this day's purpose hold - and its `not_achieved` is the only "no" it has.
 * That word cannot tell a companion who is still working toward her task from one whose task cannot be finished today,
 * and the day-end offer needed the second: measured 2026-11-11 (`round45`), an objective that could not advance stayed
 * `not_achieved` for 60 wakes and the day was never offered. The three states are what the decider reads instead.
 */
export const OBJECTIVE_STATE = Object.freeze({
  /** The purpose judge said the day's purpose held. */
  achieved: "achieved",
  /** Not achieved, and the objective's published reading moved within the span: the day's work is going somewhere. */
  advancing: "advancing",
  /** Not achieved, and that reading has not moved for the span: nothing about today is going to change it. */
  stalled: "stalled",
});

/**
 * The fields a purpose reading publishes that MOVE only when the objective moves.
 *
 * `admittedActionIds` is the progress a step criterion publishes - which of its admitted actions have arrived - and
 * `patchTiles`/`patchWindow.count`/`largestRectangle.area` are the progress a shape criterion publishes. Nothing else in
 * the reading is a progress fact: `purpose` is prose, and `state`/`reasonCode` flip once at the end.
 *
 * A reading that carries none of them (an `unproven` task, or one whose criterion needs an unpublished fact) has no
 * progress to observe, and its key is then the reading's own state: it cannot be called "advancing" by a change nobody
 * published.
 */
export function objectiveProgressKey(reading) {
  if (reading === null || typeof reading !== "object") return null;
  return JSON.stringify([
    reading.state ?? null,
    Array.isArray(reading.admittedActionIds) ? [...reading.admittedActionIds].sort() : null,
    reading.patchTiles ?? null,
    reading.patchWindow?.count ?? null,
    reading.largestRectangle?.area ?? null,
  ]);
}

/**
 * Which of the three states one read of the objective is in, from two measured numbers and one judge answer.
 *
 * `spanMs` is the run's OWN measured turn cadence (the median interval between its prompt turns), never a constant
 * invented here: a companion's turn takes as long as this run's turns take, so "nothing moved for a whole turn" is a
 * statement about that run rather than about a number someone picked. `sinceProgressMs` is how long the objective's
 * published reading has stood still.
 *
 * AN UNMEASURED SPAN OR PROGRESS IS NOT A STALL. A `null` or `NaN` on either side answers `advancing` with `because`
 * naming what was missing, so "we could not tell" can never licence the day-end reason.
 */
export function readObjectiveState({ objectiveMet = false, sinceProgressMs = null, spanMs = null } = {}) {
  if (objectiveMet === true)
    return Object.freeze({ state: OBJECTIVE_STATE.achieved, sinceProgressMs: null, spanMs, because: null });
  if (!Number.isFinite(spanMs) || spanMs <= 0)
    return Object.freeze({
      state: OBJECTIVE_STATE.advancing,
      sinceProgressMs,
      spanMs: null,
      because: "objective_span_unmeasured",
    });
  if (!Number.isFinite(sinceProgressMs))
    return Object.freeze({
      state: OBJECTIVE_STATE.advancing,
      sinceProgressMs: null,
      spanMs,
      because: "objective_progress_unmeasured",
    });
  if (sinceProgressMs < spanMs)
    return Object.freeze({ state: OBJECTIVE_STATE.advancing, sinceProgressMs, spanMs, because: null });
  return Object.freeze({ state: OBJECTIVE_STATE.stalled, sinceProgressMs, spanMs, because: null });
}

/**
 * The facts that decide one wake. Every one is read; none is inferred from another.
 *
 * `stalled` is the Host's own `execution_stalled` fact, not this loop's reading of silence: the pump owns the bound and
 * the re-arm, and a second derivation here would be a second authority for the same claim. `worldStateStale` is the
 * same relation to the Host's `world_state_stale` fact: the pump owns the bound (in turns) and this only reads whether
 * one has been published.
 *
 * `objectiveMet`, `objectiveProgressSinceMs` and `objectiveSpanMs` are the objective's three states (see
 * `readObjectiveState`): what the purpose judge said, how long its reading has stood still, and the run's own measured
 * turn cadence. They are READ here rather than inferred from silence, because a quiet session and a still objective are
 * different facts and a run can have either without the other.
 *
 * THERE IS NO QUIET INPUT. This decision used to take `quietMs` and a `quietBoundMs` and wake her once the world had been
 * silent for the bound; both are gone (see `WAKE_REASON`). A fact that stops arriving is not news, and a caller that
 * still hands one of them a duration gets this decision's answer for the facts, not a timer wearing the reason's name.
 */
export function decideWake({
  objectiveMet,
  objectiveProgressSinceMs = null,
  objectiveSpanMs = null,
  programRunning = false,
  admissionPending = false,
  lateDay = false,
  dayEndOffered = false,
  stalled = false,
  worldStateStale = false,
} = {}) {
  const objective = readObjectiveState({
    objectiveMet,
    sinceProgressMs: objectiveProgressSinceMs,
    spanMs: objectiveSpanMs,
  });
  // A stall outranks everything, including a day whose work is done: it is the body saying it will not continue.
  if (stalled === true) return Object.freeze({ wake: true, reason: WAKE_REASON.stallWake });
  if (programRunning === true || admissionPending === true)
    return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.bodyStillWorking });
  // A stale reading is a FACT about her picture rather than a reading of silence: the world has been speaking and the
  // block she would be handed has not moved, so the one move that fixes it is an observation. It sits BELOW the in-flight
  // check because a running programme owns the next move and publishes its own facts.
  if (worldStateStale === true) return Object.freeze({ wake: true, reason: WAKE_REASON.staleWorld });
  // NOTHING FROM HERE DOWN IS A CLOCK. Every branch left is a question about the DAY, asked of facts the world published:
  // the purpose judge's own answer, whether the day is nearly over, and whether the day's one question has been asked.
  // THE ORDER OF THE TWO DAY QUESTIONS IS THE POINT, and it continues the order above: `stale_world` (we cannot see what
  // the world is) outranks `objective_unreachable_for_today` (we can see it, and the objective is not moving in it). A
  // stale reading means an observation is the one move that fixes her picture, so that question comes first; a still
  // objective means the rest of the day is a decision about the day, which is the second.
  // A DAY WHOSE WORK IS DONE is the judge's own word, and the only question left is the day itself: past the evening it
  // offers, once. `objectiveMet` before the evening is a suppression rather than a wake, and always was.
  if (objective.state === OBJECTIVE_STATE.achieved) {
    if (lateDay !== true) return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.objectiveMet, objective });
    if (dayEndOffered === true)
      return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.alreadyOffered, objective });
    return Object.freeze({ wake: true, reason: WAKE_REASON.dayEndOffer, objective });
  }
  // A STILL OBJECTIVE PAST THE EVENING is a day that cannot finish, so the rest of it is a decision - asked once.
  if (objective.state === OBJECTIVE_STATE.stalled && lateDay === true) {
    if (dayEndOffered === true)
      return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.alreadyOffered, objective });
    return Object.freeze({
      wake: true,
      reason: WAKE_REASON.objectiveUnreachableForToday,
      objective,
      // THE CONDITIONS, NAMED AND PRINTED. A reason whose precondition cannot be read back from the run is a reason its
      // reader has to take on trust: these five fields are every fact the branch above read, in the shape the runner
      // prints when it fires.
      conditions: Object.freeze([
        `objective_state=${OBJECTIVE_STATE.stalled}`,
        `since_objective_progress_ms=${String(objective.sinceProgressMs)}`,
        `objective_span_ms=${String(objective.spanMs)}`,
        "objective_span_source=median_prompt_turn_interval_of_this_run",
        `late_day=${String(lateDay === true)}`,
      ]),
    });
  }
  // EVERYTHING ELSE IS THE HARNESS SAYING NOTHING. Her objective is open and still moving, or still and the day has hours
  // left in it: either way the next move is hers inside the turn she has, and no fact here gives the harness something to
  // add. NAMED RATHER THAN SILENT, because "the harness waited" and "the harness was never asked" must not read alike.
  return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.waitingForTheWorld, objective });
}

/**
 * The same decision for one turn of a day, with the day's opening stated where the day knows it is opening.
 *
 * The first prompt of a day is the one wake that is not caused by anything the world did: the harness is asking her to
 * begin. Keeping it out of `decideWake` is what lets that function answer only the settlement question.
 */
export function decideDayWake({ turnIndex, ...facts } = {}) {
  if (turnIndex === 0) return Object.freeze({ wake: true, reason: WAKE_REASON.dayStart });
  return decideWake(facts);
}

/**
 * Every reason the day loop's decider can answer, against what ONE run actually issued.
 *
 * WHAT A ZERO HERE MEANS, AND WHAT IT DOES NOT. It means this run never issued the reason. It does NOT mean the reason
 * can never fire: reachability is a property of the DECIDER and of the facts its caller hands it, and that question has
 * its own gate - `a_wake_reason_that_can_never_fire` in `run-stardew-native-local-agent-ab-live.test.mjs`, which probes
 * the decider over exactly the fact set the day loop supplies. Measured 2026-11-18 (`round76`): this reading printed
 * `wake_reason_never_reachable: stall_wake, stale_world, day_end_offer`, and its own name turned a run's coverage into a
 * claim about the vocabulary - so only one of the three (`stale_world`, whose fact the loop never handed over) was
 * actually dead, and the other two read as broken when the run had simply had no stall and no finished day.
 *
 * The population comes from `DECIDER_WAKE_REASONS`, which is derived from `WAKE_REASON`, so a reason added tomorrow is
 * examined without editing this function.
 *
 * `unmeasured` is separate from `neverIssued` for the same reason `null` is separate from an empty list everywhere else in
 * this module: a run that published no wake account has not been measured, and is not a run that issued nothing.
 */
export function wakeReasonReachability({ byReason = null } = {}) {
  const examined = DECIDER_WAKE_REASONS;
  if (byReason === null || typeof byReason !== "object") {
    return Object.freeze({
      examined,
      issued: Object.freeze({}),
      neverIssued: Object.freeze([]),
      unmeasured: "result.json multiday.wakes.byReason was not published by this run",
    });
  }
  const issued = Object.freeze(
    Object.fromEntries(
      examined.map((reason) => [
        reason,
        Number.isInteger(byReason[reason]) && byReason[reason] > 0 ? byReason[reason] : 0,
      ]),
    ),
  );
  const neverIssued = Object.freeze(examined.filter((reason) => issued[reason] === 0));
  return Object.freeze({ examined, issued, neverIssued, unmeasured: null });
}
