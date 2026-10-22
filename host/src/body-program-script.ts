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

/** One action as the Mod published it for Body Programs: the id and the argument vocabulary it declares. */
export type PublishedPlanAction = Readonly<{
  actionId: string;
  arguments: readonly Readonly<{ name: string; type: string; enum?: readonly string[] }>[];
}>;

type PlanNode = BodyProgramCandidateRequest["nodes"][number];
type PlanArgument = PlanNode["arguments"][string];

export type PlanScriptRequest = Readonly<{ script: string }>;

export type CompiledPlan =
  | Readonly<{
      ok: true;
      scriptSource: string;
      snapshotRevision: number;
      program: Readonly<{ nodes: readonly PlanNode[] }>;
    }>
  | Readonly<{ ok: false; scriptSource: string; snapshotRevision: number | null; reasonCode: string }>;

/** Frozen maximum node count per program; mirrors `protocol.ts` and the Mod's `BodyProgramValidation.MaximumNodes`. */
export const MAX_PLAN_NODES = 16;

const MAX_PLAN_SCRIPT_CHARS = 8192;
/** Wall-clock budget for one compile. A plan is a loop over a snapshot, not a computation. */
const PLAN_SCRIPT_BUDGET_MS = 50;
/** The script may call the builder more often than it adds nodes (a full plan still checks `isFull`). */
const MAX_PLAN_BUILDER_CALLS = 64;

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
const PLAN_ACTION_LIFECYCLES: readonly string[] = Object.freeze(["published", "live_verified"]);

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
    actions.push(Object.freeze({ actionId: registration.actionId, arguments: Object.freeze(declared) }));
  }
  return Object.freeze(actions);
}

/** The published argument vocabulary, in either shape the wire and the surface artifact use. */
function declaredArgumentsOf(
  registration: ActionRegistration,
): readonly Readonly<{ name: string; type: string; enum?: readonly string[] }>[] | undefined {
  const descriptor = registration.descriptor;
  if (descriptor === undefined) return undefined;
  if (Array.isArray(descriptor.arguments)) {
    const declared = descriptor.arguments.map((argument) =>
      Object.freeze(
        argument.enum === undefined
          ? { name: argument.name, type: argument.type }
          : { name: argument.name, type: argument.type, enum: Object.freeze([...argument.enum]) },
      ),
    );
    return declared.every((argument) => argument.name.length > 0 && argument.type.length > 0) ? declared : undefined;
  }
  const schema = descriptor.argumentSchema;
  if (schema === undefined) return undefined;
  return Object.freeze(
    Object.entries(schema).map(([name, declared]) =>
      Object.freeze(
        declared.enum === undefined
          ? { name, type: declared.type }
          : { name, type: declared.type, enum: Object.freeze([...declared.enum]) },
      ),
    ),
  );
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
  const sandbox = Object.freeze({
    snapshot: deepFreeze(structuredClone(snapshot)),
    builder: createPlanBuilder(dependencies.actions, state),
  });
  const context = createContext(sandbox, {
    name: "gamebuddy-plan-script",
    codeGeneration: { strings: false, wasm: false },
  });
  const global = runInContext("globalThis", context) as Record<string, unknown>;
  for (const name of ABSENT_PLAN_GLOBALS) delete global[name];

  try {
    runInContext(`(function (snapshot, builder) { "use strict";\n${scriptSource}\n})(snapshot, builder);`, context, {
      timeout: PLAN_SCRIPT_BUDGET_MS,
      displayErrors: false,
      filename: "plan-script.js",
    });
  } catch (error) {
    if (state.refusal !== null) return refused(state.refusal, scriptSource, snapshotRevision);
    if (isTimeout(error))
      return refused(`plan_script_timeout:${PLAN_SCRIPT_BUDGET_MS}`, scriptSource, snapshotRevision);
    return refused(`plan_script_threw:${thrownName(error)}`, scriptSource, snapshotRevision);
  }
  // A script may swallow a builder refusal with its own try/catch; the plan is still refused, because the
  // node it asked for was not added and a program missing that node is not the plan the companion wrote.
  if (state.refusal !== null) return refused(state.refusal, scriptSource, snapshotRevision);
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

function refused(reasonCode: string, scriptSource: string, snapshotRevision: number | null): CompiledPlan {
  return Object.freeze({ ok: false as const, scriptSource, snapshotRevision, reasonCode });
}

type PlanScriptState = { nodes: PlanNode[]; refusal: string | null; calls: number };

/**
 * The script's only writing hand: one method per published action, named exactly as the action, taking
 * exactly the arguments that action declares. Methods are generated from the registration vocabulary,
 * never hand-written per action, so a renamed argument cannot leave a stale recipe behind.
 */
function createPlanBuilder(actions: readonly PublishedPlanAction[], state: PlanScriptState): unknown {
  const methods = new Map<string, (arguments_: unknown) => void>();
  for (const action of actions) methods.set(action.actionId, (arguments_) => emitPlanNode(action, arguments_, state));
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "nodeCount") return state.nodes.length;
        if (property === "isFull") return () => state.nodes.length >= MAX_PLAN_NODES;
        const method = methods.get(property);
        if (method !== undefined) return method;
        return refusePlan(`plan_script_unknown_action:${property}`, state);
      },
    },
  );
}

function emitPlanNode(action: PublishedPlanAction, arguments_: unknown, state: PlanScriptState): void {
  state.calls += 1;
  if (state.calls > MAX_PLAN_BUILDER_CALLS) refusePlan(`plan_script_call_cap:${state.calls}`, state);
  if (state.nodes.length >= MAX_PLAN_NODES) refusePlan(`plan_cap_exceeded:${state.nodes.length + 1}`, state);
  // An action that declares no argument is called with none.
  const accepted = arguments_ === undefined && action.arguments.length === 0 ? {} : arguments_;
  if (typeof accepted !== "object" || accepted === null || Array.isArray(accepted))
    refusePlan(`plan_script_argument_not_canonical:${action.actionId}`, state);
  const supplied = accepted as Readonly<Record<string, unknown>>;
  const declared = new Map(action.arguments.map((argument) => [argument.name, argument] as const));
  for (const name of Object.keys(supplied))
    if (!declared.has(name)) refusePlan(`plan_script_unknown_argument:${action.actionId}.${name}`, state);
  const canonical: Record<string, PlanArgument> = {};
  for (const [name, declaration] of declared) {
    if (!Object.hasOwn(supplied, name)) refusePlan(`plan_script_missing_argument:${action.actionId}.${name}`, state);
    const value = canonicalPlanArgument(declaration, supplied[name]);
    if (value === undefined) refusePlan(`plan_script_argument_not_canonical:${action.actionId}.${name}`, state);
    canonical[name] = value;
  }
  // The script's statement order IS the plan's order: "till this tile, then fertilise it" is two calls,
  // and the second must not run before the first. That is one dependency edge per call, nothing more.
  const previous = state.nodes.length === 0 ? undefined : state.nodes[state.nodes.length - 1]!.nodeId;
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
function refusePlan(reasonCode: string, state: PlanScriptState): never {
  state.refusal = reasonCode;
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
