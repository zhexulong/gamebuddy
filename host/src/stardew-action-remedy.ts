/**
 * The countermeasure an Agent is told about when a Stardew action is refused.
 *
 * Why this exists: the Host used to answer a held body with `player_not_actionable` and nothing else. One
 * code covered a mounted menu, a cutscene, a faint, an eating animation and a tool swing - five states whose
 * countermeasures are completely different - so the Agent had no fact to act on and its only visible option
 * was to re-issue the same request until it gave up. The Mod now names the hold and carries the facts; this
 * module turns that into the one thing the Agent should do next, and it is a PURE function of the reason code
 * and the Mod's evidence, so the whole table is testable without a game.
 *
 * IT IS WHERE A REFUSAL'S WORDS LIVE, and that is the second half of its job. A sentence composed in the Mod
 * shipped in English inside a Chinese run, and changing one word of it was a Mod release; the Mod publishes a
 * code and its facts instead (`no_safe_clear:<occupant>:<action>`), and the sentence a reader needs - what she
 * can do about it - is composed here, next to the run's own prompt.
 *
 * <p>
 * AND ITS KEY SPACE IS THE MOD'S WHOLE DECLARED REFUSAL VOCABULARY, not one family of it. It began as the body holds,
 * because `player_not_actionable` was the code that cost a run its turn; measured `round78` (2026-11-19, read back from
 * the live-runner log this unit keeps as `REFUSED_IN_A_REAL_RUN` in its suite) the codes she ACTUALLY read were
 * `no_native_path` 8, `navigation_approach_unavailable` 6, `native_path_ended` 2, `clear_step_blocked` 1,
 * `actor_moving` 1, `warp_out_of_range` 1 and `destination_locked` 1 - and this table knew none of them, so the Game
 * floor carried a temporary second line ordering her to translate the machine's words herself. That line is gone
 * (`game-surface-prompt-floor.ts`), and what replaced it is the movement, pathing, clearing, programme and navigation
 * families below; `stardew-action-remedy.test.ts`'s `a_refusal_she_reads_is_a_sentence` holds the population to the
 * Mod's declarations rather than to this paragraph.
 * </p>
 *
 * <p>
 * ONE SENTENCE PER ANSWER, NOT PER CODE. Nine navigation terminals all mean "read the world before acting"; one sentence
 * says that once, and the code keeps its own spelling in the reference line the renderer prints beside it
 * (`fact-brief.ts`). What must not be shared is the ANSWER: two codes with different countermeasures may not read the
 * same, which is why the body holds below are each their own case.
 * </p>
 *
 * It never promises a remedy it cannot deliver: a modal the audited whitelist will not close reports that
 * honestly rather than pointing at a tool that will refuse, and every route it names is one the Game surface
 * actually hands over - a mounted tool, or a step the plan builder admits (`stardew-action-remedy.test.ts`
 * holds both directions). It named `stardew_dismiss_modal` and `stardew_answer_dialogue` until 2026-11-12;
 * both are flat per-action tools a plan surface drops, so the one sentence the Agent got after a hold pointed
 * at a tool that was not in the request at all - the same defect the Game conduct carried for body language.
 */

export type StardewActionRemedy = Readonly<{
  /** The tool to call next, or null when nothing can be called and the Agent must wait or stop. */
  action: string | null;
  /** One sentence the Agent can act on, including the tool name when there is one. */
  guidance: string;
}>;

/**
 * The code a `for_each` row answers with when every published clearer of the occupant on its tile would destroy what the
 * player put there: `no_safe_clear:<occupant>:<actionThatWouldDestroyIt>`, from the Mod's own healing join.
 */
const NO_SAFE_CLEAR_PREFIX = "no_safe_clear:";

/** The code a row answers with when nothing the plan library publishes clears the occupant on its tile. */
const NO_PUBLISHED_CLEAR_PREFIX = "no_published_action_clears:";

/**
 * The refusal families this module renders, keyed by the Mod's own code, with the reason a family that names no sentence is
 * still honest to leave bare.
 *
 * EMPTY TODAY, and that is the claim: every family the Mod DECLARES as a refusal has a sentence below - the body holds, the
 * movement and pathing outcomes, the clearing family's own verdicts, the programme's, and the navigation terminals.
 * `a_refusal_she_reads_is_a_sentence` derives that population from the Mod's declarations and from the codes a real run
 * delivered, so an entry added here is a decision a reader can see and argue with, and an entry that carries no reason is
 * refused.
 */
export const MACHINE_ONLY_REFUSAL_CODES: ReadonlyMap<string, string> = Object.freeze(new Map());

/**
 * ONE ANSWER, ONE ENTRY, and the table is the table rather than a switch.
 *
 * <p>
 * The families below are the movement and pathing outcomes, where the target is, the clearing family's own verdicts, the
 * programme's, and the navigation terminals. Until 2026-11-19 none of them was here, and the codes a live run ACTUALLY
 * read arrived with their facts and no instruction - measured `round78`, read back from its live-runner log:
 * `no_native_path` 8, `navigation_approach_unavailable` 6, `native_path_ended` 2, `clear_step_blocked` 1, `actor_moving` 1,
 * `warp_out_of_range` 1, `destination_locked` 1.
 * </p>
 *
 * <p>
 * WHY IT IS A TABLE AND NOT SIXTY `case` LABELS. The measured cost of the switch shape was a cognitive complexity of 64 in
 * one function - one increment per label - for a body of code that is a lookup and nothing else
 * (`tools/check-cognitive-complexity.mjs`). A table makes the same statement as data: `codes` is the answer's population and
 * `guidance` is its sentence, so a reader can see which codes share an answer without reading a hundred lines of switch.
 * </p>
 *
 * <p>
 * ONE SENTENCE PER ANSWER, NOT PER CODE. Nine navigation terminals all mean "read the world before acting", and one
 * sentence says that once; the code keeps its own spelling in the reference line `fact-brief.ts` prints beside it. What is
 * NOT shared is the ANSWER: codes whose countermeasures differ are separate entries, which is why the body holds above
 * stayed in the switch where each one is its own case and its own test.
 * </p>
 */
