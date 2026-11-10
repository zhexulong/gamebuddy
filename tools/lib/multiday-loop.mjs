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
    pollIntervalMs = POLL_INTERVAL_MS,
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
 * The nights a run crossed, from what the run recorded had HAPPENED rather than from the nights a watcher saw.
 *
 * WHY THIS IS NOT THE LOOP'S OWN COUNT. Measured 2026-11-10 (round44, `2026-11-10T11-30-16-268Z-multiday_routine`): her
 * `sleep` reached `state=passed;reason=day_advanced` three times (1794310882971, 1794311627708, 1794312231618), the world
 * published `day_started_day_5`/`_6`/`_7` once each, and the artifact reported `crossings: 2` - because the third
 * crossing happened inside the CLOSING day's turn, after which no night watcher runs. The number was labelled with the
 * nights that happened and counted the nights that were watched, which is the whole defect: two honest numbers, one
 * false claim.
 *
 * FOUR SOURCES, each with its own file and its own sentence:
 *   - `sleepReceipts`: the timeline's execution receipts whose reason is `day_advanced`, one per request. This is the Mod
 *     saying a lifecycle crossed a night, and it is the only source that says HOW as well as that it happened;
 *   - `dayStartedDays`: the world's own `day_started_day_<n>` facts, distinct by day. The crossing witness that cannot
 *     be hidden by which dispatch channel carried the night;
 *   - `dayRecords`: the loop's iterations - one per night the watcher saw. It is the WATCH, not the run;
 *   - `recorded`: the number the artifact published, kept so a reader can see what was claimed.
 *
 * `null` is "could not be read" and an empty array is "read, and the run crossed nothing" - the two are never merged,
 * because a count nobody could read must not be judged as a count of none.
 *
 * When the two EVIDENCE sources disagree the crossings are `null`: a run that cannot say how many nights it lived has no
 * number, and printing either one would be picking. When they agree they are the answer even if the loop's records are
 * fewer - a crossing discovered after the watcher stopped still counts, and `observed` says `post_watch` for it so nobody
 * reads it as watched. Every disagreement is named with all the numbers that produced it.
 */
