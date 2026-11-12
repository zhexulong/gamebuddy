import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import {
  FOR_EACH_SOURCE_UNRECOGNISED,
  forEachDocumentLength,
  forEachRules,
  MAX_FOR_EACH_LOOP_DOCUMENT_CHARS,
  MAX_FOR_EACH_ROWS,
  MAX_FOR_EACH_RULES,
  MAX_FOR_EACH_STEPS,
  PLAN_FOR_EACH_ROW_IDENTITY_ARGUMENT,
  PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL,
  PLAN_FOR_EACH_SOURCES,
  type PlanForEachLoop,
  readForEachLoop,
  sameForEachSource,
  withForEachRule,
} from "./body-program-for-each.js";
import { heldToolChargeCeiling, packAreaSteps, packingKindOf } from "./body-program-packing.js";
import {
  type ActionRegistration,
  type BodyProgramCandidateRequest,
  type Snapshot,
  executionRequestIntegerBounds,
} from "./protocol.js";
import { isNonNegativeSafeInteger, isOpaqueId, isRecord, isTileCoordinate } from "./protocol-target-facts.js";

/**
 * Host-side plan script compiler (CARD-BODY-PROGRAM-SYNTHESIZER-BOUNDARY, as amended by the owner).
 *
 * The companion writes a short synchronous SCRIPT that names the work: a loop over the snapshot's own
 * targets, one `builder.<actionId>({...})` call per step. This module runs it exactly once, in a
 * throwaway context, and turns the nodes it produced into ONE standard Body Program that the caller
 * submits through the same path a hand-written program takes. Nothing here executes game physics,
 * chooses a route, or invents a target: every action id and every argument name comes from the
 * published surface, and every value comes from the script's own reading of the snapshot.
 *
 * Deliberately absent from the script's world: Node globals, the network, the clock, randomness,
 * timers, and any way to compile more code. A script that reaches for one is refused BY NAME before
 * it runs (`plan_script_uses_forbidden:<name>`), and the context does not carry it either.
 */

/**
 * One argument as the Mod declared it: the name a script must use, the kind it must supply, and any closed set.
 *
 * `required` is always `true`, and it is not decoration: the Mod's protocol has no optional arguments
 * (`FarmhandActionDefinitions.cs:438-439`, written when a gift-with-item action was split in two for exactly this reason),
 * and this compiler refuses any declared argument that is omitted. Measured in `.tmp/fork-why-slow.jsonl`: seven of the
 * fourteen voided batches omitted `expectedQualifiedItemId` or `slot` while supplying the action's other arguments, which
 * is what a flat name list reads like when nothing says the list is closed. The field states the rule the loop below
 * enforces, and `body-program-script.test.ts` ties the two together over every published action.
 */
type PlanArgumentShape = Readonly<{
  name: string;
  type: string;
  required: true;
  enum?: readonly string[];
  description?: string;
}>;

/**
 * The tool one action must be holding, as the surface itself declares it, or the surface's silence.
 *
 * The Mod publishes the tool as a resource claim - key `tool:<category>`, value its own word for the upgrade-level
 * requirement (`AnyUpgrade` / `BasicOnly`, the enum the Mod declares; `claim.Value.ToString()` is what reaches the
 * wire). So the answer is read off the claim and never inferred from an action id: `cut_weeds` needing the scythe is
 * the surface's fact, not a table in the Host. `declared: false` is NOT "no tool needed" - it is the surface saying
 * nothing about a tool for that action, which the companion is told by name (`tool_requirement_undeclared`) instead of
 * being left to guess a slot from tool order.
 */
/**
 * Where the actor must stand before an action can happen.
 *
 * Separate from `toolRequirement` on purpose: a claim says what the action OCCUPIES (`embodied_actor`,
 * `tool:scythe`), and a spatial precondition says where the BODY must be. Folding the second into the first would
 * make a resource claim mean two different things.
 *
 * Why it exists: measured 2026-10-25, the companion submitted a one-node program `enter_exit(3,12)` while it was in
 * bed at `FarmHouse (9,9)`. The Mod refused with `door_out_of_range` - correctly - and the companion only learned the
 * precondition by being refused, then added `move_to_tile(3,11)` on its second attempt and succeeded. A refusal that
 * teaches is worse than a shape that says so.
 */
type PublishedPlanApproachRequirement =
  | Readonly<{
      declared: true;
      /**
       * The surface's own word for the relationship the actor must have with the target, verbatim.
       *
       * The Mod publishes two: `adjacent` - you must already stand beside it, in a step of your own - and
       * `self_walked` - the action closes the distance itself, so no separate move is needed and no distance is
       * stated. `self_walked` is why this field exists in its present form: the handlers that walk in used to declare
       * nothing, and `declared: false` then meant both "no constraint" and "nobody decided".
       */
      relation: string;
      /** How many tiles away that relationship allows, or `null` when the surface states no distance. */
      withinTiles: number | null;
    }>
  | Readonly<{ declared: false; reasonCode: "approach_requirement_undeclared" }>;

type PublishedPlanToolRequirement =
  | Readonly<{
      declared: true;
      category: string;
      /** The surface's own word for the level requirement, verbatim, so an unknown value still reads as declared. */
      upgradeRequirement: string;
      /** Lowest upgrade level that satisfies the claim, or `null` when the surface's word says nothing about level. */
      minimumUpgradeLevel: number | null;
      /** Highest upgrade level that satisfies the claim - `0` for a basic-tool-only claim - or `null` when unbounded. */
      maximumUpgradeLevel: number | null;
    }>
  | Readonly<{ declared: false; reasonCode: "tool_requirement_undeclared" }>;

/**
 * One action as the Mod published it for Body Programs: the id, the family it belongs to, and everything a script or a
 * program must supply or can read back. Every field is the Mod's own declaration, so a refusal or a shape answer cannot
 * describe an action differently from the surface the Mod actually enforces.
 */
export type PublishedPlanAction = Readonly<{
  actionId: string;
  familyId: string;
  lifecycle: string;
  arguments: readonly PlanArgumentShape[];
  outputFacts: readonly Readonly<{ name: string; type: string }>[];
  resourceClaims: readonly Readonly<{ key: string; value: string }>[];
  /** The tool the surface requires for this action, or the surface's silence - never a Host-side guess. */
  toolRequirement: PublishedPlanToolRequirement;
  /** Where the actor must stand before this action can happen, or the surface's silence. */
  approachRequirement: PublishedPlanApproachRequirement;
  /**
   * The snapshot family that supplies this action's targets (`cropTargets`), or the surface's silence.
   *
   * Carried so a refusal can name the family to re-read rather than a field the caller has no way to look up. The two
   * halves it joins - the `Discover*` projection that publishes rows and the preflight that refuses them - are
   * otherwise connected by nothing, which is the shape of every defect that had discovery publish rows execution
   * refused.
   */
  targetFamily: string | null;
}>;

/**
 * What a `slot` argument means when the SURFACE says nothing about it.
 *
 * Corrected 2026-10-29. This used to read "never a backpack index", which is false: all thirteen actions that take a
 * `slot` read `Game1.player.Items[slot]` - a backpack index - and only the tool family additionally requires it to
 * equal `Farmer.CurrentToolIndex` (`resourcetoolactions.cs:27`). Three sub-meanings that one sentence could not cover,
 * so each action's own argument now carries its own `description` and this constant is the FALLBACK for a surface that
 * publishes none, not the authority for all of them.
 */
export const PLAN_TOOL_SLOT_MEANING =
  "A `slot` argument is a BACKPACK index - the same index `snapshot.toolSlots` uses for tools. A tool action additionally requires it to be the held tool (`snapshot.currentToolSlot`); an item action accepts any pack index. When the action's own arguments carry a `description`, that is the authority for it.";

type PlanNode = BodyProgramCandidateRequest["nodes"][number];
type PlanArgument = PlanNode["arguments"][string];

export type PlanScriptRequest = Readonly<{ script: string }>;

/** The action a refused builder call named, and the arguments and claims the published surface requires for it. */
type PlanArgumentRequirement = Readonly<{
  actionId: string;
  requiredArguments: readonly PlanArgumentShape[];
  resourceClaims: readonly Readonly<{ key: string; value: string }>[];
  /** The snapshot family that supplies this action's targets, when the surface names one. */
  targetFamily?: string;
}>;

/**
 * The engine's own account of a script that threw: what it said, and the script line it named.
 *
 * `plan_script_threw:SyntaxError` is the one refusal no builder call can explain - the action vocabulary, the
 * argument names and the target families are all correct and the script still does not compile - so the reason code
 * alone leaves a caller with eight kilobytes of its own text and no place to look. `line` is the script's own
 * numbering (the wrapper the script is run inside does not count), and it is `null` when the engine blamed a line
 * that is not in the script at all: an unclosed group is reported where the wrapper's closing brace sits.
 */
type PlanScriptThrow = Readonly<{ message: string; line: number | null }>;

/**
 * One builder call the compiler refused, and the script position that wrote it.
 *
 * `call` is the 1-based index among the script's builder calls - the same order the builder was entered in, refused calls
 * included - so a companion that wrote thirty calls reads back WHICH of its thirty was wrong without counting the nodes
 * that survived.
 */
type PlanCallRejection = Readonly<{
  call: number;
  actionId: string | null;
  reasonCode: string;
  /** The arguments this call left out, when that is what refused it. */
  missingArguments?: readonly string[];
}>;

/**
 * How many authored calls one answer spells out in each of its lists, and why the count is separate from the list.
 *
 * A loop over a family the snapshot publishes can call the builder hundreds of times, so a hundred entries per list would
 * spend the turn's context on the same sentence repeated. The lists are bounded and the counts are not, so the answer says
 * how many there were without carrying all of them.
 */
const MAX_REPORTED_PLAN_CALLS = 16;

/**
 * How many insertions one answer spells out, bounded for the same reason the rejection list is: a loop over a
 * body-yielding family can insert the same dismissal dozens of times, and the repetition would spend the turn's context
 * saying one thing. `insertedCount` is not bounded, so the answer still states the population.
 */
const MAX_REPORTED_PLAN_INSERTIONS = 16;

/**
 * What became of every call the author wrote, by the one numbering a REFUSED plan still has: the position of her call.
 *
 * `n01` is her FIRST CALL - not node `n01`, which a plan that was refused does not have, and which the compiler's own
 * insertions displace for every call after them. Every list is bounded (see `MAX_REPORTED_PLAN_CALLS`) and every count is
 * not, so a bounded list never reads as "that was the whole of it".
 *
 * THE FOUR LISTS PARTITION THE CALLS THE SCRIPT REACHED: each call lands in exactly one of `acceptedSteps`, `merged`,
 * `noStepNeeded` and `dropped`, so their counts sum to the number of builder calls the script made. That is the invariant
 * `tools/check-plan-legal-fixpoint.mjs` asserts over the whole published vocabulary, and the reason an `ok` answer can no
 * longer hide a step that was thrown away.
 *
 * The limit is stated rather than hidden: a refusal that ends the WHOLE script (a builder method the surface does not
 * publish, the call cap, the node cap, a throw, a timeout) stops the interpreter, so the calls after it were never
 * reached and cannot be enumerated here. That answer carries its own `reasonCode`, which names the call it died on
 * (`plan_script_unknown_action:<name>`), and the lists name the calls that had compiled before it.
 */
type PlanCallAccount = Readonly<{
  /** Her calls whose own step is a node of the program. */
  acceptedSteps: readonly string[];
  acceptedStepsCount: number;
  /**
   * Her loops that joined an EARLIER node's loop instead of becoming their own: `n07:into=n03:same_source`.
   *
   * A `for_each` over a source a previous `for_each` already names is a second RULE of that one pass - the Mod expands one
   * pass per source - so the call did change the program, just not into a node of its own. Named because a fold the author
   * cannot see is the program quietly disagreeing with her script, which is the same defect as a drop one notch softer: the
   * result still looks right.
   */
  merged: readonly string[];
  mergedCount: number;
  /** Her calls that had nothing to do: `n04:equip_for:already_held`, the tool the action needs was already in hand. */
  noStepNeeded: readonly string[];
  noStepNeededCount: number;
  /** Her calls that were refused: `n03:plan_script_...`, so that step of hers is not going to run. */
  dropped: readonly string[];
  droppedCount: number;
}>;

export type CompiledPlan =
  | Readonly<
      {
        ok: true;
        scriptSource: string;
        snapshotRevision: number;
        program: Readonly<{ nodes: readonly PlanNode[] }>;
        /**
         * The nodes this compiler INSERTED into the list the script wrote, in program order, one entry per node, spelled
         * `inserted=<actionId>;before=<nodeId>`: what it wrote, and the node it wrote that immediately before.
         *
         * Present because the program that runs is NOT the program the author wrote, and an author who cannot see the
         * difference reads a node list that disagrees with her script for no stated reason. Bounded;
         * `insertedCount` is the population.
         */
        inserted: readonly string[];
        /** Every insertion, including the ones past `MAX_REPORTED_PLAN_INSERTIONS`. */
        insertedCount: number;
        /**
         * The node IDS this compiler minted, in program order, in full - the population `inserted` names by action.
         *
         * `inserted` says WHAT was written and where; this says which nodes are the compiler's, exactly. It exists for
         * the one reading nobody can derive from a node list: whether a node the author never asked for ever surfaced as
         * a failure (`inserted_node_refusals`). A prefix match on `auto_` would answer that too and would be a second
         * spelling of the fact, so the producer states the set it wrote - and a plan that inserted nothing states an
         * empty array rather than leaving a reader to infer zero from an absent field.
         */
        insertedNodeIds: readonly string[];
        /**
         * Layout facts this plan's own nodes depend on that the snapshot it was compiled against does not carry, one per
         * `layout_facts_absent:call <n>:<fact>`. Bounded; `layoutFactsAbsentCount` is the population, and a list that had
         * to be cut ends in one `layout_facts_absent_over_ceiling:<count>:<ceiling>` row naming the ceiling and the
         * population it truncated.
         */
        layoutFactsAbsent: readonly string[];
        layoutFactsAbsentCount: number;
      } & PlanCallAccount
    >
  | Readonly<
      {
        ok: false;
        scriptSource: string;
        snapshotRevision: number | null;
        reasonCode: string;
        /** Present when the refusal was a builder call, so the answer names what that action demands. */
        requirement?: PlanArgumentRequirement;
        /** Every argument the refused call left out, so a correction fixes all of them and not only the first. */
        missingArguments?: readonly string[];
        /**
         * The refused calls, in the order the script wrote them: the call's position, the action it named, and why.
         *
         * `dropped` beside it is this list rendered as the names the author reads; this one carries the per-call detail
         * (the action, and every argument the call omitted) that a correction is written from.
         */
        rejected: readonly PlanCallRejection[];
        /** Every refusal, including the ones past `MAX_REPORTED_PLAN_CALLS`. */
        rejectedCount: number;
        /** Present when the script threw, so the answer says what the engine said and where. */
        threw?: PlanScriptThrow;
      } & PlanCallAccount
    >;

/**
 * How many targets ONE PLAN can name, which is what the observation budget sizes its per-stack window against.
 *
 * <p>
 * This is NOT `MAX_PLAN_NODES` and must never become it again. They were the same number while both were 16, so the
 * observation budget imported the plan ceiling and nobody noticed - until the ceiling became a read-back corruption bound
 * of 256 and three tests failed with `actual: 64, expected: 256`. The two quantities answer different questions:
 * </p>
 * <ul>
 * <li>`MAX_PLAN_NODES` - the largest node array a journal this product could have written may declare. A corruption bound,
 * beside `Programs.Count > 128`.</li>
 * <li>`TARGETS_NAMED_PER_PLAN` - how many DISTINCT targets one plan's worth of steps can address, which is what makes a
 * catalogue row "reachable by some plan" or "a row no plan can exhaust".</li>
 * </ul>
 * <p>
 * 16 stays here because it is a statement about a plan a model writes, and 16 steps is the shape that measurement found:
 * of 26 programs in one run, eight sat exactly on it. If a plan really can name more than 16 targets, THIS is the number
 * to raise - on its own evidence, not by following the journal's corruption bound.
 * </p>
 */
export const TARGETS_NAMED_PER_PLAN = 16;

/**
 *
 * <p>
 * 256 IS A CORRUPTION BOUND, NOT A BUDGET. The same number is checked on the READ-BACK path
 * (`BodyProgramJournalPersistence.TryDecode` -> `TryValidate`), where it sits beside `Programs.Count > 128` and
 * `Events.Count > 4096` and does what those do: refuse a file that cannot be a journal this product wrote. A plan of 16
 * nodes is not a corrupt journal, so a reader-side bound of 16 was never protecting anything - it was the WRITER's policy
 * leaking into the reader.
 * </p>
 * <p>
 * It was 16, and the cost was measured on 2026-10-31: of 26 programs in one run, **eight were exactly 16 and none was
 * larger**, and over 117 historical `plan_work` calls 31 used `builder.isFull()` - the guard this bound publishes. A
 * companion that can see 16 weeds and can only act on 16 of them never learns the field is bigger, so the ceiling became a
 * fact about the world rather than a limit on one turn. The real constraint on one execution is TIME: every action
 * already publishes its own `WatchdogMs` (60 s ordinary, 600 s navigation/lifecycle), and that is what a total budget
 * should be built from when there is measured per-action latency to build it on.
 * </p>
 */
export const MAX_PLAN_NODES = 256;

/**
 * The node action id of the `for_each` plan form.
 *
 * It is NOT one of the Mod's published actions and nothing registers it as one: the Mod cannot execute the form yet, and
 * a capability advertised without an executor is a capability a caller can believe in. The node still exists, because
 * both alternatives are lies - a plan that silently dropped the loop would read as a patch that was covered, and a plan
 * that refused the whole script would lose the steps the caller wrote around it. So the form compiles into a node the
 * submission path already carries, and `plan_work` names by code exactly the nodes whose action id the attached Mod does
 * not publish (`for_each_execution_unavailable`) rather than sending work that cannot run.
 */
export const FOR_EACH_PLAN_ACTION_ID = "for_each";

/**
 * Every node action id this compiler can produce that is a HOST plan FORM rather than a published Mod action.
 *
 * The distinction is answered at submission time from the Mod's own catalogue, never from a list kept here: a form whose
 * id the attached Mod does publish is executable by definition, and stops being named unavailable the moment the Mod
 * ships it. `plan_work` therefore derives the answer instead of restating it.
 */