type RefusalAnswer = Readonly<{
  /** The codes this answer is for. Several where the answer is the same, one where it is not. */
  codes: readonly string[];
  /** The tool to call next, or null when nothing can be called and the reader must wait, read or stop. */
  action: string | null;
  /** The sentence, reading the Mod's own evidence where the evidence changes what she should do. */
  guidance: (detail: string | null) => string;
}>;

const REFUSAL_ANSWERS: readonly RefusalAnswer[] = Object.freeze([
  Object.freeze({
    codes: Object.freeze(["no_native_path"]),
    action: "stardew_plan_work",
    guidance: (detail: string | null) => {
      // The ONE refusal whose evidence changed most (`StardewBodyController`): it names the nearest tile the flood did
      // reach (`closest=`), whether the target is walled in (`target_enclosed=`), and - when a single swing would open a
      // route - the clear step and the action that takes it (`clear_step=weed@40,9`, `clears_with=cut_weeds(...)`).
      // A sentence that said only "no route" is what sent a run to hand-plan detours with guessed coordinates.
      const closest = tileOf(evidenceField(detail, "closest"));
      const clearStep = evidenceField(detail, "clear_step");
      const clearsWith = evidenceField(detail, "clears_with");
      const enclosed = evidenceField(detail, "target_enclosed") === "true";
      const opens =
        clearStep === null
          ? ""
          : `, unless you clear it first: ${clearStep}${clearsWith === null ? "" : ` with ${clearsWith}`} is one step you can dispatch with stardew_plan_work`;
      return (
        `Nothing walks from where she stands to the tile that request named: the map has no road to it${enclosed ? ", and the tile is walled in on every side" : ""}. ` +
        `Name a tile the walk does reach${closest === null ? " (read the world first: the world block names the nearest ones)" : ` - the nearest one this refusal measured is ${closest}`}${opens}. ` +
        `Re-issuing the same tile answers the same refusal.`
      );
    },
  }),
  Object.freeze({
    codes: Object.freeze(["navigation_approach_unavailable"]),
    action: "stardew_plan_work",
    guidance: (detail: string | null) => {
      const blocked = evidenceField(detail, "approach_blocked_by") ?? evidenceField(detail, "entry_blocked_by");
      return (
        `The destination is reachable but there is nowhere to stand beside the way into it${blocked === null ? "" : `: ${blocked} holds the only approach`}. ` +
        `Either clear that or name another destination, as a step of its own with stardew_plan_work; the navigation will not re-plan this leg by itself` +
        `${evidenceField(detail, "never_retry") === "true" ? ", and this request is finished either way" : ""}.`
      );
    },
  }),
  Object.freeze({
    codes: Object.freeze(["native_path_ended"]),
    action: null,
    // The walk STARTED and then stopped making progress (`stalled_ticks=`), which is a different fact from "no road": the
    // road exists, so the honest next step is one more attempt or a nearer tile - not a different destination.
    guidance: (detail: string | null) => {
      const stalled = evidenceField(detail, "stalled_ticks");
      const target = tileOf(evidenceField(detail, "target"));
      const stoppedBy = evidenceField(detail, "stopped_by");
      return (
        `The walk to ${target ?? "the tile that request named"} started and then stopped advancing${stalled === null ? "" : ` for ${stalled} ticks`}` +
        `${stoppedBy === null || stoppedBy === "unknown" ? "" : `, held by ${stoppedBy}`}. ` +
        `Re-issue it once, or name a tile one step closer${target === null ? "" : ` than ${target}`}: nothing in the world was changed by the attempt, so either is safe.`
      );
    },
  }),
  Object.freeze({
    codes: Object.freeze(["clear_step_blocked"]),
    action: "stardew_plan_work",
    guidance: (detail: string | null) => {
      const blocker = evidenceField(detail, "blocker_occupant") ?? evidenceField(detail, "clear_step");
      const clearsWith = evidenceField(detail, "clears_with");
      const remaining = evidenceField(detail, "remaining_clears");
      return (
        `She walked up to the way in and it is still blocked by ${blocker ?? "the tile the refusal names"}. ` +
        `That block is one step, not an obstruction: dispatch ${clearsWith === null ? "the clear the refusal names" : clearsWith} with stardew_plan_work` +
        `${remaining === null ? "" : ` - the pass stopped with ${remaining} clear(s) left`} - and the walk resumes from where she is standing.`
      );
    },
  }),
  Object.freeze({
    // Retired at the mint site (`farmhandexecutioncontroller.movementactions.cs`: a flat expression does not need the body
    // to be still), and kept because a receipt minted before that change can still be replayed into a turn - `round78`
    // read one - and a replayed code must not be a dead end.
    codes: Object.freeze(["actor_moving"]),
    action: null,
    guidance: () =>
      "She was mid-step when that request arrived, which this action used to refuse. " +
      "The body settles on its own: send the request again now, and do not change its arguments - nothing was changed by the attempt.",
  }),
  Object.freeze({
    codes: Object.freeze(["warp_out_of_range", "door_out_of_range"]),
    action: "stardew_plan_work",
    guidance: (detail: string | null) => {
      const distance = evidenceField(detail, "distance");
      const source = tileOf(evidenceField(detail, "source"));
      return (
        `She is too far from the door or warp that leads there${distance === null ? "" : ` (${distance} tiles)`}: the game only opens one when she is standing on it` +
        `${source === null ? "" : `, at ${source}`}. ` +
        `Walk to that tile as a step of its own with stardew_plan_work, then make this request again from there.`
      );
    },
  }),
  Object.freeze({
    codes: Object.freeze(["destination_locked"]),
    action: null,
    guidance: (detail: string | null) => {
      const held = evidenceField(detail, "held_by");
      const destination = evidenceField(detail, "destination");
      // A HOLD THAT OUTLIVED ITS OWN WINDOW IS NOT CLEARING BY ITSELF. MEASURED `round97` (day 6, 11:40): this sentence
      // answered a `held_by=transient_busy;transient_kind=warping;retry_window_ms=2000` hold for four minutes while the
      // engine's warp flag never came down, and "This clears by itself ... make the same request again then" was the whole
      // plan it left open. Which of the two it is, is the Mod's own verdict (`next_step=`).
      if (evidenceField(detail, "next_step") === "report_the_stalled_body") {
        const overrunMs = evidenceField(detail, "hold_overrun_ms");
        return (
          `The way to ${destination ?? "the named destination"} exists, and ${held === null ? "a hold on the body" : held} has outlived ` +
          `the window its own producer allows${overrunMs === null ? "" : ` (${overrunMs} ms past it)`}, so it is not clearing by itself any more. ` +
          `Read the world once with stardew_observe; if it still reports the body held, report the blockage instead of re-issuing the request.`
        );
      }
      return (
        `The way to ${destination ?? "the named destination"} exists and cannot be taken this instant: ${held === null ? "the game is holding the body" : `${held} holds it`}. ` +
        `This clears by itself when that hold ends, so make the same request again then; retrying now answers the same lock.`
      );
    },
  }),
  Object.freeze({
    codes: Object.freeze(["destination_temporarily_unavailable"]),
    action: null,
    guidance: () =>
      "The game itself says this destination is closed right now (its own accessibility check refused it), so nothing she can dispatch opens it. " +
      "Make the same request again later; if it must be sooner, name another destination.",
  }),
  Object.freeze({
    codes: Object.freeze(["target_not_addressable"]),
    action: null,
    guidance: () =>
      "The id that request named is not in the world any more, so nothing was attempted. Read the world again and copy the id from that reading - " +
      "an id that has left the snapshot addresses nothing, and re-sending it answers the same refusal.",
  }),
  Object.freeze({
    codes: Object.freeze(["target_tile_occupied"]),
    action: null,
    guidance: () =>
      "A person is standing on the tile, and there is no tile beside it to work from. The road exists and the body is on the end of it: " +
      "wait for them to move, or work the target from the other side rather than re-planning a route.",
  }),
  Object.freeze({
    codes: Object.freeze(["path_blocked_by_character"]),
    action: null,
    guidance: () =>
      "A person stands in the middle of the walk, and the refusal names which one. It is not a map verdict: wait for them to move or aim at a different tile - " +
      "a detour planned around them is a guess.",
  }),
  Object.freeze({
    codes: Object.freeze(["out_of_map", "tile_outside_farm_map"]),
    action: null,
    guidance: () =>
      "The tile that request named is not a place. Nothing can stand there and no route can end there: name a tile inside the map the world block publishes, " +
      "rather than one the arithmetic produced.",
  }),
  Object.freeze({
    codes: Object.freeze(["approach_out_of_reach"]),
    action: "stardew_plan_work",
    guidance: () =>
      "She is not standing within the reach this action needs. Walk to a tile beside the target as a step of its own with stardew_plan_work, " +
      "then make this request again - the action does not walk for you.",
  }),
  Object.freeze({
    codes: Object.freeze(["no_reachable_approach"]),
    action: null,
    guidance: () =>
      "There is no tile she could stand on from which this action reaches the target. Nothing about re-issuing changes that: " +
      "name a different target, or clear whatever holds the tiles beside it.",
  }),
  Object.freeze({
    codes: Object.freeze(["no_cuttable_blocker"]),
    action: null,
    guidance: () =>
      "The way in is blocked by something none of the tools can cut. Do not swing at it: name a different target or work elsewhere, " +
      "because every clear this surface publishes refuses this block.",
  }),
  Object.freeze({
    codes: Object.freeze(["clear_blocker_gone", "clear_blocker_changed", "target_reachable_after_one_clear"]),
    action: null,
    guidance: () =>
      "The block that step was for is no longer what the request expected - it is gone, or it changed. The path this was opening may already be open: " +
      "make the walk you wanted again, and re-observe rather than re-clearing.",
  }),
  Object.freeze({
    codes: Object.freeze(["clear_blocker_out_of_reach"]),
    action: "stardew_plan_work",
    guidance: () =>
      "The block is real and she is not within reach of it. Walk to the tile beside it as a step of its own with stardew_plan_work, " +
      "then take the clear - a swing from here refuses again.",
  }),
  Object.freeze({
    codes: Object.freeze(["clear_stopped_before_swing"]),
    action: null,
    guidance: () =>
      "The clear stopped before the swing landed, so nothing was destroyed and the block still stands. The refusal carries why: " +
      "send the same clear again once that condition has changed, and do not walk around it.",
  }),
  Object.freeze({
    codes: Object.freeze(["clear_already_executed"]),
    action: null,
    guidance: () =>
      "That clearance already ran for this request, and running it twice would destroy what the first one left. Continue with the step that came after it " +
      "instead of repeating the clear.",
  }),
  Object.freeze({
    codes: Object.freeze(["clear_executed_replan_required", "target_still_blocked_after_one_clear"]),
    action: null,
    guidance: () =>
      "One clear ran and the way is still blocked. The clear did its work; what is left is a decision - read the world again and plan from what is there now, " +
      "rather than repeating the same clear.",
  }),
  Object.freeze({
    codes: Object.freeze(["blocker_outside_lease", "clearance_lease_expired", "clearance_lease_invalidated"]),
    action: null,
    guidance: () =>
      "The clearance this step belongs to no longer holds the world it was granted over - it expired, or something else changed the tile. " +
      "No swing is safe under a lease that is gone: read the world again and start a fresh clear.",
  }),
  Object.freeze({
    codes: Object.freeze(["for_each_no_rows", "for_each_pass_incomplete"]),
    action: null,
    guidance: () =>
      "The pass had nothing to work on: the rows it addresses were not in the observation it ran against. This is an empty job, not a failure - " +
      "read the world and submit a pass over the rows that reading publishes.",
  }),
  Object.freeze({
    codes: Object.freeze(["for_each_stopped", "stopped", "step_stopped_without_reason"]),
    action: null,
    guidance: () =>
      "The pass was stopped before it finished, and the remaining rows were not attempted. Nothing was lost and nothing is running: " +
      "re-submit the remainder over the rows that are still there.",
  }),
  Object.freeze({
    codes: Object.freeze(["for_each_dispatch_refused"]),
    action: null,
    guidance: () =>
      "The pass built its rows and the dispatch of one of them was refused, so the loop ended where that row was. The refusal beside this names the row's own reason: " +
      "fix that one condition and submit the pass again.",
  }),
  Object.freeze({
    codes: Object.freeze(["journal_open_stale_dispatch"]),
    action: null,
    guidance: () =>
      "An older programme's journal was still open when this one tried to start, so this one was not admitted. It is a bookkeeping hold, not a world condition: " +
      "the previous programme has to settle first, then submit this again.",
  }),
  Object.freeze({
    codes: Object.freeze(["body_program_journal_scope_contended"]),
    action: null,
    guidance: () =>
      "Another writer held the programme journal while this step tried to record itself, so the step did not run. Nothing was changed: " +
      "submit it again once the in-flight programme has finished.",
  }),
  Object.freeze({
    codes: Object.freeze(["model_stop_requested"]),
    action: null,
    guidance: () =>
      "The player's own stop ended this step, and it stopped where it was asked to. Do not resume it: wait for what they say next.",
  }),
  // THE NAVIGATION TERMINALS, GROUPED BY THE ANSWER RATHER THAN BY THE CODE. `NavigationNextStep`
  // (`integrations/stardew/navigation/navigationnextstep.cs`) is the Mod's own classification of these and already publishes
  // `next_step=` / `permanent=` in the evidence; the groups below are that classification said once each.
  Object.freeze({
    codes: Object.freeze([
      "destination_access_indeterminate",
      "native_transition_uncertain",
      "navigation_warp_postcondition_mismatch",
      "navigation_warp_source_mismatch",
      "navigation_commit_exception",
      "navigation_deadline_expired_after_warp",
      "navigation_cancelled_after_warp_child",
      "navigation_invalidated_after_warp_child",
      "door_transition_not_started",
    ]),
    action: null,
    guidance: () =>
      "This step could not read what the world did - a native transition may have happened and is uncorrelated. Do not re-issue it: " +
      "read the world first, and act on what it says now, because a second attempt could move her twice.",
  }),
  Object.freeze({
    codes: Object.freeze(["destination_unreachable", "path_not_found"]),
    action: null,
    guidance: () =>
      "No route the published topology knows reaches that destination, so nothing will walk there. Pick a destination the world block lists instead of this one; " +
      "the walk itself is not what failed.",
  }),
  Object.freeze({
    codes: Object.freeze(["destination_selector_invalid", "destination_selector_ambiguous", "destination_selector_stale"]),
    action: null,
    guidance: () =>
      "The destination that request named is not one the world currently publishes - it was spelled wrongly, matches more than one, or the list changed under it. " +
      "Read the world and copy a destination from that reading.",
  }),
  Object.freeze({
    codes: Object.freeze([
      "navigation_admission_required",
      "navigation_deadline_expired",
      "invalid_deadline",
      "navigation_source_mismatch",
      "navigation_commit_revalidation_state_mismatch",
      "navigation_approach_state_revalidated_mismatch",
      "navigation_transition_revalidated_mismatch",
      "navigation_warp_unavailable",
      "navigation_multi_hop_arm_failed",
    ]),
    action: null,
    guidance: () =>
      "The world no longer matched what this navigation was admitted against, so it stopped before committing, and nothing was moved. " +
      "Read the world as it is now and make the same request again from it.",
  }),
  Object.freeze({
    codes: Object.freeze(["navigation_commit_body_still_owned"]),
    action: null,
    guidance: () =>
      "The walk reached the door and the game's own gate did not open: something still holds the body. Wait for that to clear, " +
      "then make the same request again - retrying now answers the same hold.",
  }),
  /**
   * A DOOR THE GAME'S OWN GATE SHUT, with the state the Mod now publishes beside it (`map=`, `door_tile=`, `door_at_tile=`,
   * and for a door the clock shuts `opens_at=` / `closes_at=` / `now=` - `ExecutionManager.DescribeDoorAtTile`).
   *
   * <p>
   * THIS WAS ONE SENTENCE WITH THE BODY HOLD ABOVE, and the cost was a measured minute: `round91` read eight door refusals
   * in one window - the door shut by the clock and the answer "wait for that to clear" - so the only reading it left open
   * was to ask the same door again, which it did, six times. A clock is not a hold: it has an hour, and the hour is the
   * instruction.
   * </p>
   */
  Object.freeze({
    codes: Object.freeze(["door_gate_refused"]),
    action: null,
    guidance: (detail: string | null) => {
      const state = evidenceField(detail, "door_at_tile");
      const door = evidenceField(detail, "door_tile");
      const at = door === null ? "that door" : `the door at (${door})`;
      const opens = evidenceField(detail, "opens_at");
      const closes = evidenceField(detail, "closes_at");
      const now = evidenceField(detail, "now");
      const clock =
        state === "locked_by_hours" && opens !== null
          ? `${at} is shut by the game's own clock: it opens at ${opens}${closes === null ? "" : ` and shuts again at ${closes}`}` +
            `${now === null ? "" : `, and the clock now reads ${now}`}. Nothing she can dispatch opens it before then`
          : state === "locked_by_hours"
            ? `${at} is shut by the game's own clock, and the map does not declare its hours`
            : `The game's own gate refused ${at} - the dialogue beside this line is the game's words for why - and the tile itself is ${state ?? "declared"}`;
      return (
        `${clock}. Wait for the gate's own condition to clear, then make the same request again: the hour and the gate are ` +
        `the game's, and re-asking now answers the same refusal.${repeatedRefusalClause(detail)}`
      );
    },
  }),
  /**
   * A DOOR THAT IS NOT WHERE THE REQUEST LOOKED FOR IT. The Mod enumerates this map's exits and now publishes WHICH map that
   * list is (`map=`), the tile the request named (`door_tile=`) and whether this map declares a door on it (`door_at_tile=`).
   *
   * <p>
   * `round91` read `door_not_available ... you=7,18;nearest=28,15;distance=21` six times and the line could not say whether
   * the tile was doorless or the door was shut, so the sentence she needs - walk to the door this map DOES publish, or stop
   * asking for this tile - had to be guessed. `measured round85`'s sibling - `travel` at a tile that holds a door
   * `location.warps` never held - is the other half of the same confusion and stays a refusal for `travel`.
   * </p>
   */
  Object.freeze({
    codes: Object.freeze(["door_not_available"]),
    action: null,
    guidance: (detail: string | null) => {
      const map = evidenceField(detail, "map");
      const door = evidenceField(detail, "door_tile");
      const where = map === null || map === "unknown" ? "the map she is on" : map;
      const named = door === null ? "the tile that request named" : `(${door})`;
      const state = evidenceField(detail, "door_at_tile");
      const nearest = evidenceField(detail, "nearest");
      const doorItDoesPublish =
        nearest === null
          ? "This map publishes no exit at all, so leaving it is not a step she can take from here"
          : `The nearest transition ${where} publishes is (${nearest}), and the list beside this line names the others`;
      return (
        (state === "declared"
          ? `${where} does declare a door at ${named}, and the engine resolves no destination from it`
          : `There is no door of ${where} on ${named}`) +
        `. ${doorItDoesPublish}: walk to one of those as a step of its own before asking for the transition, or name a ` +
        `threshold the world block lists.${repeatedRefusalClause(detail)}`
      );
    },
  }),
  Object.freeze({
    codes: Object.freeze(["navigation_scope_unavailable"]),
    action: null,
    guidance: () =>
      "The session this navigation belonged to has ended, so nothing inside it can resume the walk. This request will never finish: " +
      "stop waiting on it, and plan afresh if she is still meant to go there.",
  }),
  Object.freeze({
    // The one code in these families that is NOT about the world: the Mod could not write its own receipt, so what it is
    // about to say may not reflect what happened. The honest instruction is the one it costs least to obey.
    codes: Object.freeze(["execution_receipt_persistence_failed"]),
    action: null,
    guidance: () =>
      "The game could not record what this step did, so its outcome is unproven - the work may or may not have happened. " +
      "Read the world before acting again: re-issuing a step the world already took is how a tile gets worked twice.",
  }),
]);