export function crossingsFromEvidence({
  sleepReceipts = null,
  dayStartedDays = null,
  dayRecords = null,
  recorded = null,
} = {}) {
  const receiptCrossings =
    sleepReceipts === null
      ? null
      : distinctRequests(
          (Array.isArray(sleepReceipts) ? sleepReceipts : []).filter(
            (receipt) => receipt?.reasonCode === CROSSING_REASON,
          ),
        );
  const startedCrossings =
    dayStartedDays === null
      ? null
      : new Set((Array.isArray(dayStartedDays) ? dayStartedDays : []).filter((day) => Number.isInteger(day))).size;
  const watchedCrossings = Array.isArray(dayRecords) ? dayRecords.length : null;
  const recordedCrossings = Number.isInteger(recorded) ? recorded : null;

  const sources = Object.freeze([
    Object.freeze({
      name: "sleep_receipts",
      crossings: receiptCrossings,
      source: "timeline.jsonl execution receipts with reasonCode day_advanced, one per requestId",
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
  if (receiptCrossings !== null && startedCrossings !== null && receiptCrossings !== startedCrossings) {
    // TWO EVIDENCE SOURCES, TWO NUMBERS: the run cannot state one.
  } else if (receiptCrossings !== null && startedCrossings !== null) {
    crossings = receiptCrossings;
    witness = "sleep_receipts+day_started_facts";
  } else if (receiptCrossings !== null) {
    crossings = receiptCrossings;
    witness = "sleep_receipts";
  } else if (startedCrossings !== null) {
    crossings = startedCrossings;
    witness = "day_started_facts";
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

  const readable = sources.filter((entry) => entry.crossings !== null);
  const disagreement =
    readable.length > 1 && new Set(readable.map((entry) => entry.crossings)).size > 1
      ? `crossings_disagree:${readable.map((entry) => `${entry.name}=${String(entry.crossings)}`).join(":")}`
      : null;

  return Object.freeze({
    crossings,
    witness,
    observed: Object.freeze(observed),
    watched: observed.filter((entry) => entry === "watch").length,
    postWatch: observed.filter((entry) => entry === "post_watch").length,
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
 * only thing that makes the stop interesting is that nothing else can move: the body has no pass left to continue, the
 * world has been quiet for a bound, and the day's objective is still open. Then she is the only thing left that can
 * decide. Anything else waits - the Mod's own pass owns the next move.
 *
 * THE REASONS ARE A CLOSED SET, and
 * `tools/live-run/game/run-stardew-native-local-agent-ab-live.test.mjs` refuses a sixth: every prompt call site in the
 * runner must declare one of these, and each one must have a producer a test can reach. Adding a reason is therefore a
 * change to this set, not a string at a call site.
 */
export const WAKE_REASON = Object.freeze({
  /** A day (or the run) begins: the harness asks her what she will do. Never caused by a settlement. */
  dayStart: "day_start",
  /** The day's objective is open, the body has nothing to continue, and the world has been quiet for the bound. */
  continuation: "continuation",
  /** The Host published `execution_stalled`: the body is NOT continuing, so she is the only thing left that can decide. */
  stallWake: "stall_wake",
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
});

export const WAKE_REASONS = Object.freeze(Object.values(WAKE_REASON));

/**
 * Why a settlement did NOT produce a prompt. Closed for the same reason the wake reasons are, and reported by name so
 * "the harness waited" is never read as "the harness was never asked".
 */
export const WAKE_SUPPRESSION = Object.freeze({
  /** The day's task purpose is achieved and the day is not near its end. */
  objectiveMet: "objective_met",
  /** A programme is running, or an admission has no terminal yet: the Mod's pass will re-enter on its own. */
  bodyStillWorking: "body_still_working",
  /** Nothing has moved, but not for long enough to say nothing will. */
  quietPeriod: "quiet_period",
  /** The day-end offer was already made and is unanswered: an offer repeated until answered is the ping this removes. */
  alreadyOffered: "already_offered",
});

export const WAKE_SUPPRESSION_REASONS = Object.freeze(Object.values(WAKE_SUPPRESSION));

/**
 * How long nothing may move before a quiet world counts as stopped.
 *
 * The same bound the runner's own `waitForSessionQuiet` already waits out inside a turn, so a wake and the turn that
 * follows it cannot disagree about what "quiet" means. A Stardew action that is still running publishes a receipt or a
 * progress fact far more often than this; a body that has finished publishes nothing at all.
 */
export const QUIET_BOUND_MS = 20_000;

/**
 * The facts that decide one wake. Every one is read; none is inferred from another.
 *
 * `stalled` is the Host's own `execution_stalled` fact, not this loop's reading of silence: the pump owns the bound and
 * the re-arm, and a second derivation here would be a second authority for the same claim.
 */
export function decideWake({
  objectiveMet,
  programRunning = false,
  admissionPending = false,
  quietMs = null,
  quietBoundMs = QUIET_BOUND_MS,
  lateDay = false,
  dayEndOffered = false,
  stalled = false,
} = {}) {
  // A stall outranks everything, including a day whose work is done: it is the body saying it will not continue.
  if (stalled === true) return Object.freeze({ wake: true, reason: WAKE_REASON.stallWake });
  if (programRunning === true || admissionPending === true)
    return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.bodyStillWorking });
  // An unmeasured quiet is not quiet: "we could not tell" must not licence a wake.
  if (!Number.isFinite(quietMs) || quietMs < quietBoundMs)
    return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.quietPeriod });
  if (objectiveMet !== true) return Object.freeze({ wake: true, reason: WAKE_REASON.continuation });
  if (lateDay !== true) return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.objectiveMet });
  if (dayEndOffered === true) return Object.freeze({ wake: false, reason: WAKE_SUPPRESSION.alreadyOffered });
  return Object.freeze({ wake: true, reason: WAKE_REASON.dayEndOffer });
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