export const PLAN_FORM_ACTION_IDS: readonly string[] = Object.freeze([FOR_EACH_PLAN_ACTION_ID]);

/** The published action whose one job is putting a tool in hand; the `equipFor` helper writes it. */
const EQUIP_TOOL_ACTION_ID = "equip_tool";

/** The published action whose one job is putting the body on (or beside) a tile; a transition's approach step uses it. */
const MOVE_TO_TILE_ACTION_ID = "move_to_tile";

/**
 * The id prefixes a plan node carries, so a reader can tell the compiler's own nodes from the author's.
 *
 * The author's steps are `n<position>`; the walk the compiler writes to reach a transition is `auto_walk_<position>`, and
 * the dismissal it writes after a body-yielding step is `auto_dismiss_<position>`. The number is the position the node
 * holds in the program that runs, which is the one numbering every part of the answer agrees on.
 */
const PLAN_AUTHOR_NODE_PREFIX = "n";
const PLAN_WALK_NODE_PREFIX = "auto_walk_";
const PLAN_DISMISSAL_NODE_PREFIX = "auto_dismiss_";

/** One plan node id, in the positional scheme the rest of the answer reads it by. */
function planNodeId(prefix: string, position: number): string {
  return `${prefix}${String(position).padStart(2, "0")}`;
}

/**
 * The two location transitions whose `x`/`y` name a door or warp SOURCE tile the body must already be beside, and which
 * do not walk there themselves.
 *
 * Why the compiler writes the walk: the Mod gates BOTH actions on the actor's distance from the named tile
 * (`farmhandexecutioncontroller.movementactions.cs:478`, answered as `door_out_of_range` / `warp_out_of_range`), and
 * neither walks - `travel` and `enter_exit` resolve the warp and drive the transition, while `move_to_tile` is the Mod's
 * one action that moves the body. Measured 2026-10-25: the companion submitted a one-node `enter_exit(3,12)` from its
 * bed and was refused, then added `move_to_tile(3,11)` on its second attempt and succeeded. The walk was never a choice
 * the author should have had to make, and every round trip spent learning it is one the plan did not need.
 *
 * The walk is prepended rather than required of the author because reachability is the Mod's answer, not the
 * compiler's: a door tile with no route is refused by the walk step with `no_native_path`, which names what is in the
 * way, where the transition's own refusal would only say the body is far from a tile it named correctly.
 */
const TRANSITION_SOURCE_PLAN_ACTION_IDS: readonly string[] = Object.freeze(["enter_exit", "travel"]);

/**
 * The actions that rebuild the world under a plan, so a plan must END at one.
 *
 * `advance_day` walks the actor to its own bed and runs the save/warp/day-start lifecycle
 * (`SleepAndAdvanceDayLifecycle.Phase.WalkingToBed` -> `WalkToBed()`), after which the farm every later node was
 * compiled against no longer exists. It carries no arguments and its target is the actor's own bed, so it is
 * naturally the last node of any plan - which is what makes this a compile-time rule instead of a style preference:
 * a node written after it can only be refused by the Mod at runtime, aimed at a world that is gone.
 *
 * A DECLARED SET is the honest shape today, and the gap is worth naming for whoever publishes the next
 * world-resetting action: the surface does publish `postcondition.name` (`advance_day` declares `day_advanced`), but
 * nothing in that declaration says the action rebuilds the world, and `PublishedPlanAction` does not carry the
 * postcondition at all. So there is no catalog property to derive membership from yet, and an action missing from
 * this list is silently exempt - which is why the next world-resetting action must join it in the change that
 * publishes the action. `body-program-script.test.ts` checks the members against the one catalog fact there is: every
 * surface action declaring `day_advanced` must be refused as a mid-plan step, so a second one fails a named assertion
 * instead of being exempt.
 */
const WORLD_RESETTING_PLAN_ACTION_IDS: readonly string[] = Object.freeze(["sleep"]);

/**
 * Actions that SUCCEED and leave the body unable to act, so the step after them needs the modal cleared first.
 *
 * `talk_to_npc` raises a native dialogue: `drawDialogue` sets `player.CanMove = false` and mounts a `DialogueBox`, and the
 * Mod reports the node `Succeeded` while that box is still up (`farmhandexecutioncontroller.npcactions.cs:255`, whose own
 * evidence records `player_can_move_after`). Every following body-owning node is refused by the game while the box is up,
 * so "talk, then buy" needs a dismissal between the two steps.
 *
 * THE DISMISSAL IS WRITTEN, NOT DEMANDED. Measured round42 (live, day 6): four separate programs were refused
 * `plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal` - the author wrote "talk to
 * the shopkeeper, then buy seeds" four times, was told the same remedy four times, and bought no seed in any of those
 * turns. The rule was right and the remedy was mechanical: one node of an action the Mod already publishes, in the one
 * position nothing else competes for. `emitPlanNode` writes it and reports it (`inserted=...;before=...`).
 *
 * A DECLARED SET for the same reason as `WORLD_RESETTING_PLAN_ACTION_IDS`: the surface publishes no "this leaves the body
 * held" property (`postcondition.name` says `npc_talked` and nothing about the dialogue box), so there is nothing to
 * derive membership from yet. Exported so the gate in `body-program-script.test.ts` reads THIS declaration instead of a
 * second hand-written copy, and so an empty set fails that gate loudly instead of passing over nothing.
 */
export const BODY_YIELDING_PLAN_ACTION_IDS: readonly string[] = Object.freeze(["talk_to_npc"]);

/**
 * The actions that RESTORE actionability after a body-yielding one: the Host's PROJECTION of the Mod's own declaration.
 *
 * The Mod declares the fact once, as a handler group - `FarmhandActionHandlerGroup.Modal` is "the actions whose working
 * precondition is an open modal", and `FarmhandActionCatalog.ModalResolvingActionIds` is exactly the registrations in it
 * (`integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs:746-762`). THAT DECLARATION IS NOT ON THE WIRE:
 * `ActionRegistrationDescriptor` publishes arguments, output facts, resource claims, approach and target family
 * (`host/src/protocol.ts`), so this compiler cannot derive the set and has to restate it.
 *
 * Restating it is a drift risk, and the risk has two shapes: narrower than the Mod means a plan that needs the missing
 * member is refused with no legal remedy, and wider means a plan skips a dismissal the body needed. The gate in
 * `body-program-script.test.ts` compares this list against the C# declaration and fails by name
 * (`modal_clearing_set_drift:<actionId>:<side>`) when the two disagree. Publishing the group on the wire is the real fix
 * and is separate work; until then the gate is what keeps the copy honest.
 *
 * `dismiss_modal` is FIRST because it is the one member the compiler can WRITE itself - it declares no argument, while
 * `answer_dialogue` demands the `responseKey` only the author can choose and `respond_level_up` the choice, skill and
 * level it is settling. The inserted step, and the refusal that answers when an insertion is impossible, both name
 * `MODAL_CLEARING_PLAN_ACTION_IDS[0]` for that reason, and the gate asserts that first member declares no argument.
 *
 * `respond_level_up` is a member even though it can never succeed as the node after a `talk_to_npc`: a dismissal inserted
 * before it would close the dialogue the player is reading and leave the level-up prompt - the modal it actually acts on -
 * untouched. A step whose own precondition is the modal must not be preceded by a step that closes one.
 *
 * THE INSERTED STEP CANNOT BE REFUSED ON AN ABSENT MODAL, AND THAT RULE LIVES IN THE MOD, NOT HERE. Whether a modal is open
 * is a fact of the world at DISPATCH time, and this compiler reads a plan's shape at COMPILE time - so a plan can be right
 * about needing a dismissal and still meet a world where the engine, the pager or the night lifecycle already closed the
 * box. `dismiss_modal` answers that world with a NO-OP rather than a refusal: `Succeeded` / `nothing_to_dismiss` with
 * `evidence: modal=none` (`farmhandexecutioncontroller.modalactions.cs`, and the gate in `ModalDismissActionTests` requires
 * every argument-free member of the family to resolve that way). The insertion therefore stays UNCONDITIONAL: deciding it
 * from the snapshot would be this compiler guessing at a world it cannot see, and the fact the plan's shape really does
 * answer - "the body was yielded, so the step after it needs the body back" - is the fact that decides it. Measured
 * `round44`: both `no_modal_present` receipts in that run were author-written `dismiss_modal` nodes (`n01`), and the
 * compiler's `auto_dismiss_` node never ran, so this is the latent case the fix is for - the reading is
 * `inserted_node_refusals` in the plan account, not a count of that code in the log.
 */
export const MODAL_CLEARING_PLAN_ACTION_IDS: readonly string[] = Object.freeze([
  "dismiss_modal",
  "answer_dialogue",
  "respond_level_up",
]);

const MAX_PLAN_SCRIPT_CHARS = 8192;
/** The engine's message is the caller's to fix; it is bounded because it reaches a model's context. */
const MAX_THROWN_MESSAGE_CHARS = 300;
/**
 * The wall-clock windows one compile runs in, in order: the measurement, and - only when it expired - the re-measurement.
 *
 * <p>
 * WALL CLOCK MEASURES THE MACHINE, NOT THE SCRIPT, and these two windows exist to say so instead of raising one number
 * until the flake stops. 400 probes of a real compile measured 0.61 ms mean and 3.19 ms worst, and 0.62 / 10.10 ms on a
 * busier minute (the report this was sent from: 0.67 / 7.33 ms over its own 400), and the 307-compile gate in
 * `body-program-script.test.ts` still met a single 50 ms window expiring on a script that does under a millisecond of
 * work - the process was descheduled, a GC pause or another runner took the window whole - after which
 * `plan_script_timeout` told a companion her plan was slow.
 * </p>
 * <p>
 * The FIRST window is sized to absorb an ordinary pause rather than to be tighter than the work: 250 ms is 25x the worst
 * compile measured here and 34x the report's, several Windows scheduler quanta (15.6 ms each) and a collection, not a
 * margin over an average. The SECOND is four times the first, because it is the one that decides and a second stolen
 * window would have to be four times the pause. Nothing is credited to the script until both are gone, and the reason
 * that is sound is that the script is DETERMINISTIC: no `Date`, `Math`, `performance`, timer or host reference survives
 * in the sandbox and the snapshot is deep-frozen, so the re-run re-executes the same computation. A plan that is fine and
 * a window that was stolen cannot both happen twice in a row.
 * </p>
 * <p>
 * The bound still stops a runaway. A tight `while (true) {}` executes about 3.6e8 iterations per second here (measured:
 * 1e6 in 2.7 ms), so the worst one pathological plan can cost the Host is 1250 ms of wall clock - and it can mint no
 * node from it, because the only channel that writes anything is the builder and `MAX_PLAN_BUILDER_CALLS` bounds that.
 * Do not remove the bound: a sandbox without one is how a malformed plan hangs the Host.
 * </p>
 */
export const PLAN_SCRIPT_BUDGET_MS: readonly number[] = Object.freeze([250, 1000]);

/** The wall clock every window adds up to, so a refusal states the whole measurement rather than one window of it. */
const PLAN_SCRIPT_BUDGET_TOTAL_MS = PLAN_SCRIPT_BUDGET_MS.reduce((total, windowMs) => total + windowMs, 0);
/**
 * How many times one script may call the builder, INCLUDING calls that a loop's own guard turns into a no-op.
 *
 * <p>
 * This - not `MAX_PLAN_NODES` - was the real ceiling all along, and it is the one that produced the measured shape:
 * 64 calls against a 16-node limit means a script that writes a `for` loop over a snapshot family is cut at 64 ITERATIONS,
 * so the loop can never reach the node cap it was written against. Raised to 1024 so the node bound is the one a compiler
 * enforces, and so a loop over a family the snapshot really does publish (up to `maxItems: 64`) fits with room for the
 * `equipFor` calls beside it.
 * </p>
 * <p>
 * It stays bounded because a compile's windows are wall clock anyway (`PLAN_SCRIPT_BUDGET_MS`): an unbounded
 * builder-call counter would let a script spend those windows on no-ops, and the refusal has to arrive as a NAME rather
 * than as an expiry.
 * </p>
 */
const MAX_PLAN_BUILDER_CALLS = 1024;

/** The argument kinds a Body Program node may carry, exactly as the Mod's catalog projection maps them. */
const PLAN_ARGUMENT_TYPES: readonly string[] = Object.freeze(["integer", "string", "boolean", "destination_selector"]);

/**
 * The read-only action whose ANSWER is the only place a destination selector can come from.
 *
 * It is not a plan step - world-map discovery is read-only, so the builder generates no method for it - which is exactly
 * why the name has to be spelled here: `navigate_to_destination`'s destination selector is a fact the SNAPSHOT does not
 * publish, and a refusal that names only the field leaves the author with nothing to read. The name is checked against
 * the surface artifact in `body-program-script.test.ts` (it must be a published action of kind `read_only`), so a rename
 * fails there instead of leaving a refusal that points at a name nothing publishes.
 */
const DESTINATION_DISCOVERY_ACTION_ID = "find_destination";

/** How many rows of one family are sampled when deriving the fields it publishes. */
const PLAN_SOURCE_ROWS_SAMPLED = 4;

/** How many field paths one family may contribute, so a wide record cannot spend a refusal on its own shape. */
const PLAN_SOURCE_MAX_FIELDS = 24;

/**
 * How much of a field name and an argument name must agree before the field counts as the same fact.
 *
 * `expectedQualifiedItemId` -> `qualifiedItemId` scores 1.0 and -> `qualifiedHarvestItemId` scores 0.75 (they share
 * qualified/item/id, which is why `harvest_crop`'s own row field is found), while `expectedTargetId` ->
 * `qualifiedItemId` scores 0.33 and must NOT match: naming an item id as the source of a target id is worse than
 * naming nothing, because it is the one answer a model will believe.
 */
const PLAN_SOURCE_MATCH_FLOOR = 0.6;

/** How much of a value the script passed is quoted back in a refusal, and it is quoted as printable ASCII only. */
const PLAN_REASON_VALUE_CHARS = 24;

/** How many actions one unknown-argument refusal names when the name it refused IS declared somewhere else. */
const PLAN_ARGUMENT_OWNERS_LISTED = 3;

/**
 * The lifecycles a node may name: the same two the Mod's own Body Program catalog projects
 * (`integrations/stardew/src/Core/BodyPrograms/FarmhandBodyProgramCatalogProjection.cs:96-102`: `live_verified`
 * "is an admission, not a draft" - the action really ran on the target game version and produced a native
 * receipt). The Host also admits both when it projects the visible surface
 * (`visibleActionsFromModCatalog`, host/src/action-registry.ts), so a builder narrower than either would refuse
 * plans the Mod accepts.
 */
export const PLAN_ACTION_LIFECYCLES: readonly string[] = Object.freeze(["published", "live_verified"]);

/**
 * What a plan script may not name, refused before it runs.
 *
 * Each entry either leaves the sandbox (require/import/fetch/process/globalThis), makes the plan
 * non-deterministic (Date, Math.random, timers) or re-enters compilation (eval, Function). The same
 * names are absent from the context, so this list is the readable refusal rather than the only fence.
 */
const FORBIDDEN_PLAN_REFERENCES: readonly string[] = Object.freeze([
  "Math.random",
  "Math",
  "Date",
  "performance",
  "await",
  "yield",
  "import",
  "export",
  "require",
  "module",
  "process",
  "globalThis",
  "fetch",
  "XMLHttpRequest",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "eval",
  "Function",
  "this",
  "arguments",
]);

/** Deleted from the fresh context as well, so a reference that slips past the scan still resolves to nothing. */
const ABSENT_PLAN_GLOBALS: readonly string[] = Object.freeze([
  "Math",
  "Date",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "fetch",
  "XMLHttpRequest",
  "process",
  "require",
  "module",
  "globalThis",
]);

/**
 * The builder's action vocabulary: exactly the registrations the Mod's own Body Program catalog will accept -
 * `published` or `live_verified`, executable, and with every declared argument carrying a Body Program value
 * contract - so a generated method can never name an action a program may not carry.
 */
export function planActionsFromRegistrations(
  registrations: readonly ActionRegistration[],
): readonly PublishedPlanAction[] {
  const actions: PublishedPlanAction[] = [];
  for (const registration of registrations) {
    if (!PLAN_ACTION_LIFECYCLES.includes(registration.lifecycle) || registration.kind !== "execution") continue;
    const declared = declaredArgumentsOf(registration);
    if (declared === undefined || !declared.every((argument) => PLAN_ARGUMENT_TYPES.includes(argument.type))) continue;
    actions.push(
      Object.freeze({
        actionId: registration.actionId,
        familyId: registration.familyId,
        lifecycle: registration.lifecycle,
        arguments: Object.freeze(declared),
        outputFacts: Object.freeze(declaredOutputFactsOf(registration)),
        resourceClaims: Object.freeze(declaredResourceClaimsOf(registration)),
        toolRequirement: declaredToolRequirementOf(registration),
        approachRequirement: declaredApproachRequirementOf(registration),
        targetFamily: declaredTargetFamilyOf(registration),
      }),
    );
  }
  return Object.freeze(actions);
}

/** The published argument vocabulary, in either shape the wire and the surface artifact use. */
function declaredArgumentsOf(registration: ActionRegistration): readonly PlanArgumentShape[] | undefined {
  const descriptor = registration.descriptor;
  if (descriptor === undefined) return undefined;
  if (Array.isArray(descriptor.arguments)) {
    const declared = descriptor.arguments.map((argument) =>
      Object.freeze({
        name: argument.name,
        type: argument.type,
        required: true as const,
        ...(argument.enum === undefined ? {} : { enum: Object.freeze([...argument.enum]) }),
        // Carried through because it is the reason `plan_shape` answers better than a name can: the Mod says what the
        // argument means, and an absent description stays absent rather than becoming an empty string.
        ...(argument.description === undefined ? {} : { description: argument.description }),
      }),
    );
    return declared.every((argument) => argument.name.length > 0 && argument.type.length > 0) ? declared : undefined;
  }
  const schema = descriptor.argumentSchema;
  if (schema === undefined) return undefined;
  return Object.freeze(
    Object.entries(schema).map(([name, declared]) =>
      Object.freeze({
        name,
        type: declared.type,
        required: true as const,
        ...(declared.enum === undefined ? {} : { enum: Object.freeze([...declared.enum]) }),
        ...(declared.description === undefined ? {} : { description: declared.description }),
      }),
    ),
  );
}