/**
 * The answer this table owes a code, or null when the code is not one of its families.
 *
 * A table rather than cases: the population is data, and a code that appears in two entries is caught by the coverage gate's
 * count rather than by a fall-through nobody reads.
 */
function answeredRefusal(reasonCode: string, detail: string | null): StardewActionRemedy | null {
  for (const answer of REFUSAL_ANSWERS)
    if (answer.codes.includes(reasonCode)) return { action: answer.action, guidance: answer.guidance(detail) };
  return null;
}

/** One `code:parameter` split into its parts, in the order the code carries them. */function codeParts(reasonCode: string, prefix: string): readonly string[] {
  return reasonCode.slice(prefix.length).split(":");
}

/** The Mod's evidence travels as `{ detail: "key=value;..." }`. */
export function evidenceDetailOf(evidence: unknown): string | null {
  if (typeof evidence === "string") return evidence;
  if (evidence !== null && typeof evidence === "object" && "detail" in evidence) {
    const detail = (evidence as { detail?: unknown }).detail;
    return typeof detail === "string" ? detail : null;
  }
  return null;
}

/** One `key=value` pair out of the Mod's `;`-separated evidence detail. */
export function evidenceField(detail: string | null, key: string): string | null {
  if (detail === null) return null;
  for (const part of detail.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) === key) return part.slice(at + 1);
  }
  return null;
}

