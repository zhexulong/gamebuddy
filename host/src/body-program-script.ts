import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { isExpressionOnlyAction } from "./action-registry.js";
import { planSecondSowRefusal } from "./body-program-planting.js";
import {
  footprintTiles,
  type PackingResult,
  packAreaSteps,
  packingKindOf,
  TOOL_FOOTPRINT_TILES_BY_CHARGE,
  toolChargeCeilingForClaim,
} from "./body-program-packing.js";
import {
  type ActionRegistration,
  type BodyProgramCandidateRequest,
  executionRequestIntegerBounds,
  readDestinationSelector,
  type Snapshot,
} from "./protocol.js";
import type { StardewTileRead } from "./game-connection.js";
import { isNonNegativeSafeInteger, isRecord, isTileCoordinate } from "./protocol-target-facts.js";

/**
 * Host-side plan script compiler (CARD-BODY-PROGRAM-SYNTHESIZER-BOUNDARY, as amended by the owner).
 *
 * The companion writes a short synchronous SCRIPT that names the work: a loop over the snapshot's own
 * targets, one `builder.<actionId>({...})` call per step. This module runs it exactly once, in a
 * throwaway context, and turns the nodes it produced into ONE standard Body Program that the caller
 * submits through the same path a hand-written program takes. Nothing here executes game physics,
 * chooses a route, or invents a target: every action id and every argument name comes from the
 * published surface, every INTENTION comes from the script's own words, and every READING - an index
 * or an opaque id that can only be copied out of a snapshot - is read here, at submit, from the rows
 * the caller's intentions select (see `PLAN_SNAPSHOT_READINGS`).
 *
 * Deliberately absent from the script's world: Node globals, the network, the clock, randomness,
 * timers, and any way to compile more code. A script that reaches for one is refused BY NAME before
 * it runs (`plan_script_uses_forbidden:<name>`), and the context does not carry it either.
 */

/**
 * One argument as the Mod declared it: the name a script must use, the kind it must supply, and any closed set.
 *
 * `required` is the MOD's declaration, not this file's rule (`FarmhandActionArgument.ResolvedAtExecution`). `true` -
 * every argument of every action until the planting pair declared otherwise - means the caller must supply it, and this
 * compiler refuses an omission of one. `false` means the BODY answers for it at execution: the value is a pure function
 * of arguments the request already carries (`plant_seed`'s `slot` and `expectedTargetId`, both re-derived on the game
 * thread from the item the request names), so a plan may leave it out exactly where it cannot observe it. The compiler
 * never invents a value for such an argument: it omits it and names the node the value waits for (`resolvedAfter`).
 *
 * Measured in `.tmp/fork-why-slow.jsonl`: seven of the fourteen voided batches omitted `expectedQualifiedItemId` or
 * `slot` while supplying the action's other arguments, which is what a flat name list reads like when nothing says the
 * list is closed. The field states the rule the loop below enforces, and `body-program-script.test.ts` ties the two
 * together over every published action.
 */