/** The facts a later program node may bind to this action's output, exactly as the Mod declared them. */
function declaredOutputFactsOf(registration: ActionRegistration): readonly Readonly<{ name: string; type: string }>[] {
  const outputFacts = registration.descriptor?.outputFacts;
  if (outputFacts === undefined) return [];
  return Object.entries(outputFacts).map(([name, type]) => Object.freeze({ name, type }));
}

/** The resources the Mod says this action claims while it runs (an embodied actor, for instance). */
function declaredResourceClaimsOf(
  registration: ActionRegistration,
): readonly Readonly<{ key: string; value: string }>[] {
  const template = registration.descriptor?.resourceTemplate;
  if (template === undefined || typeof template === "string") return [];
  return template.claims.map((claim) => Object.freeze({ key: claim.key, value: claim.value }));
}

/** The resource claims here are published under a `tool:` key prefix; the Host only ever reads that prefix. */
const TOOL_CLAIM_PREFIX = "tool:";

/**
 * The upgrade-level words the Mod's claim value carries today (`FarmhandResourceTemplateValue` / its Body Program
 * twin). Kept as a lookup of the two the Host can translate into a level range; any other word is passed through
 * verbatim rather than guessed at.
 */
const TOOL_UPGRADE_LEVELS: Readonly<
  Record<string, Readonly<{ minimumUpgradeLevel: number; maximumUpgradeLevel: number | null }>>
> = Object.freeze({
  AnyUpgrade: Object.freeze({ minimumUpgradeLevel: 0, maximumUpgradeLevel: null }),
  BasicOnly: Object.freeze({ minimumUpgradeLevel: 0, maximumUpgradeLevel: 0 }),
});

/**
 * Reads the tool an action requires straight off its published resource claims.
 *
 * An action whose claim list carries no `tool:<category>` answers `tool_requirement_undeclared` - the field is always
 * present, so the companion can tell "the surface does not say" from a tool it was told about, and the Host never
 * fabricates a category from an action id.
 */
/**
 * Reads the spatial precondition straight off the registration's descriptor.
 *
 * An action whose descriptor carries no `approach` answers `approach_requirement_undeclared` - the field is
 * present, so the companion can tell "the surface does not say" from "stand anywhere". The Host never derives a
 * precondition from an action id.
 */
/** The snapshot family that supplies this action's targets, read from the descriptor the Mod published.
 *
 * `null` is the surface's own statement that the action addresses no published family (`sleep`, `dismiss_modal`,
 * `express_emote`), which is a different answer from a family nobody filled - and the reason this is a plain value and
 * not a `{ declared: false }` wrapper: there is no third state to distinguish.
 */
function declaredTargetFamilyOf(registration: ActionRegistration): string | null {
  const declared = registration.descriptor?.targetFamily;
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}

function declaredApproachRequirementOf(registration: ActionRegistration): PublishedPlanApproachRequirement {
  const approach = registration.descriptor?.approach;
  if (approach === undefined)
    return Object.freeze({ declared: false as const, reasonCode: "approach_requirement_undeclared" as const });
  return Object.freeze({
    declared: true as const,
    relation: approach.relation,
    // The Mod omits a null distance from the wire, so absent and null both mean "the relation states no distance".
    withinTiles: typeof approach.withinTiles === "number" ? approach.withinTiles : null,
  });
}

function declaredToolRequirementOf(registration: ActionRegistration): PublishedPlanToolRequirement {
  const claims = declaredResourceClaimsOf(registration);
  const claim = claims.find(
    (candidate) =>
      candidate.key.startsWith(TOOL_CLAIM_PREFIX) && candidate.key.slice(TOOL_CLAIM_PREFIX.length).trim().length > 0,
  );
  if (claim === undefined)
    return Object.freeze({ declared: false as const, reasonCode: "tool_requirement_undeclared" as const });
  const levels = TOOL_UPGRADE_LEVELS[claim.value];
  return Object.freeze({
    declared: true as const,
    category: claim.key.slice(TOOL_CLAIM_PREFIX.length).trim(),
    upgradeRequirement: claim.value,
    minimumUpgradeLevel: levels?.minimumUpgradeLevel ?? null,
    maximumUpgradeLevel: levels?.maximumUpgradeLevel ?? null,
  });
}

/**
 * One read-only answer about the plan vocabulary: what a script must pass for the actions it names, or for every plannable
 * action of one family. A selection that names nothing answers with the vocabulary that DOES exist, so one wrong guess,
 * or one wrong id beside right ones, teaches.
 */
export type PlanShape =
  | Readonly<{
      ok: true;
      actions: readonly PublishedPlanAction[];
      /** The ids that were asked for and are not plannable, named so the rest of the answer stays usable. */
      unknownActionIds?: readonly string[];
    }>
  | Readonly<{
      ok: false;
      reasonCode: string;
      legalActionIds?: readonly string[];
      legalFamilies?: readonly string[];
    }>;

/**
 * What a shape read asked about: any number of action ids, or one family.
 *
 * The ids are a LIST because the unit the companion writes is a whole piece of work: measured in
 * `.tmp/fork-why-slow.jsonl`, all six `stardew_plan_shape` calls in a session named one action each, and a companion
 * writing a batch over several families had to spend one round trip per action before it could write the script. One
 * call over the actions it is about to use is the shape that matches the unit.
 */
export type PlanShapeRequest = Readonly<{ actionIds?: readonly string[]; family?: string }>;

/** Bounded so a wrong name teaches instead of spending the turn's context on the whole vocabulary. */
const MAX_LISTED_PLAN_IDS = 20;

export function legalPlanActionIds(actions: readonly PublishedPlanAction[]): readonly string[] {
  return Object.freeze(actions.slice(0, MAX_LISTED_PLAN_IDS).map((action) => action.actionId));
}

function legalPlanFamilies(actions: readonly PublishedPlanAction[]): readonly string[] {
  return Object.freeze([...new Set(actions.map((action) => action.familyId))].slice(0, MAX_LISTED_PLAN_IDS));
}

/**
 * Reads the shape of the actions or the family a request names, straight out of the vocabulary the Mod published for Body
 * Programs. Nothing here is a hand-written table: a renamed argument, a new closed set or a new output fact reaches the
 * answer as soon as the surface reaches the builder.
 */
export function planShape(actions: readonly PublishedPlanAction[], request: PlanShapeRequest): PlanShape {
  // A repeated id is answered once, and the ORDER the caller asked in is kept, so it can be read positionally against
  // the script it is about to write.
  const actionIds = request.actionIds === undefined ? undefined : Object.freeze([...new Set(request.actionIds)]);
  const family = request.family;
  if ((actionIds === undefined) === (family === undefined) || actionIds?.length === 0)
    return Object.freeze({ ok: false as const, reasonCode: "plan_shape_selector_invalid" });
  if (actionIds !== undefined) {
    const found: PublishedPlanAction[] = [];
    const unknown: string[] = [];
    for (const actionId of actionIds) {
      const action = actions.find((candidate) => candidate.actionId === actionId);
      if (action === undefined) unknown.push(actionId);
      else found.push(action);
    }
    // A read that found nothing is the refusal, and it names the vocabulary: one typo beside eight good ids must not cost
    // the whole answer, which is why only an EMPTY result reaches the `unknown_action` branch below.
    if (found.length === 0)
      return Object.freeze({
        ok: false as const,
        reasonCode: `plan_shape_unknown_action:${unknown[0]}`,
        legalActionIds: legalPlanActionIds(actions),
      });
    return Object.freeze({
      ok: true as const,
      actions: Object.freeze(found),
      ...(unknown.length === 0 ? {} : { unknownActionIds: Object.freeze(unknown) }),
    });
  }
  const members = actions.filter((candidate) => candidate.familyId === family);
  if (members.length === 0)
    return Object.freeze({
      ok: false as const,
      reasonCode: `plan_shape_unknown_family:${family}`,
      legalFamilies: legalPlanFamilies(actions),
    });
  return Object.freeze({ ok: true as const, actions: Object.freeze(members) });
}

/**
 * What an ACCEPTED plan answer says about its own settlement, in one declarative sentence.
 *
 * Measured `round43` (20.0 min, 1,201 s): 96 assistant turns, 97 tool calls, and **29 of those turns were
 * `stardew_action_program_status` calls** - 30% of the run's model time spent asking whether the plan was done, at
 * ~9.4 s per turn. The settlement is already pushed (`program_settled` is an ordinary fact and it opens a turn of its
 * own), so the polls were not compensating for a missing signal. They were compensating for an ANSWER that did not say
 * what would arrive, when, or what one more question could possibly change.
 *
 * The description says much of this (`planWorkDescription`: "do NOT poll it - each step's receipt arrives later as a new
 * message"), and the answer is the thing the model re-reads while deciding whether to wait. So the answer carries it,
 * conditional on acceptance and with the population it is waiting on - which is the one fact the description cannot
 * state.
 *
 * `waitMs` is named because `stardew_action_program_status` documents it, and a bound nobody said the purpose of is a
 * habit rather than a choice: measured `round29`, 48 calls at `waitMs` median 30,000 - the cap - for 248 s blocked.
 */
export function planSettlementNote(nodeCount: number): string {
  const nodes = `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}`;
  return (
    `${nodes}, and the settlement arrives as its own message - a fact - once the last node reaches a terminal state, ` +
    "the same answer comes back until then, and `stardew_action_program_status` `waitMs` only holds a turn until that " +
    "moment."
  );
}

/**
 * The `charge` a plan EXAMPLE prints, read from the wire declaration rather than written beside it.
 *
 * `till_soil` and `water_crop` pin it on the wire (`EXECUTION_REQUEST_ARGUMENT_RULES`: their exact argument set carries
 * `charge`), so an example that leaves it out is a call the compiler refuses as `loop_do_argument_missing:charge` and the
 * wire refuses as `invalid_args` - and the batch example had already drifted that way, printing a `water_crop` call a
 * caller could not copy. Reading the value from the declaration means the example moves with the range.
 */
function planExampleCharge(action: "till_soil" | "water_crop"): string {
  const bound = executionRequestIntegerBounds(action).find((candidate) => candidate.argument === "charge");
  if (bound === undefined) throw new Error(`execution_request_integer_bound_missing:${action}:charge`);
  return `charge: ${String(bound.minimum)}`;
}

/**
 * The `stardew_plan_work` description: what the tool does, and the builder methods it exposes, named.
 *
 * The names belong HERE, in the description the companion already holds, rather than one tool call away behind
 * `stardew_plan_shape`. Measured 2026-10-28 (`round6`): a run reached 22:00 without ever dispatching `advance_day`,
 * wrote goodnight dialogue instead, and its own thinking recorded that it did not know the action's name and would not
 * guess - the engine then passed it out at 02:00 onto a standing ShippingMenu. A companion that will not spend one
 * round-trip per unknown id degenerates to single steps or to dialogue, which is the whole defect this tool exists to
 * remove.
 *
 * The vocabulary is the actions handed in - the same `PublishedPlanAction[]` `planShape` answers from - so there is no
 * hand-maintained list to drift from the Mod's catalog. Every id is printed once, under the family the Mod declared it
 * in; nothing else in the block is prose, because the block is read as a vocabulary.
 *
 * The other thing it has to teach is SUBMIT, THEN END THE TURN. `plan_work` returns as soon as the Mod accepts, because a
 * held call makes `stop`, `append` and a player's steering unreachable exactly while they matter. The wake is not
 * invented here: a dispatched node's execution receipt reaches the same pump as every other fact
 * (`host-service.ts` `acceptIntegrationFact` -> `CompanionEventPump.flush`), and a terminal receipt is not a held progress
 * fact, so it starts a follow-up turn (`event-pump.ts` `#hasPendingFactTrigger`). Measured 2026-11-03 (`round29`): 48
 * `program_status` calls, `waitMs` median 30,000, 248 s blocked - the description never said a receipt was coming.
 *
 * THE CHAIN SENTENCE AND THE READER'S BOUND ARE ONE FACT. The step count printed below is `MAX_FOR_EACH_STEPS`
 * interpolated, and `readStepChain` refuses an overlong chain with that same constant in the answer, so a caller is never
 * taught a shape the compiler then refuses with a different number. Change one and the printed sentence moves with it;
 * change the sentence's MEANING without changing the reader and the two disagree silently, which is how a form ends up
 * named in the description and absent from the tool it names.
 */
export function planWorkDescription(actions: readonly PublishedPlanAction[]): string {
  return (
    "Write one script over the current snapshot and the builder, one builder.<actionId>({...}) call per step; the host compiles it into a single plan the Mod runs in the game and advances itself. The call returns as soon as the plan is accepted: do NOT poll it - each step's receipt arrives later as a new message, so end your turn and speak to the player. Every answer carries `nodes`: one row per node you wrote, at its own `index`, with the Mod's `state` (`succeeded` when the step did the thing and its receipt proved it, `rejected`/`failed`/`cancelled` when it did not, `pending`/`running` when it has not stopped yet), a `reasonCode` when it did not succeed, and the `tile` it named - plus `settled`, true only when every node has stopped, and `remaining`, how many have not. stardew_action_program_status is for a plan that is not moving, not a progress bar. Every action below is a builder method, grouped by the family the Mod declared, with no per-action tool beside them; ask stardew_plan_shape ONCE for every action the script will call - it takes a list - and every argument it lists is required. A piece of work with a SHAPE - a 3-wide 20-long strip, the row along a fence, the 5x5 around the shed - is one RECTANGLE to query, not a reason to observe again: stardew_observe shows only a square window around you, stardew_inspect_tiles answers exactly the rectangle you name, and stardew_look_up answers what this session already holds with no round trip; all three are reads, so asking costs the plan no node, and each one's own description says what it takes. One call the compiler refuses voids the whole plan - nothing runs - and the answer names which calls were dropped beside which ones compiled, so repair that step and resend the same piece of work. Stop when builder.isFull() is true and plan the rest in the next call, in this shape:\n" +
    `${planActionVocabularyText(actions)}\n` +
    "// Sequential steps - one call per step, in order:\n" +
    "builder.move_to_tile({ x: 10, y: 20 });\n" +
    "builder.enter_exit({ x: 10, y: 20 });\n" +
    "// Or ONE LOOP over a collection of live world rows, expanded by the Mod on the game thread:\n" +
    "builder.for_each({\n" +
    "  source: { area: { x: 60, y: 18, w: 20, h: 3 } },\n" +
    "  where: [{ col: { every: 3, offset: 0 } }],\n" +
    '  do: { action: "till_soil", ' +
    planExampleCharge("till_soil") +
    " }\n" +
    "});\n" +
    "// A tile's work is a CHAIN when one action does not finish it - till, then sow, in this order:\n" +
    "builder.for_each({\n" +
    "  source: { area: { x: 60, y: 18, w: 20, h: 3 } },\n" +
    '  do: [{ action: "till_soil", ' +
    planExampleCharge("till_soil") +
    ' }, { action: "plant_seed", seed: "hops" }]\n' +
    "});\n" +
    "// Or a batch over a snapshot family:\n" +
    "for (const crop of snapshot.cropTargets) {\n" +
    "  builder.water_crop({ x: crop.x, y: crop.y, expectedTargetId: crop.targetId, " +
    planExampleCharge("water_crop") +
    " });\n" +
    "}\n" +
    'builder.for_each({ source, where, do }) is ONE loop over a collection of live world rows, expanded by the Mod on the game thread: `source` names the live tiles whose rows the pass reads; `where` is a list of tests on ONE row - a field test ({ field: "kind", in: ["weed"] }, { field: "health", gt: 0 }), what stands on the tile ({ occupant: "weed" }, in the engine\'s own words: weed, stone, crop, tree, tree_stump, grass, object, terrain, none), and/or a position guard ({ col: { every: 3, offset: 0 } }, { row: { every: 2, offset: 1 } }), one spelling per test - a word the grammar does not have is refused as for_each_where_unrecognised:<given>;allowed=<the words it does have>; `do` is an ORDERED CHAIN of steps worked on ONE tile - each step an action from the list above with its own arguments, at most ' +
    String(MAX_FOR_EACH_STEPS) +
    " of them, or a single action (the chain of length one), or null for a row left deliberately alone (a path). Several for_each calls over the SAME source are the rules of that one pass, decided per row by the first rule that claims it - which is how an intercropped patch is one intent. The caller needs no observation first - no target id, no per-tile coordinate - because the rows are read live. " +
    forEachRowIdentityText() +
    "A row no predicate claims is reported rather than skipped: ONE code for the whole patch when NO row matched it (no_row_matched_where:<field>_<test>_<value>:<the occupants the tiles carry>), and one per tile (no_rule_matched:<kind>@<x>,<y>) when some rows did. One loop addresses at most " +
    String(MAX_FOR_EACH_ROWS) +
    " rows, and a loop inside a loop is refused by name. The Mod EXECUTES the loop: each row is decided against the world as it is at that moment and dispatched through the same action path a single step takes, so the node's answer carries `succeeded`/`failed`/`refused`/`left_alone`/`not_matched`/`deferred` counts and ONE ROW PER TILE with its own action, state and reasonCode - and a row worked as a chain also carries its `steps` in the order it took them, plus `stopped_at=<step>:<reasonCode>` when it stopped before its last step, so a tile that stopped half-done says where. A tile that is not on the farm (not_on_farm), a kind `by_kind` cannot resolve (no_action_for_kind:<kind>), an action the live policy disables (row_action_not_enabled:<actionId>) and an argument the action declares that the loop cannot supply (row_argument_missing:<name>) are each NAMED PER ROW rather than skipped - a skipped row reads as a cleared patch. THE ARGUMENTS A STEP MAY CARRY ARE THAT ACTION'S OWN (its `argumentSchema`): row_argument_missing:<name> means the action declares `name` and your step left it out, and a name the action does NOT declare is row_argument_unknown:<name> - `slot` belongs to `cut_weeds`, not to `till_soil`, so one action's argument list is never another's. A STEP THAT LEAVES OUT AN ARGUMENT ONLY THE CALLER CAN SUPPLY IS REFUSED AT COMPILE TIME (loop_do_argument_missing:<name>:declared=[<the action's arguments>]) rather than per row, so one wrong step costs one repair and not a whole pass: fresh ground is tilled with `{ action: \"till_soil\", " +
    planExampleCharge("till_soil") +
    " }` - the range's own minimum is the one named tile, and a charge the held tool cannot reach is refused by name instead of being quietly reduced - while `by_kind` covers only the kinds whose work needs no per-action argument. " +
    forEachSourceText() +
    " And one loop document may be at most " +
    String(MAX_FOR_EACH_LOOP_DOCUMENT_CHARS) +
    " characters - the wire's own bound on the string the loop travels in - so a longer one is refused by the compiler with its own count rather than by the bridge."
  );
}