/**
 * The one clause a refusal that has just come back IDENTICAL adds, from the count the Mod publishes
 * (`same_refusal_as_before=<n>`, `ExecutionManager.NoteRepeatedRefusal`): how many identical answers came before this one.
 *
 * <p>
 * MEASURED `round91`: eight door refusals in one window, `door_out_of_range` twice with the same actor and distance and
 * `door_not_available` six times, every one word for word its predecessor - and nothing in the delivery said the world had
 * not moved. The companion stood at a closed door for over a minute asking it again. The count is the fact that makes the
 * repetition visible; the sentence is the instruction that stops it.
 * </p>
 */
function repeatedRefusalClause(detail: string | null): string {
  const repeated = evidenceField(detail, "same_refusal_as_before");
  if (repeated === null || !/^\d+$/u.test(repeated)) return "";
  return (
    ` This exact answer has already come back ${repeated} time(s) with nothing in the world changing between them, so ` +
    `asking again reads the same: do something else first, or wait for the world to move.`
  );
}

/**
 * One tile out of the Mod's evidence, in the spelling the world block uses - or null when the field is not a tile.
 *
 * The refusal families carry their coordinates as `closest=34,6` / `source=9,-1` / `target=9,1`, and the sentence has to
 * print them the way `<world-state>` prints every other tile (`(34,6)`), or the reader is given two spellings of one place.
 * A field that is not a pair is NOT printed as one: `target=Railroad:29,59` and `target=stardew_native` both occur.
 */
