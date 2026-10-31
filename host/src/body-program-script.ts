import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import type { ActionRegistration, BodyProgramCandidateRequest, Snapshot } from "./protocol.js";
import { isNonNegativeSafeInteger, isOpaqueId, isTileCoordinate } from "./protocol-target-facts.js";

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

/** One argument as the Mod declared it: the name a script must use, the kind it must supply, and any closed set. */
type PlanArgumentShape = Readonly<{ name: string; type: string; enum?: readonly string[]; description?: string }>;

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
      /** The surface's own word for the relationship the actor must have with the target. */
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

export type CompiledPlan =
  | Readonly<{
      ok: true;
      scriptSource: string;
      snapshotRevision: number;
      program: Readonly<{ nodes: readonly PlanNode[] }>;
    }>
  | Readonly<{
      ok: false;
      scriptSource: string;
      snapshotRevision: number | null;
      reasonCode: string;
      /** Present when the refusal was a builder call, so the answer names what that action demands. */
      requirement?: PlanArgumentRequirement;
      /** Present when the script threw, so the answer says what the engine said and where. */
      threw?: PlanScriptThrow;
    }>;

/**
 * Frozen maximum node count per program; mirrors `protocol.ts` and the Mod's `BodyProgramValidation.MaximumNodes`.
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

/** The published action whose one job is putting a tool in hand; the `equipFor` helper writes it. */
const EQUIP_TOOL_ACTION_ID = "equip_tool";

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
const WORLD_RESETTING_PLAN_ACTION_IDS: readonly string[] = Object.freeze(["advance_day"]);

const MAX_PLAN_SCRIPT_CHARS = 8192;
/** The engine's message is the caller's to fix; it is bounded because it reaches a model's context. */
const MAX_THROWN_MESSAGE_CHARS = 300;
/** Wall-clock budget for one compile. A plan is a loop over a snapshot, not a computation. */
const PLAN_SCRIPT_BUDGET_MS = 50;
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
 * It stays bounded because the budget is wall-clock anyway (`PLAN_SCRIPT_BUDGET_MS`): an unbounded builder-call counter
 * would let a script spend that budget on no-ops, and the refusal has to arrive as a NAME rather than as a timeout.
 * </p>
 */
const MAX_PLAN_BUILDER_CALLS = 1024;

/** The argument kinds a Body Program node may carry, exactly as the Mod's catalog projection maps them. */
const PLAN_ARGUMENT_TYPES: readonly string[] = Object.freeze(["integer", "string", "boolean", "destination_selector"]);

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
 * One read-only answer about the plan vocabulary: what a script must pass for one action, or for every plannable action
 * of one family. A selection that names nothing answers with the vocabulary that DOES exist, so one wrong guess teaches.
 */
export type PlanShape =
  | Readonly<{ ok: true; actions: readonly PublishedPlanAction[] }>
  | Readonly<{
      ok: false;
      reasonCode: string;
      legalActionIds?: readonly string[];
      legalFamilies?: readonly string[];
    }>;

/** Bounded so a wrong name teaches instead of spending the turn's context on the whole vocabulary. */
const MAX_LISTED_PLAN_IDS = 20;

export function legalPlanActionIds(actions: readonly PublishedPlanAction[]): readonly string[] {
  return Object.freeze(actions.slice(0, MAX_LISTED_PLAN_IDS).map((action) => action.actionId));
}

function legalPlanFamilies(actions: readonly PublishedPlanAction[]): readonly string[] {
  return Object.freeze([...new Set(actions.map((action) => action.familyId))].slice(0, MAX_LISTED_PLAN_IDS));
}

/**
 * Reads the shape of one action or one family straight out of the vocabulary the Mod published for Body Programs.
 * Nothing here is a hand-written table: a renamed argument, a new closed set or a new output fact reaches the answer as
 * soon as the surface reaches the builder.
 */