/**
 * The one row source this form has, and the refusal a caller meets when it writes another, printed in the description.
 *
 * BOTH HALVES COME FROM `PLAN_FOR_EACH_SOURCES`, so the description cannot teach a source the grammar refuses (or leave
 * out one it gains); the refusal's spelling is the one `FarmhandForEachArguments.SourceUnrecognised` answers with. That
 * is what this sentence replaces: two source kinds were taught here, were accepted by the grammar and by the preflight,
 * and were then refused on the game thread as `for_each_source_unavailable:<kind>`.
 */
function forEachSourceText(): string {
  const shapes = PLAN_FOR_EACH_SOURCES.map((source) => `{ ${source}: { x, y, w, h } }`).join(", ");
  return `\`source\` is exactly one of ${shapes} - an existing rectangle of live map tiles whose rows the pass reads, so the shape of the work is a rectangle to read rather than a reason to observe again - and a source word the form does not have is refused as ${FOR_EACH_SOURCE_UNRECOGNISED}:<given>;allowed=${PLAN_FOR_EACH_SOURCES.join(",")}.`;
}

/**
 * The row identity the Mod mints, in the caller's own terms, printed in the description.
 *
 * The refusal's name comes from `PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL`, so the description cannot teach a code the compiler
 * does not answer: a caller told one word and refused with another has been taught nothing. The second half is the other
 * shape of the same fact - a row the world cannot name is a row that does not run, and it says which action and family.
 */
function forEachRowIdentityText(): string {
  return `\`expectedTargetId\` is FILLED BY THE MOD for each row from the live tile, by the family that action's own descriptor declares, so never write one yourself: a \`do\` carrying it is refused as ${PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL}, and an action whose family cannot name that tile answers row_target_identity_unavailable:<actionId>:<family> for that row instead of running. `;
}

/** One line per family, its members comma-separated, in the order the surface declared them. */
function planActionVocabularyText(actions: readonly PublishedPlanAction[]): string {
  const families = new Map<string, string[]>();
  for (const action of actions) {
    const members = families.get(action.familyId);
    if (members === undefined) families.set(action.familyId, [action.actionId]);
    else members.push(action.actionId);
  }
  return [...families].map(([familyId, actionIds]) => `${familyId}: ${actionIds.join(", ")}`).join("\n");
}

/**
 * The layout facts a plan node's correctness depends on, per snapshot family the surface declares as the node's target
 * family.
 *
 * <p>
 * This is the ONE spelling of the list. It is keyed by the family the Mod itself declares (`FarmhandActionDefinitions.cs`:
 * `water_crop` -> `cropTargets`), so a node is checked because the surface said where its targets come from, not because
 * its action id appears here. `tools/check-stardew-crop-row-derivation.mjs` reads this table and requires every fact it
 * names to be a field the Mod really publishes on that row, so the two cannot drift apart.
 * </p>
 *
 * <p>
 * The gap this list NAMES rather than closes: `plant_seed` addresses `seedTargets`, whose rows carry the held seed and
 * the engine's planting admission (`canPlantThisSeedHere`) but nothing about the crop that seed becomes - so a planting
 * plan's trellis risk is not in any snapshot today. It is absent from this table on purpose: an entry for it would fire
 * on every planting node with a fact the row cannot carry, which is a banner, not a signal.
 * </p>
 */
const PLAN_LAYOUT_FACTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  cropTargets: Object.freeze(["isRaised", "tileBlockedNow"]),
});

/** How many absent-fact warnings one answer carries. The COUNT travels beside it and is not bounded. */
const MAX_REPORTED_LAYOUT_FACTS_ABSENT = 8;

/** One node's tile: the arguments every tile-addressed action declares, or undefined for a loop with no single tile. */
function nodeTile(node: PlanNode): Readonly<{ x: number; y: number }> | undefined {
  const argument = (name: string): number | undefined => {
    const declared = (node.arguments as Readonly<Record<string, { canonicalValue?: unknown }>>)[name];
    if (declared === undefined || typeof declared.canonicalValue !== "string") return undefined;
    const value = Number.parseInt(declared.canonicalValue, 10);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const x = argument("x");
  const y = argument("y");
  return x === undefined || y === undefined ? undefined : { x, y };
}

/**
 * The layout facts a compiled plan assumed but the snapshot it was compiled against does not carry.
 *
 * <p>
 * One entry per (node, fact), spelled `layout_facts_absent:call <n>:<fact>` - the same `call` positional index the
 * refusal list uses, so the companion reads back WHICH of its calls is blind. Nothing here refuses: the answer carries
 * the plan and the warning together, because the receipt is where she learns, not the harness.
 * </p>
 *
 * <p>
 * THE WINDOW SAYS HOW IT WAS CUT. More absent facts than the answer can afford are answered by the first
 * `MAX_REPORTED_LAYOUT_FACTS_ABSENT - 1` of them and one last row spelling
 * `layout_facts_absent_over_ceiling:<count>:<ceiling>` - the ceiling she met and the population it truncated - the same
 * shape `<world-facts>` states its own remainder in (`fact-brief.ts`). A row that names both is the difference between
 * a window and a silent prefix, and it is why the list and `layoutFactsAbsentCount` can never be read as disagreeing.
 * </p>
 */
function layoutFactsAbsent(
  nodes: readonly PlanNode[],
  actions: readonly PublishedPlanAction[],
  snapshot: Snapshot,
): Readonly<{ absent: readonly string[]; count: number }> {
  const absent: string[] = [];
  let count = 0;
  nodes.forEach((node, index) => {
    const family = actions.find((candidate) => candidate.actionId === node.actionId)?.targetFamily;
    if (family === null || family === undefined) return;
    const facts = PLAN_LAYOUT_FACTS[family];
    if (facts === undefined) return;
    const tile = nodeTile(node);
    if (tile === undefined) return;
    const rows = (snapshot as unknown as Readonly<Record<string, unknown>>)[family];
    const row = Array.isArray(rows)
      ? (rows as readonly Readonly<Record<string, unknown>>[]).find(
          (candidate) => candidate.x === tile.x && candidate.y === tile.y,
        )
      : undefined;
    for (const fact of facts) {
      if (row !== undefined && row[fact] !== undefined) continue;
      count += 1;
      absent.push(`layout_facts_absent:call ${index + 1}:${fact}`);
    }
  });
  return Object.freeze({
    absent: Object.freeze(
      absent.length > MAX_REPORTED_LAYOUT_FACTS_ABSENT
        ? [
            ...absent.slice(0, MAX_REPORTED_LAYOUT_FACTS_ABSENT - 1),
            `layout_facts_absent_over_ceiling:${String(count)}:${String(MAX_REPORTED_LAYOUT_FACTS_ABSENT)}`,
          ]
        : absent,
    ),
    count,
  });
}

/**
 * Compiles one plan script against the live snapshot.
 *
 * The script receives a frozen copy of the snapshot and the builder, and produces nodes in call
 * order. Every refusal is named and bounded; a refused script produces NO program, so a partial plan
 * can never be submitted as if it were the plan the companion wrote.
 *
 * It runs inside the windows `PLAN_SCRIPT_BUDGET_MS` declares, and a window that expired is re-measured
 * before it is believed: `runPlanScriptWindows` is where that happens and why.
 */
export function compilePlanScript(
  request: PlanScriptRequest,
  dependencies: Readonly<{
    snapshot: Snapshot | null | undefined;
    actions: readonly PublishedPlanAction[];
  }>,
): CompiledPlan {
  const scriptSource = typeof request.script === "string" ? request.script : "";
  const snapshot = dependencies.snapshot;
  const snapshotRevision = snapshot === null || snapshot === undefined ? null : snapshot.revision;
  if (scriptSource.trim().length === 0 || scriptSource.length > MAX_PLAN_SCRIPT_CHARS)
    return refused("plan_script_invalid", scriptSource, snapshotRevision);
  const forbidden = FORBIDDEN_PLAN_REFERENCES.find((reference) => mentionsReference(scriptSource, reference));
  if (forbidden !== undefined)
    return refused(`plan_script_uses_forbidden:${forbidden}`, scriptSource, snapshotRevision);
  if (snapshot === null || snapshot === undefined || !isUsableSnapshot(snapshot))
    return refused("plan_snapshot_unavailable", scriptSource, snapshotRevision);

  const run = runPlanScriptWindows(
    `(function (snapshot, builder) { "use strict";\n${scriptSource}\n})(snapshot, builder);`,
    snapshot,
    dependencies.actions,
  );
  const state = run.state;
  if (run.attempt.outcome === "refused")
    return refused(state.refusal!, scriptSource, snapshotRevision, state.requirement, state.missingArguments, state);
  // A SCRIPT THAT OUTLIVED EVERY WINDOW IS ANSWERED WITH THE WHOLE MEASUREMENT, never one window of it. It names the
  // total wall clock and the windows that made it up, because that is everything the engine can say: `attempts=1` would
  // be the code whose remedy is "send it again", this one never reads that way, and its reader is the companion writing
  // the plan - a loop that did not return in 1250 ms of wall clock spent on it twice is the thing to change, not the
  // machine, and the refusal is the only place that is said. A release gate reading the same name knows the compile was
  // measured twice rather than lost once.
  if (run.attempt.outcome === "expired")
    return refused(
      `plan_script_timeout:${PLAN_SCRIPT_BUDGET_TOTAL_MS}ms:attempts=${PLAN_SCRIPT_BUDGET_MS.length}`,
      scriptSource,
      snapshotRevision,
      undefined,
      undefined,
      state,
    );
  if (run.attempt.outcome === "threw")
    return refused(
      `plan_script_threw:${thrownName(run.attempt.error)}`,
      scriptSource,
      snapshotRevision,
      undefined,
      undefined,
      state,
      {
        message: thrownMessage(run.attempt.error),
        line: thrownLine(run.attempt.error, scriptSource),
      },
    );
  // A script may swallow a refusal with its own try/catch; a refusal that ends the SCRIPT still ends it, because the
  // node it asked for was not added and a program missing that node is not the plan the companion wrote. A refusal that
  // ends only its own CALL never reaches here: the call boundary answers it and the script carries on, so every call is
  // accounted for by name at the end - and a plan with any call refused is refused whole there.
  if (state.refusal !== null)
    return refused(state.refusal, scriptSource, snapshotRevision, state.requirement, state.missingArguments, state);
  // A script that produced no node has asked for nothing, in one of three ways that need different answers:
  // it never called a builder at all (it only computed), it called one N times and every call added nothing, or every
  // call was refused. The count is the whole point - "0 calls" and "6 refused calls" are different mistakes, and a bare
  // `plan_script_empty` told the companion neither.
  if (state.nodes.length === 0 && state.rejectedCount === 0)
    return refused(
      state.builderCalls === 0
        ? "plan_script_empty_no_builder_call"
        : `plan_script_empty_no_node_added:${state.builderCalls}`,
      scriptSource,
      snapshotRevision,
      undefined,
      undefined,
      state,
    );
  // The one case `accepted: false` was always right about: not one call produced a node, so there is no plan. The refusal
  // is the FIRST call's, with the shape it demanded, because that is the one to fix first; every other refusal travels
  // beside it.
  if (state.nodes.length === 0) {
    const first = state.rejected[0]!;
    return refused(first.reasonCode, scriptSource, snapshotRevision, state.requirement, first.missingArguments, state);
  }
  // A plan is only meaningful against a revision: an accepted plan whose revision is unknown could not be
  // replayed and could not answer idempotency, so that is a refusal rather than a plan with a null revision.
  if (snapshotRevision === null)
    return refused("plan_snapshot_missing", scriptSource, null, undefined, undefined, state);
  // THE PROGRAM THIS COMPILER PRODUCES MUST SATISFY THE RULE THE MOD ENFORCES ON SUBMISSION.
  //
  // The rule is about ORDER, and the graph now has two relations that both order: `dependsOn` ("I consume its fact",
  // whose failure skips me) and `orderedAfter` ("be terminal first", which never skips me).
  // `BodyProgramGraphRules.UnorderedClaimPairs` reads the UNION, and every published action claims `embodied_actor`, so
  // two steps of one body that are ordered by neither are still refused with `resource_conflict:<actionId>` - "order
  // them with dependsOn or orderedAfter to group them in one program" - which is why this compiler writes one ordering
  // edge per call.
  //
  // Nothing below can fire while that is true, and that is the point: the compiler's own output is the one thing that
  // must never be a candidate the other side refuses. Written here, a future producer change that drops the edge is
  // refused by name in the same turn; left to the wire, it is a program the Mod rejects after a full round trip, with
  // a code that names no line the author can look at.
  const conflicts = planResourceConflictCodes(state.nodes, dependencies.actions);
  if (conflicts.length > 0)
    return refused(
      `plan_resource_conflict:${conflicts.join(",")}`,
      scriptSource,
      snapshotRevision,
      undefined,
      undefined,
      state,
    );
  // AN `ok: true` ANSWER IS A PROMISE THAT EVERY STEP THE AUTHOR WROTE IS IN THE PROGRAM, and the promise is answered
  // here rather than left to the caller to check against `dropped`.
  //
  // It was not, and the price is measured twice. At `3d249ff1`, `builder.talk_to_npc(...); builder.shop_purchase(...)`
  // answered `ok: true` and carried ONE node: the purchase was refused, the plan was submitted without it, and the answer
  // reported a successful plan (the fixpoint gate in `tools/check-plan-legal-fixpoint.mjs` is what found it). Round40 is
  // the same shape from the other end: `accepted: true` beside `droppedCount: 15`. A plan that runs part of the work while
  // its answer says it ran all of it is the most expensive answer this product can give - the companion plans around a seed
  // she never bought, and neither the program nor the answer disagrees with her.
  //
  // So a refused call now refuses the PLAN: nothing runs, the first refusal's own code is the reason (unchanged), and
  // `dropped` beside `acceptedSteps` says which of her steps went missing and which ones compiled - one edit and one
  // resubmission, instead of a turn spent discovering what the program left out.
  if (state.rejectedCount > 0) {
    const first = state.rejected[0]!;
    return refused(first.reasonCode, scriptSource, snapshotRevision, state.requirement, first.missingArguments, state);
  }
  // What this plan assumed and the snapshot it read could not answer. Read from the SAME nodes that are about to be
  // submitted, so the warning describes the plan rather than the script.
  const layout = layoutFactsAbsent(state.nodes, dependencies.actions, snapshot);
  return Object.freeze({
    ok: true as const,
    scriptSource,
    snapshotRevision,
    program: Object.freeze({ nodes: Object.freeze([...state.nodes]) }),
    // The insertions are narrowed the same way the call account is and for the same reason: a loop over a body-yielding
    // family would otherwise repeat one sentence once per iteration. `insertedCount` is the population, so a bounded list
    // never reads as "that was the whole of it".
    inserted: Object.freeze(state.inserted.slice(0, MAX_REPORTED_PLAN_INSERTIONS)),
    insertedCount: state.inserted.length,
    insertedNodeIds: Object.freeze([...state.insertedNodeIds]),
    layoutFactsAbsent: layout.absent,
    layoutFactsAbsentCount: layout.count,
    ...planCallAccount(state),
  });
}

/** How one run of the script ended, and the error it ended with when the engine raised one. */
type PlanScriptAttempt = Readonly<{
  outcome: "finished" | "refused" | "expired" | "threw";
  /** The engine's error: present for `refused` and `threw`, absent for `finished` and `expired`. */
  error?: unknown;
}>;

/**
 * Runs the script once, in a context of its own, under one window.
 *
 * The `vm` timeout is wall clock, so an `expired` outcome says only that the window went; whether that was the script or
 * the machine is what `runPlanScriptWindows` decides. A fresh context per run is what makes a re-measurement a
 * measurement: the state, the builder and the global the script sees are all new, so nothing the stopped run had
 * already written can reach the second one.
 */
function runPlanScriptAttempt(
  source: string,
  frozenSnapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
  budgetMs: number,
  state: PlanScriptState,
): PlanScriptAttempt {
  const context = createContext(
    Object.freeze({ snapshot: frozenSnapshot, builder: createPlanBuilder(actions, frozenSnapshot, state) }),
    { name: "gamebuddy-plan-script", codeGeneration: { strings: false, wasm: false } },
  );
  const global = runInContext("globalThis", context) as Record<string, unknown>;
  // global-strip-sandbox: this deletes the withheld capabilities from the fresh context's own global, so a script that reaches one resolves to nothing
  for (const name of ABSENT_PLAN_GLOBALS) delete global[name];
  try {
    runInContext(source, context, {
      timeout: budgetMs,
      displayErrors: false,
      filename: "plan-script.js",
      // The wrapper's opening line is dropped from every reported line number, so a SyntaxError names a line the
      // caller wrote rather than one the wrapper added above it.
      lineOffset: -1,
    });
    return { outcome: "finished" };
  } catch (error) {
    // The script's own refusal is a fact about its plan and outranks a window: it was answered before the deadline and it
    // names what to fix, where an expiry can only say that the run did not return.
    if (state.refusal !== null) return { outcome: "refused", error };
    return isTimeout(error) ? { outcome: "expired" } : { outcome: "threw", error };
  }
}

/**
 * Runs the script under the first window and, while a window expired, re-runs it under the next one with a fresh state.
 *
 * <p>
 * A WINDOW THAT EXPIRED IS NOT YET A VERDICT. Wall clock cannot tell a runaway loop from a process that was not running,
 * so a single expiry buys a re-measurement instead of a refusal: the script is deterministic and the snapshot is frozen,
 * which makes the re-run the same computation with more room. Only the last window of `PLAN_SCRIPT_BUDGET_MS` mints
 * `plan_script_timeout`, so that code always means "two windows were spent and the script still had not returned" - the
 * one condition wall clock can state without pretending to know which of the two it was. A throw and the script's own
 * refusal end the loop at once: neither is a load condition, and re-running them would only repeat the same answer.
 * </p>
 * <p>
 * The state of the LAST run is returned, including the calls recorded before its deadline, so a refusal still accounts
 * for every call the script reached.
 * </p>
 */
function runPlanScriptWindows(
  source: string,
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
): Readonly<{ state: PlanScriptState; attempt: PlanScriptAttempt }> {
  const frozenSnapshot = deepFreeze(structuredClone(snapshot));
  let state = newPlanScriptState(snapshot, actions);
  let attempt = runPlanScriptAttempt(source, frozenSnapshot, actions, PLAN_SCRIPT_BUDGET_MS[0]!, state);
  for (let index = 1; index < PLAN_SCRIPT_BUDGET_MS.length && attempt.outcome === "expired"; index += 1) {
    state = newPlanScriptState(snapshot, actions);
    attempt = runPlanScriptAttempt(source, frozenSnapshot, actions, PLAN_SCRIPT_BUDGET_MS[index]!, state);
  }
  return { state, attempt };
}

/** The state one run of the script accumulates, empty: a re-measurement starts from here, not from the stopped run's. */
function newPlanScriptState(snapshot: Snapshot, actions: readonly PublishedPlanAction[]): PlanScriptState {
  return {
    nodes: [],
    refusal: null,
    heldToolCeiling: heldToolChargeCeiling(snapshot),
    calls: 0,
    builderCalls: 0,
    rejected: [],
    rejectedCount: 0,
    acceptedSteps: [],
    merged: [],
    noStepNeeded: [],
    inserted: [],
    insertedNodeIds: [],
    argumentOwners: planArgumentOwners(actions),
    worldTileByNode: new Map(),
    callOfNode: new Map(),
  };
}

/**
 * The id a compiled plan is submitted under.
 *
 * Content-addressed on purpose: the SAME plan sent twice in one world must be the same program, so the Mod
 * answers `idempotent` instead of running the work twice; two DIFFERENT plans read from the same snapshot must
 * not collide, or the second would be refused as the first one's duplicate and never run. The snapshot revision
 * keeps a plan in a later world a new program rather than a replay. The digest covers the whole node, its edges
 * included: a plan whose steps are ordered differently - or whose second step consumes its neighbour's state instead
 * of merely following it - is a different graph and therefore a different program.
 */
export function planProgramId(snapshotRevision: number, nodes: readonly PlanNode[]): string {
  const digest = createHash("sha256").update(JSON.stringify(nodes)).digest("hex").slice(0, 16);
  return `plan_${snapshotRevision}_${digest}`;
}

/** The part of a candidate node the Mod's ordering rule reads: both relations, because the rule reads the union. */
export type PlanOrderingNode = Readonly<{
  nodeId: string;
  actionId: string;
  dependsOn: readonly string[];
  /** The ordering-only edge. Absent means none, exactly as an absent field on the wire does. */
  orderedAfter?: readonly string[];
}>;

/**
 * THE ORDERING REQUIREMENT the Mod enforces on any two nodes that touch the same resource, in the Mod's own codes.
 *
 * `BodyProgramGraphRules.UnorderedClaimPairs` (`OpenBodyProgramJournalAuthority.cs` reads it from the wire candidate)
 * refuses a candidate in which two nodes whose actions share a resource-claim key are not transitively ordered by
 * EITHER relation, and every published action claims `embodied_actor`. So a candidate is a total order over its steps
 * or it is refused - and which of the two relations carries that order is the compiler's choice, made per pair: the
 * ordering edge for steps that merely happen in sequence, the consumption edge where the later one needs the earlier
 * one's product.
 *
 * This is that rule as the Host reads it, from the same published claims (`resourceClaims` are projected from the
 * Mod's own `resourceTemplate`), so a caller is told by the side that compiled the plan rather than after a round trip
 * - and told the SAME code, `resource_conflict:<actionId>`, which is what the Mod's diagnostic carries. Two nodes, one
 * code each, because the Mod reports the pair once per node it cannot place: a candidate of three independent steps
 * with no edge between them answers two conflicts, both naming the second and third.
 */
export function planResourceConflictCodes(
  nodes: readonly PlanOrderingNode[],
  actions: readonly PublishedPlanAction[],
): readonly string[] {
  const claimsOf = new Map(
    actions.map((action) => [action.actionId, action.resourceClaims.map((claim) => claim.key)] as const),
  );
  const predecessors = new Map(
    nodes.map((node) => [node.nodeId, [...node.dependsOn, ...(node.orderedAfter ?? [])]] as const),
  );
  const orderedTransitively = (from: string, target: string, seen: Set<string> = new Set()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (predecessors.get(from) ?? []).some((predecessor) => orderedTransitively(predecessor, target, seen));
  };
  const conflicts: string[] = [];
  for (let left = 0; left < nodes.length; left += 1)
    for (let right = left + 1; right < nodes.length; right += 1) {
      const leftClaims = claimsOf.get(nodes[left]!.actionId);
      const rightClaims = claimsOf.get(nodes[right]!.actionId);
      if (leftClaims === undefined || rightClaims === undefined) continue;
      if (!leftClaims.some((key) => rightClaims.includes(key))) continue;
      if (
        orderedTransitively(nodes[left]!.nodeId, nodes[right]!.nodeId) ||
        orderedTransitively(nodes[right]!.nodeId, nodes[left]!.nodeId)
      )
        continue;
      conflicts.push(`resource_conflict:${nodes[right]!.actionId}`);
    }
  return Object.freeze(conflicts);
}

/**
 * What became of every call the author wrote, rendered from the state the script left behind.
 *
 * The four lists are built HERE and nowhere else, so no caller can spell the same fact a second way: `acceptedSteps` from
 * the calls that produced their own node, `merged`/`noStepNeeded` from the calls whose work was done another way, and
 * `dropped` from the refusals - the same records `rejected` carries, rendered as the names an author reads. A refusal
 * raised before the script ran (an empty script, a bad snapshot) has no state and therefore no calls, which is a true
 * account of zero rather than a missing one.
 */
function planCallAccount(state: PlanScriptState | undefined): PlanCallAccount {
  const bounded = <TValue>(entries: readonly TValue[]): readonly TValue[] =>
    Object.freeze(entries.slice(0, MAX_REPORTED_PLAN_CALLS));
  const rejected = state?.rejected ?? [];
  const acceptedSteps = state?.acceptedSteps ?? [];
  const merged = state?.merged ?? [];
  const noStepNeeded = state?.noStepNeeded ?? [];
  return Object.freeze({
    acceptedSteps: bounded(acceptedSteps.map(planStepName)),
    acceptedStepsCount: acceptedSteps.length,
    merged: bounded(merged),
    mergedCount: merged.length,
    noStepNeeded: bounded(noStepNeeded),
    noStepNeededCount: noStepNeeded.length,
    dropped: bounded(rejected.map((rejection) => `${planStepName(rejection.call)}:${rejection.reasonCode}`)),
    droppedCount: state?.rejectedCount ?? 0,
  });
}

/**
 * One of the author's calls by its position in her script, in the spelling every account in the answer uses.
 *
 * The `n` prefix is the one the answer already gives her own nodes, and it is here for the same reason: it is the name of
 * a step SHE wrote, at the position she wrote it - which is the only numbering a refused plan still has, because a plan
 * that does not run has no nodes to point at.
 */
function planStepName(call: number): string {
  return planNodeId(PLAN_AUTHOR_NODE_PREFIX, call);
}

function refused(
  reasonCode: string,
  scriptSource: string,
  snapshotRevision: number | null,
  requirement?: PlanArgumentRequirement,
  missingArguments?: readonly string[],
  state?: PlanScriptState,
  threw?: PlanScriptThrow,
): CompiledPlan {
  return Object.freeze({
    ok: false as const,
    scriptSource,
    snapshotRevision,
    reasonCode,
    ...(requirement === undefined ? {} : { requirement }),
    ...(missingArguments === undefined ? {} : { missingArguments }),
    ...(threw === undefined ? {} : { threw }),
    rejected: Object.freeze(state === undefined ? [] : state.rejected.slice(0, MAX_REPORTED_PLAN_CALLS)),
    rejectedCount: state?.rejectedCount ?? 0,
    ...planCallAccount(state),
  });
}

type PlanScriptState = {
  nodes: PlanNode[];
  refusal: string | null;
  /**
   * The held tool's charge ceiling at compile time, or `undefined` when the snapshot could not answer.
   *
   * Read ONCE, from `heldToolChargeCeiling`, because it decides how an area is packed: a `undefined` here is the
   * difference between "this tool covers nine tiles" and "the plan must fall back and say why".
   */
  heldToolCeiling: number | undefined;
  requirement?: PlanArgumentRequirement;
  missingArguments?: readonly string[];
  calls: number;
  /**
   * How many times the SCRIPT called a per-action builder, counted where that builder is entered and before any
   * argument is validated. `calls` counts emitted nodes instead, which is what the call cap and the node cap need;
   * this counts the author's attempts, which is what an empty plan has to report - and what a refusal's `call` index
   * names, so a companion can point at the call it wrote.
   */
  builderCalls: number;
  /** The calls whose node was refused, in the order the script wrote them, narrowed once where the answer is built. */
  rejected: PlanCallRejection[];
  /** Every refusal, `rejected` list included, so a bounded list never reads as "that was all of them". */
  rejectedCount: number;
  /**
   * The calls whose own step became a node, by position: the `acceptedSteps` half of the account.
   *
   * Recorded where the node is written rather than derived from `builderCalls - rejectedCount` afterwards, because a call
   * can be honoured WITHOUT adding a node (a `for_each` that merges into an earlier pass, an `equipFor` whose tool is
   * already in hand) and a subtraction would count those as steps that do not exist.
   */
  acceptedSteps: number[];
  /** The calls whose loop joined an earlier node's loop, `n07:into=n03:same_source`. */
  merged: string[];
  /** The calls that had nothing to do, `n04:equip_for:already_held`. */
  noStepNeeded: string[];
  /**
   * The nodes the compiler inserted, in program order, each one `inserted=<actionId>;before=<nodeId>`.
   *
   * Kept in full here and narrowed once, where the plan is built: the bound is how many an answer can afford to spell
   * out, and it must not decide whether a node is written.
   */
  inserted: string[];
  /**
   * The node ids the compiler MINTED, in program order, in full: the exact population a reader joins node outcomes to.
   *
   * Not bounded, unlike `inserted`: the count is what makes an insertion reading possible at all, and a bounded list of
   * ids would make a long plan's refusals silently uncountable.
   */
  insertedNodeIds: string[];
  /**
   * Which call wrote each node, so a fold can name the call whose loop it joined rather than a node id nothing else in
   * the account speaks in.
   */
  callOfNode: Map<string, number>;
  /**
   * The vocabulary's own answer to "which actions declare this argument name", built once per compile.
   *
   * An unknown argument is nearly always a name carried over from another action (`water_crop` with a `slot`, because
   * twelve other actions take one), so the refusal can name the actions that DO declare it - a correction instead of a
   * riddle - without a hand-written table in this file.
   */
  argumentOwners: ReadonlyMap<string, readonly string[]>;
  /**
   * The world tile each emitted node addresses, for the nodes whose target IS a piece of world (see `planWorldTileOf`).
   *
   * The consumer rule reads this rather than re-deriving it: a node's action is not on the node, so the fact has to be
   * captured where the action is still in hand.
   */
  worldTileByNode: Map<string, string>;
};

/**
 * The script's only writing hand: one method per published action, named exactly as the action, taking
 * exactly the arguments that action declares, plus `equipFor`. Methods are generated from the registration
 * vocabulary, never hand-written per action, so a renamed argument cannot leave a stale recipe behind.
 */
function createPlanBuilder(
  actions: readonly PublishedPlanAction[],
  snapshot: Snapshot,
  state: PlanScriptState,
): unknown {
  const methods = new Map<string, (arguments_: unknown) => void>();
  for (const action of actions)
    methods.set(action.actionId, (arguments_) => {
      state.builderCalls += 1;
      atPlanCall(state, action.actionId, () => emitPlanNode(action, arguments_, snapshot, actions, state));
    });
  const equipFor = (actionId: unknown, target: unknown) => {
    state.builderCalls += 1;
    return atPlanCall(state, typeof actionId === "string" ? actionId : null, () =>
      equipForAction(actions, snapshot, actionId, target, state),
    );
  };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "nodeCount") return state.nodes.length;
        if (property === "isFull") return () => state.nodes.length >= MAX_PLAN_NODES;
        if (property === "equipFor") return equipFor;
        // THE FORM OWNS ITS NAME. A published action that took the same id would shadow the loop for every script that
        // writes `for_each`, and the loop is the Host's own plan vocabulary, so the form is answered first.
        if (property === FOR_EACH_PLAN_ACTION_ID)
          return (arguments_: unknown) => {
            state.builderCalls += 1;
            atPlanCall(state, FOR_EACH_PLAN_ACTION_ID, () => emitForEachNode(arguments_, actions, state));
          };
        const method = methods.get(property);
        if (method !== undefined) return method;
        return refusePlan(`plan_script_unknown_action:${property}`, state);
      },
    },
  );
}