function tileOf(value: string | null): string | null {
  if (value === null) return null;
  const pair = /^(-?\d+),(-?\d+)$/u.exec(value);
  return pair === null ? null : `(${pair[1]},${pair[2]})`;
}

/**
 * The countermeasure for a WORLD transient, from the deadline the Mod publishes rather than from a number of ours.
 *
 * A transient is a hold whose own producer ends it, and the Mod publishes both halves: what is left of the window that
 * producer is allowed (`hold_remaining_ms`), and `next_step=report_the_stalled_body` from the instant it has passed - the
 * pair a declared `body_pause` hold publishes. MEASURED `round97` (day 6 11:40): this case read
 * `transient_kind=warping;retry_window_ms=2000` for four minutes while `Game1._isWarping` never came down and the game clock
 * stood at 1140, and answered "this clears on its own ... re-issue after about 2000 ms" every time it was asked - so the one
 * caller that could have stopped kept waiting.
 */
function transientBusyGuidance(detail: string | null): StardewActionRemedy {
  const kind = evidenceField(detail, "transient_kind") ?? "a short animation";
  if (evidenceField(detail, "next_step") !== "wait_for_retry_window") {
    const overrunMs = evidenceField(detail, "hold_overrun_ms");
    return {
      action: null,
      guidance:
        `The farmhand is held by ${kind}, and that hold's own producer has not ended it inside the window it is ` +
        `allowed${overrunMs === null ? "" : ` (${overrunMs} ms past it)`}, so waiting is not a plan. ` +
        `Read the world once with stardew_observe; if it still reports the body held, report the blockage instead ` +
        `of re-issuing the request.`,
    };
  }
  const remainingMs = evidenceField(detail, "hold_remaining_ms");
  return {
    action: null,
    guidance:
      `The farmhand is briefly busy with ${kind}; this clears on its own and no tool can shorten it. ` +
      `Re-issue the SAME request ` +
      `${remainingMs === null ? "after a moment" : `in about ${remainingMs} ms, all that is left of its window`} ` +
      `rather than changing the target.`,
  };
}