export function planShape(
  actions: readonly PublishedPlanAction[],
  request: Readonly<{ actionId?: string; family?: string }>,
): PlanShape {
  const actionId = request.actionId;
  const family = request.family;
  if ((actionId === undefined) === (family === undefined))
    return Object.freeze({ ok: false as const, reasonCode: "plan_shape_selector_invalid" });
  if (actionId !== undefined) {
    const action = actions.find((candidate) => candidate.actionId === actionId);
    if (action === undefined)
      return Object.freeze({
        ok: false as const,
        reasonCode: `plan_shape_unknown_action:${actionId}`,
        legalActionIds: legalPlanActionIds(actions),
      });
    return Object.freeze({ ok: true as const, actions: Object.freeze([action]) });
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
 */
export function planWorkDescription(actions: readonly PublishedPlanAction[]): string {
  return (
    "Write one script over the current snapshot and the builder, one builder.<actionId>({...}) call per step, and the host compiles it into a single plan the Mod runs and advances itself - you do not come back between steps. Every action below is a builder method, grouped by the family the Mod declared, with no per-action tool beside them; ask stardew_plan_shape for one action's argument names. Stop when builder.isFull() is true and plan the rest in the next call, in this shape:\n" +
    `${planActionVocabularyText(actions)}\n` +
    "for (const crop of snapshot.cropTargets) {\n" +
    "  builder.water_crop({ x: crop.x, y: crop.y, expectedTargetId: crop.targetId });\n" +
    "}"
  );
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
 * Compiles one plan script against the live snapshot.
 *
 * The script receives a frozen copy of the snapshot and the builder, and produces nodes in call
 * order. Every refusal is named and bounded; a refused script produces NO program, so a partial plan
 * can never be submitted as if it were the plan the companion wrote.
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

  const state: PlanScriptState = { nodes: [], refusal: null, calls: 0 };
  const frozen = deepFreeze(structuredClone(snapshot));
  const sandbox = Object.freeze({
    snapshot: frozen,
    builder: createPlanBuilder(dependencies.actions, frozen, state),
  });
  const context = createContext(sandbox, {
    name: "gamebuddy-plan-script",
    codeGeneration: { strings: false, wasm: false },
  });
  const global = runInContext("globalThis", context) as Record<string, unknown>;
  // global-strip-sandbox: this deletes the withheld capabilities from the fresh context's own global, so a script that reaches one resolves to nothing
  for (const name of ABSENT_PLAN_GLOBALS) delete global[name];

  try {
    runInContext(`(function (snapshot, builder) { "use strict";\n${scriptSource}\n})(snapshot, builder);`, context, {
      timeout: PLAN_SCRIPT_BUDGET_MS,
      displayErrors: false,
      filename: "plan-script.js",
      // The wrapper's opening line is dropped from every reported line number, so a SyntaxError names a line the
      // caller wrote rather than one the wrapper added above it.
      lineOffset: -1,
    });
  } catch (error) {
    if (state.refusal !== null) return refused(state.refusal, scriptSource, snapshotRevision, state.requirement);
    if (isTimeout(error))
      return refused(`plan_script_timeout:${PLAN_SCRIPT_BUDGET_MS}`, scriptSource, snapshotRevision);
    return refused(`plan_script_threw:${thrownName(error)}`, scriptSource, snapshotRevision, undefined, {
      message: thrownMessage(error),
      line: thrownLine(error, scriptSource),
    });
  }
  // A script may swallow a builder refusal with its own try/catch; the plan is still refused, because the
  // node it asked for was not added and a program missing that node is not the plan the companion wrote.
  if (state.refusal !== null) return refused(state.refusal, scriptSource, snapshotRevision, state.requirement);
  if (state.nodes.length === 0) return refused("plan_script_empty", scriptSource, snapshotRevision);
  // A plan is only meaningful against a revision: an accepted plan whose revision is unknown could not be
  // replayed and could not answer idempotency, so that is a refusal rather than a plan with a null revision.
  if (snapshotRevision === null) return refused("plan_snapshot_missing", scriptSource, null);
  return Object.freeze({
    ok: true as const,
    scriptSource,
    snapshotRevision,
    program: Object.freeze({ nodes: Object.freeze([...state.nodes]) }),
  });
}

/**
 * The id a compiled plan is submitted under.
 *
 * Content-addressed on purpose: the SAME plan sent twice in one world must be the same program, so the Mod
 * answers `idempotent` instead of running the work twice; two DIFFERENT plans read from the same snapshot must
 * not collide, or the second would be refused as the first one's duplicate and never run. The snapshot revision
 * keeps a plan in a later world a new program rather than a replay.
 */
export function planProgramId(snapshotRevision: number, nodes: readonly PlanNode[]): string {
  const digest = createHash("sha256").update(JSON.stringify(nodes)).digest("hex").slice(0, 16);
  return `plan_${snapshotRevision}_${digest}`;
}

function refused(
  reasonCode: string,
  scriptSource: string,
  snapshotRevision: number | null,
  requirement?: PlanArgumentRequirement,
  threw?: PlanScriptThrow,
): CompiledPlan {
  return Object.freeze({
    ok: false as const,
    scriptSource,
    snapshotRevision,
    reasonCode,
    ...(requirement === undefined ? {} : { requirement }),
    ...(threw === undefined ? {} : { threw }),
  });
}

type PlanScriptState = {
  nodes: PlanNode[];
  refusal: string | null;
  requirement?: PlanArgumentRequirement;
  calls: number;
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
  for (const action of actions) methods.set(action.actionId, (arguments_) => emitPlanNode(action, arguments_, state));
  const equipFor = (actionId: unknown, target: unknown) => equipForAction(actions, snapshot, actionId, target, state);
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
    refusePlan("plan_script_equip_for_selector_invalid", state);
  const action = actions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined) refusePlan(`plan_script_unknown_action:${actionId}`, state);
  const fromTarget = declaredToolOf(target);
  const requirement = action.toolRequirement;
  const category = requirement.declared ? requirement.category : fromTarget?.toolKind;
  if (category === undefined)
    refusePlan(`plan_script_tool_requirement_undeclared:${action.actionId}`, state, requirementOf(action));
  const slot =
    publishedSlotOfCategory(snapshot, category, requirement) ??
    (fromTarget !== undefined && fromTarget.toolKind === category ? fromTarget.slot : null);
  if (slot === null)
    refusePlan(
      `plan_script_${toolRefusalReason(snapshot)}:${action.actionId}:${category}`,
      state,
      requirementOf(action),
    );
  // The tool the action must name is already in hand, so the plan is the action alone.
  if (publishedToolSlot(snapshot) === slot) return slot;
  const equip = actions.find((candidate) => candidate.actionId === EQUIP_TOOL_ACTION_ID);
  if (equip === undefined)
    refusePlan(`plan_script_equip_unavailable:${EQUIP_TOOL_ACTION_ID}`, state, requirementOf(action));
  // Written through the same emitter as every other node, so the equip step is validated against `equip_tool`'s own
  // declared argument (a semantic tool category, never a slot) exactly as a hand-written call would be.
  emitPlanNode(equip, { tool: category }, state);
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
  });
}