/**
 * Writes the equip step the action's own declared tool needs, immediately before that action, and answers the tool slot
 * the action must name.
 *
 * The tool an action needs is published at two grains. The action-wide `tool:<category>` claim (read into
 * `toolRequirement`, and selected by the Mod at dispatch) names the CATEGORY; the pack's own tool slots publish that same
 * category word, which is what resolves a slot. A target entry's `toolKind` and `slot` (`debrisTargets`,
 * `animalProductTargets`) is the second input, and on those families it is the only one - the surface publishes no
 * claim for them, so reading the claim alone would report `tool_requirement_undeclared` for an action whose tool is
 * declared, and reading the target alone refuses the tool families whose target carries no tool fields.
 *
 * An action whose surface truly declares nothing is refused BY NAME, together with the arguments and claims the surface
 * does declare for it, because a guessed tool is a guaranteed failed hit.
 */
function equipForAction(
  actions: readonly PublishedPlanAction[],
  snapshot: Snapshot,
  actionId: unknown,
  target: unknown,
  state: PlanScriptState,
): number {
  if (typeof actionId !== "string" || actionId.length === 0)
    rejectPlanCall("plan_script_equip_for_selector_invalid", state);
  const action = actions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined) rejectPlanCall(`plan_script_unknown_action:${actionId}`, state);
  const fromTarget = declaredToolOf(target);
  const requirement = action.toolRequirement;
  const category = requirement.declared ? requirement.category : fromTarget?.toolKind;
  if (category === undefined)
    rejectPlanCall(`plan_script_tool_requirement_undeclared:${action.actionId}`, state, requirementOf(action));
  const slot =
    publishedSlotOfCategory(snapshot, category, requirement) ??
    (fromTarget !== undefined && fromTarget.toolKind === category ? fromTarget.slot : null);
  if (slot === null)
    rejectPlanCall(
      `plan_script_${toolRefusalReason(snapshot)}:${action.actionId}:${category}`,
      state,
      requirementOf(action),
    );
  // The tool the action must name is already in hand, so the plan is the action alone - which is a call that had nothing
  // to do, not a call that was ignored: an author who cannot tell those apart cannot tell whether the compiler saw her
  // `equipFor` at all.
  if (publishedToolSlot(snapshot) === slot) {
    state.noStepNeeded.push(`${planStepName(state.builderCalls)}:equip_for:already_held`);
    return slot;
  }
  const equip = actions.find((candidate) => candidate.actionId === EQUIP_TOOL_ACTION_ID);
  if (equip === undefined)
    rejectPlanCall(`plan_script_equip_unavailable:${EQUIP_TOOL_ACTION_ID}`, state, requirementOf(action));
  // Written through the same emitter as every other node, so the equip step is validated against `equip_tool`'s own
  // declared argument (a semantic tool category, never a slot) exactly as a hand-written call would be.
  emitPlanNode(equip, { tool: category }, snapshot, actions, state);
  return slot;
}

/**
 * Why no slot carries the category the action names, in the two terms that have two different remedies.
 *
 * `tool_slot_unresolved` is an evidence problem: not one slot in the pack publishes a category, which is what an older
 * Mod looks like, so no slot can be resolved and updating the Mod is the remedy. `tool_not_owned` is a world problem:
 * the pack publishes categories and this one is not among them, so obtaining the tool is the remedy. A slot whose
 * category is `unknown` says the Mod has no word for that tool and never counts as evidence about a named category.
 */
function toolRefusalReason(snapshot: Snapshot): "tool_slot_unresolved" | "tool_not_owned" {
  return (snapshot.toolSlots ?? []).some((entry) => entry.category !== undefined)
    ? "tool_not_owned"
    : "tool_slot_unresolved";
}

/**
 * The slot whose published category is the one the action needs, ranked the way the Mod ranks it for `equip_tool`: the
 * highest upgrade level wins and ties go to the smallest slot. Slots inside the claim's own upgrade range are preferred,
 * because a `BasicOnly` claim is refused by name when an upgraded tool is held.
 */
function publishedSlotOfCategory(
  snapshot: Snapshot,
  category: string,
  requirement: PublishedPlanToolRequirement,
): number | null {
  const matches = (snapshot.toolSlots ?? []).filter((entry) => entry.category === category);
  if (matches.length === 0) return null;
  const withinRequirement = matches.filter((entry) =>
    satisfiesUpgradeRequirement(entry.upgradeLevel ?? 0, requirement),
  );
  // A tool of the right category that is the WRONG upgrade level is not a candidate. Choosing one made the plan
  // compile and the Mod refuse the node later with `tool_upgrade_insufficient` - a compile-time fact spent as a
  // runtime round trip. The caller reports it by name instead (see `publishedSlotOfCategory` callers).
  if (withinRequirement.length === 0 && matches.length > 0) return null;
  const ranked = withinRequirement;
  let best: Readonly<{ slot: number; upgradeLevel: number }> | undefined;
  for (const entry of ranked) {
    const level = entry.upgradeLevel ?? 0;
    if (best === undefined || level > best.upgradeLevel || (level === best.upgradeLevel && entry.slot < best.slot))
      best = { slot: entry.slot, upgradeLevel: level };
  }
  return best === undefined ? null : best.slot;
}

/** Whether one owned tool's upgrade level satisfies the range the action's claim publishes. */
function satisfiesUpgradeRequirement(level: number, requirement: PublishedPlanToolRequirement): boolean {
  if (!requirement.declared) return true;
  const minimum = requirement.minimumUpgradeLevel;
  const maximum = requirement.maximumUpgradeLevel;
  return (minimum === null || level >= minimum) && (maximum === null || level <= maximum);
}