type PlanArgumentShape = Readonly<{
  name: string;
  type: string;
  required: boolean;
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
 *
 * <p>
 * WHAT IS NOT HERE IS DELIBERATE: the registration's `lifecycle` is OUR release maturity, not a fact a caller can act on.
 * It used to ride along in every shape answer (`stardew_plan_shape` printed `published`, `live_verified` or `experimental`
 * per action), which is a word that answers nothing the companion can do: whether an action is plannable is decided by the
 * vocabulary she is handed and by the Mod's admission, not by a label she has to interpret. The label still lives where it
 * is used - the registry, the gates, the dashboards - and `agent_visible_field_is_our_bookkeeping:<field>`
 * (`body-program-script.test.ts`) keeps any other field of ours from reaching her the same way.
 * </p>
 */
export type PublishedPlanAction = Readonly<{
  actionId: string;
  familyId: string;
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
 * The arguments whose value is a READING OF THE SUBMIT-MOMENT SNAPSHOT, and the row field each one reads.
 *
 * <p>
 * A plan argument is one of two things. An INTENTION is what the author means - the tile, the item, which seed, how
 * many - and nothing on this side may choose it. A READING is a value that can only be COPIED out of a snapshot: an
 * opaque id the Mod minted for a row, or an index into the pack. These two are readings, and the measurement is
 * `round84` (2026-11-20, one live run): 54 `plant_seed` nodes carrying 44 hand-written `expectedTargetId` values, in
 * which the tile `(59,18)` and the tile `(59,12)` were each submitted TWICE with a different id - one tile cannot carry
 * two - and 22 of the plants answered `seed_target_unavailable`. Her own call was `{ x: 79, y: 18, slot: 11,
 * expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_51f5e088b8c867e7" }`: two intentions and two copies, and
 * both copies were knowable from the snapshot the plan was submitted against.
 * </p>
 * <p>
 * `slot` is a reading and not merely a number she likes. It indexes `Game1.player.Items`, it moves between the compile
 * and the execution, and the Mod already re-resolves it from the item the request names
 * (`ExecutionManager.ResolveLiveSlot`, and the Mod's own `StaleIndexIsNotAMissingItemGateTests`, which prints a slot the
 * caller SAW as `migrated` and a slot the caller MEANS as an address). Binding it at submit is therefore never less
 * trustworthy than her copy.
 * </p>
 * <p>
 * NOT readings, and deliberately left to her: `expectedQualifiedItemId` - the item she MEANS, which is why the Mod's gate
 * calls the item "the fact that survives the re-packing" while it re-resolves the slot - `expectedSkill`/`expectedLevel`
 * (which of the pending level-ups she is answering), and every tile, quantity and closed-set choice.
 * </p>
 */
export const PLAN_SNAPSHOT_READINGS: ReadonlyMap<string, string> = Object.freeze(
  new Map([
    ["expectedTargetId", "targetId"],
    ["slot", "slot"],
  ]),
);

/**
 * The one argument and row field that name ONE ROW from outside: the opaque id the surface minted for it, and the row
 * field it appears as.
 *
 * <p>
 * ONE FACT, ONE SPELLING. `slot` is a reading too, but a pack index names no row; this pair does, and `planNamedTargetRow`
 * is the row-finding that accepts it. The pair is exported because a second reader asks the same question about
 * DECLARATIONS rather than values: `body-program-snapshot-readings.test.ts` crosses it with the arguments each action declares and the
 * fields each family's rows publish, which is how an action that addresses a guarded family by nothing the row-finding
 * accepts is named instead of silently skipped - `round87b`'s `shop_purchase`, whose only address was this id and whose
 * row was never found because the selection that skips readings found nothing to select.
 * </p>
 */
export const PLAN_ROW_IDENTITY = Object.freeze({ argument: "expectedTargetId", field: "targetId" } as const);

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
 * How many bindings one answer spells out, bounded for the same reason the insertion list is: a loop over a patch binds
 * one reading per node, so a forty-tile plan would repeat one sentence forty times. `boundFromSnapshotCount` is the
 * population, so a bounded list never reads as "that was the whole of it".
 */
export const MAX_REPORTED_PLAN_READINGS = 16;

/**
 * What became of every call the author wrote, by the one numbering a REFUSED plan still has: the position of her call.
 *
 * `n01` is her FIRST CALL - not node `n01`, which a plan that was refused does not have, and which the compiler's own
 * insertions displace for every call after them. Every list is bounded (see `MAX_REPORTED_PLAN_CALLS`) and every count is
 * not, so a bounded list never reads as "that was the whole of it".
 *
 * THE THREE LISTS PARTITION THE CALLS THE SCRIPT REACHED: each call lands in exactly one of `acceptedSteps`,
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
  /** Her calls that had nothing to do: `n04:equip_for:already_held`, the tool the action needs was already in hand. */
  noStepNeeded: readonly string[];
  noStepNeededCount: number;
  /** Her calls that were refused: `n03:plan_script_...`, so that step of hers is not going to run. */
  dropped: readonly string[];
  droppedCount: number;
}>;

/**
 * What one plan script compiled to, in three states that are three different answers.
 *
 * `compiled` - every call the author wrote became a step, and the program is the plan she wrote.
 *
 * `partial` - SOME calls became steps and some were refused. THE COMPILED STEPS RUN: the program is a real program and
 * it has an identity, so the answer carries it. What makes the answer honest is that it says so - `status` is not
 * `compiled`, and `dropped` names every refused call by the position she wrote it. It was not always so: one refused call
 * used to void the batch, so a single typo in a sixteen-step plan cost her the fifteen steps that were correct, and the
 * measured price of that is a companion who stops batching - every extra call she writes is another chance to lose the
 * whole turn, so she writes one call at a turn and pays a model round-trip for each. The forgery the old rule was built
 * for (`ok: true` beside a dropped call) is answered by `status` instead: an answer that ran part of the work says
 * `partial`, and nothing in this type can be read as a success while it is.
 *
 * `refused` - not one call produced a step, or the script itself could not be run (a throw, a timeout, an empty script, a
 * snapshot that cannot be read, a program that breaks the Mod's claim rule). There is no program, so there is no program
 * id and nothing runs.
 *
 * THE FIELD IS THE ONLY SPELLING OF THE DISTINCTION. There is no `ok` beside it: a boolean that is false for two states
 * which differ in the one way a consumer must not confuse (does a program run?) is what let a refusal answer stand for a
 * partial one. A consumer switches on `status`, and `program` is present exactly when something runs.
 */
export type CompiledPlan =
  | Readonly<
      {
        status: "compiled";
      } & RunnablePlan
    >
  | Readonly<
      {
        status: "partial";
        /** The FIRST refused call's own code, unchanged: the one to fix first. Every other refusal travels in `rejected`. */
        reasonCode: string;
        /** Present when that first refusal was a builder call, so the answer names what the action demands. */
        requirement?: PlanArgumentRequirement;
        /**
         * The refused calls, in the order the script wrote them: the call's position, the action it named, and why.
         *
         * `dropped` beside it is this list rendered as the names the author reads; this one carries the per-call detail
         * (the action, and every argument the call omitted) that a correction is written from.
         */
        rejected: readonly PlanCallRejection[];
        /** Every refusal, including the ones past `MAX_REPORTED_PLAN_CALLS`. */
        rejectedCount: number;
      } & RunnablePlan
    >
  | Readonly<
      {
        status: "refused";
        scriptSource: string;
        snapshotRevision: number | null;
        reasonCode: string;
        /** Present when the refusal was a builder call, so the answer names what that action demands. */
        requirement?: PlanArgumentRequirement;
        /** Every argument the refused call left out, so a correction fixes all of them and not only the first. */
        missingArguments?: readonly string[];
        rejected: readonly PlanCallRejection[];
        rejectedCount: number;
        /** Present when the script threw, so the answer says what the engine said and where. */
        threw?: PlanScriptThrow;
      } & PlanCallAccount
    >;

/**
 * Everything a plan that RUNS carries, in both states that run.
 *
 * One shape for `compiled` and `partial` because the difference between them is the calls that did not compile, which the
 * partial answer states in `dropped` - never in what the program is made of. A consumer that only needs to run the plan
 * reads this and nothing else, which is what keeps "some calls were refused" from being re-decided at every call site.
 */
type RunnablePlan = Readonly<{
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
   * The transitions this compiler could NOT write its walk for, one per transition, spelled
   * `auto_walk_refused:<reasonCode>:<x>:<y>` - the transition's own source tile beside the reason.
   *
   * <p>
   * The third answer beside a written node and a step that had nothing to do, and the one that did not exist when it was
   * measured. `round89`'s `plan_12` (2026-11-21T20-38-52-354Z) sent `enter_exit(40,-1)` from the Farm; the walk was
   * written to the clamped `(40,0)` and the map answered `target_not_addressable;target_on_map=true` with four walls
   * around it. A clamped index is not a cell, and this compiler holds no map geometry to ask which neighbouring cell
   * admits a body - so it writes NO step instead of an invented one, and says why here. Her transition then runs alone and
   * any refusal of it is the world's answer to HER coordinate, which is the only node whose failure is hers to read.
   * </p>
   * <p>
   * Reported beside the program and never inside it: no node exists for it, so nothing of the compiler's is left in the
   * program to be refused or abandoned by the world. Bounded like `inserted`; `autoWalkRefusedCount` is the population.
   * </p>
   */
  autoWalkRefused: readonly string[];
  /** Every walk refusal, including the ones past `MAX_REPORTED_PLAN_INSERTIONS`. */
  autoWalkRefusedCount: number;
  /**
   * The arguments this compiler READ OUT OF THE SUBMIT-MOMENT SNAPSHOT rather than asking the author for, one per
   * binding, spelled `bound=<actionId>.<argument>;from=snapshot.<family>[].<field>`.
   *
   * Present for the same reason `inserted` is: the program that runs is not the script she wrote, and a value she
   * copied by hand was REPLACED here. She learns from this list which arguments are the harness's, so the next plan
   * omits them instead of spending context on a copy that will be overruled. Bounded;
   * `boundFromSnapshotCount` is the population.
   */
  boundFromSnapshot: readonly string[];
  /** Every binding, including the ones past `MAX_REPORTED_PLAN_READINGS`. */
  boundFromSnapshotCount: number;
  /**
   * The arguments this compiler could NOT read out of the snapshot, one per reading, spelled
   * `unmeasured=<actionId>.<argument>;family_not_published=<family>` - the argument, and the family the SURFACE declares
   * for the action that the snapshot does not carry.
   *
   * Present for the same reason `boundFromSnapshot` is, from the other side. A family the snapshot does not publish at
   * all cannot answer: her own number stays in the program, and that number is the one argument this side never checked -
   * so the answer names it instead of leaving her to believe the harness verified it. Bounded;
   * `readingsUnmeasuredCount` is the population.
   */
  readingsUnmeasured: readonly string[];
  /** Every unmeasured reading, including the ones past `MAX_REPORTED_PLAN_READINGS`. */
  readingsUnmeasuredCount: number;
  /**
   * The readings this compiler OMITTED because a node earlier in the same program creates their target, one per reading,
   * spelled `resolved_after=<actionId>.<argument>;producer=<nodeId>`.
   *
   * The whole point of the chained batch: `till_soil(79,18)` then `plant_seed(79,18)` composes, the plant node carries
   * no target id at all, and the Mod computes it on the game thread from the item the request names. Named here so a
   * reader can tell "the body was left to answer this" from "nobody wrote it". Bounded; `resolvedAfterCount` is the
   * population.
   */
  resolvedAfter: readonly string[];
  /** Every resolved-after reading, including the ones past `MAX_REPORTED_PLAN_READINGS`. */
  resolvedAfterCount: number;
  /**
   * The readings this compiler OMITTED because THIS SESSION READ the tile and the Mod mints the value when it acts, one
   * per reading, spelled `<nodeId>:resolved_from_observation=<actionId>.<argument>;family=<family>;tile=<x>,<y>;kind=<occupantKind>`.
   *
   * The third way a reading can be answered, and the one that is NOT the same claim as `resolvedAfter`: a producer says
   * the target does not exist YET and a node of this plan will make it, while this says the target EXISTS, the session
   * read it at a coordinate the submit-moment snapshot cannot reach, and the body will mint its id. The coordinate and
   * the occupant kind travel in the line because they are the whole of the evidence - a reader must be able to tell
   * "she read it" from "it is assumed". Keyed by the node id the program actually carries, since the wire's node refuses
   * unknown keys (`isBodyProgramNode`). Bounded; `resolvedFromObservationCount` is the population.
   */
  resolvedFromObservation: readonly string[];
  /** Every reading proved by a rectangle read, including the ones past `MAX_REPORTED_PLAN_READINGS`. */
  resolvedFromObservationCount: number;
  /**
   * The seed counts this plan needed and the snapshot did not publish, one per seed it plants, spelled
   * `unmeasured=plant_seed.<item>;family_not_published=inventoryItemFacts`.
   *
   * Present for the same reason `readingsUnmeasured` is, from the plan's own side: with the pack unpublished there is no
   * count to compare the planting steps against, so this compiler bounds nothing - and says so, because a plan that plants
   * seventeen of a seed it holds fifteen of is the plan this list is the only warning for. Bounded;
   * `heldSeedsUnmeasuredCount` is the population.
   */
  heldSeedsUnmeasured: readonly string[];
  /** Every seed count this plan could not read, including the ones past `MAX_REPORTED_PLAN_READINGS`. */
  heldSeedsUnmeasuredCount: number;
  /**
   * The can water this plan needed and the snapshot did not publish, one per watering action it writes, spelled
   * `unmeasured=water_crop.watering_can;family_not_published=wateringCanFacts`.
   *
   * The other half of the bound `planWaterBudget` applies, and the same doctrine as `heldSeedsUnmeasured`: with a can
   * published, a plan that waters more than it holds is refused by name; with the can NOT published there is no number to
   * compare against, so nothing is refused - and this list is what keeps that from reading as a plan the harness checked.
   * Bounded; `heldWaterUnmeasuredCount` is the population.
   */
  heldWaterUnmeasured: readonly string[];
  /** Every can reading this plan could not find, including the ones past `MAX_REPORTED_PLAN_READINGS`. */
  heldWaterUnmeasuredCount: number;
  /**
   * Layout facts this plan's own nodes depend on that the snapshot it was compiled against does not carry, one per
   * `layout_facts_absent:call <n>:<fact>`. Bounded; `layoutFactsAbsentCount` is the population, and a list that had
   * to be cut ends in one `layout_facts_absent_over_ceiling:<count>:<ceiling>` row naming the ceiling and the
   * population it truncated.
   */
  layoutFactsAbsent: readonly string[];
  layoutFactsAbsentCount: number;
}> &
  PlanCallAccount;

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
 * Every node action id this compiler can produce that is a HOST plan FORM rather than a published Mod action.
 *
 * IT IS EMPTY, AND THAT IS THE DECLARATION. A batch is a `for` loop over a snapshot family, so every node the script
 * compiles to is one of the Mod's published actions - there is no second vocabulary in this compiler at all. The list
 * stays because it is the authority two gates read rather than a table to fill: `two_ways_to_write_a_loop` derives the
 * loop shapes taught and accepted from it, and `a_script_form_is_reachable_from_the_description` refuses a form the
 * description does not teach. Adding an id here without teaching it is red by name, which is the gate whose absence let
 * `for_each` live while nobody used it.
 */
export const PLAN_FORM_ACTION_IDS: readonly string[] = Object.freeze([]);

/** The published action whose one job is putting a tool in hand; the `equipFor` helper writes it. */
const EQUIP_TOOL_ACTION_ID = "equip_tool";

/** The published action whose one job is putting the body on (or beside) a tile; a transition's approach step uses it. */
const MOVE_TO_TILE_ACTION_ID = "move_to_tile";

/**
 * The surface's own claim word for the watering can - the ONE declaration that says an action swings that can.
 *
 * The population `planWaterBudget` counts is derived from it rather than listed here: every action whose `tool:` claim
 * names the can spends its water, so `water_crop`, `water_pet_bowl` and `water_slime_hutch_trough` are all bounded by the
 * same reading and a fourth one joins in the change that declares it. `refill_watering_can` names the same can and is the
 * one exception - it is the action that FILLS it.
 */
const WATERING_CAN_CLAIM_CATEGORY = "watering_can";

/** The published action whose one job is filling the can: it spends no water and tops the can up to its maximum. */
const REFILL_WATERING_CAN_ACTION_ID = "refill_watering_can";

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
 *
 * TWO READERS, ONE FACT - these are the two actions that MOVE THE ACTOR TO ANOTHER MAP. The walk above is the first
 * reading; the second is what a refused one costs the rest of a script (`emitPlanNode`): every later call of the same
 * script was written against the map the transition leads to, and one compile holds one snapshot of one map.
 *
 * Exported so the gates read THIS declaration instead of a second hand-written copy: `check-plan-legal-fixpoint.mjs`
 * measures what one refused call costs, and a transition's refusal is the one that costs the steps after it.
 */
export const TRANSITION_SOURCE_PLAN_ACTION_IDS: readonly string[] = Object.freeze(["enter_exit", "travel"]);

/**
 * The one transition whose source tile must be a way out of the map she is standing on, and whose tables are checked.
 *
 * IT IS A NAME AND NOT A FAMILY, which is the whole reason the check below did not exist: `enter_exit` declares
 * `targetFamily: "warps"`, and the family pass (`bindSnapshotReadings`) only reads arguments the surface marks as
 * READINGS - while a transition's `x`/`y` is her own intention, the tile she believes the door is at. So the declared
 * family was never applied to the coordinate, and `protocol.ts` accepts any tile `>= -1` on both axes: a door tile of
 * another map compiled, and the body walked to it before the Mod answered `door_not_available` (`round91`).
 */
const ENTER_EXIT_ACTION_ID = "enter_exit";

/**
 * The snapshot families whose rows are ways OUT of the map the actor stands on, in the order the Mod resolves them, each
 * beside the word a refusal calls it by.
 *
 * <p>
 * BOTH TABLES, BECAUSE NEITHER IS A SUPERSET OF THE OTHER. `enter_exit` resolves a transition source through the door
 * table first and the warp table as its fallback (`ExecutionManager.RequestLocalDoorTransition`, pinned by
 * `TransitionTileIsResolvableSourceShapeTests`), and `DiscoverDoorTargets` publishes both of them: `warps` is the map's
 * own `Warp` property, and `doorTargets` adds every Buildings-layer door the engine's `updateDoors` built beside each
 * building's human door - a farmhouse door is in `doorTargets` and in no warp list. A check against `warps` alone
 * would therefore refuse a door the Mod enters, which is the `round19`/`round42` defect from the other side.
 * </p>
 */
const PLAN_EXIT_FAMILY_IDS: readonly Readonly<{ family: string; label: string }>[] = Object.freeze([
  Object.freeze({ family: "warps", label: "warps" }),
  Object.freeze({ family: "doorTargets", label: "doors" }),
]);

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

/**
 * The Mod's `world_lifecycle` handler group, projected: the actions that move the DAY rather than the ground in front of
 * her.
 *
 * <p>
 * THE SAME SHAPE AS `MODAL_CLEARING_PLAN_ACTION_IDS`, for the same reason and from the same owner. The Mod declares the
 * group once (`FarmhandActionHandlerGroup.WorldLifecycle`) and the wire does not publish it - `ActionRegistrationDescriptor`
 * carries arguments, output facts, resource claims, approach, target family and (now) the scene binding, and no group - so a
 * Host that needs the classification has to restate it and be held to it by a gate. `action-handler-groups.v1.json` is the
 * Mod's own generated publication of that rule for every registered action, and
 * `lookahead-eligibility.test.ts` holds this list equal to it BY NAME in both directions.
 * </p>
 *
 * <p>
 * NOT `WORLD_RESETTING_PLAN_ACTION_IDS`, which is one member of this group and answers a different question: that list is
 * about a plan whose later nodes are compiled against a world the earlier one destroyed (`sleep` walks to a bed and rebuilds
 * the farm). These four are about a DECISION made from a snapshot: a quest accepted, a reward claimed, a prize redeemed is
 * a decision taken about a menu that was open when the snapshot was read. Two questions, two lists, and neither is derived
 * from the other - a fact with two spellings would drift in one of them.
 * </p>
 */
export const WORLD_LIFECYCLE_PLAN_ACTION_IDS: readonly string[] = Object.freeze([
  "sleep",
  "accept_daily_quest",
  "accept_special_order",
  "claim_museum_reward",
  "redeem_prize_ticket",
]);

/**
 * Why an action may NOT be composed into a plan while another programme still has nodes to run, or `undefined` when it may.
 *
 * <p>
 * WHAT A LOOKAHEAD IS. The pump opens a turn when the plan in flight is down to its last nodes (`PLAN_LOW_WATER_NODES`), so
 * the next programme is composed from a snapshot that was read while that programme was still working - the Mod queues it
 * rather than starting it (`FarmhandBodyProgramController.ProgramWithNodeInFlight`), so its nodes run at least one node
 * later than the picture they were written from.
 * </p>
 * <p>
 * WHICH ACTIONS SURVIVE THAT GAP IS DERIVED, from two statements the Mod already makes and one it does not:
 * </p>
 * <ol>
 *   <li>`handlerGroup` - `world_lifecycle` and `modal`: the action's whole subject is a day or a menu that the gap can
 *       close. Projected above because the wire never publishes the group.</li>
 *   <li>`descriptor.sceneTarget` - the action declares that it READS a scene, so it is bound to the scene it read.</li>
 * </ol>
 * <p>
 * THE RESIDUAL IS NAMED RATHER THAN HIDDEN, because the failure direction matters: an action wrongly excluded is planned
 * one turn later, and an action wrongly included is planned THROUGH a day. `move_to_tile` stays eligible (a walk inside the
 * map is composable from a slightly old picture), and so does `shop_purchase` - a shop does not change the scene, only the
 * bag - but `travel` and `enter_exit` are in `movement` and declare no `sceneTarget`, so a CROSS-MAP leg is the one member
 * of your four that this rule cannot name. `lookahead-eligibility.test.ts` prints that residual beside its verdict.
 * </p>
 */
export function lookaheadIneligibility(
  registration: Readonly<{ actionId: string; descriptor?: ActionRegistration["descriptor"] }>,
): "world_lifecycle" | "modal" | "scene_target" | undefined {
  if (WORLD_LIFECYCLE_PLAN_ACTION_IDS.includes(registration.actionId)) return "world_lifecycle";
  if (MODAL_CLEARING_PLAN_ACTION_IDS.includes(registration.actionId)) return "modal";
  if (registration.descriptor?.sceneTarget !== undefined) return "scene_target";
  return undefined;
}

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

/**
 * The closed SHAPES a plan argument can be, spelled out where the caller reads them.
 *
 * A type NAME is not a shape. `stardew_plan_shape` answered `navigate_to_destination` with
 * `{"name":"destination","type":"destination_selector","required":true}` and no description at all, while every refusal
 * spelled `destination_selector[one_of:label,ref]` - four words that never say `kind`. Measured `round75`: she answered it
 * three ways (a run handle, a bare label, the object `find_destination` had just handed her in `candidates[].destination`)
 * and read back `got:string(dr1_...)`, `got:string()` and `got:object`. None of the three says which keys go together.
 *
 * The keys are the Host protocol's, read once by `readDestinationSelector`; the worked values printed here are checked
 * against that one reader by `body-program-argument-answer.test.ts`, because a description that drifted from the reader
 * would teach a shape the door refuses - worse than the bare name it replaces.
 */
type PlanClosedArgumentShape = Readonly<{
  /** The keys each arm carries, in the order a refusal names them. */
  arms: readonly (readonly string[])[];
  /** What the shape answer says: every arm as a caller writes it, and where a real one comes from. */
  description: string;
}>;

const PLAN_CLOSED_ARGUMENT_SHAPES: Readonly<Record<string, PlanClosedArgumentShape>> = Object.freeze({
  destination_selector: Object.freeze({
    arms: Object.freeze([Object.freeze(["kind", "label"]), Object.freeze(["kind", "ref"])]),
    description:
      'One place, named one way: {"kind":"label","label":"Mine"} or ' +
      `{"kind":"ref","ref":"dr1_AAAAAAAAAAAAAAAAAAAAAA"}. ${DESTINATION_DISCOVERY_ACTION_ID} answers both in ` +
      "candidates[].destination, and the object it returns is accepted here as it comes.",
  }),
});

/** How many keys of an object argument a refusal quotes back, so a wide record cannot spend the answer on its own shape. */
const PLAN_RECEIVED_MAX_KEYS = 6;

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

/** How much of a value the script passed is quoted back in a refusal, in code points so a bound cannot split a character. */
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
 *
 * <p>
 * MINUS THE EXPRESSION DECLARATION (`action-registry.ts` `EXPRESSION_ONLY_ACTION_IDS`). Expression is one step by nature,
 * so a plan step is the wrong home for it: the gesture would queue behind the work steps in front of it and be reported
 * settled by the plan's own settlement rather than by itself. Those actions reach the actor through their own mounted
 * tool instead, which `runtime-core.internal.ts` keeps for exactly this declaration - one declaration, one route per
 * action. Measured `round47` (2026-11-12, 64 assistant turns, 188 planned nodes): every emote the run did not make was a
 * plan step it never wrote.
 * </p>
 */
export function planActionsFromRegistrations(
  registrations: readonly ActionRegistration[],
): readonly PublishedPlanAction[] {
  const actions: PublishedPlanAction[] = [];
  for (const registration of registrations) {
    if (!PLAN_ACTION_LIFECYCLES.includes(registration.lifecycle) || registration.kind !== "execution") continue;
    if (isExpressionOnlyAction(registration.actionId)) continue;
    const declared = declaredArgumentsOf(registration);
    if (declared === undefined || !declared.every((argument) => PLAN_ARGUMENT_TYPES.includes(argument.type))) continue;
    actions.push(
      Object.freeze({
        actionId: registration.actionId,
        familyId: registration.familyId,
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
        required: argument.resolvedAtExecution !== true,
        ...(argument.enum === undefined ? {} : { enum: Object.freeze([...argument.enum]) }),
        ...planArgumentDescription(argument),
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
        required: declared.resolvedAtExecution !== true,
        ...(declared.enum === undefined ? {} : { enum: Object.freeze([...declared.enum]) }),
        ...planArgumentDescription(declared),
      }),
    ),
  );
}

/**
 * What a shape answer says about one argument: the Mod's own words, and - for a closed shape - the arms themselves.
 *
 * The Mod's description is carried through because it is what the argument MEANS; the closed shape is added because no
 * description of a selector can be copied and called with, and the arms are the part that is read as a shape rather than
 * as prose. An argument the surface describes and this compiler does not shape keeps the Mod's words alone.
 */
function planArgumentDescription(
  declared: Readonly<{ type: string; description?: string }>,
): Readonly<{ description?: string }> {
  const closed = PLAN_CLOSED_ARGUMENT_SHAPES[declared.type]?.description;
  if (closed === undefined) return declared.description === undefined ? {} : { description: declared.description };
  return { description: declared.description === undefined ? closed : `${closed} ${declared.description}` };
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
 * What an ACCEPTED plan answer says, in the register the harness's own tool receipts use: one line, what happened,
 * to what, and how much.
 *
 * WHAT WENT: this used to be a paragraph - "the settlement arrives as its own message - a fact - once the last node
 * reaches a terminal state, the same answer comes back until then, and `stardew_action_program_status` `waitMs` only
 * holds a turn until that moment". The measurement behind it (`round43`: 29 of 96 turns were status calls) named a real
 * cost, but the sentence answered a question nobody asked: it described the DELIVERY of a message, told her the same
 * answer comes back, and gave a bound's purpose beside a tool she had not called. `edit` answers `Applied 1 edit to
 * src/foo.ts` - the outcome, its target and its size - and a model reads that without deciding anything.
 *
 * WHAT MAY NEVER COME BACK: any sentence about a future message, about a turn, about waiting, or about asking again.
 * `game-surface-receipt.test.ts` reads this line for those words and fails naming the sentence.
 */
export function planSettlementNote(nodeCount: number, programId: string): string {
  return `Accepted ${String(nodeCount)} ${nodeCount === 1 ? "node" : "nodes"} as ${programId}.`;
}

/**
 * The `charge` argument a plan EXAMPLE prints, name and value, read from the wire declaration rather than written beside
 * it.
 *
 * <p>
 * `till_soil` and `water_crop` pin it on the wire (`EXECUTION_REQUEST_ARGUMENT_RULES`: their exact argument set carries
 * `charge`), so an example that leaves it out is a call the compiler refuses as `loop_do_argument_missing:charge` and the
 * wire refuses as `invalid_args` - and the batch example had already drifted that way, printing a `water_crop` call a
 * caller could not copy. Reading the value from the declaration means the example moves with the range.
 * </p>
 *
 * <p>
 * IT RETURNS THE WHOLE PAIR BECAUSE ONE CALLER ALREADY WROTE THE NAME. The `till_soil` loop prefixed its own `charge: `
 * beside this one and printed `charge: charge: 0` - a `SyntaxError`, not a refusal: every companion that copied the
 * example got `plan_script_threw:SyntaxError` and had to invent its own loop, which is how a plan ends up iterating rows a
 * guard would have left out. The name is spelled here once and no call site repeats it; `the recipe's examples are a script
 * the compiler accepts` in `body-program-script.test.ts` compiles the rendered tail and would name the broken call.
 * </p>
 */
function planExampleCharge(action: "till_soil" | "water_crop"): string {
  const bound = executionRequestIntegerBounds(action).find((candidate) => candidate.argument === "charge");
  if (bound === undefined) throw new Error(`execution_request_integer_bound_missing:${action}:charge`);
  return `charge: ${String(bound.minimum)}`;
}

/**
 * The most characters the Game surface's own FIXED PROSE may occupy: the `stardew_plan_work` description plus the conduct
 * block the floor composes, counted TOGETHER.
 *
 * A PAIR, not a per-document ceiling, because a per-document ceiling is exactly what moving prose exploits: a sentence can
 * leave one document and land in the other, and a ceiling on the document it left would call that growth while a ceiling on
 * the document it reached would read a move as new prose. The pair may only fall. A sentence may move between the two
 * owners - the per-document numbers then move in opposite directions - and that is the only case in which either may rise,
 * because the pair proves it was a move rather than a sentence nobody paid for.
 *
 * MEASURED 2026-11-19, THE UNIT THAT MADE THIS A PAIR: `SLEEPING_IS_AN_ACTION` moved out of the conduct block into
 * `sleep()`'s description, +82 here and -198 there, so the pair fell 10,747 -> 10,631 while one of its two sides grew.
 *
 * RE-RECORDED 2026-11-24, AND THE RE-RECORD IS WHAT KEPT THE GATE ABLE TO FAIL: the conduct block became an input header,
 * 3,397 -> 283, so every expression of growth the pair refuses - a hundred characters nobody removed, the moved sentence
 * still in its old home - became unreachable against a 10,631 ceiling, and the falsifier in
 * `body-program-script.test.ts` passed on a budget that no longer measured anything. The description is unchanged
 * (7,234 both readings), so the ceiling follows the floor: 7,234 + 283 = 7,517, and it may only fall from here.
 *
 * THE TWO SIDES ARE READ FROM THEIR OWN OWNERS. The description is read live (`planWorkDescription`); the Game floor's size
 * is the floor's own recorded reading (`GAME_SURFACE_PROMPT_FLOOR.conductBlock.chars` in
 * `game-surface-prompt-floor.test-support.ts`), which the floor's suite holds against the prompt the product really builds -
 * so this budget carries no second measurement of that text. A reading that goes missing is BLOCKED
 * (`pair_budget_not_measured:<where it looked>`) and never read as zero: a floor side of 0 would make the pair the
 * description alone and pass. `body-program-script.test.ts` refuses an overrun by name
 * (`game_prose_pair_exceeds_budget:<pair>:<budget>`) and prints both sides with their sources, so a reader of a green run
 * sees which side moved rather than only the pair.
 */
export const GAME_PROSE_PAIR_BUDGET_CHARS = 7517;

/**
 * How long `stardew_plan_work` may hold its own call waiting for the plan it just submitted to settle.
 *
 * THE BUDGET IS ONE DECISION, NOT ONE PLAN'S PATIENCE. Measured 2026-11-20 (`round84`): a model turn costs a median
 * 6.18 s to decide and 10.1 s to deliver, and the 1,702.7 s between its programmes was 437.5 s of queue wait and
 * 1,265.2 s of turn gaps - so a plan that settles inside the call that submitted it costs the run nothing, and one that
 * outlasts this bound costs no more than the turn the wait was meant to save. `program-status-wait.ts`'s 30 s cap is a
 * different question (how long a caller who ASKED to wait may wait); nothing here raises it.
 */
export const PLAN_SELF_WAIT_BUDGET_MS = 6_000;

/**
 * The pace one node of a plan was measured at, which is what makes the threshold below a DERIVATION.
 *
 * A MEASUREMENT, NOT A KNOB: `round84`'s 57 accepted programmes, each programme's own span (its journal's first
 * `atMs` to its last `settledAtMs`) divided by its node count - p50 629 ms, p90 2,480 ms - so the pace is what the
 * work actually took, not what a node count chosen by hand would assume. A threshold written as `2` or `3` would be
 * that hand-picked number standing beside a measurement nothing can check it against, which is the drift the family
 * tables and the prose budget exist to prevent; `plan-self-wait.test.ts` re-derives the threshold from this pace over
 * the run's own programmes and prints how many of them it covers.
 */
export const PLAN_NODE_PACE_MS = 629;

/**
 * The largest plan whose own settlement is predicted to fit inside the budget: DERIVED, never written.
 * `floor(6_000 / 629) = 9` - and a plan past it is answered as soon as the Mod accepts, because holding that turn would
 * buy nothing but an expired bound.
 */
export const MAX_PLAN_SELF_WAIT_NODES = Math.floor(PLAN_SELF_WAIT_BUDGET_MS / PLAN_NODE_PACE_MS);

/**
 * The `stardew_plan_work` description: what the tool does, and the builder methods it exposes, named and taking the
 * arguments they declare.
 *
 * The names belong HERE, in the description the companion already holds, rather than one tool call away behind
 * `stardew_plan_shape`. Measured 2026-10-28 (`round6`): a run reached 22:00 without ever dispatching `advance_day`,
 * wrote goodnight dialogue instead, and its own thinking recorded that it did not know the action's name and would not
 * guess - the engine then passed it out at 02:00 onto a standing ShippingMenu. A companion that will not spend one
 * round-trip per unknown id degenerates to single steps or to dialogue, which is the whole defect this tool exists to
 * remove.
 *
 * The vocabulary is the actions handed in - the same `PublishedPlanAction[]` `planShape` answers from - so there is no
 * hand-maintained list to drift from the Mod's catalog. Every action is printed once, under the family the Mod declared
 * it in, as the call it is: its declared argument names in parentheses, `sleep()` for the five that declare none.
 *
 * The other thing it has to teach is WHEN THE CALL RETURNS, BECAUSE IT IS NOT THE SAME ANSWER FOR EVERY PLAN. A plan
 * whose nodes fit `MAX_PLAN_SELF_WAIT_NODES` is held until it settles, so the same turn carries on with the outcome in
 * hand - measured `round84`: 51 of 57 programmes were shorter than one turn, and the turn boundaries between them cost
 * 1,265.2 s of that run. A longer plan returns as soon as the Mod accepts, because a held call makes `stop`, `append`
 * and a player's steering unreachable exactly while they matter. For those the wake is not invented here: a dispatched
 * node's execution receipt reaches the same pump as every other fact (`host-service.ts` `acceptIntegrationFact` ->
 * `CompanionEventPump.flush`), and a terminal receipt is not a held progress fact, so it starts a follow-up turn
 * (`event-pump.ts` `#hasPendingFactTrigger`). Measured 2026-11-03 (`round29`): 48 `program_status` calls, `waitMs` median
 * 30,000, 248 s blocked - the description never said a receipt was coming.
 *
 * THE BATCH IS TAUGHT AS THE JAVASCRIPT IT IS. A `for` over a snapshot family, an `if` that leaves out the tiles she does
 * not mean to touch, and one call per tile: that is the shape that buys twenty actions for one turn. It replaced a
 * vocabulary of its own (`for_each` with `source`/`where`/`do`), which was a second way to write a loop in a script that
 * is already JavaScript - so the description named a form the language covers, and named our row model while doing it.
 * The words `source`, `where`, `row`, `occupant` and `for_each` are absent here on purpose; the only loop it teaches is
 * `for`, and `body-program-script.test.ts` reads both sides of that claim.
 *
 * EVERY ROW IT PRINTS IS A CALL THE DECLARATION ALREADY ANSWERS. `planActionVocabularyText` renders the arguments from
 * `PublishedPlanAction.arguments`, the same field `planShape` reads, so a row and a shape answer cannot disagree.
 *
 * THE ROW THAT USED TO SIT BESIDE THE SEQUENCE IS GONE, and the reason is the route's: `express_emote` was taught here as
 * one example builder call (`c63a5763`), and it is no longer a builder method at all - expression reaches the actor
 * through its own mounted tool (`EXPRESSION_ONLY_ACTION_IDS`), so an example here would teach a call the compiler now
 * refuses as `plan_script_unknown_action`. The conduct names the tool.
 *
 * THE DAY'S END IS STATED HERE BECAUSE THE CALL IS DECLARED HERE. `SLEEPING_IS_AN_ACTION` carried "call builder.sleep()
 * (with no arguments) after entering the farmhouse" in the Game prompt floor until 2026-11-19, and the part of it nothing
 * else could say is the precondition: `sleep()` takes no arguments, and the day passes only from inside her own farmhouse or
 * cabin, answering `not_home` outdoors. A precondition a caller needs AT THE MOMENT OF THE CALL belongs beside the call, and
 * the floor is the last thing she reads rather than the place she decides what to write - so a rule there stating the same
 * thing was the second spelling, the one that goes stale. `body-program-script.test.ts` holds the sentence here (and drives
 * its own red by taking it back out), and `game-surface-prompt-floor.test.ts` holds the floor to saying nothing about it.
 */
export function planWorkDescription(actions: readonly PublishedPlanAction[]): string {
  return (
    "Write one script over the current snapshot and the builder, one builder.<actionId>({...}) call per step; the host compiles it into a single plan the Mod runs in the game and advances itself. A plan of " +
    String(MAX_PLAN_SELF_WAIT_NODES) +
    " nodes or fewer is held until it settles, so its outcome is in this answer; a longer plan returns as soon as it is accepted - do NOT poll it, each step's receipt arrives later as a new message. Keep composing; end the turn only when you have nothing more to plan. Every answer carries `nodes`: one entry per node you wrote, with the Mod's `state` (`succeeded` only when its receipt proved it, `rejected`/`failed`/`cancelled` when it did not, `pending`/`running` before it stopped), a `reasonCode` when it did not succeed, and its `tile` - plus `settled` (true only when every node has stopped) and `remaining`. stardew_action_program_status is for a plan that is not moving, not a progress bar. Every action below is a builder method, grouped by the family the Mod declared and printing the arguments each declares - `sleep()` takes none, and ends the day only from inside your own farmhouse or cabin (`not_home` outdoors) - so one line is the whole call; ask stardew_plan_shape for their types and closed sets, once for every action the script will call. A SHAPE - a 3-wide 20-long strip, the strip along a fence - is one RECTANGLE to query, not a reason to observe again and guess the tiles in between: stardew_observe takes it as `select: [{ x: { from, to }, y: { from, to } }]` and answers every tile of it - `occupantKind`, `tillable`, `passable` - while no argument gives the whole bounded world, and stardew_look_up answers what the session holds; all of them are reads that cost the plan no node. A call the compiler refuses costs only that call: the rest run, the answer says `planStatus: partial` and names the dropped calls, so fix and resend. Stop when builder.isFull() is true and plan the rest in the next script of this same turn, in this shape:\n" +
    `${planActionVocabularyText(actions)}\n` +
    "The script is ordinary JavaScript over `snapshot` and `builder`: `for`, `if`, `.filter`, `.sort` run; timers,\n" +
    "randomness, the network and eval are refused by name.\n" +
    "// In order:\n" +
    "const door = (snapshot.warps ?? [])[0];\n" +
    "if (door) builder.enter_exit({ x: door.sourceX, y: door.sourceY });\n" +
    "// A BATCH IS A LOOP: twenty tiles in ONE call are twenty actions for one turn, and the `if` is what leaves out\n" +
    "// the tiles you do not mean to touch:\n" +
    "for (const soil of snapshot.soilTiles) {\n" +
    "  if (soil.hoeDirt !== true) builder.till_soil({ x: soil.x, y: soil.y, " +
    planExampleCharge("till_soil") +
    " });\n" +
    "}\n" +
    "for (const crop of snapshot.cropTargets) {\n" +
    "  builder.water_crop({ x: crop.x, y: crop.y, expectedTargetId: crop.targetId, " +
    planExampleCharge("water_crop") +
    " });\n" +
    "}\n" +
    "// A solid rectangle written one tile per call is PACKED for you: a 3x20 patch at that charge is the few native\n" +
    "// uses whose footprints cover it, not sixty taps, so name the tiles and let the compiler choose the use."
  );
}

/**
 * One line per family, its members printed as the calls they are, in the order the surface declared them.
 *
 * THE PARENTHESES ARE THE DECLARATION, NOT THIS FUNCTION'S. The names come from `PublishedPlanAction.arguments` - the
 * same field `planShape` answers from - so a row cannot print an argument list the compiler does not enforce, and an
 * action added to the Mod's catalog arrives with its arguments in the same edit that names it.
 *
 * AN ACTION THAT TAKES NOTHING PRINTS EMPTY PARENS. Measured `round54`: her own thinking read "Sleep action is
 * world_lifecycle builder.sleep - args? Probably x,y? ... that costs a turn ... Simpler: speak", and twelve turns of
 * speech followed by a 02:00 pass-out. The declaration said `sleep` takes no arguments; a bare `sleep` beside `till_soil`
 * read as an action whose arguments were simply not printed, and only one tool call could tell her which it was.
 */
function planActionVocabularyText(actions: readonly PublishedPlanAction[]): string {
  const families = new Map<string, string[]>();
  for (const action of actions) {
    const row = `${action.actionId}(${action.arguments.map((argument) => argument.name).join(",")})`;
    const members = families.get(action.familyId);
    if (members === undefined) families.set(action.familyId, [row]);
    else members.push(row);
  }
  return [...families].map(([familyId, rows]) => `${familyId}: ${rows.join(", ")}`).join("\n");
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

/**
 * The condition under which a loop over a published family is WORK, per family the plan recipe iterates.
 *
 * <p>
 * THE PROPERTY. A family reached from the recipe is a target list, so a loop over it is only work where the row's own
 * state says the work is still to do. Two shapes say it and there are no others: `rowField` - the row carries the state,
 * and the recipe's loop guards on that field, which is how `soilTiles` loses the tiles already under the Hoe; and
 * `publishedAsWork` - the family publishes ONLY rows that need the work, so the family itself is the condition and a guard
 * written into the loop would be a second spelling of its publication predicate.
 * </p>
 *
 * <p>
 * WHY IT EXISTS. Measured `round81` (2026-11-20, the first three minutes): `plan_35` wrote 25 `till_soil` nodes over a
 * 13x3 patch whose every tile was already HoeDirt, and all 25 settled `succeeded` - the settlement proves the
 * postcondition was already true, which is right, and it leaves 25 node executions bought for nothing. A family named to a
 * plan without its condition is a family a plan will iterate because the rows are listed; which of the two shapes a
 * family carries is a decision, so it is declared here rather than left to whichever loop the text happens to show.
 * `body-program-script.test.ts` reads this table against the rendered recipe
 * (`a_row_a_plan_iterates_says_when_iterating_it_is_work:<family>`) and fails naming a family that carries neither.
 * </p>
 */
export type PlanIterationCondition =
  /** The row field the loop guards on: iterating the row is work when this field says so. */
  | Readonly<{ rowField: string }>
  /** Why every published row of the family already needs the work, so no guard is owed. */
  | Readonly<{ publishedAsWork: string }>;

export const PLAN_ITERATION_CONDITIONS: Readonly<Record<string, PlanIterationCondition>> = Object.freeze({
  soilTiles: Object.freeze({ rowField: "hoeDirt" }),
  cropTargets: Object.freeze({
    publishedAsWork:
      "`DiscoverCropTargets` answers only a crop whose `CropNeedsWater` holds - crop != null && needsWatering() && !isWatered() (`farmhandexecutioncontroller.targetdiscovery.cs:1578-1625`), so every published row is a tile the Can is still needed on",
  }),
});

/** How many absent-fact warnings one answer carries. The COUNT travels beside it and is not bounded. */
const MAX_REPORTED_LAYOUT_FACTS_ABSENT = 8;

/** One node's tile: the arguments every tile-addressed action declares, or undefined for a loop with no single tile. */
function nodeTile(node: PlanNode): Readonly<{ x: number; y: number }> | undefined {
  const integer = (name: string): number | undefined => {
    const text = nodeArgumentText(node, name);
    if (text === undefined) return undefined;
    const value = Number.parseInt(text, 10);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const x = integer("x");
  const y = integer("y");
  return x === undefined || y === undefined ? undefined : { x, y };
}

/** One node argument's canonical text, or `undefined` when the node does not carry it as one. */
function nodeArgumentText(node: PlanNode, name: string): string | undefined {
  const declared = (node.arguments as Readonly<Record<string, { canonicalValue?: unknown }>>)[name];
  return declared !== undefined && typeof declared.canonicalValue === "string" ? declared.canonicalValue : undefined;
}

/**
 * The seed this plan plants more of than it will hold, or `null` when every planting step has a seed behind it.
 *
 * <p>
 * MEASURED `round89`, `plan_96`: the pack held fifteen parsnip seeds and `inventory_after` went 15 -> 0, while the plan
 * carried SEVENTEEN `plant_seed` nodes - so `n16` and `n17` answered `seed_not_owned_in_pack`, two dispatches bought for
 * steps that could not do anything. The count and the program are one reading: the pack is `inventoryItemFacts`, summed
 * over the slots that hold the item, which is the same pack the Mod re-resolves `slot` from on the game thread. A plan
 * that asks for more than that is therefore a fact about the PLAN, answered before a node exists.
 * </p>
 *
 * <p>
 * THE PLAN ANSWERS FOR WHAT IT BUYS ITSELF. Fifteen bought seeds and fifteen plantings is executable with an empty pack,
 * and `seedSupplyTargets` exists to teach exactly that shape - so the units this plan's own `shop_purchase` nodes add are
 * counted with the pack's, and `held` in the refusal is what the plan WILL have rather than what the snapshot showed. In
 * which order she wrote the purchase and the plantings is hers, and a planting written before its purchase fails on its
 * own, by name.
 * </p>
 *
 * <p>
 * AN UNPUBLISHED PACK IS NOT ZERO. `inventoryItemFacts` absent means the snapshot published no pack at all (an older Mod,
 * or a world that measured nothing), so nothing is compared and NOTHING IS BOUND: the plan compiles exactly as it would
 * have and the count is named per seed (`heldSeedsUnmeasured`) instead of being invented as a refusal. A published family
 * carrying no row for the item IS a zero - that is the snapshot saying she does not hold it.
 * </p>
 */
function planSeedCounts(
  nodes: readonly PlanNode[],
  snapshot: Snapshot,
): Readonly<{ refusal: string | null; unmeasured: readonly string[] }> {
  const planted = new Map<string, number>();
  const bought = new Map<string, number>();
  for (const node of nodes) {
    const item = nodeArgumentText(node, "expectedQualifiedItemId");
    if (item === undefined) continue;
    if (node.actionId === "plant_seed") planted.set(item, (planted.get(item) ?? 0) + 1);
    if (node.actionId !== "shop_purchase") continue;
    const quantityText = nodeArgumentText(node, "quantity");
    const quantity = quantityText !== undefined && /^\d+$/u.test(quantityText) ? Number(quantityText) : 0;
    if (Number.isSafeInteger(quantity) && quantity > 0) bought.set(item, (bought.get(item) ?? 0) + quantity);
  }
  if (planted.size === 0) return Object.freeze({ refusal: null, unmeasured: Object.freeze([]) });
  const pack = planSnapshotRows(snapshot, "inventoryItemFacts");
  if (!pack.measured)
    return Object.freeze({
      refusal: null,
      unmeasured: Object.freeze(
        [...planted.keys()].map((item) => `unmeasured=plant_seed.${item};family_not_published=inventoryItemFacts`),
      ),
    });
  const held = new Map<string, number>();
  for (const row of pack.rows) {
    const item = planRowValue(row.qualifiedItemId);
    const stack = row.stack;
    if (item === undefined || typeof stack !== "number" || !isNonNegativeSafeInteger(stack)) continue;
    held.set(item, (held.get(item) ?? 0) + stack);
  }
  for (const [item, planned] of planted) {
    const available = (held.get(item) ?? 0) + (bought.get(item) ?? 0);
    if (planned > available)
      return Object.freeze({
        refusal: `plan_script_exceeds_the_seeds_held:${item}:planned=${String(planned)}:held=${String(available)}`,
        unmeasured: Object.freeze([]),
      });
  }
  return Object.freeze({ refusal: null, unmeasured: Object.freeze([]) });
}

/**
 * The water this plan will spend and what its can holds, answered before a node exists.
 *
 * <p>
 * MEASURED `round92`, `plan_534` (30 nodes): the can ran dry at `n21`, and `n22`..`n30` each WALKED to their tile and were
 * then refused `watering_can_empty` - nine walks bought to be told one fact the plan could read for free. A can's water is
 * spent by the node that swings it (`WateringCan.cs:189-191`: `WaterLeft -= power + 1`, and that `power` is the `charge`
 * argument every charged watering action declares), so the count and the program are one reading: `wateringCanFacts`
 * publishes the can's own `water` and `max`, which is the same number the Mod's guard compares against zero.
 * </p>
 *
 * <p>
 * THE PLAN ANSWERS FOR WHAT IT REFILLS ITSELF, exactly as `planSeedCounts` answers for what it buys: a `refill_watering_can`
 * node sets the can back to its maximum (`WateringCan.cs:155-158`), so the nodes after one start from `max` again. The
 * simulation therefore runs in PROGRAM ORDER over the nodes that will really run, and `held` in the refusal is the water
 * the plan had AT THE POINT IT RAN DRY - which is the number the correction is written from: with no refill in the plan it
 * is the can's water, and with a refill written after the dry point it is still the water that ran out, so moving the
 * refill earlier is the remedy the code names without having to say so in prose.
 * </p>
 *
 * <p>
 * THE CAN IS THE ONE THE MOD SELECTS, not one this file picks: `publishedSlotOfCategory` is the same ranking the Mod's
 * `ResolveDeclaredTool`/`ResolveOwnedTool` applies (highest upgrade level, ties to the smallest slot), so the row whose
 * `water` is compared is the row of the can the swing will use. A pack carrying two cans of different levels ranks them
 * the way the Mod does; a surface whose two watering actions ranked DIFFERENT cans is named (`slot_ambiguous`) instead of
 * comparing a plan against one of them.
 * </p>
 *
 * <p>
 * AN UNPUBLISHED CAN IS NOT ZERO, and neither is a can this side cannot find. `wateringCanFacts` absent (an older Mod, or
 * one that does not advertise `refill_watering_can`), no resolvable `tool:watering_can` slot, no row for the slot that was
 * resolved, and a `water`/`max` that is not a whole number all say the same thing: NOTHING WAS MEASURED, so nothing is
 * bound, and the plan compiles exactly as it would have while the list names what was missing.
 * </p>
 *
 * <p>
 * STAMINA IS NOT THE SAME QUESTION, and the reason is on this side of the wire: a swing's stamina cost is computed from
 * the actor's skill level and its enchantment (`WateringCan.cs:167-170`: `2 * (power + 1) - FarmingLevel * 0.1`, skipped
 * entirely when the tool is efficient), neither of which the snapshot publishes, and stamina RECOVERS while a long plan
 * runs - so `snapshot.stamina` is one reading of a quantity that changes by rules this compiler cannot evaluate. The Mod
 * answers that at the swing (`ToolStaminaGuard`) instead, which is the layer that owns it. Water is different in exactly
 * the way a bound needs: `water` and `max` are published, the spend is one unit per charge level the request ITSELF names,
 * and nothing inside a plan restores it except a refill node this compiler can see.
 * </p>
 *
 * <p>
 * A BOTTOMLESS CAN IS INDISTINGUISHABLE HERE AND IS NAMED RATHER THAN HIDDEN: `WateringCan.WaterLeft` answers `waterCanMax`
 * whenever `IsBottomless` holds (`WateringCan.cs:25-34`), so such a can publishes a FULL reading and never depletes - a
 * plan longer than that many waterings is refused by this bound though the engine would run it. Publishing the flag is the
 * fix and is separate work; the direction of the error is safe (a split plan, one can's worth at a time, is what the
 * refusal asks for) and the alternative - no bound at all - is the nine walks above.
 * </p>
 */
function planWaterBudget(
  nodes: readonly PlanNode[],
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
): Readonly<{ refusal: string | null; unmeasured: readonly string[] }> {
  const watering = actions.filter(
    (action) =>
      action.actionId !== REFILL_WATERING_CAN_ACTION_ID &&
      action.toolRequirement.declared &&
      action.toolRequirement.category === WATERING_CAN_CLAIM_CATEGORY,
  );
  const spends = (node: PlanNode): boolean => watering.some((action) => action.actionId === node.actionId);
  const written = nodes.filter((node) => spends(node) || node.actionId === REFILL_WATERING_CAN_ACTION_ID);
  const spenders = [...new Set(written.filter(spends).map((node) => node.actionId))];
  if (spenders.length === 0) return Object.freeze({ refusal: null, unmeasured: Object.freeze([]) });
  const slots = new Set<number>();
  for (const actionId of spenders) {
    const action = watering.find((candidate) => candidate.actionId === actionId)!;
    const slot = publishedSlotOfCategory(snapshot, WATERING_CAN_CLAIM_CATEGORY, action.toolRequirement);
    if (slot !== null) slots.add(slot);
  }
  const unmeasured = (reason: string): Readonly<{ refusal: null; unmeasured: readonly string[] }> =>
    Object.freeze({
      refusal: null,
      unmeasured: Object.freeze(spenders.map((actionId) => `unmeasured=${actionId}.watering_can;${reason}`)),
    });
  if (slots.size === 0) return unmeasured(`slot_unresolved=${WATERING_CAN_CLAIM_CATEGORY}`);
  if (slots.size > 1) return unmeasured(`slot_ambiguous=${[...slots].sort((left, right) => left - right).join("|")}`);
  const slot = [...slots][0]!;
  const facts = planSnapshotRows(snapshot, "wateringCanFacts");
  if (!facts.measured) return unmeasured("family_not_published=wateringCanFacts");
  const row = facts.rows.find((candidate) => candidate.slot === slot);
  if (row === undefined) return unmeasured(`slot_not_published=${String(slot)}`);
  const water = row.water;
  const maximum = row.max;
  if (!isNonNegativeSafeInteger(water) || !isNonNegativeSafeInteger(maximum))
    return unmeasured(`can_reading_invalid=${String(slot)}`);
  // The cost of one node is the engine's own: `WaterLeft -= power + 1`, where `power` is the `charge` the request names -
  // an action that declares no `charge` swings at power 0 and spends one. A charge this compiler cannot read is priced at
  // the same 0, which is the surface's own minimum and the only call a builder could write without one.
  const costOf = (node: PlanNode): number => {
    const chargeText = nodeArgumentText(node, "charge");
    const charge = chargeText !== undefined && /^\d+$/u.test(chargeText) ? Number(chargeText) : 0;
    return Number.isSafeInteger(charge) && charge >= 0 ? charge + 1 : 1;
  };
  const planned = written.reduce((total, node) => total + (spends(node) ? costOf(node) : 0), 0);
  let available = water;
  let spent = 0;
  for (const node of written) {
    if (!spends(node)) {
      available = maximum;
      continue;
    }
    spent += costOf(node);
    if (spent > available)
      return Object.freeze({
        refusal: `plan_script_not_enough_water:planned=${String(planned)}:held=${String(available)}`,
        unmeasured: Object.freeze([]),
      });
  }
  return Object.freeze({ refusal: null, unmeasured: Object.freeze([]) });
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
 * order. Every refusal is named and bounded, and the batch is answered in ONE of three states: `compiled` (every call
 * became a step), `partial` (some did, and the steps that did RUN - `status` is what says so, never a success beside a
 * refused call) or `refused` (nothing became a step, so there is no program). See `CompiledPlan`.
 *
 * It runs inside the windows `PLAN_SCRIPT_BUDGET_MS` declares, and a window that expired is re-measured
 * before it is believed: `runPlanScriptWindows` is where that happens and why.
 */
export function compilePlanScript(
  request: PlanScriptRequest,
  dependencies: Readonly<{
    snapshot: Snapshot | null | undefined;
    actions: readonly PublishedPlanAction[];
    /**
     * The last rectangle this SESSION read, when it read one. Absent is a session that never asked.
     *
     * <p>
     * `TileAreaQuery.Answer` is stateless on the Mod side and the rectangle's rows reached only the model's
     * answer, so before this dependency existed the one reading that reaches outside the snapshot's window
     * was thrown away at the moment it was made. A plan naming such a tile was refused as though the
     * snapshot had measured it empty.
     * </p>
     */
    tileRead?: StardewTileRead | null;
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
    dependencies.tileRead ?? null,
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
  // accounted for by name at the end - and a plan with SOME calls refused is answered `partial` there, not refused whole.
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
  // A WALK TO THE TILE A REFUSED TRANSITION NAMED IS NOT DISPATCHED. The refusal of ONE call does not stop the others -
  // that doctrine is right for a typo and wrong for this shape, where her own next call says the walk had a purpose that
  // does not exist (`planWalkToRefusedExit`).
  const walkedToARefusedExit = planWalkToRefusedExit(state);
  if (walkedToARefusedExit !== null)
    return refused(walkedToARefusedExit, scriptSource, snapshotRevision, undefined, undefined, state);
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
  // THE BATCH THE SCRIPT WROTE IS PACKED BEFORE IT IS JUDGED. A `for` loop over a patch names one tile per step, and
  // every step is a dispatch with its own walk; the pass that turns a filled rectangle of those steps into the few native
  // uses covering it runs here, so the conflict check, the layout reading and the program itself all describe the plan
  // that will run rather than the one that was typed.
  packAuthoredRuns(state, snapshot, dependencies.actions);
  // THEN THE STEPS ARE PUT IN PATH ORDER, which is a different question from what the steps are: packing decides the nodes
  // and the tiles each one works, the path order decides which of them is walked to first. One pass does the whole of it -
  // re-order each batch of independent steps of one action, renumber from the new order, re-point both edges on it. See
  // `planPathOrderedProgram` for the measurement, the guarantee, and the two things it does not do.
  const ordered = planPathOrderedProgram(state, snapshot, dependencies.actions);
  // The id a node has in the program that runs, for the account below: a reorder renumbers, so the ids the compiler
  // recorded as it wrote them are looked up rather than printed straight.
  const programNodeId = (nodeId: string): string => ordered.renamed.get(nodeId) ?? nodeId;
  const conflicts = planResourceConflictCodes(ordered.nodes, dependencies.actions);
  if (conflicts.length > 0)
    return refused(
      `plan_resource_conflict:${conflicts.join(",")}`,
      scriptSource,
      snapshotRevision,
      undefined,
      undefined,
      state,
    );
  // A PLAN MAY NOT PLANT MORE SEED THAN IT WILL HOLD, and the surplus is answered HERE, from the same nodes that are about
  // to be submitted: `round89`'s seventeen plantings against fifteen seeds spent two dispatches to learn
  // `seed_not_owned_in_pack` twice. Read after the pack-and-order passes because the steps that are judged are the ones
  // that would run; see `planSeedCounts` for the count, the plan's own purchase, and the unmeasured case.
  const seeds = planSeedCounts(ordered.nodes, snapshot);
  if (seeds.refusal !== null)
    return refused(seeds.refusal, scriptSource, snapshotRevision, undefined, undefined, state);
  // A PLAN MAY NOT WATER MORE THAN ITS CAN HOLDS, and it is answered from the same nodes, in the same place, for the same
  // reason: `round92`'s thirty `water_crop` nodes against a can of twenty walked nine of them to their tiles to be told
  // `watering_can_empty` nine times. See `planWaterBudget` for the count, the plan's own refills, and the two facts that
  // are NOT measured and therefore bound nothing.
  const water = planWaterBudget(ordered.nodes, snapshot, dependencies.actions);
  if (water.refusal !== null)
    return refused(water.refusal, scriptSource, snapshotRevision, undefined, undefined, state);
  // THE RULE THAT USED TO STAND HERE - ONE REFUSED CALL VOIDS THE BATCH - answered a real forgery and cost the calls that
  // were correct. The forgery is measured: at `3d249ff1`, `builder.talk_to_npc(...); builder.shop_purchase(...)` answered
  // `ok: true` and carried ONE node, the purchase refused and the plan submitted without it; round40 is the same shape
  // from the other end (`accepted: true` beside `droppedCount: 15`). The fix bought that honesty by refusing the PLAN, so a
  // sixteen-step plan became sixteen chances to lose the turn - and the safe move, one call at a time and a model
  // round-trip between each, is the behaviour this whole tool exists to remove.
  //
  // The state below keeps the honesty and drops the collateral: the steps that compiled RUN under their own program id,
  // `dropped` names every call that did not, by the position she wrote it, and `status` is `partial` rather than `compiled`
  // - so an answer cannot claim the whole plan ran, and a typo cannot cost the batch. What still refuses the WHOLE plan is
  // above, and it is a different kind of fact: no plan exists (nothing compiled), or the program would be one the Mod
  // refuses.
  // What this plan assumed and the snapshot it read could not answer. Read from the SAME nodes that are about to be
  // submitted, so the warning describes the plan rather than the script.
  const layout = layoutFactsAbsent(ordered.nodes, dependencies.actions, snapshot);
  const runnable = {
    scriptSource,
    snapshotRevision,
    program: Object.freeze({ nodes: ordered.nodes }),
    // The insertions are narrowed the same way the call account is and for the same reason: a loop over a body-yielding
    // family would otherwise repeat one sentence once per iteration. `insertedCount` is the population, so a bounded list
    // never reads as "that was the whole of it".
    //
    // THE STEP AN INSERTION PRECEDES IS READ OFF THE PROGRAM IT IS BESIDE. The compiler wrote it before her own step at the
    // time it emitted it, and the path order then re-ordered that step's batch and renumbered everything after it - so the
    // node it precedes is the one the final program has next, and nothing else is the same fact.
    inserted: Object.freeze(
      state.inserted
        .slice(0, MAX_REPORTED_PLAN_INSERTIONS)
        .map(
          (insertion) =>
            `inserted=${insertion.actionId};before=${planFollowingNodeId(ordered.nodes, programNodeId(insertion.nodeId))}`,
        ),
    ),
    insertedCount: state.inserted.length,
    insertedNodeIds: Object.freeze(state.insertedNodeIds.map(programNodeId)),
    autoWalkRefused: Object.freeze(state.autoWalkRefused.slice(0, MAX_REPORTED_PLAN_INSERTIONS)),
    autoWalkRefusedCount: state.autoWalkRefused.length,
    boundFromSnapshot: Object.freeze(state.boundFromSnapshot.slice(0, MAX_REPORTED_PLAN_READINGS)),
    boundFromSnapshotCount: state.boundFromSnapshot.length,
    readingsUnmeasured: Object.freeze(state.readingsUnmeasured.slice(0, MAX_REPORTED_PLAN_READINGS)),
    readingsUnmeasuredCount: state.readingsUnmeasured.length,
    resolvedAfter: Object.freeze(state.resolvedAfter.slice(0, MAX_REPORTED_PLAN_READINGS)),
    resolvedAfterCount: state.resolvedAfter.length,
    resolvedFromObservation: Object.freeze(
      state.resolvedFromObservation
        .slice(0, MAX_REPORTED_PLAN_READINGS)
        .map((proof) => `${programNodeId(proof.nodeId)}:${proof.line}`),
    ),
    resolvedFromObservationCount: state.resolvedFromObservation.length,
    heldSeedsUnmeasured: Object.freeze(seeds.unmeasured.slice(0, MAX_REPORTED_PLAN_READINGS)),
    heldSeedsUnmeasuredCount: seeds.unmeasured.length,
    heldWaterUnmeasured: Object.freeze(water.unmeasured.slice(0, MAX_REPORTED_PLAN_READINGS)),
    heldWaterUnmeasuredCount: water.unmeasured.length,
    layoutFactsAbsent: layout.absent,
    layoutFactsAbsentCount: layout.count,
    ...planCallAccount(state),
  };
  if (state.rejectedCount > 0)
    return Object.freeze({
      status: "partial" as const,
      reasonCode: state.rejected[0]!.reasonCode,
      ...(state.requirement === undefined ? {} : { requirement: state.requirement }),
      rejected: Object.freeze(state.rejected.slice(0, MAX_REPORTED_PLAN_CALLS)),
      rejectedCount: state.rejectedCount,
      ...runnable,
    });
  return Object.freeze({ status: "compiled" as const, ...runnable });
}

/** How one run of the script ended, and the error it ended with when the engine raised one. */ type PlanScriptAttempt =
  Readonly<{
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
  tileRead: StardewTileRead | null,
): Readonly<{ state: PlanScriptState; attempt: PlanScriptAttempt }> {
  const frozenSnapshot = deepFreeze(structuredClone(snapshot));
  let state = newPlanScriptState(actions, tileRead);
  let attempt = runPlanScriptAttempt(source, frozenSnapshot, actions, PLAN_SCRIPT_BUDGET_MS[0]!, state);
  for (let index = 1; index < PLAN_SCRIPT_BUDGET_MS.length && attempt.outcome === "expired"; index += 1) {
    state = newPlanScriptState(actions, tileRead);
    attempt = runPlanScriptAttempt(source, frozenSnapshot, actions, PLAN_SCRIPT_BUDGET_MS[index]!, state);
  }
  return { state, attempt };
}

/** The state one run of the script accumulates, empty: a re-measurement starts from here, not from the stopped run's. */
function newPlanScriptState(
  actions: readonly PublishedPlanAction[],
  tileRead: StardewTileRead | null,
): PlanScriptState {
  return {
    nodes: [],
    refusal: null,
    calls: 0,
    builderCalls: 0,
    rejected: [],
    rejectedCount: 0,
    acceptedSteps: [],
    refusedExits: [],
    refusedTransitions: [],
    refusedTiles: [],
    tileRead,
    noStepNeeded: [],
    inserted: [],
    insertedNodeIds: [],
    autoWalkRefused: [],
    boundFromSnapshot: [],
    readingsUnmeasured: [],
    resolvedAfter: [],
    resolvedFromObservation: [],
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
 * The three lists are built HERE and nowhere else, so no caller can spell the same fact a second way: `acceptedSteps` from
 * the calls that produced their own node, `noStepNeeded` from the calls whose work was already done, and `dropped` from
 * the refusals - the same records `rejected` carries, rendered as the names an author reads. A refusal raised before the
 * script ran (an empty script, a bad snapshot) has no state and therefore no calls, which is a true account of zero rather
 * than a missing one.
 */
function planCallAccount(state: PlanScriptState | undefined): PlanCallAccount {
  const bounded = <TValue>(entries: readonly TValue[]): readonly TValue[] =>
    Object.freeze(entries.slice(0, MAX_REPORTED_PLAN_CALLS));
  const rejected = state?.rejected ?? [];
  const acceptedSteps = state?.acceptedSteps ?? [];
  const noStepNeeded = state?.noStepNeeded ?? [];
  return Object.freeze({
    acceptedSteps: bounded(acceptedSteps.map(planStepName)),
    acceptedStepsCount: acceptedSteps.length,
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
    status: "refused" as const,
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

/**
 * One node the compiler wrote itself: the answer's `inserted=<actionId>;before=<the node that follows it>`.
 *
 * The node it precedes is NOT carried: the path order renumbers the program and may move a batch's first step, so the node
 * that follows an insertion is the one the FINAL program has there (`compilePlanScript` reads it off the program it is
 * about to answer with). Recorded as the last emission the insertion preceded, it would be a sentence about a program
 * nobody runs.
 */
type PlanInsertion = Readonly<{ actionId: string; nodeId: string }>;

type PlanScriptState = {
  nodes: PlanNode[];
  refusal: string | null;
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
   * can be honoured WITHOUT adding a node (an `equipFor` whose tool is already in hand) and a subtraction would count those
   * as steps that do not exist.
   */
  acceptedSteps: number[];
  /**
   * The transition sources this compile REFUSED because they are not ways out of the map she stands on, each with the
   * line its own call was answered with, in the order the calls were written.
   *
   * Kept because that refusal is not only one call's: a script that WALKS to the tile it cannot leave through is one
   * mistake written twice, and the walk is a node that would dispatch (`planWalkToRefusedExit`).
   */
  refusedExits: PlanRefusedExit[];
  /**
   * The transitions this compile REFUSED, by the position she wrote them, in order.
   *
   * Kept because a transition's refusal is not only its own: `enter_exit` and `travel` move the actor to another map
   * (`TRANSITION_SOURCE_PLAN_ACTION_IDS`), so every later call of the same script was written against a world this
   * compile never read - and a plan that loses that premise must not quietly become a smaller plan on this one. See
   * `emitPlanNode` for the measurement and the refusal it names.
   */
  refusedTransitions: PlanRefusedTransition[];
  /**
   * The refused steps that named a piece of world, by the tile they named: the other half of the same invariant.
   *
   * A later step on that tile is a step on state this one was to create - the edge `dependsOn` writes for a step that
   * WAS accepted, which a refused step has no node to carry. See `emitPlanNode`.
   */
  refusedTiles: PlanRefusedTile[];
  /**
   * THE LAST RECTANGLE THIS SESSION READ, which is the only evidence this compile has about a tile outside the snapshot's
   * window.
   *
   * The submit-moment snapshot publishes a family's rows inside the Mod's discovery radius and nothing outside it, so a
   * tile out there is in NO family - and an absence in every family is not the same claim as a family measuring the tile
   * empty. Carried on the state rather than threaded through five signatures: it is one input of one run, like the
   * actions the builder was generated from.
   */
  tileRead: StardewTileRead | null;
  /** The calls that had nothing to do, `n04:equip_for:already_held`. */
  noStepNeeded: string[];
  /**
   * The slot the PROGRAMME has put in hand, or `undefined` until the first `equipFor` asks.
   *
   * The snapshot is frozen for the whole compile, so it answers "what was in hand when the plan was written" and never
   * changes. An equip step written ten nodes up is state the snapshot cannot see, and a helper that re-read the snapshot
   * re-established the same hand once per unit of work: measured 2026-11-20 (`round82`), 28 of the 43 `equip_tool` nodes
   * in 16 accepted programmes answered `already_equipped`, and no programme's tool sequence ever changed - one hand, one
   * change, repeated until the work ran out.
   */
  heldSlot?: number | null;
  /**
   * The nodes the compiler inserted, in program order, each one `<actionId>` beside the id it was minted with.
   *
   * Kept in full here and narrowed once, where the plan is built: the bound is how many an answer can afford to spell
   * out, and it must not decide whether a node is written. The step the answer says it precedes is read off the final
   * program, because the path order renumbers and re-orders everything after this point.
   */
  inserted: PlanInsertion[];
  /**
   * The node ids the compiler MINTED, in program order, in full: the exact population a reader joins node outcomes to.
   *
   * Not bounded, unlike `inserted`: the count is what makes an insertion reading possible at all, and a bounded list of
   * ids would make a long plan's refusals silently uncountable.
   */
  insertedNodeIds: string[];
  /**
   * The transitions whose walk this compiler could not write, in program order, each
   * `auto_walk_refused:<reasonCode>:<x>:<y>`. Narrowed once, where the answer is built.
   */
  autoWalkRefused: string[];
  /**
   * The arguments this compiler read out of the submit-moment snapshot, in the order the calls were written, each
   * `<actionId>.<argument>` beside the path it was read from. Narrowed once, where the answer is built.
   */
  boundFromSnapshot: string[];
  /**
   * The arguments this compiler could NOT read out of the snapshot, in the order the calls were written, each
   * `unmeasured=<actionId>.<argument>;family_not_published=<family>` - the argument, and the family the SURFACE declares
   * for the action that the snapshot does not carry.
   *
   * The other half of `boundFromSnapshot`, and the half that used to be silence: a family the snapshot never published
   * leaves her number in the program, so nothing refused her AND nothing told her - and her number is the one value this
   * side could not check. Narrowed once, where the answer is built.
   */
  readingsUnmeasured: string[];
  /**
   * The readings this compiler OMITTED because a node earlier in the same program creates their target, in the order the
   * calls were written, each `resolved_after=<actionId>.<argument>;producer=<nodeId>`.
   *
   * The third answer beside `boundFromSnapshot` and `readingsUnmeasured`, and the only one that is neither the snapshot's
   * nor the author's: the value is not in the program at all, and the BODY computes it when the node runs - which is what
   * makes `till_soil` then `plant_seed` on one tile expressible as one plan. Narrowed once, where the answer is built.
   */
  resolvedAfter: string[];
  /**
   * The readings THIS SESSION'S OWN RECTANGLE READ answered, each with the node id it belongs to.
   *
   * A sibling of `resolvedAfter` and never folded into it: the two say different things about the world, and the node id
   * travels because the line is about ONE node of the program that runs - `emitPlanStep` has it, `bindSnapshotReadings`
   * does not. Renumbering is why it is stored rather than formatted there: the path order renames nodes.
   */
  resolvedFromObservation: PlanObservationProof[];
  /**
   * Which call wrote each node, so the account can name the call a node belongs to rather than a node id nothing else in
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
   * captured where the action is still in hand. It is an EMIT-TIME reading: `packAuthoredRuns` rewrites the program and
   * replaces authored tiles with footprint uses, so nothing may read this map afterwards - the path order reads the tile
   * a node names off the node itself for exactly that reason.
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
  // The hand this PROGRAMME will have by the time the action runs, not the one the snapshot froze: an equip step written
  // ten nodes up has already put the tool in hand, and answering from the compile-time snapshot put it there again. The
  // snapshot seeds this once, and every equip step written below moves it on.
  if (state.heldSlot === undefined) state.heldSlot = publishedToolSlot(snapshot);
  // The tool the action must name is already in hand, so the plan is the action alone - which is a call that had nothing
  // to do, not a call that was ignored: an author who cannot tell those apart cannot tell whether the compiler saw her
  // `equipFor` at all.
  if (state.heldSlot === slot) {
    state.noStepNeeded.push(`${planStepName(state.builderCalls)}:equip_for:already_held`);
    return slot;
  }
  const equip = actions.find((candidate) => candidate.actionId === EQUIP_TOOL_ACTION_ID);
  if (equip === undefined)
    rejectPlanCall(`plan_script_equip_unavailable:${EQUIP_TOOL_ACTION_ID}`, state, requirementOf(action));
  // Written through the same emitter as every other node, so the equip step is validated against `equip_tool`'s own
  // declared argument (a semantic tool category, never a slot) exactly as a hand-written call would be.
  emitPlanNode(equip, { tool: category }, snapshot, actions, state);
  state.heldSlot = slot;
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
  // A closed shape names its ARMS, one key list per arm: `kind+label` is the arm she could not read out of
  // `one_of:label,ref`, and it is the half of every refusal that says what to write.
  const closed = PLAN_CLOSED_ARGUMENT_SHAPES[declaration.type];
  if (closed !== undefined) return `${declaration.type}[one_of:${closed.arms.map((arm) => arm.join("+")).join(",")}]`;
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
 * could not tell a rounding slip from a wrong field, from the wrong action. So the value is named - bounded to one line
 * and stripped of invisible characters, which is what keeps a value the model wrote from forging a log line or spending
 * the turn's context - but it is named rather than described, which is the half this answer used to lose.
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
    case "object": {
      // WHICH KEYS, because `object` answered nothing: the object `find_destination` hands back was refused by a word that
      // names neither the arm it carried nor the key the door wanted, so the one correction worth making was invisible.
      const keys = Object.keys(value as Readonly<Record<string, unknown>>)
        .slice(0, PLAN_RECEIVED_MAX_KEYS)
        .map((key) => planBoundedReasonText(key))
        .sort()
        .join(",");
      return keys.length === 0 ? "object{}" : `object{${keys}}`;
    }
    case "undefined":
      return "missing";
    default:
      return typeof value;
  }
}

function planBoundedReasonText(value: string): string {
  // IT KEPT PRINTABLE ASCII ONLY, so `皮埃尔的杂货店` was deleted character by character and the refusal said
  // `got:string()` - the same words as a value she never sent (measured `round75`). A value is quoted in the language it
  // was written in. INVISIBLE characters are still dropped: they cannot be read, and a right-to-left override inside a log
  // line can make a refusal say something nobody wrote. `<empty>` and `<invisible>` are facts about the ARGUMENT, kept
  // apart from each other and from a formatter that produced nothing.
  const readable = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  if (readable.length === 0) return value.length === 0 ? "<empty>" : `<invisible ${String([...value].length)}>`;
  const points = [...readable];
  return points.length > PLAN_REASON_VALUE_CHARS ? `${points.slice(0, PLAN_REASON_VALUE_CHARS).join("")}...` : readable;
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

/**
 * Binds the arguments that are READINGS OF THE SUBMIT-MOMENT SNAPSHOT, and refuses by name when the snapshot holds no
 * such target.
 *
 * <p>
 * HER INTENTIONS SELECT THE ROW, AND A READING NEVER SELECTS THE ROW IT IS READ FROM. The tile and the item she wrote
 * say WHICH target this step is about; the id and the slot are then read off that one row, so her stale copy cannot
 * choose the row it came from and two readings of one step can never disagree with each other. Selection is EXACT first
 * (a field name her argument spells); the `expected` prefix is stripped only as a FALLBACK selection and only as a
 * NARROWING after it - `bait_crab_pot` names the bait in `expectedQualifiedItemId` while its row's `qualifiedItemId` is
 * the pot, so a stripped-name match is a way to FIND a row among rows her tile already selected, never a way to pick one
 * on its own.
 * </p>
 * <p>
 * THREE ANSWERS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT. (1) The snapshot publishes the action's target family
 * and a row matches: the answer is that row's field, whatever she wrote. (2) The family is published and NO row
 * matches: the tool refuses NOW, by name and place
 * (`plan_script_target_not_in_the_submitted_snapshot:<family>:<x>,<y>`), instead of accepting a plan that will fail once
 * per node in the body - the shape of the 22 `seed_target_unavailable` refusals this exists for. (3) The family is not
 * published at all (an older Mod, or a world that measured nothing): the snapshot cannot answer, so her number stands
 * exactly as it did before, and a call that omitted it is refused as a missing argument.
 * </p>
 * <p>
 * <p>
 * (2) COVERS THE FAMILY THAT IS MEASURED AND EMPTY, which `planSnapshotRows` used to fold into (3): a published family
 * holding no row at all is the snapshot saying the target does not exist, and it is refused for the reason every
 * unmatched tile is. (3) IS NOT SILENT: her number stands, so the answer names the argument the harness could not read
 * (`readingsUnmeasured`) - a value nothing on this side checked is a fact she has to know about the program she submits.
 * </p>
 * <p>
 * AND (2) IS TRUE ONLY INSIDE THE WINDOW. Every displaced family is published through the Mod's Chebyshev discovery
 * radius (`PLAN_SNAPSHOT_DISCOVERY_RADIUS`), so past it the family holds no row for ANY tile: the silence is "not asked",
 * not "measured empty", and answering it with (2) dropped 30 of 30 clear nodes on a 3x20 strip the session had just
 * read tile by tile. Outside the window there is a THIRD ANSWER - and two refusals that keep their own words, because
 * they are different claims:
 * </p>
 * <ul>
 *   <li>Nothing on this side names the tile: `plan_script_target_outside_the_read:<family>:<x>,<y>:read_covers=<n>`. The
 *       number is how many tiles this session's surviving rectangle read covers (`0` when it made none), or `replaced`
 *       when it made more than one and only the last survives - a count that silently meant "a different read" is the
 *       shape this repository keeps deleting.</li>
 *   <li>The session's own read names the tile, but this action's value has to be COPIED out of the snapshot and the Mod
 *       does not mint it at execution: `plan_script_reading_outside_the_submitted_snapshot:<actionId>.<argument>:<family>:<x>,<y>`.
 *       The tile is proved and the step still cannot be honoured, so the refusal points at the declaration rather than
 *       at the snapshot.</li>
 *   <li>The session's read names the tile AND the action's readings are the body's to mint (`required: false`): the
 *       readings are omitted and the proof is recorded (`resolvedFromObservation`, keyed by the node that carries it).
 *       A PERMISSION, NOT A PROMISE: the read says what stood there when she looked, and the promise is kept by the Mod,
 *       which mints the target as it acts and refuses `*_target_changed` when the world moved. The read's revision is
 *       therefore recorded and never compared; its MAP is, because a read of another map proves nothing about this one.</li>
 * </ul>
 * <p>
 * AND A FOURTH: the target may be one this program is ABOUT TO MAKE (`till_soil` then `plant_seed` on one tile). The
 * snapshot cannot hold a row for a tile that is still bare, and refusing there made the batch the product needs
 * impossible as one plan. A reading the Mod declared the body resolves (`required: false`) is therefore OMITTED when a
 * node earlier in the same program addresses that tile, and named in `resolvedAfter` - the value is neither the
 * snapshot's nor the author's, because the body computes it on the game thread. A reading the Mod did NOT declare that
 * way is never omitted: it is still read from the row or refused by name.
 * </p>
 * <p>
 * THE TWO OMISSIONS ARE NOT ONE FACT, and they are reported apart. `resolvedAfter` says a node of THIS PROGRAM will make
 * the target (`till_soil` then `plant_seed`); `resolvedFromObservation` says the world already holds it and THIS SESSION
 * read it at a coordinate the submit-moment snapshot never carries. A reader that could not tell them apart would read
 * "the body will compute it" where the truth is "she looked".
 * </p>
 */
function bindSnapshotReadings(
  action: PublishedPlanAction,
  canonical: Record<string, PlanArgument>,
  snapshot: Snapshot,
  state: PlanScriptState,
  requirement: PlanArgumentRequirement,
): PlanSnapshotReadings {
  const readings = action.arguments.filter((argument) => planReadingField(argument.name) !== undefined);
  const familyName = action.targetFamily;
  if (readings.length === 0 || familyName === null) return PLAN_NO_READINGS;
  // THE TARGET THIS STEP NAMES MAY BE ONE THIS PROGRAM IS ABOUT TO MAKE, and the submit-moment snapshot cannot hold a
  // row for a tile that is still bare: `till_soil` then `plant_seed` on that tile is the batch the product needs, and it
  // was impossible as one plan because the binder read the snapshot and refused (`seedTargets:79,18`).
  //
  // THE BODY ANSWERS FOR A READING THE MOD DECLARED IT RESOLVES (`required: false`, `FarmhandActionArgument.ResolvedAtExecution`),
  // and that declaration is what makes this honest rather than a guess: the value is a pure function of arguments the
  // node already carries (`plant_seed`'s slot and target id are re-derived from the item the request names). So when the
  // tile is one this program creates, this compiler OMITS the reading instead of inventing a number or copying a stale
  // one, and says which node produces the target (`resolvedAfter`). A reading the body does NOT answer for is untouched:
  // it is still read from the snapshot or refused by name.
  const resolvable = readings.filter((reading) => !reading.required);
  const tile = planWorldTileOf(action, canonical);
  const producer = tile === null ? undefined : planProducerNodeOnTile(state, tile);
  const resolved: string[] = [];
  if (producer !== undefined)
    for (const reading of resolvable) {
      // Her copy is dropped rather than kept: the row she remembers belongs to a tile that did not exist when she wrote
      // it, so the only value that can be true at execution is the one the body computes.
      delete canonical[reading.name];
      resolved.push(`resolved_after=${action.actionId}.${reading.name};producer=${producer.nodeId}`);
    }
  const outstanding = readings.filter((reading) => reading.required || producer === undefined);
  if (outstanding.length === 0) return Object.freeze({ bound: [], unmeasured: [], resolved, observed: [] });
  const family = planSnapshotRows(snapshot, familyName);
  // NOT MEASURED, which is a different answer from "measured, and nothing is there": the doctrine every family in
  // `protocol.ts` states (`soilTiles` null versus an empty array). An unmeasured family cannot overrule the author's own
  // number and cannot refuse her either - but it SAYS SO, because a number nothing on this side checked is the one fact
  // she has to know about the program that is about to run.
  if (!family.measured) {
    // ONLY THE READINGS WHOSE VALUE IS STILL HERS ARE REPORTED HERE. An argument the body answers for needs no number at
    // all, so telling her that one "stands unmeasured" would send her to supply a value the harness never wanted.
    const unmeasured = outstanding
      .filter((reading) => reading.required)
      .map((reading) => `unmeasured=${action.actionId}.${reading.name};family_not_published=${familyName}`);
    return Object.freeze({ bound: [], unmeasured: Object.freeze(unmeasured), resolved, observed: [] });
  }
  const rows = family.rows;
  // THE WINDOW DECIDES WHAT A FAMILY'S SILENCE MEANS, and this is the whole of the change here. Inside it a published
  // family that lists no row for her tile HAS MEASURED the tile - that is a proof the target is not there, and it is
  // refused by name. Outside it the family publishes nothing about any tile (`ExecutionManager.TargetDiscoveryRadius`),
  // so the same silence is the snapshot not having looked, and treating the two the same is what dropped 30 of 30 clear
  // nodes on a 3x20 strip the session had just read tile by tile.
  const place = planNamedPlace(canonical);
  const unlisted = (where: string): PlanSnapshotReadings => {
    if (!planTargetOutsideTheWindow(snapshot, canonical))
      rejectPlanCall(`plan_script_target_not_in_the_submitted_snapshot:${familyName}:${where}`, state, requirement);
    return planOutsideTheRead(action, snapshot, familyName, where, outstanding, canonical, state, requirement);
  };
  // MEASURED, AND THE FAMILY HOLDS NOTHING: no row can match, so the target this step names does not exist - INSIDE the
  // window. Refusing here is the difference the fold used to lose - an empty family used to be read as "not measured",
  // the answer that leaves her number standing, and the plan ran to answer `seed_target_unavailable` once per node.
  if (rows.length === 0) return unlisted(place);
  const fields = planRowFields(rows);
  // SELECTION IS EXACT FIRST, and the assertion's own name is the fallback: an action that names no field its family
  // publishes exactly (`use_item` writes `expectedQualifiedItemId` against a row publishing `qualifiedItemId`) still
  // has one field the row and the author agree about, and that is the one that selects. The fallback is only a
  // SELECTION, never a reading: it is how a row is found, not a value taken from it.
  const exact = planRowSelections(action, canonical, false, fields);
  const selecting = exact.length > 0 ? exact : planRowSelections(action, canonical, true, fields);
  // SHE WROTE NO READING TO SELECT WITH. Unchanged, inside the window and out: an argument she never wrote is answered
  // as the omission it is (`plan_script_missing_argument`), never as a claim about a tile - the order of her mistakes is
  // the order of the checks (`emitPlanStep`), and this binder does not get to move it.
  if (selecting.length === 0) return Object.freeze({ bound: [], unmeasured: [], resolved, observed: [] });
  let chosen = planRowsMatching(rows, selecting);
  const selected = planSelectedPlace(selecting);
  if (chosen.length > 1) {
    const narrowing = planRowSelections(action, canonical, true, fields).filter(
      (selection) => !selecting.some((candidate) => candidate.field === selection.field),
    );
    const narrowed = narrowing.length === 0 ? chosen : planRowsMatching(chosen, narrowing);
    // ONE TILE CAN HOLD SEVERAL TARGETS, and only the item she MEANT says which of them this step is about: a tile with
    // seed rows for two seed types and an argument naming a third is a target this snapshot does not hold, not an
    // ambiguity to guess through.
    if (narrowing.length > 0 && narrowed.length === 0) return unlisted(selected);
    if (narrowed.length > 0) chosen = narrowed;
  }
  if (chosen.length === 0) return unlisted(selected);
  const bound: string[] = [];
  for (const reading of outstanding) {
    const field = planReadingField(reading.name)!;
    // Only the fields the ROWS really carry: `chop_tree`'s slot is the tool its own claim names, not a field of
    // `treeChopSourceTargets`, so nothing is read for it and her number stays the only source.
    const published = new Map<string, unknown>();
    for (const row of chosen) {
      const value = row[field];
      const key = planRowValue(value);
      if (key !== undefined) published.set(key, value);
    }
    if (published.size === 0) continue;
    if (published.size > 1)
      rejectPlanCall(
        `plan_script_target_is_ambiguous_in_the_submitted_snapshot:${familyName}:${selected}`,
        state,
        requirement,
      );
    const [only] = [...published.values()];
    // A row's `-1` is the row saying it holds no slot for this action (`debrisTargets`: the actor owns no tool for it).
    // That is a fact to report, not a number to bind.
    if (typeof only === "number" && only < 0) continue;
    const value = canonicalPlanArgument(reading, only);
    if (value === undefined) continue;
    canonical[reading.name] = value;
    bound.push(`bound=${action.actionId}.${reading.name};from=snapshot.${familyName}[].${field}`);
  }
  return Object.freeze({ bound: Object.freeze(bound), unmeasured: [], resolved, observed: [] });
}

/**
 * The window a family's rows are published inside, in tiles from the actor.
 *
 * ONE HOST COPY OF THE MOD'S RADIUS, and it is a NAME rather than a number for the reason every other host copy in this
 * repository is: `ExecutionManager.TargetDiscoveryRadius` is 6 in `farmhandexecutioncontroller.cs`, and
 * `body-program-script.test.ts` reads that declaration and fails when the two disagree. The Host needs it because the
 * question it answers is about THIS side's reading: a family that lists no row for a tile inside six tiles has measured
 * the tile and found nothing, and a family that lists no row for a tile at distance nine has not looked at it at all.
 */
export const PLAN_SNAPSHOT_DISCOVERY_RADIUS = 6;

/**
 * Whether the tile this call names lies OUTSIDE the window the submit-moment snapshot publishes targets in.
 *
 * <p>
 * OUTSIDE IS NOT EMPTY. Every displaced family is published through the Mod's Chebyshev radius, so past it the snapshot
 * holds no row for any tile - not "no target", but "not asked" - and a binder that folds the two refuses a strip the
 * session has just read tile by tile. Inside the radius the same silence is a measurement, and remains a refusal.
 * </p>
 * <p>
 * A call naming no tile at all (`no-target-named`) is not outside anything: the question does not apply, and answering
 * "outside" would move an ordinary missing-argument refusal onto a claim about the world.
 * </p>
 */
function planTargetOutsideTheWindow(snapshot: Snapshot, canonical: Readonly<Record<string, PlanArgument>>): boolean {
  const tile = planTileOf(canonical);
  const actor = snapshot.tile;
  if (tile === null || !Number.isFinite(actor?.x) || !Number.isFinite(actor?.y)) return false;
  return Math.max(Math.abs(tile.x - actor.x), Math.abs(tile.y - actor.y)) > PLAN_SNAPSHOT_DISCOVERY_RADIUS;
}

/**
 * THE THIRD ANSWER FOR A TILE OUTSIDE THE WINDOW: what this session's own rectangle read proves about it.
 *
 * <p>
 * A PERMISSION, NOT A PROMISE. The read says what stood on the tile when she looked; the promise that the step acts on
 * that very thing is kept by the MOD, which mints the target at the moment it swings and refuses with
 * `*_target_changed` when the world moved. That is why the read's revision is recorded and never compared: a
 * read from two turns ago that names the right tile and the right occupant kind is still good enough to let the node
 * exist, and a revision equality check here would turn a stale-but-harmless reading into a refused plan while changing
 * nothing about the promise. THE MAP IS DIFFERENT: a read of another map proves nothing about this one.
 * </p>
 * <p>
 * TWO REFUSALS, AND THEY ARE NOT THE SAME CLAIM. `plan_script_target_outside_the_read` says nothing on this side named
 * the tile - and it states how many tiles the surviving read covers, or `replaced` when this session made more than one
 * reading and only the last survives, because a count that silently meant "a different read" is exactly the shape this
 * file keeps deleting. `plan_script_reading_outside_the_submitted_snapshot` says the opposite: the tile IS proved, but
 * this action's value has to be COPIED out of the snapshot and the Mod does not resolve it at execution, so no node
 * exists that could honour the tile without inventing that value.
 * </p>
 * <p>
 * WHAT THIS IS NOT: the predecessor rule one branch up. `till_soil` then `plant_seed` on one tile omits the reading
 * because a node of THIS PROGRAM will make the target (`resolvedAfter`); here nothing in the program makes it - the
 * session read it in the world, at a coordinate the submit-moment snapshot never carries - and the two are reported
 * apart (`resolvedFromObservation`) so a reader can tell "she read it" from "a step of hers will make it".
 * </p>
 */
function planOutsideTheRead(
  action: PublishedPlanAction,
  snapshot: Snapshot,
  familyName: string,
  place: string,
  outstanding: readonly PlanArgumentShape[],
  canonical: Record<string, PlanArgument>,
  state: PlanScriptState,
  requirement: PlanArgumentRequirement,
): PlanSnapshotReadings {
  const proof = planReadProof(state.tileRead, snapshot, planTileOf(canonical));
  if (proof === null)
    rejectPlanCall(
      `plan_script_target_outside_the_read:${familyName}:${place}:read_covers=${planReadCovers(state.tileRead)}`,
      state,
      requirement,
    );
  const required = outstanding.filter((reading) => reading.required);
  if (required.length > 0)
    rejectPlanCall(
      `plan_script_reading_outside_the_submitted_snapshot:${action.actionId}.${required[0]!.name}:${familyName}:${place}`,
      state,
      requirement,
    );
  const observed: string[] = [];
  for (const reading of outstanding) {
    // Her copy is dropped for the same reason the producer path drops one: the value that has to be true at execution is
    // the one the body computes, not the one she remembers.
    delete canonical[reading.name];
    observed.push(
      `resolved_from_observation=${action.actionId}.${reading.name};family=${familyName};tile=${proof.x},${proof.y};kind=${proof.occupantKind}`,
    );
  }
  return Object.freeze({ bound: [], unmeasured: [], resolved: [], observed: Object.freeze(observed) });
}

/** The tile a call's own intentions name, in coordinates, or `null` when they name none. */
function planTileOf(canonical: Readonly<Record<string, PlanArgument>>): PlanTile | null {
  const x = canonical.x;
  const y = canonical.y;
  if (x?.type !== "integer" || y?.type !== "integer") return null;
  const tileX = Number(x.canonicalValue);
  const tileY = Number(y.canonicalValue);
  return Number.isSafeInteger(tileX) && Number.isSafeInteger(tileY) ? { x: tileX, y: tileY } : null;
}

/** What one session read proves about one tile: the coordinate it named and the kind it found standing there. */
type PlanReadProof = Readonly<{ x: number; y: number; occupantKind: string }>;

/** The session's own rectangle row for this tile, or `null` when nothing on this side named it. */
function planReadProof(read: StardewTileRead | null, snapshot: Snapshot, tile: PlanTile | null): PlanReadProof | null {
  if (read === null || tile === null) return null;
  if (read.location === null || read.location !== snapshot.location) return null;
  const row = read.rows.find((candidate) => candidate.x === tile.x && candidate.y === tile.y);
  return row === undefined ? null : Object.freeze({ x: row.x, y: row.y, occupantKind: row.occupantKind });
}

/**
 * How many tiles the session's own rectangle reading covers, as `plan_script_target_outside_the_read` names it.
 *
 * `0` is a session that never read a rectangle at all - the request's own count, not a read that found nothing. A
 * session that has made more than one reading answers `replaced`, because only the last one survives and this side
 * cannot say which of them the plan was written from.
 */
function planReadCovers(read: StardewTileRead | null): string {
  if (read === null) return "0";
  return read.reads > 1 ? "replaced" : String(read.rows.length);
}

/**
 * What one call's readings came to, in the three answers that are not the author's - committed by `emitPlanNode` ONLY
 * once the step is a node of the program (a call refused after being bound produced no node, and an answer that named a
 * binding anyway would describe a program nobody runs).
 */
type PlanSnapshotReadings = Readonly<{
  /** `bound=<actionId>.<argument>;from=snapshot.<family>[].<field>` - read out of the submit-moment snapshot. */
  bound: readonly string[];
  /** `unmeasured=<actionId>.<argument>;family_not_published=<family>` - her number stands, and nothing checked it. */
  unmeasured: readonly string[];
  /** `resolved_after=<actionId>.<argument>;producer=<nodeId>` - left out, and the body computes it at execution. */
  resolved: readonly string[];
  /**
   * `resolved_from_observation=<actionId>.<argument>;family=<family>;tile=<x>,<y>;kind=<occupantKind>` - left out, and
   * the tile it belongs to was read by THIS SESSION outside the snapshot's window.
   *
   * Apart from `resolved` on purpose: a producer is a node of this plan that will make the target, while this is the
   * world as the session's own reading found it. A reader that could not tell them apart would read "the body computes
   * it" where the truth is "she looked".
   */
  observed: readonly string[];
}>;

/** One call with no readings at all, which is most of them. */
const PLAN_NO_READINGS: PlanSnapshotReadings = Object.freeze({
  bound: [],
  unmeasured: [],
  resolved: [],
  observed: [],
});

/** The row field this argument reads, when the surface states it as a reading rather than as a statement of intent. */
function planReadingField(argumentName: string): string | undefined {
  return PLAN_SNAPSHOT_READINGS.get(argumentName);
}

/** The one answer a family the snapshot does not publish at all gets: nothing was measured, so nothing can refuse. */
const PLAN_FAMILY_UNMEASURED: Readonly<{ measured: false }> = Object.freeze({ measured: false });

/**
 * The rows one published family carries in this snapshot, or the fact that the snapshot does not publish it at all.
 *
 * <p>
 * THE TWO USED TO BE ONE ANSWER, and that fold is the defect: `undefined`, `null` and a MEASURED `[]` all became
 * `rows = []`, so a family the snapshot measured and found empty - the family saying "there is no such target" - was
 * answered exactly like a family it never published, and the caller kept the number she wrote. The distinction is the
 * doctrine every family in `protocol.ts` states (`soilTiles` null versus an empty array), and it is the whole of the
 * answer: measured-and-empty is a refusal, unmeasured is not a refusal but a thing to say.
 * </p>
 */
function planSnapshotRows(
  snapshot: Snapshot,
  family: string,
): Readonly<{ measured: false }> | Readonly<{ measured: true; rows: readonly Readonly<Record<string, unknown>>[] }> {
  const rows = (snapshot as Readonly<Record<string, unknown>>)[family];
  if (!Array.isArray(rows)) return PLAN_FAMILY_UNMEASURED;
  return Object.freeze({
    measured: true as const,
    rows: Object.freeze(rows.filter((row): row is Readonly<Record<string, unknown>> => isRecord(row))),
  });
}

/** Every field name the family's own rows carry, which is what a selection may match by. */
function planRowFields(rows: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  const fields = new Set<string>();
  for (const row of rows) for (const field of Object.keys(row)) fields.add(field);
  return Object.freeze([...fields]);
}

/** A row field, or an argument name, as one case-free key: `expectedQualifiedItemId` and `qualifiedItemId` agree. */
function planFieldKey(words: readonly string[]): string {
  return words.join("");
}

/** One row field the author's own words select a target by, and the value she wrote for it. */
type PlanRowSelection = Readonly<{ field: string; value: string }>;

/** The value of a row field as the one string a selection compares with, or `undefined` when it is not a scalar. */
function planRowValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length === 0 ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * What the author's own arguments select a row by: every argument she wrote that the row publishes under the same name
 * (and, when `stripExpected`, under the name her assertion is about - `expectedQualifiedItemId` -> `qualifiedItemId`).
 */
function planRowSelections(
  action: PublishedPlanAction,
  canonical: Readonly<Record<string, PlanArgument>>,
  stripExpected: boolean,
  fields: readonly string[],
): readonly PlanRowSelection[] {
  const selections: PlanRowSelection[] = [];
  for (const argument of action.arguments) {
    if (planReadingField(argument.name) !== undefined) continue;
    const value = canonical[argument.name];
    if (value === undefined || !("canonicalValue" in value)) continue;
    const words = stripExpected ? planArgumentFieldWords(argument.name) : planNameWords(argument.name);
    const key = planFieldKey(words);
    const field = fields.find((candidate) => planFieldKey(planNameWords(candidate)) === key);
    if (field === undefined) continue;
    selections.push({ field, value: value.canonicalValue });
  }
  return selections;
}

/** The rows whose every selected field carries the value the author wrote. */
function planRowsMatching(
  rows: readonly Readonly<Record<string, unknown>>[],
  selections: readonly PlanRowSelection[],
): readonly Readonly<Record<string, unknown>>[] {
  return rows.filter((row) => selections.every((selection) => planRowValue(row[selection.field]) === selection.value));
}

/**
 * Where a refusal says the target is: the tile she named - `79,18`, the spelling every receipt uses - or, for an action
 * that selects by something else, every field and value she selected by.
 */
function planSelectedPlace(selections: readonly PlanRowSelection[]): string {
  const x = selections.find((selection) => selection.field === "x");
  const y = selections.find((selection) => selection.field === "y");
  if (x !== undefined && y !== undefined) return `${x.value},${y.value}`;
  return selections.map((selection) => `${selection.field}=${selection.value}`).join(";");
}

/**
 * Where a refusal says the target is when the family published NO row to select it from.
 *
 * `planSelectedPlace` reads the place off a row's own field, which a measured-empty family has none of - so the tile
 * comes from the intentions she wrote, and the answer still points at the call she has to change rather than at a family
 * alone. A reading is skipped for the same reason the selection skips it: it is never an intention.
 */
function planNamedPlace(canonical: Readonly<Record<string, PlanArgument>>): string {
  const text = (name: string): string | undefined => {
    const value = canonical[name];
    return value !== undefined && "canonicalValue" in value ? value.canonicalValue : undefined;
  };
  const x = text("x");
  const y = text("y");
  if (x !== undefined && y !== undefined) return `${x},${y}`;
  const named = Object.entries(canonical)
    .filter(([name]) => planReadingField(name) === undefined)
    .map(([name]) => `${name}=${text(name) ?? "selector"}`)
    .join(";");
  return named.length === 0 ? "no-target-named" : named;
}

/** One row of a snapshot family, as the family publishes it. */
type PlanTargetRow = Readonly<Record<string, unknown>>;

/**
 * What the row a step NAMES says about that step, in the surface's own fields - or `null` when the row is silent.
 *
 * <p>
 * THE FAMILY IS WHERE A STEP'S TARGETS COME FROM, AND A ROW ANSWERS MORE THAN ITS IDENTITY. `soilTiles` publishes
 * `hoeDirt` - the engine's own `GetHoeDirtAtTile`, which is the fact `till_soil` refuses on - and `shopTargets`
 * publishes `stockItemIds`/`stockCount`, what that counter actually sells. Measured `round87b` (2026-11-21,
 * `.live-runs/game-ladder/2026-11-21T13-38-15-600Z-multiday_routine`): `plan_39_a511ebcdc7723dd5` then
 * `plan_57_8a8ea0ac773aab77` wrote the same `for (let x = 62; x <= 79; x++) till_soil({ x, y: 18, charge: 0 })` strip
 * 4.4 s apart over a row that was already tilled, and the 36 nodes answered 30 `soil_already_tilled`, 4
 * `soil_not_diggable:occupied:object` and 2 `soil_not_diggable:not_map_diggable` with **no success at all**; and
 * `plan_27_05189350af1f1b0d` bought seed at `PetAdoption`'s counter - the "nearest" one the affordance list named -
 * while the snapshot held nine counters with their stock, answered `item_sold_by_another_counter ...
 * sold_here_by=shop_d1821b85749a947f@4,17`. Every one of those facts was on the row her call named, which is what makes
 * this the compiler's answer rather than the body's.
 * </p>
 * <p>
 * ONLY A ROW THAT IS THERE CAN REFUSE, and only for a fact it POSITIVELY carries: never for a row the family does not
 * hold, never for a family the snapshot did not publish, never for a field a row left out. The surface itself caps
 * `stockItemIds` at sixteen lines while `stockCount` carries the true number, so a truncated list is a list that cannot
 * refuse. A step the snapshot cannot answer is left exactly as it was - the body is the authority on the world, and this
 * pass only stops a plan from ordering work the row it named has already answered.
 * </p>
 * <p>
 * THE `snapshot` IS HANDED IN because one of these questions is about the WHOLE snapshot rather than about the row: what
 * the wallet holds is published once per observation (`snapshot.money`), and the shop rule compares it with the row's own
 * `stockPrices`. A rule that needs the world outside its row must say so here rather than reach for a module global.
 * </p>
 */
type PlanTargetRowRule = (
  named: PlanTargetRow,
  rows: readonly PlanTargetRow[],
  canonical: Readonly<Record<string, PlanArgument>>,
  state: PlanScriptState,
  snapshot: Snapshot,
) => string | null;

const PLAN_TARGET_ROW_RULES: Readonly<Record<string, PlanTargetRowRule>> = Object.freeze({
  // `soilTiles` publishes every tile within the hoe's reach that is bare AND tillable, or already worked. THE FIELD IS NOT
  // SPELLED HERE: `PLAN_ITERATION_CONDITIONS` is where the product states which row field says a tile still needs the
  // work, and the plan recipe the companion reads renders its own loop guard from that entry
  // (`if (soil.hoeDirt !== true) builder.till_soil({...})`). This refusal is that same guard, enforced instead of merely
  // suggested - `round81` bought 25 `till_soil` nodes over a patch where every tile was already HoeDirt, and `round87b`
  // bought 36 more.
  soilTiles: (named, _rows, canonical, state) =>
    planRowSaysTheWorkIsDone("soilTiles", named) && !planStepClearsTheHoeDirt(canonical, state)
      ? `plan_script_target_already_tilled:soilTiles:${planNamedPlace(canonical)}`
      : null,
  shopTargets: (named, rows, canonical, _state, snapshot) =>
    planCounterRefusal(named, rows, canonical) ?? planUnaffordablePurchaseRefusal(named, canonical, snapshot),
});

/**
 * The families whose rows this compiler asks a question about the step that names them - the population of
 * `PLAN_TARGET_ROW_RULES`, derived from it rather than restated.
 *
 * <p>
 * A GUARD IS ONLY A GUARD IF IT CAN BE OPENED, and opening one takes an argument the row-finding accepts: a rule keyed to
 * a family no action's declarations can address is a refusal nobody can reach. That is what
 * `body-program-snapshot-readings.test.ts` crosses this population with - the actions the SURFACE declares address these
 * families, and the arguments each of them declares - so a family that gains a guard it cannot reach, and a guarded
 * family no action addresses, are both red by name. `round87b` is the shape from the other side: a condition the product
 * declared (`PLAN_ITERATION_CONDITIONS`) whose guard the compiler never rendered.
 * </p>
 */
export const PLAN_GUARDED_FAMILIES: readonly string[] = Object.freeze(Object.keys(PLAN_TARGET_ROW_RULES).sort());

/** Whether the family's own published loop guard excludes this row - the row field `PLAN_ITERATION_CONDITIONS` names. */
function planRowSaysTheWorkIsDone(familyName: string, row: PlanTargetRow): boolean {
  const condition = PLAN_ITERATION_CONDITIONS[familyName];
  if (condition === undefined || !("rowField" in condition)) return false;
  return row[condition.rowField] === true;
}

/**
 * The counter she named sells something the item she means is not, and a counter in the same room sells it.
 *
 * <p>
 * THE ADDRESS IS THE WHOLE ANSWER, in the vocabulary the body already uses for this refusal (`sold_here_by`), so the
 * correction is one id and costs no walk. The Mod's own code is `item_sold_by_another_counter`, and "another counter"
 * means one in the room the actor is standing in: a shop across the map is not an address a plan may send her to.
 * </p>
 * <p>
 * `stockItemIds` IS CAPPED AT SIXTEEN by the surface and `stockCount` is the number the shop really stocks, so the two
 * together are what says whether absence means anything: a complete list that does not name the item is the counter
 * saying it does not sell it, and a truncated one says nothing at all.
 * </p>
 */
function planCounterRefusal(
  named: PlanTargetRow,
  rows: readonly PlanTargetRow[],
  canonical: Readonly<Record<string, PlanArgument>>,
): string | null {
  const item = canonical.expectedQualifiedItemId;
  const itemId = item !== undefined && "canonicalValue" in item ? item.canonicalValue : undefined;
  if (itemId === undefined) return null;
  const stock = named.stockItemIds;
  const stocked = named.stockCount;
  if (!Array.isArray(stock) || typeof stocked !== "number" || stock.length !== stocked) return null;
  if (stock.some((published) => published === itemId)) return null;
  const elsewhere = rows.find(
    (row) =>
      row !== named &&
      row.location === named.location &&
      Array.isArray(row.stockItemIds) &&
      row.stockItemIds.some((published) => published === itemId),
  );
  if (elsewhere === undefined) return null;
  const counter = `${planRowValue(elsewhere.targetId) ?? "unknown_counter"}@${planRowValue(elsewhere.ownerTileX) ?? "?"},${planRowValue(elsewhere.ownerTileY) ?? "?"}`;
  return `plan_script_item_sold_by_another_counter:${itemId}:sold_here_by=${counter}`;
}

/** One argument's canonical text, when she wrote it as an intention - a reading is never an amount she chose. */
function planIntentionText(canonical: Readonly<Record<string, PlanArgument>>, name: string): string | undefined {
  const value = canonical[name];
  return value !== undefined && "canonicalValue" in value ? value.canonicalValue : undefined;
}

/**
 * The purchase costs more than the wallet holds, so the plan is refused before it is even dispatched.
 *
 * <p>
 * THE ARITHMETIC IS THE GAME'S. `ShopMenu` charges `ItemStockInformation.Price * stockToBuy` (`ShopMenu.cs:1337`), and
 * the price the counter publishes is already that `Price` - the number after the shop's and the entry's own modifiers - so
 * `unitPrice * quantity` is the total the game would take, not an estimate of it. Measured `round87b` (2026-11-21):
 * `plan_27` bought seed at the wrong counter and answered `item_sold_by_another_counter`, and a later
 * `shop_purchase({ expectedQualifiedItemId: "(O)378", quantity: 15 })` was sent at 75g a unit with 35g in hand - the
 * only answer that came back was the game's own `insufficient_money ... price=75; available=35; short=40`, one walk and
 * one menu later. The wallet and the unit price are both on the snapshot now, so the plan can be answered before the
 * body moves.
 * </p>
 * <p>
 * IT ONLY FIRES WHEN BOTH FACTS ARE MEASURED, which is the half that must never be softened: no `snapshot.money` (no world
 * was ready), no `stockPrices` on the row (the counter published no prices), no price for THIS item, or a `quantity` she
 * did not write - every one of those is `unmeasured`, and unmeasured is not affordable. A missing price read as
 * affordable is the absence-as-pass shape this repository deletes; the boundary is the other way - a purchase that costs
 * EXACTLY the wallet is affordable and stays in the plan, because the game would take it.
 * </p>
 */
function planUnaffordablePurchaseRefusal(
  named: PlanTargetRow,
  canonical: Readonly<Record<string, PlanArgument>>,
  snapshot: Snapshot,
): string | null {
  const itemId = planIntentionText(canonical, "expectedQualifiedItemId");
  const quantityText = planIntentionText(canonical, "quantity");
  if (itemId === undefined || quantityText === undefined) return null;
  if (!/^\d+$/u.test(quantityText)) return null;
  const quantity = Number(quantityText);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
  const prices = named.stockPrices;
  if (!Array.isArray(prices)) return null;
  const priced = prices.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Readonly<Record<string, unknown>>).qualifiedItemId === itemId,
  );
  if (priced === undefined) return null;
  const unitPrice = (priced as Readonly<Record<string, unknown>>).price;
  if (typeof unitPrice !== "number" || !Number.isSafeInteger(unitPrice) || unitPrice < 0) return null;
  const money = snapshot.money;
  if (typeof money !== "number" || !Number.isSafeInteger(money) || money < 0) return null;
  const total = unitPrice * quantity;
  // A total past the safe-integer range is an amount this compiler cannot state exactly, so it states nothing rather than
  // refusing on a rounded number.
  if (!Number.isSafeInteger(total)) return null;
  if (total <= money) return null;
  return `plan_script_unaffordable_purchase:${itemId}:${String(unitPrice)}x${String(quantity)}=${String(total)}>money:${String(money)}`;
}

/**
 * Whether an earlier step in this program takes the hoe dirt off the tile this one names, so the row's `hoeDirt` is not
 * the state the step will find (`clear_hoedirt` then `till_soil` on one tile is a plan the body runs, not a mistake).
 */
function planStepClearsTheHoeDirt(canonical: Readonly<Record<string, PlanArgument>>, state: PlanScriptState): boolean {
  const tile = tileKeyOf(canonical);
  return tile !== null && planProducerNodeOnTile(state, tile)?.actionId === "clear_hoedirt";
}

/**
 * The row a step names, out of its family: the tile it addresses, or - for an action whose only address is the opaque id
 * the surface mints - the row carrying that id.
 */
function planNamedTargetRow(
  canonical: Readonly<Record<string, PlanArgument>>,
  rows: readonly PlanTargetRow[],
): PlanTargetRow | undefined {
  const tile = tileKeyOf(canonical);
  if (tile !== null) return rows.find((row) => `${planRowValue(row.x)},${planRowValue(row.y)}` === tile);
  const identity = canonical[PLAN_ROW_IDENTITY.argument];
  const named = identity !== undefined && "canonicalValue" in identity ? identity.canonicalValue : undefined;
  if (named === undefined) return undefined;
  return rows.find((row) => planRowValue(row[PLAN_ROW_IDENTITY.field]) === named);
}

/** The refusal the row a step names raises about that step, or `null` when it raises none. */
function planTargetRowRefusal(
  action: PublishedPlanAction,
  canonical: Readonly<Record<string, PlanArgument>>,
  snapshot: Snapshot,
  state: PlanScriptState,
): string | null {
  const familyName = action.targetFamily;
  if (familyName === null) return null;
  const rule = PLAN_TARGET_ROW_RULES[familyName];
  if (rule === undefined) return null;
  const family = planSnapshotRows(snapshot, familyName);
  if (!family.measured) return null;
  const named = planNamedTargetRow(canonical, family.rows);
  if (named === undefined) return null;
  return rule(named, family.rows, canonical, state, snapshot);
}

/**
 * A transition source this compile refused, and the line its own call was answered with.
 *
 * The line travels BESIDE the tile because a second call can name the same tile: `planWalkToRefusedExit` refuses the
 * whole program when the script also walks there, and it answers with the same sentence rather than with a second
 * spelling of it.
 */
type PlanRefusedExit = Readonly<{ tile: string; reasonCode: string }>;

/**
 * What the snapshot published about this map's ways out: every SOURCE tile, and the rows each table carried.
 *
 * <p>
 * A SET OF TILES, NOT A COUNT. A count says the map has exits; it cannot say whether (3,12) is one of them, which is the
 * only question a plan asks. The tile is read off `sourceX`/`sourceY` and never off `targetX`/`targetY`: the target pair
 * is the arrival tile on the DESTINATION map (`ROW_TILE_FIELD_PAIRS` states the same rule for every reader), so reading
 * it would place another map's tile in this one - the very confusion this check refuses.
 * </p>
 * <p>
 * A TABLE THE SNAPSHOT DOES NOT CARRY IS `null`, NOT ZERO: `warps` is published by every Mod that has a world ready and
 * `doorTargets` is published exactly when `enter_exit` is advertised, so an absent table means "not measured" and the
 * refusal says `unmeasured` rather than claiming the map has no doors. The distinction is `planSnapshotRows`', which is
 * why this reads it instead of `Array.isArray` on the snapshot field.
 * </p>
 */
type PlanExitTables = Readonly<{
  /** Every SOURCE tile the snapshot published as a way out of this map, spelled `x,y`. */
  tiles: ReadonlySet<string>;
  /** The rows each exit table published, in `PLAN_EXIT_FAMILY_IDS` order: its count, or `null` for a table it did not carry. */
  counts: readonly Readonly<{ label: string; count: number | null }>[];
}>;

function planExitTables(snapshot: Snapshot): PlanExitTables {
  const tiles = new Set<string>();
  const counts: Readonly<{ label: string; count: number | null }>[] = [];
  for (const { family, label } of PLAN_EXIT_FAMILY_IDS) {
    const published = planSnapshotRows(snapshot, family);
    counts.push(Object.freeze({ label, count: published.measured ? published.rows.length : null }));
    if (!published.measured) continue;
    for (const row of published.rows) {
      const x = planRowValue(row.sourceX);
      const y = planRowValue(row.sourceY);
      if (x !== undefined && y !== undefined) tiles.add(`${x},${y}`);
    }
  }
  return Object.freeze({ tiles, counts: Object.freeze(counts) });
}

/**
 * The line a transition is answered with when the tile it names is not a way out of the map she stands on.
 *
 * <p>
 * `round91` (day 7, `plan_481`) is the measurement: she stood on `Farm 64,15`, the snapshot published `location: "Farm"`
 * with the farm's own exits in `warps` and nothing at `3,12`, and the plan walked twenty seconds - `(42,16)`, `(15,10)`,
 * `(7,18)` - before `n02 enter_exit(3,12)` answered `door_not_available`. `3,12` is a tile of the FarmHOUSE, and no
 * layer had ever said so, so the walk was paid for a door that was never on her map.
 * </p>
 * <p>
 * The line names the three facts a correction is written from: the tile she wrote, the map it was measured against, and
 * what each exit table published - a count, or `unmeasured` for a table the snapshot did not carry, because "this map
 * has no doors" and "nobody measured them" are different answers and only one of them is the world's.
 * </p>
 */
function planDoorNotOnThisMapReason(
  tile: Readonly<{ x: string; y: string }>,
  snapshot: Snapshot,
  tables: PlanExitTables,
): string {
  const counts = tables.counts
    .map((entry) => `${entry.label}=${entry.count === null ? "unmeasured" : String(entry.count)}`)
    .join(":");
  return `plan_script_door_not_on_this_map:${tile.x}:${tile.y}:map=${planRowValue(snapshot.location) ?? "unmeasured"}:${counts}`;
}

/**
 * Whether this call's tile is a way out of the map she stands on, or the refusal to answer it with.
 *
 * Only `enter_exit` asks this: `travel` resolves the warp table alone and answers `warp_not_available` at a door tile by
 * the action surface's own declaration, so the two actions do not share an exit population. `move_to_tile` cannot ask it
 * at all - a tile of the map is a legal place to stand - which is what `planWalkToRefusedExit` answers instead.
 */
function planExitTileRefusal(
  action: PublishedPlanAction,
  canonical: Readonly<Record<string, PlanArgument>>,
  snapshot: Snapshot,
): PlanRefusedExit | null {
  if (action.actionId !== ENTER_EXIT_ACTION_ID) return null;
  const x = planIntentionText(canonical, "x");
  const y = planIntentionText(canonical, "y");
  if (x === undefined || y === undefined) return null;
  const exits = planExitTables(snapshot);
  if (exits.tiles.has(`${x},${y}`)) return null;
  return Object.freeze({ tile: `${x},${y}`, reasonCode: planDoorNotOnThisMapReason({ x, y }, snapshot, exits) });
}

/**
 * A WALK TO THE TILE THIS SCRIPT'S OWN TRANSITION WAS REFUSED FOR IS THE SAME MISTAKE WEARING A WALK.
 *
 * <p>
 * ONE REFUSED CALL DOES NOT STOP THE OTHERS, which is the doctrine this compiler is built on: a typo must not cost a
 * batch. Its other half was missing. `round91`'s `plan_481` was `move_to_tile({3,12}); enter_exit({3,12})`, so the walk
 * was a legal node and only the transition was refused - the answer would have been `partial`, and the one node it ran
 * would have been the twenty-second walk to a tile nothing can leave through.
 * </p>
 * <p>
 * The walk cannot be refused where it is written: a tile of the map is a legal place to stand, and whether this walk is
 * a mistake depends on her OWN next call. So it is answered once the script is done, and the plan is refused whole with
 * the line the transition already carried - nothing dispatches, and the correction is the tile, not the walk. A walk no
 * call tries to leave through still compiles: that is a plan with a step in it.
 * </p>
 */
function planWalkToRefusedExit(state: PlanScriptState): string | null {
  if (state.refusedExits.length === 0) return null;
  for (const node of state.nodes) {
    if (node.actionId !== MOVE_TO_TILE_ACTION_ID) continue;
    const tile = tileKeyOf(node.arguments);
    if (tile === null) continue;
    const refused = state.refusedExits.find((candidate) => candidate.tile === tile);
    if (refused !== undefined) return refused.reasonCode;
  }
  return null;
}

/**
 * A transition this compile refused, by the position SHE wrote it: the call, its action, and the line she was answered
 * with.
 *
 * The line travels with the position because the refusal that orphans her later steps is written once per orphan and has
 * one predecessor to name (`emitPlanNode`), and a code that could only say "a transition" would send a reader back to the
 * script to count which one.
 */
type PlanRefusedTransition = Readonly<{ call: number; actionId: string; reasonCode: string }>;

/**
 * A step this compile refused that named a piece of WORLD, by the position she wrote it and the tile it named.
 *
 * The tile is the compiler's own consumer relation (`planWorldTileOf`): a later step on the same tile is a step on state
 * this one was to create, which is exactly the edge an ACCEPTED step gets as `dependsOn`. A refused step has no node, so
 * that edge has nowhere to be written - and the later step would run with no producer, against a tile whose state nobody
 * prepared.
 */
type PlanRefusedTile = Readonly<{ call: number; actionId: string; tile: string }>;

/**
 * One reading a rectangle read answered, against the node that carries it: `<nodeId>:resolved_from_observation=...`.
 *
 * The node id is carried rather than formatted where the line is written, because the path order that runs after the
 * script renames nodes (`planPathOrderedProgram`) and a line naming the id it had before the reorder would point at a
 * node the program does not hold.
 */
type PlanObservationProof = Readonly<{ nodeId: string; line: string }>;

/**
 * A REFUSED STEP DOES NOT LEAVE THE REST OF HER SCRIPT STANDING: the map it would have left her on, and the tile it would
 * have prepared. `round93` paid a night to learn the first half.
 *
 * <p>
 * Measured 2026-11-22 (`round93`, `plan_463`): she stood in Town and wrote `enter_exit({x:64,y:14}); sleep();`. The
 * transition was refused by name - `plan_script_door_not_on_this_map:64:14:map=Town`, `(64,14)` being the FARMHOUSE's
 * door spelled in the town's frame - and the `sleep` was KEPT, because one refused call stops only itself. The plan that
 * ran was therefore `sleep()` ALONE, from Town: the night answered `not_home` for 308 s and the engine's 2:00 AM pass-out
 * ended the run with her money lost. The compiler had submitted a plan nobody wrote: hers had the walk home in it.
 * </p>
 * <p>
 * TWO DEPENDENCIES, BOTH THE COMPILER'S OWN AND NEITHER A TABLE OF ACTION PAIRS. The MAP is
 * `TRANSITION_SOURCE_PLAN_ACTION_IDS`, the two actions that move the actor to another map: a call written after one was
 * written for the map it leads to, and this compile holds one snapshot of ONE map. The TILE is `planWorldTileOf`, which
 * is what `dependsOn` is built from for a step that WAS accepted - a later step on that tile is a step on state the
 * refused one was to create. When the premise goes, the dependants go with it: a plan that loses its precondition must
 * not become a SMALLER plan.
 * </p>
 * <p>
 * WHAT THIS DOES NOT DO: it does not stop the calls after it from being READ, and it does not void the steps before it.
 * Each orphan is refused as its own call - `dropped` names it and its predecessor by position - so a batch that had good
 * work in front of a bad transition still runs that work, and a plan that was only the transition and what came after it
 * is refused whole with nothing dispatched. ONE REFUSED CALL STILL STOPS ONLY ITSELF: the rule here is about the calls
 * whose world or whose tile the refused step was.
 * </p>
 */
function emitPlanNode(
  action: PublishedPlanAction,
  arguments_: unknown,
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
  state: PlanScriptState,
): void {
  const tile = announcedTileOf(action, arguments_);
  const predecessor =
    state.refusedTransitions[0] ??
    (tile === null ? undefined : state.refusedTiles.find((entry) => entry.tile === tile));
  if (predecessor !== undefined)
    rejectPlanCall(
      `plan_script_orphaned_by_a_refused_predecessor:${planStepName(state.builderCalls)}:${action.actionId}:${planStepName(predecessor.call)}:${predecessor.actionId}`,
      state,
      requirementOf(action),
    );
  try {
    emitPlanStep(action, arguments_, snapshot, actions, state);
  } catch (error) {
    // Recorded on the way out, where the refusal and the action that was being written are both in hand: `atPlanCall`
    // records the rejection, and only this boundary knows whether the call that failed was THE STEP ITSELF or the
    // `equipFor` helper that names an action (`equipForAction`), whose refusal orphans nothing.
    if (error instanceof PlanScriptRefusal && !error.wholeScript) {
      if (TRANSITION_SOURCE_PLAN_ACTION_IDS.includes(action.actionId))
        state.refusedTransitions.push(
          Object.freeze({ call: state.builderCalls, actionId: action.actionId, reasonCode: error.reasonCode }),
        );
      if (tile !== null)
        state.refusedTiles.push(Object.freeze({ call: state.builderCalls, actionId: action.actionId, tile }));
    }
    throw error;
  }
}

/**
 * The world tile a call names, read from what she WROTE rather than from an argument record already canonicalised.
 *
 * `planWorldTileOf` answers the same question for a call that is about to become a node; this one has to answer it for a
 * call that never will, so it canonicalises the pair itself through the surface's own declarations. Both end in
 * `tileKeyOf`, so "the same tile" stays ONE rule rather than two that agree today.
 */
function announcedTileOf(action: PublishedPlanAction, arguments_: unknown): string | null {
  if (action.targetFamily === null) return null;
  if (typeof arguments_ !== "object" || arguments_ === null) return null;
  const supplied = arguments_ as Readonly<Record<string, unknown>>;
  const declared = new Map(action.arguments.map((argument) => [argument.name, argument] as const));
  const canonical: Record<string, PlanArgument> = {};
  for (const name of ["x", "y"]) {
    const declaration = declared.get(name);
    if (declaration === undefined || !Object.hasOwn(supplied, name)) return null;
    const value = canonicalPlanArgument(declaration, supplied[name]);
    if (value === undefined) return null;
    canonical[name] = value;
  }
  return tileKeyOf(canonical);
}

function emitPlanStep(
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
  // AN OMITTED ARGUMENT IS REFUSED - EXCEPT THE TWO THAT ARE READINGS, WHICH ARE BOUND HERE INSTEAD.
  //
  // The rule this replaces was "refuse, never infer", and its four reasons were right about the arguments it was written
  // for and blind to the difference this file now draws between an INTENTION and a READING (`PLAN_SNAPSHOT_READINGS`).
  // Each reason, against a reading:
  //   1. "Those arguments are ASSERTIONS the Mod re-checks, so a value this compiler filled in is an assertion nobody
  //      made." For a READING the assertion is not about intent: the Mod re-checks the row at the tile she named, this
  //      compiler's value is that row AT THE SUBMISSION'S REVISION, and hers is a memory of an older one. Binding is the
  //      only version of the assertion anybody can make truthfully - `round84` made it from memory 54 times and was wrong
  //      22 times.
  //   2. "(x, y) does not identify a row; it selects among every family." True, which is why the row is looked for in the
  //      ONE family the SURFACE declares for this action and selected by her own fields - and why a selection that finds
  //      nothing refuses by name (`target_not_in_the_submitted_snapshot`) rather than picking a family.
  //   3. "It is silent." It was. It is not: `boundFromSnapshot` names every reading this compiler wrote and the row path
  //      it read, and a model that believes a reading is optional learns it there, in a value it can check.
  //   4. "`planProgramId` is content-addressed and a Host-inferred value has no provenance." The provenance is the path
  //      `boundFromSnapshot` prints and the `snapshotRevision` the program already carries; a journal replay is against a
  //      world, not against the author's memory.
  // What did NOT change: every intention - the tile, the item, the seed, the quantity - is still hers, and an argument
  // that is neither bound nor supplied is still refused by name, with the whole set of omissions beside it.
  const canonical: Record<string, PlanArgument> = {};
  // THE ORDER OF THE THREE CHECKS IS THE ORDER OF HER MISTAKES. What she FAILED TO WRITE is answered first and for every
  // argument that is not a reading, because a value she never wrote is a fact about her call and outranks anything the
  // snapshot could say - binding first made `pickup_forage` with no `x` answer "no forage at y=1", a place built from the
  // one coordinate she did write. What she wrote wrong is answered second, unchanged. What the snapshot knows is read
  // last, and a reading it could not answer is then reported exactly as any other omission.
  const rejectMissing = (candidates: readonly PlanArgumentShape[], readingsCount: boolean): void => {
    const missing = candidates.filter(
      (declaration) =>
        declaration.required &&
        !Object.hasOwn(supplied, declaration.name) &&
        (readingsCount || planReadingField(declaration.name) === undefined),
    );
    if (missing.length === 0) return;
    // EVERY ARGUMENT THAT IS MISSING, not the first one: measured in `.tmp/fork-why-slow.jsonl`, the refusal for
    // `claim_mail_attachment({ expectedTargetId })` named `x` alone, so a correction that fixed `x` bought a second
    // refusal for `y`. The code names the first (with what it must be and where the value is published) and the answer
    // carries the whole set beside it.
    const first = missing[0]!;
    rejectPlanCall(
      `plan_script_missing_argument:${action.actionId}.${first.name}:${planArgumentExpectation(first)}:${planArgumentSource(action, snapshot, first.name)}`,
      state,
      requirement,
      Object.freeze(missing.map((declaration) => declaration.name)),
    );
  };
  rejectMissing([...declared.values()], false);
  for (const [name, declaration] of declared) {
    if (!Object.hasOwn(supplied, name)) continue;
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
  // THE READINGS ARE READ HERE, before the last look at what is missing: a reading she did not write is not a mistake,
  // and a reading she DID write is replaced by the row's own value - which is the half of this change that answers the
  // 22 `seed_target_unavailable` nodes, because her copy was the stale one.
  const readings = bindSnapshotReadings(action, canonical, snapshot, state, requirement);
  rejectMissing(
    [...declared.values()].filter((declaration) => !Object.hasOwn(canonical, declaration.name)),
    true,
  );
  // AND WHAT THE ROW THIS STEP NAMES SAYS ABOUT IT, which is a fact about the step and not about her arguments: a
  // missing argument is answered first, because no row can fix a call she did not finish writing.
  const rowRefusal = planTargetRowRefusal(action, canonical, snapshot, state);
  if (rowRefusal !== null) rejectPlanCall(rowRefusal, state, requirement);
  // AND WHETHER THIS PROGRAM ALREADY TOOK THE TILE, which no row of any family can answer: the snapshot was read before
  // the plan ran, so a tile this program sows is still published as empty soil in it (`body-program-planting.ts`).
  const sowTile = tileKeyOf(canonical);
  const secondSow = planSecondSowRefusal(
    {
      actionId: action.actionId,
      targetFamily: action.targetFamily,
      place: sowTile === null ? null : planNamedPlace(canonical),
    },
    sowTile === null ? undefined : planProducerNodeOnTile(state, sowTile),
    actions,
  );
  if (secondSow !== null) rejectPlanCall(secondSow, state, requirement);
  // AND WHETHER THE TILE A TRANSITION NAMES IS A WAY OUT OF THE MAP SHE IS ON - the question every other layer left
  // unasked, because a transition's coordinates are intentions and its declared family is never applied to them.
  const refusedExit = planExitTileRefusal(action, canonical, snapshot);
  if (refusedExit !== null) {
    state.refusedExits.push(refusedExit);
    rejectPlanCall(refusedExit.reasonCode, state, requirement);
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
  if (approach.kind === "written") state.nodes.push(approach.node);
  // A WALK THIS COMPILER CANNOT PLACE IS REPORTED, NOT WRITTEN: an invented coordinate becomes a node the world refuses,
  // and a refused node the author never wrote is the shape `round89`'s `plan_12` measured. See `transitionApproachNode`.
  if (approach.kind === "refused")
    state.autoWalkRefused.push(`auto_walk_refused:${approach.reasonCode}:${approach.tile.x}:${approach.tile.y}`);
  // EVERY NODE THE COMPILER WRITES IS ONE THE WIRE CARRIES, so the cap is checked against all of them: a program past
  // the bound would be refused as a malformed request instead of as a plan that is too long.
  const authorPosition = state.nodes.length + 1;
  if (authorPosition > MAX_PLAN_NODES) refusePlan(`plan_cap_exceeded:${authorPosition}`, state, requirement);
  const authorNodeId = planNodeId(PLAN_AUTHOR_NODE_PREFIX, authorPosition);
  // The answer shows the program is not exactly the script, once per node and in program order.
  if (dismissal !== null) {
    state.inserted.push({ actionId: dismissal.actionId, nodeId: dismissalNodeId });
    state.insertedNodeIds.push(dismissalNodeId);
  }
  if (approach.kind === "written") {
    state.inserted.push({ actionId: approach.node.actionId, nodeId: approach.node.nodeId });
    state.insertedNodeIds.push(approach.node.nodeId);
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
  const producer = tile === null ? undefined : planProducerNodeOnTile(state, tile)?.nodeId;
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
  // Her step is in the program, so her call is accounted for and cannot also appear as dropped or unneeded.
  state.acceptedSteps.push(state.builderCalls);
  state.callOfNode.set(authorNodeId, state.builderCalls);
  // AND THE READINGS ARE COMMITTED ONLY NOW, because a step that was refused after being bound produced no node: an
  // answer that listed the binding anyway would be a sentence about a program nobody runs.
  state.boundFromSnapshot.push(...readings.bound);
  state.readingsUnmeasured.push(...readings.unmeasured);
  state.resolvedAfter.push(...readings.resolved);
  for (const line of readings.observed)
    state.resolvedFromObservation.push(Object.freeze({ nodeId: authorNodeId, line }));
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

/** A tile of the world, as a step names it: the piece of map its coordinates point at. */
type PlanTile = Readonly<{ x: number; y: number }>;

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
  return tileKeyOf(arguments_);
}

/**
 * The canonical key of the tile a step's arguments name, or `null` when they name no tile.
 *
 * Keyed on the CANONICAL value, so two spellings of one coordinate are one tile. One spelling of the key for every
 * reader - the consumer rule and the packing pass below must agree on what "the same tile" is, or a step on packed
 * ground consumes a node that works a different tile.
 */
function tileKeyOf(arguments_: Readonly<Record<string, PlanArgument>>): string | null {
  const tile = planTileOf(arguments_);
  return tile === null ? null : `${tile.x},${tile.y}`;
}

/**
 * The nearest earlier step on this tile: the one whose state this step is written on top of.
 *
 * Nearest rather than all of them, so a node carries one edge and a skip names one producer - `till`, then `plant`, then
 * `water` on one tile is a chain of consumption, not a node with three edges.
 */
function planProducerNodeOnTile(state: PlanScriptState, tile: string): PlanNode | undefined {
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const candidate = state.nodes[index]!;
    if (state.worldTileByNode.get(candidate.nodeId) === tile) return candidate;
  }
  return undefined;
}

/**
 * HOW MANY STEPS OF ONE ACTION THE COMPILER ORDERS EXACTLY, AND WHY THERE IS A LIMIT AT ALL.
 *
 * The shortest visiting order is a travelling-salesman path: exact computation is exponential in the batch. Twelve steps
 * is 2^12 x 12 x 12 = 590k relaxations - a small fraction of the 250 ms window the script itself runs inside - while past
 * it the order is nearest-first, which is not always the shortest. The guarantee the caller reads is NOT "the shortest":
 * it is `planPathOrderedProgram`'s own check, "never longer than the order the script wrote", which holds at both sizes.
 */
const PLAN_PATH_EXACT_STEPS = 12;

/** One node of the program, with the tile it names beside it - the only position the plan itself carries. */
type PlanPathStep = Readonly<{
  node: PlanNode;
  /** The piece of world this step addresses, or `null` when it names none (`move_to_tile`, `dismiss_modal`). */
  tile: PlanTile | null;
  /** The call that wrote this node, so a renumbering carries the call account across with it. */
  call: number;
}>;

/** The program's nodes in path order, and where each node id ended up after the renumbering a reorder needs. */
type PlanPathOrder = Readonly<{ nodes: readonly PlanNode[]; renamed: ReadonlyMap<string, string> }>;

/** The walk between two tiles: Manhattan, which is what a body with no obstacle in the way spends. */
function planTileDistance(from: PlanTile, to: PlanTile): number {
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
}

/** The length of walking the given tiles in the order given, starting from `from`. */
function planPathLength(tiles: readonly PlanTile[], from: PlanTile): number {
  let length = 0;
  let standing = from;
  for (const tile of tiles) {
    length += planTileDistance(standing, tile);
    standing = tile;
  }
  return length;
}

/**
 * The shortest order to visit every tile from where she stands: dynamic programming over the SET already visited.
 *
 * `best[mask][last]` is the shortest walk that starts at `from`, covers exactly `mask` and ends at `last` - Held-Karp,
 * exact, and `undefined` past `PLAN_PATH_EXACT_STEPS` because the table is 2^count long. Ties resolve to the earliest
 * step the script wrote, so the same batch always compiles to the same program.
 */
function planShortestOrder(tiles: readonly PlanTile[], from: PlanTile): readonly number[] | undefined {
  const count = tiles.length;
  if (count === 0 || count > PLAN_PATH_EXACT_STEPS) return undefined;
  const full = (1 << count) - 1;
  const cell = (mask: number, last: number): number => mask * count + last;
  const best = new Array<number>((full + 1) * count).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Array<number>((full + 1) * count).fill(-1);
  for (let index = 0; index < count; index += 1) best[cell(1 << index, index)] = planTileDistance(from, tiles[index]!);
  for (let mask = 1; mask <= full; mask += 1) {
    for (let last = 0; last < count; last += 1) {
      const walked = best[cell(mask, last)]!;
      if (walked === Number.POSITIVE_INFINITY) continue;
      for (let next = 0; next < count; next += 1) {
        if ((mask & (1 << next)) !== 0) continue;
        const reached = walked + planTileDistance(tiles[last]!, tiles[next]!);
        if (reached >= best[cell(mask | (1 << next), next)]!) continue;
        best[cell(mask | (1 << next), next)] = reached;
        cameFrom[cell(mask | (1 << next), next)] = last;
      }
    }
  }
  let last = 0;
  for (let index = 1; index < count; index += 1) if (best[cell(full, index)]! < best[cell(full, last)]!) last = index;
  const order: number[] = [];
  let mask = full;
  while (mask !== 0) {
    order.push(last);
    const previous = cameFrom[cell(mask, last)]!;
    mask ^= 1 << last;
    last = previous;
  }
  return order.reverse();
}

/**
 * Nearest-first from where she stands, ties broken by the order the script wrote: the order used past
 * `PLAN_PATH_EXACT_STEPS`, where a strip of sixty-four tiles is an ordinary plan.
 */
function planNearestOrder(tiles: readonly PlanTile[], from: PlanTile): readonly number[] {
  const remaining = tiles.map((_, index) => index);
  const order: number[] = [];
  let standing = from;
  while (remaining.length > 0) {
    let nearest = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      const candidate = planTileDistance(standing, tiles[remaining[index]!]!);
      if (candidate < planTileDistance(standing, tiles[remaining[nearest]!]!)) nearest = index;
    }
    const chosen = remaining.splice(nearest, 1)[0]!;
    order.push(chosen);
    standing = tiles[chosen]!;
  }
  return order;
}

/**
 * The tile the body stands on when the step at `index` begins: the last positioned step before it, else the tile the
 * snapshot says she stands on.
 *
 * `nodeTile` is the position a step NAMES - for a targeted action the target, for a walk the tile she ends on - which is
 * the only position the plan itself carries. The Mod chooses the adjacent stand tile for a target on its own, so this is
 * the plan's own measure of the walk and not the walk itself; both sides of every comparison are taken this way.
 */
function planStandingTile(steps: readonly PlanPathStep[], index: number, snapshot: Snapshot): PlanTile {
  for (let back = index - 1; back >= 0; back -= 1) {
    const named = nodeTile(steps[back]!.node);
    if (named !== undefined) return named;
  }
  return { x: snapshot.tile.x, y: snapshot.tile.y };
}

/**
 * The batches the program contains: maximal runs of CONSECUTIVE steps of ONE action, each naming a DIFFERENT piece of
 * world, with no edge among them.
 *
 * THIS IS THE SAME SHAPE `authoredRunAt` PACKS, read for the other question. That pass reads written order to decide how
 * many native uses a rectangle needs; this one reads the same run to decide which of those uses is walked to first. The
 * four rules are the compiler's own, read from the other side:
 *  - A PIECE OF WORLD: two `move_to_tile` steps are NOT interchangeable - the last one decides where she ends up - and
 *    the surface's `targetFamily` is what says which steps address state instead of a place to stand.
 *  - ONE ACTION: two actions on two tiles may still be a sequence (`till` then `plant`), and only a repeated action says
 *    the steps are alternatives of one job.
 *  - DIFFERENT TILES: a second step on a tile the run already names consumes the first, which is the next rule.
 *  - NO EDGE AMONG THEM: `dependsOn` is "I consume its fact", and a batch is reordered only where there is nothing to
 *    consume. Distinct tiles imply it for authored steps; after packing a use consumes nothing (`authoredRunAt` breaks a
 *    run at any step that carries an edge), so the check states what holds rather than assuming it.
 */
function planBatchRuns(steps: readonly PlanPathStep[]): readonly Readonly<{ from: number; to: number }>[] {
  const runs: { from: number; to: number }[] = [];
  let open = -1;
  const close = (end: number): void => {
    if (open >= 0 && end - open > 1) runs.push({ from: open, to: end });
    open = -1;
  };
  steps.forEach((step, index) => {
    if (step.tile === null) {
      close(index);
      return;
    }
    if (open >= 0) {
      const tile = step.tile;
      const members = steps.slice(open, index);
      const continues =
        steps[open]!.node.actionId === step.node.actionId &&
        members.every((member) => member.tile!.x !== tile.x || member.tile!.y !== tile.y) &&
        !members.some((member) => step.node.dependsOn.includes(member.node.nodeId));
      if (!continues) close(index);
    }
    if (open < 0) open = index;
  });
  close(steps.length);
  return runs;
}

/**
 * The node that immediately follows `nodeId` in the program: what an insertion's `before=<id>` states.
 *
 * An insertion is always written immediately before one of her own steps, so it always has a successor. When that ever
 * stops being true the answer names the inserted node itself - a name a reader can see is wrong - rather than an empty
 * field it would have to interpret.
 */
function planFollowingNodeId(nodes: readonly PlanNode[], nodeId: string): string {
  const index = nodes.findIndex((node) => node.nodeId === nodeId);
  return index < 0 ? nodeId : (nodes[index + 1]?.nodeId ?? nodeId);
}

/**
 * THE PROGRAM IN PATH ORDER: every batch of independent steps of one action, re-ordered from where the body stands.
 *
 * <p>
 * WHY (measured, `round66`). One node per builder call, in call order, and an ordering edge carrying that order to the
 * game - so a script that named three crops in the order it happened to read them walked the field three times. That run
 * walked **647 tiles (Manhattan) in 1230 s over 37 positioned events, 38 tiles per world-changing action**
 * (`_multiday_routine-round66-live-runner.log`), and walking is 93.6% of a node's time (`body-program-packing.ts`). The
 * submitted program `plan_4_bba49665079fd0dd` is the plain case: three `harvest_crop` nodes at `(60,10)`, `(58,14)`,
 * `(60,9)` from the tile `61,11` - 15 tiles of walk where 10 is the shortest, out to the isolated crop and back past the
 * middle one.
 * </p>
 * <p>
 * IT IS A COMPILE-TIME OPTIMISATION AND IT IS INVISIBLE TO HER: the same nodes, the same arguments, the same action ids -
 * only the order changes. Her `for` loop reads the same and walks less.
 * </p>
 * <p>
 * IT RUNS AFTER `packAuthoredRuns`, AND THE SPLIT IS THE POINT. Packing answers WHAT the steps are - one authored step per
 * tile becomes the few native uses that cover the rectangle - and this pass answers WHICH of them is walked to first. Run
 * the other way round, every packed use would be left in the packing pass's own order, which is the walk the packing
 * exists to save. Two consequences follow from running second, and both are stated here because both would be silently
 * wrong:
 * </p>
 * <ul>
 * <li>THE TILE IS READ FROM THE NODE'S OWN ARGUMENTS AND THE SURFACE'S `targetFamily`, not from `state.worldTileByNode`:
 * that map is written where the action is in hand and is stale the moment packing rewrites the program.</li>
 * <li>`dependsOn` IS REMAPPED, NEVER RE-DERIVED BY TILE. For an authored step its named tile is all it works, which is
 * why `emitPlanNode` can find its producer by tile. A packed use's named tile is its ANCHOR, and the ground it produces is
 * its whole footprint - so "the nearest earlier step on the same tile" would drop the planting edge that a use three
 * tiles away really owns, which is the one thing the packing pass's own docblock warns can go wrong silently.</li>
 * </ul>
 * <p>
 * THE GUARANTEE IS ONE LINE AND IT IS CHECKED, NOT ASSUMED: the emitted order is NEVER LONGER than the order the script
 * wrote. The shortest order below `PLAN_PATH_EXACT_STEPS` makes that true by construction, nearest-first above it does
 * not (a greedy first step can be worse than an arbitrary order), so the lengths are compared and the script's order is
 * kept when the path is not shorter. A batch already written as a path is therefore left EXACTLY as written.
 * </p>
 * <p>
 * WHAT A REORDER COSTS: node ids are positional (`planNodeId`), so the program is renumbered from its new order; every id
 * an edge names is looked up in that table, `orderedAfter` is written fresh from the step before it (the rule
 * `packAuthoredRuns` applies to the same field), and the call account and insertion record are carried across the same
 * table so no part of the answer names a node that is no longer there.
 * </p>
 */
function planPathOrderedProgram(
  state: PlanScriptState,
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
): PlanPathOrder {
  const addressed = new Set(actions.filter((action) => action.targetFamily !== null).map((action) => action.actionId));
  const steps: PlanPathStep[] = state.nodes.map((node) =>
    Object.freeze({
      node,
      tile: addressed.has(node.actionId) ? (nodeTile(node) ?? null) : null,
      call: state.callOfNode.get(node.nodeId) ?? 0,
    }),
  );
  let reordered = false;
  for (const run of planBatchRuns(steps)) {
    const members = steps.slice(run.from, run.to);
    const tiles = members.map((member) => member.tile!);
    const standing = planStandingTile(steps, run.from, snapshot);
    const order = planShortestOrder(tiles, standing) ?? planNearestOrder(tiles, standing);
    const path = order.map((index) => tiles[index]!);
    if (planPathLength(path, standing) >= planPathLength(tiles, standing)) continue;
    steps.splice(run.from, members.length, ...order.map((index) => members[index]!));
    reordered = true;
  }
  if (!reordered) return Object.freeze({ nodes: state.nodes, renamed: new Map<string, string>() });
  const renamed = new Map<string, string>();
  steps.forEach((step, index) => {
    renamed.set(step.node.nodeId, planNodeId(nodeIdPrefixOf(step.node.nodeId), index + 1));
  });
  const nodes = steps.map((step, index): PlanNode => {
    const nodeId = renamed.get(step.node.nodeId)!;
    const dependsOn = Object.freeze(
      [
        ...new Set(
          step.node.dependsOn.flatMap((id) => {
            const at = renamed.get(id);
            return at === undefined ? [] : [at];
          }),
        ),
      ].filter((id) => id !== nodeId),
    );
    const previous = index === 0 ? undefined : renamed.get(steps[index - 1]!.node.nodeId)!;
    return Object.freeze({
      nodeId,
      actionId: step.node.actionId,
      arguments: step.node.arguments,
      dependsOn,
      // ONE ORDERING EDGE PER NODE, the rule the packing pass writes to the same field: every published action claims the
      // one body, so two steps ordered by neither are refused as `resource_conflict`.
      ...(previous === undefined || dependsOn.includes(previous) ? {} : { orderedAfter: Object.freeze([previous]) }),
      bindings: step.node.bindings,
    });
  });
  state.callOfNode = new Map(steps.map((step) => [renamed.get(step.node.nodeId)!, step.call] as const));
  state.insertedNodeIds = state.insertedNodeIds.map((id) => renamed.get(id) ?? id);
  state.inserted = state.inserted.map((insertion) => ({
    actionId: insertion.actionId,
    nodeId: renamed.get(insertion.nodeId) ?? insertion.nodeId,
  }));
  return Object.freeze({ nodes: Object.freeze(nodes), renamed });
}

/** The first in-map tile index on either axis. Stardew tile space starts at (0,0); a negative index is outside the map. */
const MAP_ORIGIN_TILE = 0;

/**
 * What became of the walk this compiler writes before a transition, which is three answers rather than two.
 *
 * `written` is the ordinary case; `not_needed` is a step the plan already performs; `refused` is a walk this compiler
 * cannot place, and it carries the reason its answer names instead of a node. The third state is not a failure of the
 * plan: it is the compiler declining to invent a coordinate it cannot check (`round89`'s `plan_12`).
 */
type PlanWalk =
  | Readonly<{ kind: "written"; node: PlanNode }>
  | Readonly<{ kind: "not_needed" }>
  | Readonly<{ kind: "refused"; reasonCode: string; tile: Readonly<{ x: string; y: string }> }>;

/** No walk is written, and nothing is owed: either the action is no transition, or the plan already stands there. */
const NO_WALK: PlanWalk = Object.freeze({ kind: "not_needed" });

/**
 * The compiler's own walk to a transition's source tile, or the reason it cannot write one.
 *
 * <p>
 * THE STEP CARRIES THE TRANSITION'S OWN COORDINATES. `move_to_tile` is what makes that executable: it accepts a warp
 * tile as its target and, because the target is a warp the actor would trigger by stopping on it, arrives ADJACENT
 * instead of on top of it (`farmhandexecutioncontroller.movementactions.cs:62-63`, `nativeWarpTarget` ->
 * `adjacentArrival`) - which is exactly the relationship `enter_exit` gates on. The tile is also legal as an
 * `enter_exit` target by the Mod's own three-way warp rule (same file, `IsWarpBufferTile`).
 * </p>
 * <p>
 * A SOURCE OUTSIDE THE GRID IS A BOUNDARY, NOT A CELL, so no walk is written for it. An edge exit's source is one tile
 * outside the map (`-1 53 BusStop` for the west edge, `40 -1 Backwoods` for the north), and this used to be answered by
 * clamping the off-map axis to the map's first index - a number that is in range and still not a place. Measured
 * `round89` (`plan_12`, 2026-11-21T20-38-52-354Z): `enter_exit(40,-1)` from the Farm, the walk written to `(40,0)`, and
 * the map answered `target_not_addressable;target_on_map=true` with `north:off_map` and three `buildings_tile:blocked`
 * neighbours - the Farm's top row is wall. Which cell beside that boundary admits a body is the MAP's answer and nothing
 * on the wire publishes it, so the honest move is to write no step at all: her transition then runs alone and any refusal
 * is the world's answer to the coordinate she named. The refusal travels beside the program (`autoWalkRefused`), never as
 * a node that could be refused or abandoned in her plan.
 * </p>
 * <p>
 * A STEP THAT ALREADY STANDS BESIDE THE DOOR IS NOT WALKED TO TWICE. `enter_exit` declares `adjacent` - one tile
 * (`FarmhandActionApproachRequirement.Adjacent`, so `approachRequirement.withinTiles` is `1`) - so a plan whose previous
 * step already stands within that distance has done the work this node would do. Measured `round89` (`plan_75`):
 * `move_to_tile(3,11)` then `enter_exit(3,12)`, a second walk written to the door's own tile, dispatched, never settled,
 * and abandoned twelve minutes later by the journal heal. The distance is read from the SURFACE's declaration (a surface
 * that states none falls back to `0`, the same tile, which is the rule this replaced); nothing here restates a radius.
 * </p>
 * <p>
 * The id is `auto_walk_<position>` rather than `n<position>` so a journal reader can tell which plan node the compiler
 * wrote, while the author's own nodes keep the order, arguments and relative position its script gave them. The position
 * is passed in rather than derived here, because the dismissal written after a body-yielding step occupies a position too
 * and the whole program is numbered once.
 * </p>
 */
function transitionApproachNode(
  action: PublishedPlanAction,
  canonical: Readonly<Record<string, PlanArgument>>,
  state: PlanScriptState,
  nodeId: string,
): PlanWalk {
  if (!TRANSITION_SOURCE_PLAN_ACTION_IDS.includes(action.actionId)) return NO_WALK;
  const x = canonical.x;
  const y = canonical.y;
  if (x?.type !== "integer" || y?.type !== "integer") return NO_WALK;
  const sourceX = Number(x.canonicalValue);
  const sourceY = Number(y.canonicalValue);
  if (sourceX < MAP_ORIGIN_TILE || sourceY < MAP_ORIGIN_TILE)
    return Object.freeze({
      kind: "refused",
      // The Mod's own word for it (`RefusalFacts.MoveToTile`): the coordinate is not a tile of the map the actor stands
      // on. No second spelling, so a companion that has seen the receipt recognises the reason.
      reasonCode: "target_off_map",
      tile: Object.freeze({ x: x.canonicalValue, y: y.canonicalValue }),
    });
  const previous = state.nodes[state.nodes.length - 1];
  if (previous !== undefined && planWalkReaches(previous, sourceX, sourceY, approachTilesOf(action))) return NO_WALK;
  return Object.freeze({
    kind: "written",
    node: Object.freeze({
      nodeId,
      actionId: MOVE_TO_TILE_ACTION_ID,
      arguments: Object.freeze({ x, y }),
      // A walk consumes nothing: where the body stands is not a piece of world state another step produced (`move_to_tile`
      // declares no target family), so a failed walk orders the step after it rather than skipping it.
      dependsOn: Object.freeze([]),
      ...(previous === undefined ? {} : { orderedAfter: Object.freeze([previous.nodeId]) }),
      bindings: Object.freeze({}),
    }),
  });
}

/**
 * How close a step must already stand to a transition's source for the walk to be unnecessary.
 *
 * The distance is the surface's (`approachRequirement.withinTiles`), and `0` when the surface states none - which is the
 * same-tile rule this replaced, kept for the actions that declare no approach at all. Allowing a `null` distance to mean
 * "anywhere will do" would turn an undeclared requirement into a claim the surface never made.
 */
function approachTilesOf(action: PublishedPlanAction): number {
  const approach = action.approachRequirement;
  return approach.declared && approach.withinTiles !== null ? approach.withinTiles : 0;
}

/** Whether a node already puts the body within `tiles` (Chebyshev) of the transition's source tile. */
function planWalkReaches(previous: PlanNode, sourceX: number, sourceY: number, tiles: number): boolean {
  if (previous.actionId !== MOVE_TO_TILE_ACTION_ID) return false;
  const x = previous.arguments.x;
  const y = previous.arguments.y;
  if (x?.type !== "integer" || y?.type !== "integer") return false;
  return Math.max(Math.abs(Number(x.canonicalValue) - sourceX), Math.abs(Number(y.canonicalValue) - sourceY)) <= tiles;
}

/** An integer plan argument: the whole-number wire value, canonicalized to its exact decimal spelling. */
/**
 * ONE PACKED AREA IS NOT A FORM: the rectangle a run of authored steps covers, packed into the uses that cover it.
 *
 * <p>
 * WHAT THIS REPLACED. The packing pass used to hang off `for_each`, whose one node declared a rectangle; the script's own
 * batch is a `for` loop writing one builder call per tile, and each of those calls is a dispatch. A 3x20 patch tilled that
 * way is sixty dispatches of which fifty-seven are refused `soil_already_tilled` - every walk the packing existed to save,
 * handed straight back. So the pass reads the TILES THE AUTHOR NAMED instead of a `source` key: consecutive steps of one
 * action at one charge, whose tiles form a filled rectangle, become the same few native uses. Nothing about how far one
 * use reaches is decided here - that is `body-program-packing.ts`'s ladder, pinned to the engine's own `tilesAffected`.
 * </p>
 * <p>
 * THE CONSUMER RULE IS THE HALF THAT CAN BE WRONG SILENTLY. `emitPlanNode` gives a step on a tile the node that worked
 * that tile, and `dependsOn` means "skip me if it failed". Packing removes those nodes, so every edge into them has to be
 * repointed at the USE THAT COVERS THE TILE - not at the previous node (which is `orderedAfter`, "wait, then run anyway")
 * and not left as a reference to a node no longer in the program. A packed use that failed must skip the planting written
 * on the ground it did not till.
 * </p>
 */
type PackedAuthoredRun = Readonly<{
  first: number;
  length: number;
  action: PublishedPlanAction;
  steps: PackingResult["steps"];
}>;

/** Every run of authored steps this program can be packed into, in written order. */
function authoredRuns(
  state: PlanScriptState,
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
): readonly PackedAuthoredRun[] {
  const runs: PackedAuthoredRun[] = [];
  let index = 0;
  while (index < state.nodes.length) {
    const run = authoredRunAt(state, index, snapshot, actions);
    if (run === null) {
      index += 1;
      continue;
    }
    runs.push(run);
    index = run.first + run.length;
  }
  return runs;
}

/**
 * The run that starts at `start`, or `null` when that step cannot begin one.
 *
 * A run is ONE action, ONE charge and a filled rectangle, and every step of it must be one the author wrote as a single
 * tile with no consumer of its own: the packing replaces whole steps, so a step that carries an edge is not a tile in a
 * rectangle, it is a step on top of something.
 */
function authoredRunAt(
  state: PlanScriptState,
  start: number,
  snapshot: Snapshot,
  actions: readonly PublishedPlanAction[],
): PackedAuthoredRun | null {
  const first = state.nodes[start];
  if (first === undefined || !first.nodeId.startsWith(PLAN_AUTHOR_NODE_PREFIX)) return null;
  const action = actions.find((candidate) => candidate.actionId === first.actionId);
  if (action === undefined || action.targetFamily === null) return null;
  if (packingKindOf(action.arguments.map((argument) => argument.name)) !== "charged_rectangle") return null;
  const charge = planIntegerOf(first.arguments.charge);
  if (charge === undefined) return null;
  const tiles: { x: number; y: number }[] = [];
  const seen = new Set<string>();
  let index = start;
  while (index < state.nodes.length) {
    const node = state.nodes[index]!;
    if (!node.nodeId.startsWith(PLAN_AUTHOR_NODE_PREFIX)) break;
    if (node.actionId !== action.actionId) break;
    if (node.dependsOn.length > 0 || planIntegerOf(node.arguments.charge) !== charge) break;
    const key = tileKeyOf(node.arguments);
    if (key === null || seen.has(key)) break;
    const x = planIntegerOf(node.arguments.x);
    const y = planIntegerOf(node.arguments.y);
    if (x === undefined || y === undefined) break;
    seen.add(key);
    tiles.push({ x, y });
    index += 1;
  }
  const length = index - start;
  if (length < 2) return null;
  const area = boundingBoxOf(tiles);
  // A FILLED RECTANGLE OR NOTHING. A footprint is a region, so a run whose tiles already fill their own bounding box is
  // the one shape whose `area` a rectangle can say; anything else would cover tiles the author never named.
  if (area.w * area.h !== length) return null;
  const requirement = action.toolRequirement;
  const ceiling = toolChargeCeilingForClaim(snapshot, requirement.declared ? requirement : undefined);
  // No readable ceiling, no packing - and a charge above the tool is the Mod's refusal to make per use, by name.
  if (ceiling === undefined || charge > ceiling) return null;
  const packing = packAreaSteps({ area, kind: "charged_rectangle", maximumCharge: ceiling });
  if (packing.status !== "packed" || packing.steps.length >= length) return null;
  return Object.freeze({ first: start, length, action, steps: packing.steps });
}

/** The bounding box of a set of tiles: the rectangle a run of them can be packed as. */
function boundingBoxOf(tiles: readonly Readonly<{ x: number; y: number }>[]): Readonly<{
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    minX = Math.min(minX, tile.x);
    minY = Math.min(minY, tile.y);
    maxX = Math.max(maxX, tile.x);
    maxY = Math.max(maxY, tile.y);
  }
  return Object.freeze({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
}

/** One step's integer argument, or `undefined` when it is not an integer this compiler wrote. */
function planIntegerOf(value: PlanArgument | undefined): number | undefined {
  if (value === undefined || value.type !== "integer") return undefined;
  const parsed = Number(value.canonicalValue);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Rewrites the program so every packable run becomes the native uses that cover it, and repoints every edge into it.
 *
 * Ids are positional (`n01`, `auto_walk_02`), so the rewrite renumbers the whole program: the map from an old node id to
 * the node that now does its work is what keeps `dependsOn`, `orderedAfter`, the call account and the insertion record
 * naming nodes that are in the program.
 */
function packAuthoredRuns(state: PlanScriptState, snapshot: Snapshot, actions: readonly PublishedPlanAction[]): void {
  const runs = authoredRuns(state, snapshot, actions);
  if (runs.length === 0) return;
  const runByFirst = new Map(runs.map((run) => [run.first, run] as const));
  type Rebuilt = Readonly<{
    prefix: string;
    actionId: string;
    arguments: Readonly<Record<string, PlanArgument>>;
    consumed: readonly string[];
    call: number;
  }>;
  const rebuilt: Rebuilt[] = [];
  /** An old node id -> the index in `rebuilt` of the node that now does that work. */
  const performs = new Map<string, number>();
  let index = 0;
  while (index < state.nodes.length) {
    const node = state.nodes[index]!;
    const run = runByFirst.get(index);
    if (run === undefined) {
      performs.set(node.nodeId, rebuilt.length);
      rebuilt.push({
        prefix: nodeIdPrefixOf(node.nodeId),
        actionId: node.actionId,
        arguments: node.arguments,
        consumed: node.dependsOn,
        call: state.callOfNode.get(node.nodeId) ?? 0,
      });
      index += 1;
      continue;
    }
    const call = state.callOfNode.get(node.nodeId) ?? 0;
    const covering = new Map<string, number>();
    for (const step of run.steps) {
      const entry = rebuilt.length;
      rebuilt.push({
        prefix: PLAN_AUTHOR_NODE_PREFIX,
        actionId: run.action.actionId,
        arguments: Object.freeze({
          x: Object.freeze({ type: "integer" as const, canonicalValue: String(step.x) }),
          y: Object.freeze({ type: "integer" as const, canonicalValue: String(step.y) }),
          charge: Object.freeze({ type: "integer" as const, canonicalValue: String(step.charge) }),
        }),
        consumed: Object.freeze([]),
        call,
      });
      for (const tile of footprintTiles({ x: step.x, y: step.y }, TOOL_FOOTPRINT_TILES_BY_CHARGE[step.charge]!, "y"))
        covering.set(`${String(tile.x)},${String(tile.y)}`, entry);
    }
    for (let offset = 0; offset < run.length; offset += 1) {
      const member = state.nodes[index + offset]!;
      const key = tileKeyOf(member.arguments);
      const cover = key === null ? undefined : covering.get(key);
      if (cover !== undefined) performs.set(member.nodeId, cover);
    }
    index += run.length;
  }
  const idOf = (position: number): string => planNodeId(rebuilt[position]!.prefix, position + 1);
  state.nodes = rebuilt.map((entry, position) => {
    const own = idOf(position);
    const consumed = [
      ...new Set(
        entry.consumed.flatMap((id) => {
          const at = performs.get(id);
          return at === undefined ? [] : [idOf(at)];
        }),
      ),
    ].filter((id) => id !== own);
    const previous = position === 0 ? undefined : idOf(position - 1);
    return Object.freeze({
      nodeId: own,
      actionId: entry.actionId,
      arguments: entry.arguments,
      dependsOn: Object.freeze(consumed),
      // ONE ORDERING EDGE PER NODE, which is what keeps the Mod's claim rule satisfied: every published action claims the
      // one body, so two steps ordered by neither are refused as `resource_conflict`.
      ...(previous === undefined || consumed.includes(previous) ? {} : { orderedAfter: Object.freeze([previous]) }),
      bindings: Object.freeze({}),
    });
  });
  state.callOfNode = new Map(rebuilt.map((entry, position) => [idOf(position), entry.call] as const));
  state.insertedNodeIds = state.insertedNodeIds.map((id) => {
    const at = performs.get(id);
    return at === undefined ? id : idOf(at);
  });
  // AN INSERTION IS NOT PACKED, so `performs` answers itself for every one of them: the record still says which nodes the
  // compiler wrote, and the step each precedes is read off the final program when the answer is built.
  state.inserted = state.inserted.map((insertion) => ({
    actionId: insertion.actionId,
    nodeId: performs.has(insertion.nodeId) ? idOf(performs.get(insertion.nodeId)!) : insertion.nodeId,
  }));
}

/** The id prefix a node was written with, so a renumbered program keeps the compiler's own nodes distinguishable. */
function nodeIdPrefixOf(nodeId: string): string {
  for (const prefix of [PLAN_DISMISSAL_NODE_PREFIX, PLAN_WALK_NODE_PREFIX, PLAN_AUTHOR_NODE_PREFIX])
    if (nodeId.startsWith(prefix)) return prefix;
  return PLAN_AUTHOR_NODE_PREFIX;
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
  // The selector's shape and content are the Host protocol's (`readDestinationSelector`), not this compiler's: a label
  // this minted at a bound the Mod refuses (`256` here, `128` there), or with a trailing space, reached the Mod as a
  // program it could not admit - and an object the model copied out of `find_destination` was refused here for carrying
  // the arm that selector does not use.
  const selector = readDestinationSelector(value, "argument");
  if (selector === null) return undefined;
  return Object.freeze({
    type: "destination_selector" as const,
    destination:
      selector.kind === "label"
        ? Object.freeze({ kind: "label" as const, label: selector.label })
        : Object.freeze({ kind: "ref" as const, ref: selector.ref }),
  });
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