/**
 * The countermeasure for a refusal, or null when this reason code is not one this module knows.
 *
 * Returning null matters: a remedy attached to a code it does not understand would tell the Agent to close a
 * dialogue that is not open.
 */
export function remedyForRefusal(reasonCode: string | null, detail: string | null): StardewActionRemedy | null {
  const answered = reasonCode === null ? null : answeredRefusal(reasonCode, detail);
  if (answered !== null) return answered;
  switch (reasonCode) {
    case "actor_held_by_modal": {
      const modalType = evidenceField(detail, "modal_type") ?? "a menu";
      const isQuestion = evidenceField(detail, "is_question");
      if (isQuestion === "true")
        return {
          action: "stardew_plan_work",
          guidance:
            `The farmhand cannot act because a ${modalType} is waiting for an answer. Answering it is an ` +
            `action in the plan you submit with stardew_plan_work: submit 'answer_dialogue' with the responseKey ` +
            `you want, then re-issue the same request.`,
        };
      if (isQuestion === "false")
        return {
          action: "stardew_plan_work",
          guidance:
            `The farmhand cannot act because a ${modalType} is on screen. Closing it is an action in the ` +
            `plan you submit with stardew_plan_work: submit 'dismiss_modal', then re-issue the same request with ` +
            `the same target.`,
        };
      // No answer state was readable, which is the case for an operation menu rather than a dialogue. Say
      // what will actually happen instead of promising a close that the whitelist may refuse.
      return {
        action: "stardew_plan_work",
        guidance:
          `The farmhand cannot act because a ${modalType} is on screen. Dismissing it is an action in the ` +
          `plan you submit with stardew_plan_work: submit 'dismiss_modal'; it refuses menus it is not allowed to ` +
          `close, and if it refuses, report the blockage instead of retrying the original request.`,
      };
    }
    case "transient_busy":
      return transientBusyGuidance(detail);
    // The cutscene hold. The evidence decides whether there is anything to ACT ON, because a cutscene is not one
    // state: two modal-family handlers act on its own dialogue box (`dismiss_modal` closes it and the native close
    // advances the event; `answer_dialogue` answers a question raised inside it), and with no box on screen no action
    // at all can move the scene along. One sentence covered both, so a run that met a box it could have advanced read
    // "no action can run" and retried until it gave up - measured: four retries over twenty minutes, then
    // "Persistent cutscene ... I just wait."
    case "cutscene_active": {
      const dialogueBox = evidenceField(detail, "dialogue_box");
      const isQuestion = evidenceField(detail, "is_question");
      if (dialogueBox === "true" && isQuestion === "true")
        return {
          action: "stardew_plan_work",
          guidance:
            "A cutscene is holding the farmhand and its dialogue is waiting for an answer. Answering it is an " +
            `action in the plan you submit with stardew_plan_work: submit 'answer_dialogue' with the responseKey the ` +
            "box offers - and if you do not have the keys, submit 'dismiss_modal' once: it refuses a question box " +
            "and that refusal lists the keys and the question.",
        };
      if (dialogueBox === "true")
        return {
          action: "stardew_plan_work",
          guidance:
            "A cutscene is holding the farmhand and its dialogue box is on screen. Advancing it is an action in " +
            `the plan you submit with stardew_plan_work: submit 'dismiss_modal'; if the box is asking a question that ` +
            "step is refused with the offered response keys, which is what 'answer_dialogue' needs.",
        };
      return {
        action: null,
        guidance:
          "A cutscene currently holds the farmhand, so no action can run. Do not issue actions until the " +
          "scene ends: it advances on its own, and the request can be re-issued once it does.",
      };
    }
    // The modal family was admitted into the cutscene and found nothing to act on: the event is running with no
    // dialogue box, so there is no box to dismiss or answer and nothing in the catalog advances an event's own
    // command program. Named separately from `cutscene_active` because the answer is different: this is a wait that
    // ends by itself, not a hold whose countermeasure the Agent has not found yet.
    case "event_has_no_dialogue_box":
      return {
        action: null,
        guidance:
          "A cutscene is holding the farmhand and it has no dialogue box on screen, so no tool can move it along. " +
          "Do not retry now: the scene advances on its own until its next dialogue, and the request can be re-issued " +
          "once the cutscene ends.",
      };
    case "actor_passed_out":
      return {
        action: null,
        guidance:
          "The farmhand is unconscious (exhausted or past the forced end of day), so nothing can be done " +
          "until the next in-game day begins. Do not retry the request.",
      };
    // A named `body_owned_by_*` code says WHICH in-flight execution holds the body. The Mod's frozen table
    // fixes whether that owner can be superseded: only an in-flight local movement yields to a newer command,
    // so only that one is told to re-issue now; every other owner has to settle on its own first.
    case "body_owned_by_navigation":
      return {
        action: null,
        // This owner is NOT supersedable, and the Mod says so (`interruptible=false`, pinned by a test). I checked
        // which side was wrong by reading the movement path: `RequestLocalMove`'s own occupancy guard
        // (farmhandexecutioncontroller.movementactions.cs:50) does not include `activeNavigate`, and the only place
        // a navigation ends is its own approach handoff (`HandleNavigationApproachTransition`, :3763). So there is
        // no takeover to offer - a new move either gets `body_release_unavailable` or proceeds while the
        // navigation is still nominally the owner. The TEXT was the wrong half, so the text is what changed.
        guidance:
          "The farmhand is already walking to a target an earlier request chose, and that walk cannot be taken " +
          "over. Wait for it to settle, then re-issue the same request.",
      };
    case "body_owned_by_travel":
      return {
        action: null,
        guidance:
          "The farmhand is changing location through a door, warp or mine entrance. Wait for the transition " +
          "to finish, then re-issue the same request; a map transition cannot be interrupted.",
      };
    case "body_owned_by_movement":
      return {
        action: null,
        // The guidance is keyed on the OWNER, but what the Agent should do depends on the owner AND what it
        // asked for: only a MOVEMENT directive displaces a walk in progress
        // (farmhandexecutioncontroller.movementactions.cs:52-53 cancels `active`), so a re-issued tool action
        // would simply be refused again. An earlier version promised "the new directive takes over" to any
        // requester, which is false for everything that is not a move. The text now names which case the Agent
        // is in rather than assuming one.
        guidance:
          "Wait for the walk to settle, or replace it: a new movement directive takes over from a walk in " +
          "progress, so if you meant to walk somewhere, re-issue the request now. Any other action has to wait " +
          "for the walk to end.",
      };
    case "body_owned_by_approach":
      return {
        action: null,
        guidance:
          "The farmhand is walking into reach of a target another request chose. Wait for the approach to " +
          "finish, then re-issue the same request.",
      };
    case "body_owned_by_ride":
      return {
        action: null,
        guidance:
          "The farmhand is riding a mount or bus. Wait for the ride to end, then re-issue the same request; " +
          "a ride cannot be interrupted mid-trip.",
      };
    case "body_owned_by_day_advance":
      return {
        action: null,
        guidance:
          "The farmhand is in the day-advance transition. Wait for the new day to begin, then re-issue the " +
          "same request; the transition cannot be interrupted.",
      };
    case "body_owned_by_activity":
      return {
        action: null,
        guidance:
          "The farmhand is occupied by another in-flight activity (petting, animal produce, item use, pickup " +
          "or pedestal taking). Wait for it to finish, then re-issue the same request.",
      };
    default:
      // A QUEUED REQUEST THAT OUTLIVED ITS WAIT. The Mod parks a request that collides with the actor's own in-flight
      // work and dispatches it the moment that work ends; when the owner outlasts the Mod's bounded window the wait
      // ends in this code, which names the owner the wait was for. Nothing was started, so this is recoverable by
      // re-issuing against the world as it is now - and the owner itself travels in the evidence.
      if (reasonCode !== null && reasonCode.startsWith("waiting_for_body:")) {
        const owner = evidenceField(detail, "owner_action") ?? reasonCode.slice("waiting_for_body:".length);
        return {
          action: null,
          guidance:
            `The farmhand was still busy with ${owner}, so the request waited and was not started. Re-issue the same ` +
            `request: if that work is still running it will wait again rather than being lost, so do not change the target.`,
        };
      }
      // The Mod keeps the `body_owned_` prefix on every named hold, so a named code this table does not list
      // yet still gets actionable guidance instead of degrading to an unknown error. The bare legacy
      // `body_owned` names no owner and carries no countermeasure, so it keeps returning null.
      if (reasonCode !== null && reasonCode.startsWith("body_owned_"))
        return {
          action: null,
          guidance:
            "The farmhand's body is held by another in-flight execution. Wait for it to settle, then re-issue " +
            "the same request instead of repeating it in a loop.",
        };
      // A REQUEST FOR A TILE NOTHING SAFE OPENS. The Mod's healing join answers a refused row with the code alone -
      // `no_safe_clear:<occupant>:<action>` - because the sentence is the conversation's: it has to arrive in the run's own
      // words, and re-wording it must not be a Mod release. Until 2026-11-19 that sentence lived in the Mod's clearing
      // declaration, in English, and reached the model only through a chain of four records.
      if (reasonCode !== null && reasonCode.startsWith(NO_SAFE_CLEAR_PREFIX)) {
        const [occupant = "occupant", swing = "that action"] = codeParts(reasonCode, NO_SAFE_CLEAR_PREFIX);
        return {
          action: "stardew_plan_work",
          guidance:
            `The ${occupant} standing here is something she put there, not an obstruction: ${swing} would take it, so the ` +
            `pass withheld that swing and left it standing. If it should go, dispatch ${swing} yourself as a step of its ` +
            `own with stardew_plan_work - it is her decision, not the pass's. Otherwise work a different tile.`,
        };
      }
      // AND A TILE NOTHING PUBLISHED OPENS AT ALL. The honest answer is that no step exists, so the Agent must stop asking
      // this tile for one instead of re-issuing the request.
      if (reasonCode !== null && reasonCode.startsWith(NO_PUBLISHED_CLEAR_PREFIX)) {
        const [occupant = "occupant"] = codeParts(reasonCode, NO_PUBLISHED_CLEAR_PREFIX);
        return {
          action: null,
          guidance:
            `Nothing the plan library publishes removes the ${occupant} standing on the tile the request named, so no step ` +
            `can work that tile. Leave it as it is and work a different one: re-issuing the same request cannot change it.`,
        };
      }
      return null;
  }
}

/**
 * Everything an Agent-visible refusal carries: the Mod's named code, the Mod's evidence, the countermeasure, and the exact
 * sentence appended to the tool result.
 *
 * The tool layer and the live probe both call THIS, so what a probe asserts is literally what the Agent reads - an
 * assertion on a hand-written sentence would prove nothing about the tool result.
 */
export function describeRefusalRemedy(reasonCode: string | null, evidence: unknown): StardewActionRemedy | null {
  return remedyForRefusal(reasonCode, evidenceDetailOf(evidence));
}

/**
 * The name the tool layer and the live-smoke harness still call.
 *
 * It answers every refusal this module knows, which is what its caller already asks it for - the tool layer hands it every
 * refused receipt, and a body hold is only the majority of them. One function, one spelling; the alias exists because
 * `tools/**` pins the name and the tool layer's own import is not this unit's to change.
 */
export const describeBodyHoldRefusal = describeRefusalRemedy;