/** The tool a target entry declares it needs, or `undefined` when this part of the surface says nothing about a tool. */
function declaredToolOf(target: unknown): Readonly<{ toolKind: string; slot: number }> | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const declared = target as Readonly<{ toolKind?: unknown; slot?: unknown }>;
  if (typeof declared.toolKind !== "string") return undefined;
  if (typeof declared.slot !== "number" || !isNonNegativeSafeInteger(declared.slot)) return undefined;
  return Object.freeze({ toolKind: declared.toolKind, slot: declared.slot });
}

/** The slot the farmer is holding, exactly as the Mod's snapshot publishes it. */
function publishedToolSlot(snapshot: Snapshot): number | null {
  const held = snapshot.currentToolSlot;
  return typeof held === "number" && isNonNegativeSafeInteger(held) ? held : null;
}

/** The shape this action demands, carried by every refusal a call can produce: the model that guessed a name or a kind
 * reads what the surface requires instead of a bare `invalid_arguments`. */
function requirementOf(action: PublishedPlanAction): PlanArgumentRequirement {
  return Object.freeze({
    actionId: action.actionId,
    requiredArguments: action.arguments,
    resourceClaims: action.resourceClaims,
    // The family the caller should re-read, when the surface names one. A refusal that says a target was refused
    // without naming where its rows live leaves the author guessing at a vocabulary it cannot see.
    ...(action.targetFamily === null ? {} : { targetFamily: action.targetFamily }),
  });
}

/** Which actions declare each argument name, in the vocabulary's own order, bounded per name. */
function planArgumentOwners(actions: readonly PublishedPlanAction[]): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, string[]>();
  for (const action of actions)
    for (const argument of action.arguments) {
      const bucket = owners.get(argument.name);
      if (bucket === undefined) owners.set(argument.name, [action.actionId]);
      else if (bucket.length < PLAN_ARGUMENT_OWNERS_LISTED && !bucket.includes(action.actionId))
        bucket.push(action.actionId);
    }
  return owners;
}

/**
 * What one argument must be, in the surface's own terms: its declared type, its declared closed set where there is one,
 * and - for the two kinds whose bounds are the Host's rather than an enum - the bound itself.
 *
 * This is half of every argument refusal's answer. The other half is `planArgumentSource`.
 */
function planArgumentExpectation(declaration: PlanArgumentShape): string {
  if (declaration.type === "destination_selector") return "destination_selector[one_of:label,ref]";
  // A tile coordinate and a backpack index are both `integer` on the wire and both refuse a fractional value, which is
  // the fact `travel({ x: 12.5 })` needed and `argument_not_canonical` did not state. WHICH integers are legal belongs to
  // the action's own bounds, and those are checked where they are declared: the Mod's registry (`transitions declare the
  // warp SOURCE floor of -1`) and this side's execution validator (`isWarpSourceCoordinate` for a transition,
  // `isTileCoordinate` for a walk target). This compiler is not a second statement of them - it was, and it refused the
  // edge exit `snapshot.warps[]` had just told the author to name.
  const kind = declaration.type === "integer" ? "integer[whole]" : declaration.type;
  if (declaration.enum !== undefined) return `${kind}[one_of:${declaration.enum.join(",")}]`;
  return kind;
}

/** One row family the snapshot publishes: its name, the field paths its rows carry, and how many rows it holds. */
type PlanSnapshotRowFamily = Readonly<{ name: string; fields: readonly string[]; rows: number }>;

/**
 * The row families the snapshot currently publishes, with the field paths each one carries.
 *
 * Read from the LIVE snapshot, never from a table in this file, because the only answer a refusal can be held to is one
 * about the object the script was handed. One nesting level is followed (`chests[].items[].qualifiedItemId`), which is
 * where the container families keep the item id `chest_store` asks for; the depth stops there because a second level is
 * a different action's question.
 */
function planSnapshotRowFamilies(snapshot: Snapshot): readonly PlanSnapshotRowFamily[] {
  const families: PlanSnapshotRowFamily[] = [];
  for (const [name, value] of Object.entries(snapshot as Readonly<Record<string, unknown>>)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const fields = new Set<string>();
    for (const row of value.slice(0, PLAN_SOURCE_ROWS_SAMPLED)) {
      if (!isRecord(row)) continue;
      for (const [field, fieldValue] of Object.entries(row)) {
        if (fields.size >= PLAN_SOURCE_MAX_FIELDS) break;
        fields.add(field);
        if (!Array.isArray(fieldValue)) continue;
        const nested = fieldValue.find((entry) => isRecord(entry));
        if (!isRecord(nested)) continue;
        for (const nestedField of Object.keys(nested)) fields.add(`${field}[].${nestedField}`);
      }
    }
    if (fields.size > 0)
      families.push(Object.freeze({ name, fields: Object.freeze([...fields].sort()), rows: value.length }));
  }
  return families;
}

/** `qualifiedItemId` -> [qualified, item, id]. Both argument names and field names split the same way. */
function planNameWords(name: string): readonly string[] {
  return name
    .replaceAll("[]", ".")
    .split(/(?=[A-Z])|[._]/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** `expected` is the caller's word for "this is my assertion", not part of the fact it names. */
function planArgumentFieldWords(argumentName: string): readonly string[] {
  const words = planNameWords(argumentName);
  return words[0] === "expected" ? words.slice(1) : words;
}

/** How much of a field name and an argument name agree: shared words over the words either one has. */
function planFieldMatch(field: string, words: readonly string[]): number {
  if (words.length === 0) return 0;
  const fieldWords = planNameWords(field);
  if (fieldWords.length === 0) return 0;
  let shared = 0;
  for (const word of words) if (fieldWords.includes(word)) shared += 1;
  return shared === 0 ? 0 : shared / (words.length + fieldWords.length - shared);
}

/** Whether a field path IS the fact the argument names, word for word (`expectedTargetId` -> `targetId`). */
function planFieldIsTheArgument(field: string, words: readonly string[]): boolean {
  return planNameWords(field).join(" ") === words.join(" ");
}

/**
 * The row families of this snapshot, ordered by how much of THIS action they answer.
 *
 * A family scores one point for every argument the action declares that it publishes a field for, so `harvest_crop`
 * ranks `harvestTargets` (x, y, targetId and - under a name of its own - `qualifiedHarvestItemId`) level with
 * `forageTargets` and then wins on the next key: the family whose NAME shares a word with the action id
 * (`pickup_item` -> `itemTargets` rather than `forageTargets`, `harvest_crop` -> `harvestTargets` rather than
 * `forageTargets`, which carries the same four field names). Ties then go to the larger family, then alphabetically, so
 * the answer is a function of the input and never of iteration order. HOW WELL a field matches decides which field of
 * the chosen family is named (exact before approximate), never which family is the action's own.
 */
function planRowFamiliesFor(action: PublishedPlanAction, snapshot: Snapshot): readonly PlanSnapshotRowFamily[] {
  const actionWords = planNameWords(action.actionId);
  return planSnapshotRowFamilies(snapshot)
    .map((family) => {
      let answered = 0;
      for (const argument of action.arguments) {
        const words = planArgumentFieldWords(argument.name);
        const best = Math.max(0, ...family.fields.map((field) => planFieldMatch(field, words)));
        if (best >= PLAN_SOURCE_MATCH_FLOOR) answered += 1;
      }
      const named = planNameWords(family.name).filter((word) => actionWords.includes(word)).length;
      return { family, answered, named };
    })
    .sort(
      (left, right) =>
        right.answered - left.answered ||
        right.named - left.named ||
        right.family.rows - left.family.rows ||
        left.family.name.localeCompare(right.family.name),
    )
    .map((entry) => entry.family);
}

/** Whether this action names a TARGET at all, which is what decides where its tile coordinates are published. */
function planNamesATarget(action: PublishedPlanAction): boolean {
  return action.arguments.some((argument) => planArgumentFieldWords(argument.name).at(-1) === "id");
}

/** A one-level path into the snapshot that ends in the fact an argument names (`snapshot.tile.x`), if there is one. */
function planSnapshotScalarPath(snapshot: Snapshot, argumentWords: readonly string[]): string | undefined {
  for (const [name, value] of Object.entries(snapshot as Readonly<Record<string, unknown>>)) {
    if (isRecord(value)) {
      for (const field of Object.keys(value))
        if (planFieldIsTheArgument(field, argumentWords)) return `snapshot.${name}.${field}`;
      continue;
    }
    if (Array.isArray(value)) continue;
    if (planFieldIsTheArgument(name, argumentWords)) return `snapshot.${name}`;
  }
  return undefined;
}

/**
 * The families to read a value from, with the family the SURFACE declares for this action first.
 *
 * The declaration is the Mod's own answer to "which family supplies this action's targets", so it outranks this
 * file's scoring: `talk_to_npc` declares `npcRelationshipTargets`, and the scoring handed back `forageTargets` instead -
 * a family that publishes a field of the same name and has nothing to do with villagers.
 *
 * The declared family is only a candidate when it published ROWS. `planSnapshotRowFamilies` never lists an empty family,
 * and an empty one cannot be read from, so a family the bounded `Discover*` left empty falls through to the populated
 * family that publishes the same id - `villagerWhereabouts`, whose rows carry `targetId` for exactly this reason.
 */
function planDeclaredFamilyFirst(
  action: PublishedPlanAction,
  families: readonly PlanSnapshotRowFamily[],
): readonly PlanSnapshotRowFamily[] {
  if (action.targetFamily === null) return families;
  const declared = families.filter((family) => family.name === action.targetFamily);
  if (declared.length === 0) return families;
  return [...declared, ...families.filter((family) => family.name !== action.targetFamily)];
}

/**
 * WHERE the value for one argument is published - the third part of every argument refusal's answer.
 *
 * Measured 2026-10-31 (`round18`): 9 of 66 plans were refused for reasons the model could not have known, and the five
 * worst were `pickup_forage` scene bindings the model hand-wrote because the refusal named a field and nothing else. The
 * old answer to `pickup_item` omitting `expectedQualifiedItemId` said exactly what the model had failed at and not where to
 * look; this is the "where to look", derived from the snapshot the script was actually handed, or the name of the
 * read-only action whose answer carries it when the snapshot carries it at all.
 */
function planArgumentSource(action: PublishedPlanAction, snapshot: Snapshot, argumentName: string): string {
  const declaration = action.arguments.find((argument) => argument.name === argumentName);
  // A destination is not a snapshot fact: the selector copies a label (or an opaque ref) out of `find_destination`'s
  // answer, and no snapshot family publishes one.
  if (declaration?.type === "destination_selector") return DESTINATION_DISCOVERY_ACTION_ID;
  // A tile coordinate on an action that names no target is the actor's own tile: there is no row to read, and
  // `tile.x`/`tile.y` are the one coordinate pair every usable snapshot publishes.
  if ((argumentName === "x" || argumentName === "y") && !planNamesATarget(action))
    return `snapshot.tile.${argumentName}`;
  const words = planArgumentFieldWords(argumentName);
  const families = planDeclaredFamilyFirst(action, planRowFamiliesFor(action, snapshot));
  // The action's OWN family first, and only then the others: a field name that differs by a word inside the family the
  // action is about (`harvestTargets[].qualifiedHarvestItemId` for `expectedQualifiedItemId`) is a better answer than an
  // exact name in a family the action is not about (`forageTargets[].qualifiedItemId`), because the second points at rows
  // the plan is not allowed to harvest. Within one family, exact beats approximate.
  for (const family of families) {
    const exact = family.fields.find((candidate) => planFieldIsTheArgument(candidate, words));
    if (exact !== undefined) return `snapshot.${family.name}[].${exact}`;
    const approximate = family.fields.find((candidate) => planFieldMatch(candidate, words) >= PLAN_SOURCE_MATCH_FLOOR);
    if (approximate !== undefined) return `snapshot.${family.name}[].${approximate}`;
  }
  return planSnapshotScalarPath(snapshot, words) ?? "not_in_snapshot";
}

/**
 * What the script ACTUALLY passed, in one bounded word.
 *
 * `travel({ x: 12.5 })` was refused `argument_not_canonical:travel.x` and nothing said the value was a float: the model
 * could not tell a rounding slip from a wrong field, from the wrong action. Printable ASCII only and bounded, because a
 * value the model wrote must not be able to forge a line in a log or spend the turn's context.
 */
function planReceivedValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return `number(${planBoundedReasonText(String(value))})`;
    case "string":
      return `string(${planBoundedReasonText(value)})`;
    case "boolean":
      return `boolean(${String(value)})`;
    case "object":
      return "object";
    case "undefined":
      return "missing";
    default:
      return typeof value;
  }
}

function planBoundedReasonText(value: string): string {
  const printable = value.replace(/[^\u0020-\u007e]/gu, "");
  return printable.length > PLAN_REASON_VALUE_CHARS ? `${printable.slice(0, PLAN_REASON_VALUE_CHARS)}...` : printable;
}

/**
 * Refuses a call carrying an argument this action does not declare.
 *
 * The answer names the set the action DOES take (`allowed`), and - because an invented argument is nearly always a name
 * carried over from another action - the actions that really declare it, up to a bound. Measured 2026-10-31
 * (`round18`): one plan called `water_crop` with a `slot` because twelve other actions take one, and the refusal said only
 * that the argument was unknown.
 */
function refuseUnknownArguments(
  action: PublishedPlanAction,
  supplied: Readonly<Record<string, unknown>>,
  state: PlanScriptState,
  requirement: PlanArgumentRequirement,
): void {
  const allowed = action.arguments.length === 0 ? "none" : action.arguments.map((argument) => argument.name).join(",");
  for (const name of Object.keys(supplied)) {
    if (action.arguments.some((argument) => argument.name === name)) continue;
    const owners = (state.argumentOwners.get(name) ?? []).slice(0, PLAN_ARGUMENT_OWNERS_LISTED);
    const declaredBy = owners.length === 0 ? "none" : owners.join(",");
    rejectPlanCall(
      `plan_script_unknown_argument:${action.actionId}.${name}:allowed:${allowed}:declared_by:${declaredBy}`,
      state,
      requirement,
    );
  }
}

