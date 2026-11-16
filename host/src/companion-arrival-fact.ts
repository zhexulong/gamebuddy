/**
 * The companion's arrival on the farm: the event that opens her first turn, and nothing else.
 *
 * THE EVENT. She has arrived. Nothing in the game says "I arrived" - the AI attaching to an already-running world is an
 * event of the HOST, and the Host is the only party holding the half it takes to say it: that the attach completed
 * (`acceptInitialFacts`, the one call `activateIngress` makes). So the Host mints the one fact that says so, and the
 * EXISTING Game mechanism does the rest: event pump -> `CompanionLoop` -> one proactive Pi turn. Her words come from the
 * provider, exactly as they do when the Mod's own `day_started` fact makes her speak; this module writes no speech.
 *
 * IT STATES NO STATE EITHER, AND THAT IS MEASURED. `<world-state>` arrives in the SAME batch and already prints the clock,
 * the date, the season, the weather and the place, from the same snapshot - `round63`'s own delivered text read
 * 「06:00（清晨）；1年第5天 春季；天气：晴天；位置: 农舍」. Until 2026-11-22 this fact appended a sentence over those same
 * five values, so one turn printed each of them twice and in two spellings (「此刻在Farm」 beside 「位置: 农舍」). Two
 * writers for one claim is the defect `design/input-authority.md` § three names, and the fix is deletion, not a rewrite:
 * the arrival owns the EVENT, the block owns the STATE. So the fact carries no `contextProjection` at all, and the line
 * the model reads for it is the kind's own words in `fact-brief.ts` (「她到了」).
 * `companion-arrival-fact.test.ts` proves it field by field against the block the same snapshot composes
 * (`arrival_fact_states_a_fact_the_block_already_states`), against a live probe on both sides of the batch.
 *
 * WHY `world_fact`, AND WHY A NEW SEMANTIC KIND. `world_fact` is the pump's existing "something in the world is worth
 * her attention" kind, and `semanticKind` is the label `CompanionLoop` already reads to decide which facts may open a
 * native companion turn. The two kinds it whitelists (`day_started`, `time_milestone`) are the MOD's own events;
 * borrowing either name for a Host-minted fact would claim the Mod said something it did not. The whitelist therefore
 * gains exactly one name - `companion_arrival` - which only this fact carries, and the presentation lease is granted on
 * it (`companion-loop.ts:opensPresentationLease`). `source` names who synthesised the fact.
 *
 * SAID ONCE PER MOUNT. The live switch in `CompanionHostService` (`#arrivalSaid`) is what stops one mounted session from
 * opening a second arrival turn. It used to have a durable second half - a scan of the Game session's Pi transcript for
 * the opening sentence - and that half is gone with the sentence: a dedupe keyed on prose dies the moment the prose
 * changes, and there is nothing left in the transcript that names this fact. The module no longer carries a marker of
 * its own; a fact cannot be found in a delivery without being a second spelling of that delivery.
 *
 * THE CLOCK IS THE GATE, AND IT IS THE ONLY THING THIS FACT READS. A world that has not started its day has no clock
 * (`Snapshot.timeOfDay` is 0 until it does), so the fact waits for the first reading that has actually ticked - the same
 * rule the environment-facts provider follows: absent a usable reading, say nothing. Nothing else in the snapshot is
 * inspected, because nothing else is stated.
 */

import type { WorldFact } from "./event-pump.js";

/** The fact's own identity. Stable per Game session, because it is said at most once per mount. */
export const COMPANION_ARRIVAL_EVENT_ID = "companion_arrival";

/** The semantic kind `CompanionLoop` must treat as salient (see `isSalientSensoryKind`). */
export const COMPANION_ARRIVAL_SEMANTIC_KIND = "companion_arrival";

/** Who synthesised the fact. Deliberately not `stardew_mod`: the Mod never says this. */
export const COMPANION_ARRIVAL_SOURCE = "host_game_session";

/**
 * The arrival fact for one attached Game session, or `undefined` while the world has no usable clock yet.
 *
 * Pure: the caller owns the once-only decision.
 */
export function companionArrivalFact(snapshot: unknown): WorldFact | undefined {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return undefined;
  const timeOfDay = (snapshot as Readonly<Record<string, unknown>>).timeOfDay;
  // A world that has not started its day has no clock (`Snapshot.timeOfDay` is 0 until it does).
  if (typeof timeOfDay !== "number" || !Number.isSafeInteger(timeOfDay) || timeOfDay <= 0) return undefined;
  return Object.freeze({
    source: COMPANION_ARRIVAL_SOURCE,
    kind: "world_fact" as const,
    eventId: COMPANION_ARRIVAL_EVENT_ID,
    sourceEventId: COMPANION_ARRIVAL_EVENT_ID,
    correlationId: COMPANION_ARRIVAL_EVENT_ID,
    revision: 0,
    occurredAtMs: Date.now(),
    semanticKind: COMPANION_ARRIVAL_SEMANTIC_KIND,
    // The event and nothing else: the state is the batch's `<world-state>`, composed from the same snapshot.
    payload: Object.freeze({ kind: COMPANION_ARRIVAL_SEMANTIC_KIND }),
  });
}