function emitPlanNode(action: PublishedPlanAction, arguments_: unknown, state: PlanScriptState): void {
  state.calls += 1;
  if (state.calls > MAX_PLAN_BUILDER_CALLS) refusePlan(`plan_script_call_cap:${state.calls}`, state);
  if (state.nodes.length >= MAX_PLAN_NODES) refusePlan(`plan_cap_exceeded:${state.nodes.length + 1}`, state);
  const requirement = requirementOf(action);
  // Checked before the arguments, because a step written after a world reset is illegal whatever it carries: no
  // argument can fix it, and answering with an argument problem would send the author back to a call that still
  // cannot run.
  const previousNode = state.nodes.length === 0 ? undefined : state.nodes[state.nodes.length - 1]!;
  if (previousNode !== undefined && WORLD_RESETTING_PLAN_ACTION_IDS.includes(previousNode.actionId))
    refusePlan(`plan_script_action_after_world_reset:${action.actionId}:${previousNode.actionId}`, state, requirement);
  // An action that declares no argument is called with none.
  const accepted = arguments_ === undefined && action.arguments.length === 0 ? {} : arguments_;
  if (typeof accepted !== "object" || accepted === null || Array.isArray(accepted))
    refusePlan(`plan_script_argument_not_canonical:${action.actionId}`, state, requirement);
  const supplied = accepted as Readonly<Record<string, unknown>>;
  const declared = new Map(action.arguments.map((argument) => [argument.name, argument] as const));
  for (const name of Object.keys(supplied))
    if (!declared.has(name)) refusePlan(`plan_script_unknown_argument:${action.actionId}.${name}`, state, requirement);
  const canonical: Record<string, PlanArgument> = {};
  for (const [name, declaration] of declared) {
    if (!Object.hasOwn(supplied, name))
      refusePlan(`plan_script_missing_argument:${action.actionId}.${name}`, state, requirement);
    const value = canonicalPlanArgument(declaration, supplied[name]);
    if (value === undefined)
      refusePlan(`plan_script_argument_not_canonical:${action.actionId}.${name}`, state, requirement);
    canonical[name] = value;
  }
  // The script's statement order IS the plan's order: "till this tile, then fertilise it" is two calls,
  // and the second must not run before the first. That is one dependency edge per call, nothing more.
  const previous = previousNode?.nodeId;
  state.nodes.push(
    Object.freeze({
      nodeId: `n${String(state.nodes.length + 1).padStart(2, "0")}`,
      actionId: action.actionId,
      arguments: Object.freeze(canonical),
      dependsOn: Object.freeze(previous === undefined ? [] : [previous]),
      bindings: Object.freeze({}),
    }),
  );
}

/** The canonical argument the Mod's own declaration asks for, or `undefined` when the script's value is not one. */
function canonicalPlanArgument(
  declaration: Readonly<{ name: string; type: string; enum?: readonly string[] }>,
  value: unknown,
): PlanArgument | undefined {
  switch (declaration.type) {
    case "integer":
      return typeof value === "number" && isNonNegativeSafeInteger(value)
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

/** Records the named refusal and stops the script at the statement that caused it. */
function refusePlan(reasonCode: string, state: PlanScriptState, requirement?: PlanArgumentRequirement): never {
  state.refusal = reasonCode;
  if (requirement !== undefined) state.requirement = requirement;
  throw new Error(reasonCode);
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