function emitPlanNode(
  action: PublishedPlanAction,
  arguments_: unknown,
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
  state: PlanScriptState,
): void {
  state.calls += 1;
  if (state.calls > MAX_PLAN_BUILDER_CALLS) refusePlan(`plan_script_call_cap:${state.calls}`, state);
  if (state.nodes.length >= MAX_PLAN_NODES) refusePlan(`plan_cap_exceeded:${state.nodes.length + 1}`, state);
  const requirement = requirementOf(action);
  // Checked before the arguments, because a step written after a world reset is illegal whatever it carries: no
  // argument can fix it, and answering with an argument problem would send the author back to a call that still
  // cannot run.
  const previousNode = state.nodes.length === 0 ? undefined : state.nodes[state.nodes.length - 1]!;
  if (previousNode !== undefined && WORLD_RESETTING_PLAN_ACTION_IDS.includes(previousNode.actionId))
    rejectPlanCall(
      `plan_script_action_after_world_reset:${action.actionId}:${previousNode.actionId}`,
      state,
      requirement,
    );
  // THE BODY A DIALOGUE TOOK IS GIVEN BACK BY THE COMPILER, NOT BY THE AUTHOR.
  //
  // Decided before the arguments, for the same reason the world-reset refusal above is: no argument can fix a step
  // written while the body is held, so answering with an argument problem would send the author back to a call that
  // still cannot run. Written into the program below, immediately after the yielding node and immediately before the
  // author's own - nothing else moves.
  const dismissal = bodyYieldDismissal(previousNode, action, actions, requirement, state);
  // An action that declares no argument is called with none.
  const accepted = arguments_ === undefined && action.arguments.length === 0 ? {} : arguments_;
  if (typeof accepted !== "object" || accepted === null || Array.isArray(accepted))
    rejectPlanCall(`plan_script_argument_not_canonical:${action.actionId}`, state, requirement);
  const supplied = accepted as Readonly<Record<string, unknown>>;
  const declared = new Map(action.arguments.map((argument) => [argument.name, argument] as const));
  refuseUnknownArguments(action, supplied, state, requirement);
  // AN OMITTED ARGUMENT IS REFUSED, NOT INFERRED, EVEN WHEN ITS VALUE IS IN THE SNAPSHOT.
  //
  // Inferring was considered and rejected. `expectedQualifiedItemId` when exactly one target row matches the x/y of the
  // same script is the case that invites it, and there are four reasons it is wrong:
  //   1. Those arguments are ASSERTIONS the Mod re-checks at execution against the live target. A value this compiler
  //      filled in is an assertion nobody made; when the row it picked is the wrong one (`forageTargets`, `itemTargets`,
  //      `harvestTargets` and `cropTargets` overlap in tile space) the plan is refused at runtime, aimed at a line whose
  //      author never wrote that value and cannot see which row was read.
  //   2. (x, y) does not identify a row. It selects among EVERY family publishing x and y, so choosing one is a Host-side
  //      claim about what the caller meant, and this projection may only narrow what the Mod published - never add.
  //   3. It is silent. The measured cost of the alternative is one teaching refusal per class (`round18`: the model had
  //      `qualifiedItemId` in its target rows and omitted the argument anyway); the cost of inference is a model that
  //      believes the argument is optional and cannot say why the same plan fails when two families share a tile.
  //   4. `planProgramId` is content-addressed on the nodes, and a journal replays a node's arguments as written. A
  //      Host-inferred value has no provenance to replay.
  const canonical: Record<string, PlanArgument> = {};
  // EVERY ARGUMENT THAT IS MISSING, not the first one: measured in `.tmp/fork-why-slow.jsonl`, the refusal for
  // `claim_mail_attachment({ expectedTargetId })` named `x` alone, so a correction that fixed `x` bought a second
  // refusal for `y`. The code names the first (with what it must be and where the value is published) and the answer
  // carries the whole set beside it.
  const missing = [...declared.values()].filter((declaration) => !Object.hasOwn(supplied, declaration.name));
  if (missing.length > 0) {
    const first = missing[0]!;
    rejectPlanCall(
      `plan_script_missing_argument:${action.actionId}.${first.name}:${planArgumentExpectation(first)}:${planArgumentSource(action, snapshot, first.name)}`,
      state,
      requirement,
      Object.freeze(missing.map((declaration) => declaration.name)),
    );
  }
  for (const [name, declaration] of declared) {
    const argumentPath = `${action.actionId}.${name}`;
    const value = canonicalPlanArgument(declaration, supplied[name]);
    if (value === undefined) {
      const expects = planArgumentExpectation(declaration);
      const from = planArgumentSource(action, snapshot, name);
      const received = planReceivedValue(supplied[name]);
      rejectPlanCall(
        `plan_script_argument_not_canonical:${argumentPath}:${expects}:${from}:got:${received}`,
        state,
        requirement,
      );
    }
    canonical[name] = value;
  }
  // A transition is written as the walk plus the door: the walk is the compiler's because the Mod refuses the door
  // on distance alone, and the node the author wrote still runs in the order the author wrote it.
  //
  // THE DISMISSAL IS PUSHED FIRST, and the walk is computed with it already in place. Two nodes ordered after the same
  // predecessor are two nodes the Mod's claim rule refuses (`resource_conflict`), so the compiler's own insertions have to
  // be a CHAIN: dismissal, then the walk, then the author's step. The fixpoint gate found this on
  // `talk_to_npc` -> `travel` before it reached a run.
  const nextPosition = state.nodes.length + 1;
  const dismissalNodeId = planNodeId(PLAN_DISMISSAL_NODE_PREFIX, nextPosition);
  if (dismissal !== null) state.nodes.push(bodyYieldDismissalNode(dismissalNodeId, dismissal));
  const approach = transitionApproachNode(
    action,
    canonical,
    state,
    planNodeId(PLAN_WALK_NODE_PREFIX, state.nodes.length + 1),
  );
  if (approach !== null) state.nodes.push(approach);
  // EVERY NODE THE COMPILER WRITES IS ONE THE WIRE CARRIES, so the cap is checked against all of them: a program past
  // the bound would be refused as a malformed request instead of as a plan that is too long.
  const authorPosition = state.nodes.length + 1;
  if (authorPosition > MAX_PLAN_NODES) refusePlan(`plan_cap_exceeded:${authorPosition}`, state, requirement);
  const authorNodeId = planNodeId(PLAN_AUTHOR_NODE_PREFIX, authorPosition);
  // The answer shows the program is not exactly the script, once per node and in program order.
  if (dismissal !== null) {
    state.inserted.push(`inserted=${dismissal.actionId};before=${authorNodeId}`);
    state.insertedNodeIds.push(dismissalNodeId);
  }
  if (approach !== null) {
    state.inserted.push(`inserted=${approach.actionId};before=${authorNodeId}`);
    state.insertedNodeIds.push(approach.nodeId);
  }
  // TWO EDGES, TWO MEANINGS: THE ORDER A SCRIPT WROTE IS NOT A CHAIN OF CONSUMERS.
  //
  // `orderedAfter` says "do not start before this one is terminal, and do not skip me if it failed"; `dependsOn` says
  // "I consume its fact, so if it failed I cannot run". The claim rule reads the union, so the script's statement order
  // still has to survive as an edge - but spending `dependsOn` on it was the measured defect: on the finished 293-node
  // run, `till_soil` alone was 64 nodes with 30 succeeded, 5 failed and **29 skipped**, because a strip of independent
  // tiles was written as a chain. The tiles of a strip do not consume each other, so what the second one waits for is
  // "that tile is done", not "that tile succeeded".
  //
  // WHAT COUNTS AS A CONSUMER, and why this is not a table of action pairs. The one fact this compiler holds about a
  // step is the TILE it names: the canonical `x`/`y` pair the surface declares, which is the piece of world the step
  // reads and writes. A later step aimed at the SAME tile is a step on state the earlier one was to create, and the
  // cases are the product's own: `till_soil` then `plant_seed` on that tile (there is no soil for the seed where tilling
  // failed), `plant_seed` then `water_crop`, `machine_load` then `machine_collect_output` (an output of a machine nothing
  // was loaded into), `place_owned_object` then `rotate_furniture`. A step on a DIFFERENT tile consumes nothing of the
  // earlier one, whatever the two actions are.
  //
  // Which also says what is NOT a consumer: the walk this compiler writes before a transition. Where the body stands is
  // not state one step makes for another (`move_to_tile` declares no target family), so a walk that failed leaves the
  // door to be attempted and refused by its own gate - `door_out_of_range` names what is wrong, where a skip names
  // nothing.
  //
  // This is the same rule the Mod's own cases state from the other side: in `BodyProgramOrderedAfterTests.A3`, `b`
  // consumes `a` and is skipped naming `a`, while `c` merely had to happen after `a` and runs. The producer a skip names
  // is the nearest earlier step on that tile, which is the edge `program-status-wait.ts` `producersThatSkipped` joins on.
  //
  // The limit of the rule, stated rather than hidden: tile identity is coarser than data flow, so a step on a tile an
  // earlier step only READ (`machine_inspect` of the machine a later step loads) is treated as a consumer and skipped
  // with it. That errs toward leaving a tile alone after the step written on it failed; the direction it must never err
  // in is acting as if a failed step had produced something.
  const tile = planWorldTileOf(action, canonical);
  const producer = tile === null ? undefined : planProducerOnTile(state, tile);
  const previous = state.nodes[state.nodes.length - 1]?.nodeId;
  if (tile !== null) state.worldTileByNode.set(authorNodeId, tile);
  state.nodes.push(
    Object.freeze({
      nodeId: authorNodeId,
      actionId: action.actionId,
      arguments: Object.freeze(canonical),
      dependsOn: Object.freeze(producer === undefined ? [] : [producer]),
      // Absent rather than `[]` when there is no ordering edge: absent is the empty edge on the wire, and the first
      // node (or one that follows the very step it consumes) has nothing to wait for.
      ...(previous === undefined || previous === producer ? {} : { orderedAfter: Object.freeze([previous]) }),
      bindings: Object.freeze({}),
    }),
  );
  // Her step is in the program, so her call is accounted for and cannot also appear as dropped, merged or unneeded.
  state.acceptedSteps.push(state.builderCalls);
  state.callOfNode.set(authorNodeId, state.builderCalls);
}

/**
 * The dismissal the compiler writes, and the node it has to follow: everything needed to place it without asking the
 * question a second time.
 */
type PlanBodyYieldDismissal = Readonly<{ actionId: string; afterNodeId: string }>;

/**
 * The dismissal this call needs written before it, or `null` when the step before it left the body free.
 *
 * `dismiss_modal` is the step because it is the one body-clearing action the Mod publishes with NO arguments; the other,
 * `answer_dialogue`, demands a `responseKey` only the author can choose, so writing it would be the compiler deciding
 * what the player said.
 *
 * The refusal survives for the one shape this compiler cannot fix: no published action it could write (an older Mod, or a
 * vocabulary that stopped advertising the id), or a published one that now demands an argument nobody here can supply.
 * Then the author is told what she was told before - `dismiss_first=<id>` names the step she has to write.
 */
function bodyYieldDismissal(
  previousNode: PlanNode | undefined,
  action: PublishedPlanAction,
  actions: readonly PublishedPlanAction[],
  requirement: PlanArgumentRequirement,
  state: PlanScriptState,
): PlanBodyYieldDismissal | null {
  if (previousNode === undefined) return null;
  if (!BODY_YIELDING_PLAN_ACTION_IDS.includes(previousNode.actionId)) return null;
  if (MODAL_CLEARING_PLAN_ACTION_IDS.includes(action.actionId)) return null;
  const dismissalId = MODAL_CLEARING_PLAN_ACTION_IDS[0]!;
  const published = actions.find((candidate) => candidate.actionId === dismissalId);
  if (published === undefined || published.arguments.length > 0)
    rejectPlanCall(
      `plan_script_action_after_body_yield:${action.actionId}:${previousNode.actionId}:dismiss_first=${dismissalId}`,
      state,
      requirement,
    );
  return Object.freeze({ actionId: dismissalId, afterNodeId: previousNode.nodeId });
}

/**
 * The dismissal node itself: no arguments, ordered after the step that yielded the body, consuming nothing.
 *
 * `dependsOn` stays empty for the same reason the walk's does - if the dialogue never opened, the dismissal is attempted
 * and refused by its own gate, which names that nothing was open, where a skip names nothing.
 */
function bodyYieldDismissalNode(nodeId: string, dismissal: PlanBodyYieldDismissal): PlanNode {
  return Object.freeze({
    nodeId,
    actionId: dismissal.actionId,
    arguments: Object.freeze({}),
    dependsOn: Object.freeze([]),
    orderedAfter: Object.freeze([dismissal.afterNodeId]),
    bindings: Object.freeze({}),
  });
}

/**
 * The tile of a PIECE OF WORLD a step addresses, or `null` when its coordinates are not state but a place to stand.
 *
 * The distinction is the surface's own, not this compiler's: `targetFamily` is where an action declares its targets come
 * from (`soilTiles`, `machineTargets`, `chests`), and an action declaring none addresses no state at its coordinates -
 * `move_to_tile`'s `x`/`y` is a place to stand, and nothing a later step can consume. That is the whole input of the
 * consumer rule `emitPlanNode` applies.
 */
function planWorldTileOf(
  action: PublishedPlanAction,
  arguments_: Readonly<Record<string, PlanArgument>>,
): string | null {
  if (action.targetFamily === null) return null;
  const x = arguments_.x;
  const y = arguments_.y;
  if (x?.type !== "integer" || y?.type !== "integer") return null;
  // Keyed on the CANONICAL value, so two spellings of one coordinate are one tile.
  return `${x.canonicalValue},${y.canonicalValue}`;
}

/**
 * The nearest earlier step on this tile: the one whose state this step is written on top of.
 *
 * Nearest rather than all of them, so a node carries one edge and a skip names one producer - `till`, then `plant`, then
 * `water` on one tile is a chain of consumption, not a node with three edges.
 */
function planProducerOnTile(state: PlanScriptState, tile: string): string | undefined {
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const candidate = state.nodes[index]!.nodeId;
    if (state.worldTileByNode.get(candidate) === tile) return candidate;
  }
  return undefined;
}

/**
 * The compiler's own walk to a transition's source tile, or `null` when the plan already reaches that tile.
 *
 * The step carries the transition's OWN coordinates. `move_to_tile` is what makes that executable: it accepts a warp
 * tile as its target and, because the target is a warp the actor would trigger by stopping on it, arrives ADJACENT
 * instead of on top of it (`farmhandexecutioncontroller.movementactions.cs:62-63`, `nativeWarpTarget` ->
 * `adjacentArrival`) - which is exactly the relationship `enter_exit` gates on. The tile is also legal as an
 * `enter_exit` target by the Mod's own three-way warp rule (same file, `IsWarpBufferTile`).
 *
 * Nothing is prepended when the node immediately before already walks to that same tile: the author wrote the walk and
 * a second one would be a no-op submission. The id is `auto_walk_<position>` rather than `n<position>` so a journal
 * reader can tell which plan node the compiler wrote, while the author's own nodes keep the order, arguments and
 * relative position its script gave them. The position is passed in rather than derived here, because the dismissal
 * written after a body-yielding step occupies a position too and the whole program is numbered once.
 */
function transitionApproachNode(
  action: PublishedPlanAction,
  canonical: Readonly<Record<string, PlanArgument>>,
  state: PlanScriptState,
  nodeId: string,
): PlanNode | null {
  if (!TRANSITION_SOURCE_PLAN_ACTION_IDS.includes(action.actionId)) return null;
  const x = canonical.x;
  const y = canonical.y;
  if (x?.type !== "integer" || y?.type !== "integer") return null;
  const walkX = approachTileFor(x);
  const walkY = approachTileFor(y);
  const previous = state.nodes[state.nodes.length - 1];
  const previousX = previous?.arguments.x;
  const previousY = previous?.arguments.y;
  if (
    previous !== undefined &&
    previous.actionId === MOVE_TO_TILE_ACTION_ID &&
    previousX?.type === "integer" &&
    previousY?.type === "integer" &&
    previousX.canonicalValue === walkX.canonicalValue &&
    previousY.canonicalValue === walkY.canonicalValue
  )
    return null;
  return Object.freeze({
    nodeId,
    actionId: MOVE_TO_TILE_ACTION_ID,
    arguments: Object.freeze({ x: walkX, y: walkY }),
    // A walk consumes nothing: where the body stands is not a piece of world state another step produced (`move_to_tile`
    // declares no target family), so a failed walk orders the step after it rather than skipping it.
    dependsOn: Object.freeze([]),
    ...(previous === undefined ? {} : { orderedAfter: Object.freeze([previous.nodeId]) }),
    bindings: Object.freeze({}),
  });
}

/**
 * ONE PACKED AREA INSTEAD OF ONE LOOP: the native uses that cover the rectangle exactly, emitted as ordinary nodes.
 *
 * <p>
 * WHY THE LOOP IS BYPASSED RATHER THAN TAUGHT TO PACK. `for_each` expands one target per tile on the game thread
 * (`FarmhandForEachExpansion.cs:373`), so a loop over a 3x20 patch at `charge: 3` becomes 60 dispatches of which 57 are
 * refused `soil_already_tilled` - every walk the packing saved, handed back. Teaching the loop to pack would make one form
 * carry two meanings; emitting the packed steps as ordinary nodes keeps the loop's meaning intact and gives each native use
 * its own receipt.
 * </p>
 * <p>
 * THE CHARGE IS THE COMPILER'S CHOICE, not the caller's: the words a model should have to write are "till this 3x20", and a
 * model that had to pick a charge would pick wrong and get a silent downgrade. A caller who does write a charge is bounded
 * by the held tool and never raised to it.
 * </p>
 * <p>
 * IT REFUSES TO GUESS. No readable held tool and no written charge is `plan_packing_footprint_unknown:held_tool` rather than
 * a level-0 assumption, and a packing that would not save a single step is left as the loop, which resolves its rows live.
 * </p>
 */
function tryEmitPackedArea(
  loop: PlanForEachLoop,
  actions: readonly PublishedPlanAction[],
  state: PlanScriptState,
): boolean {
  const rules = forEachRules(loop);
  if (rules.length !== 1) return false;
  const effect = rules[0]!.do;
  // A chain is several actions over the SAME tile: the last one's footprint is not the one the first needs, so a chain is
  // never packed.
  if (effect === null || effect.length !== 1) return false;
  const step = effect[0]!;
  const action = actions.find((candidate) => candidate.actionId === step.action);
  if (action === undefined) return false;
  if (packingKindOf(action.arguments.map((argument) => argument.name)) !== "charged_rectangle") return false;
  const written = step.charge;
  if (written !== undefined && (typeof written !== "number" || !Number.isInteger(written) || written < 0)) return false;
  const requested = written ?? state.heldToolCeiling;
  // NO READABLE CEILING, NO PACKING. A written charge is not a substitute: the plan would then promise footprints the held
  // tool may not reach, and the Mod would refuse them one by one after the walk. The loop is still a correct program, so
  // it is left exactly as the caller wrote it.
  if (state.heldToolCeiling === undefined || requested === undefined) return false;
  if (written !== undefined && written > state.heldToolCeiling) return false;
  const packing = packAreaSteps({
    area: loop.source.area,
    kind: "charged_rectangle",
    maximumCharge: requested,
  });
  if (packing.status !== "packed") return false;
  const tiles = loop.source.area.w * loop.source.area.h;
  // A packing that saves no step is left as the loop: one node covering the rectangle live is strictly better than the same
  // number of pre-resolved ones, and emitting them would make the plan larger without making the walk shorter.
  if (packing.steps.length >= tiles) return false;
  if (state.nodes.length + packing.steps.length > MAX_PLAN_NODES) return false;
  let previousNodeId: string | undefined = state.nodes[state.nodes.length - 1]?.nodeId;
  for (const packed of packing.steps) {
    const nodeId = `n${String(state.nodes.length + 1).padStart(2, "0")}`;
    state.nodes.push(
      Object.freeze({
        nodeId,
        actionId: step.action,
        arguments: Object.freeze({
          x: Object.freeze({ type: "integer" as const, canonicalValue: String(packed.x) }),
          y: Object.freeze({ type: "integer" as const, canonicalValue: String(packed.y) }),
          charge: Object.freeze({ type: "integer" as const, canonicalValue: String(packed.charge) }),
        }),
        // A packed step consumes nothing a previous step produced: it names its own tile, so it never binds an earlier
        // node's output, and it is only ORDERED after the one before it.
        dependsOn: Object.freeze([]),
        ...(previousNodeId === undefined ? {} : { orderedAfter: Object.freeze([previousNodeId]) }),
        bindings: Object.freeze({}),
      }),
    );
    state.callOfNode.set(nodeId, state.builderCalls);
    previousNodeId = nodeId;
  }
  state.acceptedSteps.push(state.builderCalls);
  return true;
}

/**
 * Compiles one `builder.for_each({ source, where, do })` call into the single node the loop form is.
 *
 * ONE CALL, ONE NODE - UNLESS THE LOOP IS A PACKABLE AREA, in which case the packing pass above turns it into the native
 * uses that cover the rectangle exactly. That is the ONE exception, and it exists because the loop's own expansion is one
 * target per tile (`FarmhandForEachExpansion.cs:373`): a packed area left as a loop is walked tile by tile again, which
 * hands back every walk the packing saved.
 *
 * A loop this product could never run is refused BY NAME with the part of the declaration that broke it - a source the
 * caller did not write, a rectangle past the row bound with its own count, a stride that claims no index, an action the
 * surface does not publish - so one bad loop is one named refusal beside the loops that did read, and the author corrects
 * that call rather than rewriting the script.
 */
