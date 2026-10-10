/**
 * The reason codes the Mod's SHARED admission returns when the actor cannot act right now.
 *
 * Why this list exists as one place: the naming wave replaced a single anonymous `player_not_actionable` with
 * codes that say WHAT holds the actor, and consumers kept asserting the old string. A shipped live gate
 * (`run-stardew-native-local-player-talk-to-npc-smoke.mjs`) failed exactly that way - it expected
 * `player_not_actionable` while the product now says `actor_held_by_modal` - and its offline mirror could not see
 * it because the fake emitted the OLD code. That is the "the mock encodes the old assumption" failure this
 * project keeps meeting, so the codes live here once and a test reads the Mod's own source to keep them honest.
 *
 * Two families, both from the Mod:
 *   - `WorldModel.HoldReasonCode` - what KIND of hold it is (four named holds plus the generic fallback that is
 *     still correct when nothing more specific applies, e.g. `Idle` with `CanMove == false`).
 *   - the named BODY OWNERS (`farmhandexecutioncontroller.cs`) - which in-flight execution holds the body.
 */

/** Every reason code the shared admission can return for a held actor. */
export const ADMISSION_HOLD_CODES = Object.freeze([
  // WorldModel.HoldReasonCode
  "actor_held_by_modal",
  "cutscene_active",
  "actor_passed_out",
  "transient_busy",
  // The generic fallback: still the right answer when the disposition is Idle but the actor cannot move.
  "player_not_actionable",
  // the named body owners
  "body_owned_by_movement",
  "body_owned_by_navigation",
  "body_owned_by_travel",
  "body_owned_by_approach",
  "body_owned_by_ride",
  "body_owned_by_day_advance",
  "body_owned_by_activity",
  // the defensive fallback for an owner this build cannot name
  "body_owned",
]);

/**
 * Whether a refusal reason code means "the actor's body is held", as opposed to some other failure.
 *
 * Runners assert this rather than one literal code: WHICH hold it is belongs to the Mod's decision table, while
 * "it was refused because the actor is held, not for an unrelated reason" is what the gate is actually about.
 */
export function isAdmissionHold(reasonCode) {
  return typeof reasonCode === "string" && ADMISSION_HOLD_CODES.includes(reasonCode);
}