function emitForEachNode(value: unknown, actions: readonly PublishedPlanAction[], state: PlanScriptState): void {
  state.calls += 1;
  if (state.calls > MAX_PLAN_BUILDER_CALLS) refusePlan(`plan_script_call_cap:${String(state.calls)}`, state);
  if (state.nodes.length >= MAX_PLAN_NODES) refusePlan(`plan_cap_exceeded:${String(state.nodes.length + 1)}`, state);
  const reading = readForEachLoop(
    value,
    actions.map((action) => action.actionId),
  );
  if (!reading.ok)
    rejectPlanCall(
      reading.detail.length === 0 ? `plan_script_${reading.code}` : `plan_script_${reading.code}:${reading.detail}`,
      state,
    );
  const loop: PlanForEachLoop = reading.loop;
  // PACKING IS DECIDED BEFORE THE LOOP IS EMITTED, and it is decided here rather than in the Mod because the Host is the
  // layer that knows the surface's declarations and the snapshot's held tool. See tryEmitPackedArea.
  if (tryEmitPackedArea(loop, actions, state)) return;
  // The step's own arguments are checked HERE as well as per row: an argument only the caller can supply, left out of a
  // step, is a fact the compiler knows - and learning it from a spent pass costs the whole patch.
  refuseMissingStepArguments(loop, actions, state);
  const previous = state.nodes[state.nodes.length - 1];
  if (previous !== undefined && previous.actionId === FOR_EACH_PLAN_ACTION_ID) {
    const previousLoop = previous.arguments.loop as PlanForEachLoop | undefined;
    if (previousLoop !== undefined && sameForEachSource(previousLoop, loop)) {
      // ONE PASS PER SOURCE. Two `for_each` calls over the same rectangle are two RULES of one intent and not two intents:
      // separate passes would each report the tile the other one owns as `no_rule_matched`, and a tile both claim would
      // be worked twice. The first rule stays where the caller wrote it; every rule of the rest joins it in order.
      const merged: PlanForEachLoop = mergeForEachRules(previousLoop, loop, state);
      // The LENGTH is measured on the document that would result, not on the call that was just read: composing rules
      // grows the document, and a check that only saw the new rule would let the merge cross the wire's bound.
      RefuseOversizedDocument(merged, state);
      state.nodes[state.nodes.length - 1] = Object.freeze({
        ...previous,
        arguments: Object.freeze({ loop: Object.freeze({ type: "loop" as const, ...merged }) }),
      });
      // HER LOOP DID CHANGE THE PROGRAM, just not into a node of its own: a second rule over the same source is a rule
      // of that one pass. Named, because a fold she cannot see is the program quietly disagreeing with her script - and
      // the result still looks right, which makes it harder to notice than a drop.
      const into = state.callOfNode.get(previous.nodeId);
      state.merged.push(
        `${planStepName(state.builderCalls)}:into=${into === undefined ? previous.nodeId : planStepName(into)}:same_source`,
      );
      return;
    }
  }
  RefuseOversizedDocument(loop, state);
  state.nodes.push(
    Object.freeze({
      nodeId: `n${String(state.nodes.length + 1).padStart(2, "0")}`,
      actionId: FOR_EACH_PLAN_ACTION_ID,
      // The wire tag is added HERE and nowhere else: the caller writes a loop, the node carries a runtime value.
      arguments: Object.freeze({ loop: Object.freeze({ type: "loop" as const, ...loop }) }),
      // A loop names no tile of its own - its rows are resolved on the game thread - so it consumes no earlier step.
      dependsOn: Object.freeze([]),
      ...(previous === undefined ? {} : { orderedAfter: Object.freeze([previous.nodeId]) }),
      bindings: Object.freeze({}),
    }),
  );
  state.acceptedSteps.push(state.builderCalls);
  state.callOfNode.set(state.nodes[state.nodes.length - 1]!.nodeId, state.builderCalls);
}

/**
 * Two `for_each` calls over one source as ONE pass carrying every rule both of them wrote - or a refusal that says how
 * much of the second one could not be carried.
 *
 * <p>
 * MEASURED at `516e2559`: the merge appended exactly `forEachRules(loop)[0]`, so a loop whose own intent was TWO ordered
 * rules - a predicate and an ordered follow-up under `then` - compiled `ok: true` with the follow-up gone. She wrote it,
 * the compiler dropped it, and the answer said the plan was accepted.
 * </p>
 *
 * <p>
 * SO A MERGE IS ALLOWED ONLY WHEN EVERY RULE SURVIVES IT. `MAX_FOR_EACH_RULES` is the pass's own representable size and
 * the Mod's reader enforces it, so a union past it has rules with nowhere to go; trimming would hand the Mod a pass the
 * caller did not write. The refusal's counts are the INCOMING loop's: `<kept>:<dropped>` of the rules it wrote, so the
 * caller reads which of its rules the pass has no room for rather than a document length. The union is compared to the
 * ceiling itself - `refuseForEachMergeOverflow` is where the code is spelled - so the measurement and the refusal that
 * names it are the same statement.
 * </p>
 */
function mergeForEachRules(
  previous: PlanForEachLoop,
  incoming: PlanForEachLoop,
  state: PlanScriptState,
): PlanForEachLoop {
  const previousRules = forEachRules(previous);
  const incomingRules = forEachRules(incoming);
  if (previousRules.length + incomingRules.length > MAX_FOR_EACH_RULES)
    refuseForEachMergeOverflow(Math.max(MAX_FOR_EACH_RULES - previousRules.length, 0), incomingRules.length, state);
  const merged = incomingRules.reduce(withForEachRule, previous);
  // AND THE RESULT IS CHECKED AGAINST THE UNION rather than trusted to the fold: the rules the pass reports ARE the union,
  // in the order the caller wrote them, or this refuses instead of shipping a pass that disagrees with her script.
  const carried = forEachRules(merged);
  const kept = incomingRules.filter(
    (rule, index) => JSON.stringify(carried[previousRules.length + index]) === JSON.stringify(rule),
  ).length;
  if (kept !== incomingRules.length || carried.length !== previousRules.length + incomingRules.length)
    refuseForEachMergeOverflow(kept, incomingRules.length, state);
  return merged;
}

/**
 * Refuses a merge the pass has no room for, naming how many of THIS loop's rules survive it and how many have nowhere to
 * go - `plan_script_for_each_merge_would_drop_rules:<kept>:<dropped>`, the one spelling of that refusal.
 */
function refuseForEachMergeOverflow(kept: number, incoming: number, state: PlanScriptState): never {
  rejectPlanCall(`plan_script_for_each_merge_would_drop_rules:${String(kept)}:${String(incoming - kept)}`, state);
}

/**
 * Refuses a loop document the wire cannot carry, with its own length and the bound.
 *
 * The canonical string the loop becomes is bounded on both sides of the bridge (`MAX_FOR_EACH_LOOP_DOCUMENT_CHARS`), and a
 * document over it is answered by the TRANSPORT with a code that names nothing a caller can act on. So the producer says
 * it instead: one dropped call, with the number that broke it and the number to stay under.
 */
function RefuseOversizedDocument(loop: PlanForEachLoop, state: PlanScriptState): void {
  const length = forEachDocumentLength(loop);
  if (length <= MAX_FOR_EACH_LOOP_DOCUMENT_CHARS) return;
  rejectPlanCall(
    `plan_script_for_each_loop_document_too_long:${String(length)}_of_${String(MAX_FOR_EACH_LOOP_DOCUMENT_CHARS)}`,
    state,
  );
}

/** An integer plan argument: the whole-number wire value, canonicalized to its exact decimal spelling. */
type IntegerPlanArgument = Readonly<{ type: "integer"; canonicalValue: string }>;

/** The first in-map tile index on either axis. Stardew tile space starts at (0,0); a negative index is outside the map. */
const MAP_ORIGIN_TILE = 0;

/**
 * The tile a body can WALK to in order to reach a transition's source tile.
 *
 * <p>
 * Usually the source itself. An edge exit is the exception: the map declares its source one tile outside the grid
 * (`-1 53 BusStop` for the west edge, `79 -1 Mountain` for the north), and that coordinate is a boundary event, not a
 * tile anyone occupies - the actor leaves through the map's own edge. Writing it into the prepended walk produced
 * `move_to_tile({ x: -1 })`, which is a request no `move_to_tile` accepts (`isTileCoordinate`) and no path can reach.
 * The transition's own gate is Chebyshev-1, so the edge tile on that axis is the cell that reaches the exit, and it is
 * the coordinate the plan must carry.
 * </p>
 */
function approachTileFor(source: Readonly<{ canonicalValue: string }>): IntegerPlanArgument {
  const coordinate = Number(source.canonicalValue);
  return Object.freeze({
    type: "integer" as const,
    canonicalValue: String(Math.max(coordinate, MAP_ORIGIN_TILE)),
  });
}

/** The canonical argument the Mod's own declaration asks for, or `undefined` when the script's value is not one. */
function canonicalPlanArgument(
  declaration: Readonly<{ name: string; type: string; enum?: readonly string[] }>,
  value: unknown,
): PlanArgument | undefined {
  switch (declaration.type) {
    case "integer":
      // Integrality only. The RANGE is the action's own (a transition's x/y is a warp SOURCE tile, where `-1` is the
      // engine's edge exit, and every other x/y is an in-map tile), so a floor here would be the wrong floor for half
      // the surface and would refuse a request the Mod and this Host's own execution validator both accept.
      return Number.isSafeInteger(value)
        ? Object.freeze({ type: "integer" as const, canonicalValue: String(value) })
        : undefined;
    case "string": {
      if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
      if (declaration.enum !== undefined && !declaration.enum.includes(value)) return undefined;
      return Object.freeze({ type: "string" as const, canonicalValue: value });
    }
    case "boolean":
      return typeof value === "boolean"
        ? Object.freeze({ type: "boolean" as const, canonicalValue: String(value) })
        : undefined;
    case "destination_selector":
      return canonicalDestinationSelector(value);
    default:
      return undefined;
  }
}

function canonicalDestinationSelector(value: unknown): PlanArgument | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const selector = value as Readonly<{ kind?: unknown; label?: unknown; ref?: unknown }>;
  if (
    selector.kind === "label" &&
    typeof selector.label === "string" &&
    selector.label.length >= 1 &&
    selector.label.length <= 256
  )
    return Object.freeze({
      type: "destination_selector" as const,
      destination: Object.freeze({ kind: "label" as const, label: selector.label }),
    });
  if (selector.kind === "ref" && isOpaqueId(selector.ref))
    return Object.freeze({
      type: "destination_selector" as const,
      destination: Object.freeze({ kind: "ref" as const, ref: selector.ref }),
    });
  return undefined;
}

/**
 * A refusal raised by one builder call, and whether it ends the script or only that call.
 *
 * It unwinds the script's stack either way, because a call cannot produce a node once it is refused. What differs is who
 * catches it: `refusePlan` is re-thrown out of the call boundary and ends the script, while `rejectPlanCall` is answered
 * by `atPlanCall`, which records the call and lets the script carry on.
 */
class PlanScriptRefusal extends Error {
  readonly reasonCode: string;
  readonly requirement: PlanArgumentRequirement | undefined;
  readonly missingArguments: readonly string[] | undefined;
  readonly wholeScript: boolean;

  constructor(
    reasonCode: string,
    wholeScript: boolean,
    requirement?: PlanArgumentRequirement,
    missingArguments?: readonly string[],
  ) {
    super(reasonCode);
    this.name = "PlanScriptRefusal";
    this.reasonCode = reasonCode;
    this.requirement = requirement;
    this.missingArguments = missingArguments;
    this.wholeScript = wholeScript;
  }
}

/** Refuses the whole script: the calls after this one cannot fix what this one broke, so no plan is produced at all. */
function refusePlan(
  reasonCode: string,
  state: PlanScriptState,
  requirement?: PlanArgumentRequirement,
  missingArguments?: readonly string[],
): never {
  state.refusal = reasonCode;
  if (requirement !== undefined) state.requirement = requirement;
  if (missingArguments !== undefined) state.missingArguments = missingArguments;
  throw new PlanScriptRefusal(reasonCode, true, requirement, missingArguments);
}

/**
 * Refuses ONE builder call: recorded, named, and answered to the call boundary so the script carries on.
 *
 * The other calls still compile - a batch of thirty is not thirty chances for a typo to tell its author nothing - but the
 * PLAN is refused at the end, because a program that runs twenty-nine of her thirty steps is not the program she wrote.
 * The answer therefore carries both halves: `dropped` names the calls that will not run, and `acceptedSteps` names the ones
 * that compiled, so the correction is one edit and one resubmission.
 */
function rejectPlanCall(
  reasonCode: string,
  state: PlanScriptState,
  requirement?: PlanArgumentRequirement,
  missingArguments?: readonly string[],
): never {
  // The first rejection's shape is the one the refusal answer carries when NOTHING was accepted, so the teaching payload
  // is the same one a single refused call has always produced.
  if (state.rejected.length === 0 && state.rejectedCount === 0) {
    if (requirement !== undefined) state.requirement = requirement;
  }
  throw new PlanScriptRefusal(reasonCode, false, requirement, missingArguments);
}

/**
 * The one boundary every builder call passes through: a refusal that ends only its call is answered HERE, so the script's
 * own `try/catch` cannot shorten a plan silently and cannot see a refusal either - there is nothing for it to catch. Every
 * refusal is recorded, and the plan is refused whole once the script is done if there is even one.
 */
function atPlanCall<TResult>(state: PlanScriptState, actionId: string | null, run: () => TResult): TResult | undefined {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof PlanScriptRefusal) || error.wholeScript) throw error;
    // Every refusal is recorded and the list is narrowed once, where the plan is built. A capacity comparison here
    // would read as a business gate that refuses the script; this boundary only decides how many rejections the
    // answer can afford to spell out (see `MAX_REPORTED_PLAN_CALLS`).
    state.rejected.push(
      Object.freeze({
        call: state.builderCalls,
        actionId,
        reasonCode: error.reasonCode,
        ...(error.missingArguments === undefined ? {} : { missingArguments: error.missingArguments }),
      }),
    );
    state.rejectedCount += 1;
    return undefined;
  }
}

/** Word-bounded, so an argument value or target id that merely contains the token is not a false hit on it. */
function mentionsReference(source: string, reference: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${reference.replace(/[.$]/gu, "\\$&")}([^A-Za-z0-9_$]|$)`, "u").test(source);
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  );
}

function thrownName(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z]{1,32}$/u.test(name)) return name;
  }
  return "Error";
}

/**
 * What the engine said, in its own words. Its name is not an account of it: `SyntaxError` says a script does not
 * parse and nothing about where, which is the state a caller cannot leave in one turn.
 */
function thrownMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string" || message.length === 0) return thrownName(error);
  return message.slice(0, MAX_THROWN_MESSAGE_CHARS);
}

/**
 * The line the engine's stack names first, in the script's own numbering, or `null`.
 *
 * `lineOffset: -1` already dropped the wrapper's opening line, so a number past the script's own length is the
 * wrapper's closing line - an unclosed group is reported there - and naming it would send the caller to a line that
 * does not exist in its script.
 */
function thrownLine(error: unknown, scriptSource: string): number | null {
  const stack = (error as { stack?: unknown } | null | undefined)?.stack;
  if (typeof stack !== "string") return null;
  const named = /plan-script\.js:(\d+)/u.exec(stack);
  if (named === null) return null;
  const line = Number(named[1]);
  return Number.isSafeInteger(line) && line >= 1 && line <= scriptSource.split("\n").length ? line : null;
}

function isUsableSnapshot(snapshot: Snapshot): boolean {
  return (
    isNonNegativeSafeInteger(snapshot.revision) &&
    isTileCoordinate(snapshot.tile.x) &&
    isTileCoordinate(snapshot.tile.y) &&
    Array.isArray(snapshot.enabledActionIds)
  );
}

/** The script may read the world, never mutate the Host's own snapshot object. */
function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

/**
 * The arguments a loop row derives from the tile itself, so a step neither supplies nor withholds.
 *
 * One fact, one spelling: the Mod's dispatch seam keeps the same three (`x`, `y`, and the row's minted target id) and
 * refuses a step that names one of them (`row_argument_reserved:<name>`), so the compiler's check below cannot drift
 * from the rule the row answers with.
 */
export const ROW_DERIVED_STEP_ARGUMENTS: readonly string[] = Object.freeze([
  "x",
  "y",
  PLAN_FOR_EACH_ROW_IDENTITY_ARGUMENT,
]);

/**
 * The arguments a step may still leave out, and why it is not every argument.
 *
 * MEASURED, and it is a finding rather than a permission: every shipped loop example - the one in the description and the
 * intercropping one in `body-program-area-dispatch.test.ts` - writes `do: { action: "plant_seed", seed: "hops" }`,
 * which omits `slot` and `expectedQualifiedItemId` (and names an argument `plant_seed` does not declare at all). The Mod
 * refuses every one of those rows today, because `TryBuildRowArguments` demands each declared argument the row cannot
 * derive, so those examples are ALREADY broken per row. Moving them to plan time here would turn a repair of this unit
 * into a rewrite of that form's documentation, so they are named instead; a THIRD name is a capability decision, and the
 * test that reads this list asserts it holds exactly these two.
 */
export const STEP_ARGUMENTS_STILL_OMISSIBLE: readonly string[] = Object.freeze(["slot", "expectedQualifiedItemId"]);

/**
 * Refuses a loop whose step names an action and leaves out an argument the row could never supply.
 *
 * <p>
 * THE ROW CANNOT SUPPLY IT EITHER. A `for_each` row's arguments are the tile's own coordinates, the identity the family
 * mints from the live tile, and the step's scalars - nothing else. So a step that omits a declared argument is not a
 * step the Mod can complete: every row closes `row_argument_missing:<name>` and the pass does nothing. Discovering that
 * costs a whole pass, which is why the compiler says it here, in the call that wrote it, with the arguments the action
 * actually declares. `charge` on `till_soil` and `water_crop` is that shape: `0` is the one named tile.
 * </p>
 *
 * <p>
 * A `by_kind` step names no action of its own - the Mod's classifier decides per row - so there is nothing here to
 * compare it against, and its refusals stay the row's (`no_action_for_kind:<kind>`).
 * </p>
 */
function refuseMissingStepArguments(
  loop: PlanForEachLoop,
  actions: readonly PublishedPlanAction[],
  state: PlanScriptState,
): void {
  const declared = new Map(actions.map((action) => [action.actionId, action.arguments]));
  for (const rule of forEachRules(loop)) {
    if (rule.do === null) continue;
    for (const step of rule.do) {
      const arguments_ = declared.get(step.action);
      if (arguments_ === undefined) continue;
      const supplied = new Set(Object.keys(step));
      const declaredNames = arguments_.map((argument) => argument.name);
      const missing = declaredNames.filter(
        (name) =>
          !ROW_DERIVED_STEP_ARGUMENTS.includes(name) &&
          !STEP_ARGUMENTS_STILL_OMISSIBLE.includes(name) &&
          !supplied.has(name),
      );
      if (missing.length === 0) continue;
      rejectPlanCall(
        `plan_script_loop_do_argument_missing:${missing[0]!}:declared=[${declaredNames.join(",")}]`,
        state,
        undefined,
        Object.freeze(missing),
      );
    }
  }
}
