import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXPRESSION_ONLY_ACTION_IDS, STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { planWorkDescription, planActionsFromRegistrations } from "./body-program-script.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import { buildCandidateToolSchema, createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import {
  type ActionRegistration,
  type ActionRegistrationDescriptor,
  EXECUTION_REQUEST_ARGUMENT_RULES,
  type ExecutionReceipt,
  type ExecutionRequest,
  type Scope,
  type Snapshot,
  executionRequestIntegerBounds,
  validateExecutionRequest,
} from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

/**
 * A Game Action tool states its wire arguments in three places, written by three authoring acts: the
 * DESCRIPTION (what the model is told to supply), the declared SCHEMA (what the SDK admits and what the
 * model sees), and `toArgs` (what actually reaches the bridge). A fourth judgement - the Host protocol's
 * exact-key check - decides whether the resulting request may leave the Host at all.
 *
 * They can disagree, and no other check reads all four together:
 *   * a native-local runner calls `client.execute` directly, so the tool layer and the Host's request
 *     validation never run during a live gate;
 *   * `game-tools-dispatch-args.test.ts` reads the mount blocks out of the source, so it sees that
 *     `toArgs` mentions the declared names but cannot see what the protocol does with the forward nor
 *     what the description promised;
 *   * a schema-only test never calls the tool.
 *
 * The failure that motivated this file was measured, not imagined. Ten published actions built a complete
 * parameter schema and told the model to read the opaque target id and its tile from the latest
 * observation, then forwarded `{}` - so `validateExecutionRequest` refused every call as
 * `invalid_execution_request` before the bridge and the model got a bare code with no fact to act on.
 * `dismount_transport`, an argument-less action whose `{}` the protocol accepts, reached `execute()` in the
 * same harness: that control is what proved the harness itself was right. `travel` additionally declared an
 * OPTIONAL `expectedTargetId` the protocol refuses, and `pickup_forage` required a `sceneTarget` its
 * description never mentioned - the latter is gone with the binding, which no producer could fill.
 *
 * Each test asserts one rule over whatever the Mod publishes, so it follows the catalog rather than a
 * hand-maintained list.
 *
 * THE DECLARED SET IS THE PROTOCOL'S SET. The behavioural probe below proves that what a tool declares is what
 * reaches the bridge, but it can only speak about a tool the model can already call: it reads the schema the tool
 * HAS. The equality test states the rule directly and takes its population from `EXECUTION_REQUEST_ARGUMENT_RULES`,
 * so an action the declaration grows is checked the moment it gets a tool, and a tool whose schema still carries an
 * earlier shape is named rather than measured. The remaining derivation followed from the same table once it carried
 * its whole-number ranges as data (`integerBound`): `executionRequestIntegerBounds` is what the `charge` mounts read,
 * so a schema cannot state a range the validator refuses.
 *
 * THE FOURTH READER IS THE EXAMPLE. `stardew_plan_work` prints calls the model copies, and an example is a stronger
 * instruction than the argument list beside it: `water_crop`'s batch example printed a call without `charge` while the
 * wire demanded it, so the one call the model was shown was the one call it could not make. Its examples are read here
 * against the same declaration, with the loop form's own row-derived and still-omissible names accounted for rather than
 * invented.
 *
 * red-proof: leave `chest_store`'s schema on the pre-`chests` shape ->
 *   `stardew_chest_store (chest_store): the schema declares [expectedQualifiedItemId, expectedTargetId, slot, x, y]
 *    while the protocol pins [chestId, expectedQualifiedItemId]`
 * red-proof, one per gate below (each run against the compiled artifact with that one fact removed):
 *   drop a pinned argument from a mount's schema -> `tool_schema_missing_argument:stardew_till_soil:charge`, and the
 *     end-to-end probe reports the schema's own `{"x":0,"y":0}` refused with `invalid_args`;
 *   drop the charge clause from an example -> `plan_example_omits_argument:water_crop:charge`.
 */
const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);
const GAME_TOOLS_PATH = resolve(hostRoot, "src/game-tools.ts");

const SCOPE: Scope = {
  integrationId: "stardew",
  saveId: "save_gate",
  worldId: "world_gate",
  playerId: "player_gate",
  companionId: "companion_gate",
};

const IDENTITY_ARGUMENT_KEYS = new Set(["requestId", "idempotencyKey"]);
const TARGET_ID = "gateTargetId1";
const QUALIFIED_ITEM_ID = "(O)322";
const MINECART_TARGET_ID = `minecart_${"a".repeat(16)}`;
const SCENE_REF = `sr1_${"a".repeat(16)}`;

type JsonObject = Record<string, unknown>;

type SurfaceAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, Readonly<{ type?: string; enum?: readonly string[] }>>>;
  effect?: string;
  postcondition?: Readonly<{ name?: string }>;
}>;

/** The Mod-owned cross-language action surface: the authority for which actions exist and what they take. */
function publishedSurface(): readonly SurfaceAction[] {
  const parsed = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as {
    schema?: unknown;
    actions?: unknown;
  };
  assert.equal(parsed.schema, "gamebuddy-action-descriptors/v1");
  assert.ok(Array.isArray(parsed.actions));
  return parsed.actions as readonly SurfaceAction[];
}

/** The Mod's published registration for one action, in the wire (`arguments`) descriptor shape. */
function registrationFor(action: SurfaceAction): ActionRegistration {
  const arguments_ = Object.entries(action.argumentSchema ?? {}).map(([name, schema]) => ({
    name,
    type: schema.type ?? "string",
    // The vocabulary travels WITH the argument on the Mod's published surface, so the probe
    // exercises the closed set the Mod declares rather than one this test invents or scrapes
    // out of the C# source.
    ...(schema.enum === undefined ? {} : { enum: schema.enum }),
  }));
  const postconditionName = action.postcondition?.name;
  const descriptor: ActionRegistrationDescriptor = {
    arguments: arguments_,
    effect: (action.effect ?? "write") as "read" | "write",
    nativeBinding: "Fixture.Binding",
    ...(postconditionName === undefined ? {} : { postcondition: { name: postconditionName } }),
  };
  return {
    actionId: action.actionId,
    familyId: action.actionId,
    identityVersion: action.identityVersion,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    descriptor,
  };
}

function buildSnapshot(capabilities: readonly string[]): Snapshot {
  return {
    revision: 7,
    location: "Farm",
    tile: { x: 0, y: 0 },
    stamina: 100,
    health: 100,
    actionable: true,
    exhausted: false,
    capabilities,
    catalogRevision: 1,
    enabledActionIds: capabilities,
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
    raftTargets: [{ targetId: TARGET_ID, x: 0, y: 0 }],
    horseTargets: [{ targetId: TARGET_ID, x: 0, y: 0, name: "Horse" }],
    mineEntranceTargets: [{ targetId: TARGET_ID, x: 0, y: 0 }],
    minecartTargets: [
      {
        targetId: MINECART_TARGET_ID,
        networkId: "minecart_network",
        destinationId: "Mine",
        displayName: "Mine",
        price: 0,
        stationX: 0,
        stationY: 0,
        targetLocation: "Mine",
        targetTileX: 0,
        targetTileY: 0,
      },
    ],
  };
}

function receiptFor(request: ExecutionRequest): ExecutionReceipt {
  return {
    executionId: "exec_gate",
    requestId: request.requestId,
    actionId: request.action,
    state: "succeeded",
    reasonCode: "gate_receipt",
    revision: 7,
    evidence: {},
  };
}

/** A live-looking bridge whose `execute` records the exact request the tool layer produced. */
function buildIntegration(registrations: readonly ActionRegistration[]): {
  integration: MoveCapableIntegration;
  calls: ExecutionRequest[];
} {
  const calls: ExecutionRequest[] = [];
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const integration: MoveCapableIntegration = {
    scope: SCOPE,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "gate_session",
      capabilities,
      catalogRevision: 1,
      enabledActionIds: capabilities,
      snapshot: buildSnapshot(capabilities),
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: registrations,
    },
    async execute(request) {
      calls.push(request);
      return receiptFor(request);
    },
    async cancel() {
      throw new Error("gate_never_cancels");
    },
  };
  return { integration, calls };
}

function admissionFor(integration: MoveCapableIntegration) {
  const ledger = new ExecutionCorrelationLedger((requestId, executionId, reasonCode) =>
    integration.cancel(requestId, executionId, reasonCode),
  );
  const owner = { ownerId: "gate_owner", epoch: 1 };
  return {
    observer: ledger,
    owner,
    cancelExact: (requestId: string, executionId: string, reasonCode: string) =>
      ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
  };
}

function propertiesOf(schema: JsonObject): JsonObject {
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null ? (properties as JsonObject) : {};
}

function requiredOf(schema: JsonObject): readonly string[] {
  const required = schema.required;
  return Array.isArray(required) ? (required as readonly string[]) : [];
}

/** The argument keys a tool declares; the identity fields live outside `args` and are not wire arguments. */
function declaredArgumentKeys(schema: JsonObject, requiredOnly: boolean): readonly string[] {
  const required = new Set(requiredOf(schema));
  return Object.keys(propertiesOf(schema)).filter(
    (key) => !IDENTITY_ARGUMENT_KEYS.has(key) && (!requiredOnly || required.has(key)),
  );
}

/** A schema-satisfying value for one declared argument, so the call fails only on the argument SHAPE. */
function valueFor(node: JsonObject, name: string, action: string): unknown {
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length > 0) return valueFor(variants[0] as JsonObject, name, action);
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (node.const !== undefined) return node.const;
  if (node.type === "integer" || node.type === "number") return typeof node.minimum === "number" ? node.minimum : 1;
  if (node.type === "boolean") return false;
  if (node.type === "object") {
    const value: JsonObject = {};
    for (const [key, child] of Object.entries(propertiesOf(node)))
      value[key] = valueFor(child as JsonObject, key, action);
    return value;
  }
  const pattern = typeof node.pattern === "string" ? node.pattern : "";
  if (pattern.includes("sr1_")) return SCENE_REF;
  if (name === "expectedTargetId") return action === "ride_minecart" ? MINECART_TARGET_ID : TARGET_ID;
  // The item's wire identity is the engine's qualified form; a schema that accepts any string still reaches a
  // protocol row that reads this one as `(prefix)id`, and the probe must not fail on a value IT invented.
  if (name === "expectedQualifiedItemId") return QUALIFIED_ITEM_ID;
  return "aa";
}

function argsFor(schema: JsonObject, keys: readonly string[], action: string): JsonObject {
  const properties = propertiesOf(schema);
  const args: JsonObject = {};
  for (const key of keys) args[key] = valueFor((properties[key] ?? {}) as JsonObject, key, action);
  return args;
}

/** The closed set a schema node declares, read only when EVERY member is a string literal. */
function declaredVocabulary(node: JsonObject): readonly string[] {
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const literals = variants.map((variant) => (variant as JsonObject).const);
    return literals.every((literal) => typeof literal === "string") ? (literals as string[]) : [];
  }
  return Array.isArray(node.enum) && node.enum.every((member) => typeof member === "string")
    ? (node.enum as string[])
    : [];
}

/**
 * One probe per DECLARED VOCABULARY VALUE. A schema that admits a value the Mod's contract declares
 * legal, while the Host's request validator refuses it, is the same defect as a dropped argument: the
 * model is told it may send something the bridge will never see. Probing only the first member, as the
 * shape probes do, cannot see a validator whose closed set is missing one value.
 */
function vocabularyProbes(
  schema: JsonObject,
  keys: readonly string[],
  action: string,
): readonly Readonly<{ label: string; args: JsonObject }>[] {
  const properties = propertiesOf(schema);
  const probes: Array<{ label: string; args: JsonObject }> = [];
  for (const key of keys) {
    for (const value of declaredVocabulary((properties[key] ?? {}) as JsonObject)) {
      probes.push({ label: `${key}=${value}`, args: { ...argsFor(schema, keys, action), [key]: value } });
    }
  }
  return probes;
}

function actionOf(toolName: string): string | undefined {
  for (const [action, name] of Object.entries(STARDEW_ACTION_TOOL_NAMES)) if (name === toolName) return action;
  return undefined;
}

type CallOutcome = Readonly<{ refusal: string | null; forwarded: readonly string[] | null }>;

type MountedTool = Readonly<{
  name: string;
  action: string;
  description: string;
  schema: JsonObject;
  call: (args: JsonObject) => Promise<CallOutcome>;
}>;

/** Every tool the Host mounts for the published surface, driven against a synthetic authenticated bridge. */
function mountedTools(): readonly MountedTool[] {
  const registrations = publishedSurface().map(registrationFor);
  const { integration, calls } = buildIntegration(registrations);
  const tools = createStardewActionTools(integration, undefined, () => admissionFor(integration));
  const mounted: MountedTool[] = [];
  for (const tool of tools) {
    const action = actionOf(tool.name);
    if (action === undefined) continue;
    mounted.push({
      name: tool.name,
      action,
      description: tool.description,
      schema: tool.parameters as unknown as JsonObject,
      call: async (args) => {
        const before = calls.length;
        const result = await tool.execute("gate_call", args, new AbortController().signal, () => {}, {} as never);
        if (calls.length > before) {
          const request = calls[calls.length - 1];
          return { refusal: null, forwarded: request === undefined ? null : Object.keys(request.args) };
        }
        const details = result.details as { reasonCode?: string | null } | undefined;
        return { refusal: details?.reasonCode ?? "unknown_refusal", forwarded: null };
      },
    });
  }
  return mounted;
}

test("every mounted tool forwards what its own schema declares, and the protocol accepts it", async () => {
  const mounted = mountedTools();
  assert.ok(mounted.length >= 60, `expected the mounted tool surface, found ${mounted.length}`);
  const offenders: string[] = [];

  for (const tool of mounted) {
    const required = declaredArgumentKeys(tool.schema, true);
    const all = declaredArgumentKeys(tool.schema, false);
    for (const [label, keys] of [
      ["required", required],
      ["all declared", all],
    ] as const) {
      const outcome = await tool.call(argsFor(tool.schema, keys, tool.action));
      if (outcome.refusal !== null) {
        offenders.push(
          `${tool.name} (${tool.action}): ${label} args [${keys.join(", ")}] were refused with "${outcome.refusal}" before the bridge`,
        );
        continue;
      }
      const forwarded = [...(outcome.forwarded ?? [])].sort();
      const expected = [...keys].sort();
      if (JSON.stringify(forwarded) !== JSON.stringify(expected))
        offenders.push(
          `${tool.name} (${tool.action}): ${label} args [${expected.join(", ")}] reached the bridge as [${forwarded.join(", ")}]`,
        );
    }
    for (const probe of vocabularyProbes(tool.schema, all, tool.action)) {
      const outcome = await tool.call(probe.args);
      if (outcome.refusal !== null)
        offenders.push(
          `${tool.name} (${tool.action}): the schema admits ${probe.label}, which its own validator refused with "${outcome.refusal}" before the bridge`,
        );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a tool that drops or invents arguments is a capability the model can call and never use",
  );
});

test("dismount_transport reaches the bridge with no arguments, which is what proves the harness", async () => {
  const tool = mountedTools().find((candidate) => candidate.name === "stardew_dismount_transport");
  assert.ok(tool !== undefined, "dismount_transport must be mounted");
  assert.deepEqual(await tool.call({}), { refusal: null, forwarded: [] });
});

test("the protocol's exact wire shape matches the Mod-declared arguments for every tooled action", () => {
  const capabilities = publishedSurface()
    .filter((action) => action.kind === "execution")
    .map((action) => action.actionId);
  const snapshot = buildSnapshot(capabilities);
  // A refusal that names a VALUE (`invalid_horse_target`, `invalid_raft_target`, ...) proves the protocol
  // ACCEPTED the key set and rejected a value this probe invented, which is not this test's business. Only
  // these two codes mean the protocol demanded a different set of KEYS.
  const keyShapeCodes = new Set(["invalid_args", "invalid_execution_request"]);
  const offenders: string[] = [];

  for (const action of publishedSurface()) {
    if (action.kind !== "execution") continue;
    if (!(action.actionId in STARDEW_ACTION_TOOL_NAMES)) continue;
    const args: JsonObject = {};
    for (const [name, schema] of Object.entries(action.argumentSchema ?? {}))
      args[name] = valueFor(schema as unknown as JsonObject, name, action.actionId);
    const verdict = validateExecutionRequest(
      {
        requestId: "gateRequestId",
        idempotencyKey: "gateIdempotencyKey",
        action: action.actionId,
        args,
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
      },
      snapshot,
    );
    if (verdict !== null && keyShapeCodes.has(verdict))
      offenders.push(
        `${action.actionId} declares [${Object.keys(args).join(", ")}] but the protocol refused the key set with "${verdict}"`,
      );
  }

  assert.deepEqual(offenders, [], "the Host protocol and the Mod's own wire shape must demand the same keys");
});

/** The argument names a description tells the model to supply, taken from its "must be copied" recipe. */
function instructedNames(description: string): readonly string[] {
  const recipe = /([A-Za-z][A-Za-z0-9_]*(?:(?:,| and)\s+[A-Za-z][A-Za-z0-9_]*)*)\s+must be copied/g;
  return [...description.matchAll(recipe)].flatMap((match) => (match[1] as string).split(/,\s*| and\s+/));
}

test("every tooled action's schema declares exactly the argument set the protocol pins for it", () => {
  const mounted = new Map(mountedTools().map((tool) => [tool.action, tool]));
  const declaredActions = Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES) as readonly ExecutionRequest["action"][];
  const offenders: string[] = [];
  const examined: string[] = [];

  for (const action of declaredActions) {
    const tool = mounted.get(action);
    if (tool === undefined) {
      offenders.push(`${action}: the protocol pins an argument set for it, but no tool is mounted under that action`);
      continue;
    }
    const pinned = EXECUTION_REQUEST_ARGUMENT_RULES[action].find(
      (row) => row.argumentNames !== undefined,
    )?.argumentNames;
    if (pinned === undefined) {
      offenders.push(`${action}: no row pins the exact argument set, so there is nothing to hold the schema against`);
      continue;
    }
    examined.push(action);
    const schemaKeys = [...declaredArgumentKeys(tool.schema, false)].sort();
    const pinnedKeys = [...pinned].sort();
    if (JSON.stringify(schemaKeys) !== JSON.stringify(pinnedKeys)) {
      offenders.push(
        `${tool.name} (${action}): the schema declares [${schemaKeys.join(", ")}] while the protocol pins [${pinnedKeys.join(", ")}]`,
      );
      continue;
    }
    const required = new Set(declaredArgumentKeys(tool.schema, true));
    const optional = pinnedKeys.filter((key) => !required.has(key));
    if (optional.length > 0)
      offenders.push(
        `${tool.name} (${action}): the schema makes [${optional.join(", ")}] optional, but the protocol refuses the request that omits them`,
      );
  }

  assert.ok(examined.length >= 90, `expected the declaration to be walked, examined ${examined.length} actions`);
  assert.deepEqual(
    offenders,
    [],
    "a tool whose schema is not the protocol's own argument set shows the model a shape the validator will refuse",
  );
});

test("a description's argument recipe names only schema arguments and covers every required one", () => {
  const offenders: string[] = [];
  for (const tool of mountedTools()) {
    const instructed = instructedNames(tool.description);
    if (instructed.length === 0) continue;
    const declared = new Set(declaredArgumentKeys(tool.schema, false));
    const invented = instructed.filter((name) => !declared.has(name));
    if (invented.length > 0)
      offenders.push(
        `${tool.name} (${tool.action}) tells the model to copy [${invented.join(", ")}], which its schema does not declare`,
      );
    const unmentioned = declaredArgumentKeys(tool.schema, true).filter(
      (name) => !new RegExp(`\\b${name}\\b`, "u").test(tool.description),
    );
    if (unmentioned.length > 0)
      offenders.push(
        `${tool.name} (${tool.action}) gives a copy recipe but never names the required [${unmentioned.join(", ")}]`,
      );
  }
  assert.deepEqual(
    offenders,
    [],
    "a description that hands the model a recipe must account for every required argument",
  );
});

test("no mount forwards a constant empty argument object", () => {
  const source = readFileSync(GAME_TOOLS_PATH, "utf8");
  const constantEmpty = [...source.matchAll(/toArgs: \(\) => \(\{\}\)/gu)].length;
  assert.equal(
    constantEmpty,
    0,
    "a mount that derives arguments and forwards none is a registered capability that can never execute",
  );
});

/**
 * The argument names one action's declaration pins, read from the row that pins the exact set.
 *
 * Every gate below takes its population from this lookup, so an action the declaration grows is examined the moment it
 * exists rather than when someone remembers to add it to a list here.
 */
function pinnedArguments(action: ExecutionRequest["action"]): readonly string[] | undefined {
  return EXECUTION_REQUEST_ARGUMENT_RULES[action].find((row) => row.argumentNames !== undefined)?.argumentNames;
}

/**
 * A wire-required argument the tool schema leaves out, named for the action that lost it.
 *
 * The equality test above already compares the two sets and reads as one sentence; this one states the rule the other
 * implies, so the failure names the ARGUMENT a caller would have to invent instead of printing two arrays and letting the
 * reader diff them. It is the difference between "a capability the model can call and never use" and the one name that
 * makes it unusable.
 */
test("no tool schema leaves out an argument the wire requires", () => {
  const mounted = new Map(mountedTools().map((tool) => [tool.action, tool]));
  const findings: string[] = [];
  let examined = 0;
  for (const action of Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES) as readonly ExecutionRequest["action"][]) {
    const pinned = pinnedArguments(action);
    const tool = mounted.get(action);
    // An action with no tool is the equality test's finding, not this one's: this gate speaks about schemas that exist.
    if (pinned === undefined || tool === undefined) continue;
    examined += 1;
    const declared = new Set(declaredArgumentKeys(tool.schema, false));
    for (const argument of pinned)
      if (!declared.has(argument)) findings.push(`tool_schema_missing_argument:${tool.name}:${argument}`);
  }
  assert.ok(examined >= 90, `expected the tooled declaration to be walked, examined ${examined} actions`);
  assert.deepEqual(
    findings,
    [],
    "the model is shown a schema that cannot carry an argument the validator demands, so the call is refused before the bridge",
  );
});

/**
 * The arguments a plan example names, taken at its TOP level only.
 *
 * An example's value can be an object of its own (`{ kind: "label", label: "probe" }`), so a comma split would read that
 * value's inner keys as the example's arguments. The scanner counts brackets and only closes an entry at depth zero.
 */
function exampleArgumentNames(body: string): readonly string[] {
  const names: string[] = [];
  let depth = 0;
  let entry = "";
  const closeEntry = (): void => {
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/u.exec(entry)?.[1];
    if (name !== undefined) names.push(name);
    entry = "";
  };
  for (const character of body) {
    if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      closeEntry();
      continue;
    }
    entry += character;
  }
  closeEntry();
  return names;
}

type PlanExample = Readonly<{
  action: string;
  names: readonly string[];
  /** The double-quoted values the example states, by name - the half a closed-set argument is judged on. */
  strings: readonly (readonly [string, string])[];
  source: "builder" | "step";
}>;

/**
 * The string values a plan example states, by argument name.
 *
 * The names beside this are not enough for an argument the surface declares as a CLOSED SET: `emote: "happy"` and
 * `emote: "joyful"` supply the same name and only one of them is a call the Mod admits, so a gate that reads names alone
 * passes the example it exists to refuse. Only the double-quoted spelling the examples use is read; a value the reader
 * cannot see is reported as absent rather than passed.
 */
function exampleStringValues(body: string): readonly (readonly [string, string])[] {
  return [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"/gu)].map((match) =>
    Object.freeze([match[1]!, match[2]!] as const),
  );
}

/**
 * Every example the plan tool's own description prints, read off the rendered text.
 *
 * One shape is read, because one shape is copied: a `builder.<action>({...})` call, on a line of its own or inside the
 * loop the example is about. Nothing else in the description is parsed - a line that carries no whole builder call
 * teaches no call a caller could copy.
 */
function planExamples(description: string): readonly PlanExample[] {
  const examples: PlanExample[] = [];
  for (const line of description.split("\n")) {
    for (const builder of line.matchAll(/builder\.([a-z0-9_]+)\(\{([^}]*)\}\)/gu))
      examples.push({
        action: builder[1]!,
        names: exampleArgumentNames(builder[2]!),
        strings: exampleStringValues(builder[2]!),
        source: "builder",
      });
  }
  return examples;
}

/**
 * An argument a plan example omits and a caller would have to add before the example would run.
 *
 * The example is a STRONGER instruction than the argument list - a caller copies it - so an example that leaves out a
 * wire-required argument teaches a call the compiler refuses or the validator refuses (`invalid_args`). Every rendered
 * example is a whole builder call, so every argument the wire pins is one the example must carry.
 */
test("every plan example carries the arguments the wire requires of it", () => {
  const registrations = publishedSurface().map(registrationFor);
  const description = planWorkDescription(planActionsFromRegistrations(registrations));
  const examples = planExamples(description);
  const findings: string[] = [];
  const examined: string[] = [];

  for (const example of examples) {
    if (!(example.action in EXECUTION_REQUEST_ARGUMENT_RULES)) continue;
    const pinned = pinnedArguments(example.action as ExecutionRequest["action"]);
    if (pinned === undefined) continue;
    examined.push(`${example.source}:${example.action}`);
    const supplied = new Set(example.names);
    for (const argument of pinned)
      if (!supplied.has(argument)) findings.push(`plan_example_omits_argument:${example.action}:${argument}`);
  }

  // Zero population is BLOCKED, never green: a description whose examples the parser no longer recognises must fail here
  // rather than agree with itself. `charge` is named because it is the argument this gate was written for.
  assert.ok(examined.length >= 4, `expected the rendered examples to be walked, examined ${examined.join(", ")}`);
  assert.ok(
    examples.some((example) => example.names.includes("charge")),
    "blocked: no rendered example carries a charge, so the parser is not reading the examples it exists for",
  );
  assert.deepEqual(findings, [], "an example a caller copies must be a call the compiler and the wire both accept");
});

/**
 * The words a MOUNTED TOOL admits for one closed-set argument, read out of the schema the mount builds.
 *
 * `buildCandidateToolSchema` renders a closed set as a union of literals (`anyOf: [{ const: ... }]`), which is what the
 * model is shown, so this reads the surface the caller actually copies rather than a second description of it.
 */
function closedSetOf(schema: unknown): readonly string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const record = schema as Readonly<{ anyOf?: readonly Readonly<{ const?: unknown }>[]; const?: unknown }>;
  const members = record.anyOf ?? (record.const === undefined ? [] : [{ const: record.const }]);
  return members.map((member) => member.const).filter((value): value is string => typeof value === "string");
}

/**
 * The closed-set words a gesture takes are on its MOUNTED TOOL, and the plan no longer teaches a row for it.
 *
 * <p>
 * This test used to assert the other way round: `express_emote` was a plan example (`c63a5763`), and the gate read that
 * example's `emote: "<word>"` against the Mod's declared enum. The registry now declares that action - and
 * `face_direction` - expression-only, so the plan builder generates no method for either and the example row is gone. A
 * gate left reading that row would be a test of a section that no longer exists, so it asserts the two facts that
 * replaced it: NO example teaches an expression route, and the closed set is carried by the tool a Game session mounts.
 * </p>
 *
 * <p>
 * The population is every closed-set argument of every action the registry declares expression-only, taken from the
 * Mod's published surface, so an action that gains a second argument joins this gate without an edit - and a word the
 * mount stops publishing fails here by name rather than in a live run.
 * </p>
 */
test("an expression action is no longer a plan example, and its closed set is on the tool a Game session mounts", () => {
  const actions = planActionsFromRegistrations(publishedSurface().map(registrationFor));
  const description = planWorkDescription(actions);
  const expressionOnly = new Set<string>(EXPRESSION_ONLY_ACTION_IDS);
  assert.deepEqual(
    planExamples(description)
      .filter((example) => expressionOnly.has(example.action))
      .map((example) => `plan_example_teaches_an_expression_route:${example.action}`),
    [],
    "a gesture is one step by nature; an example here is a call the compiler now refuses as plan_script_unknown_action",
  );

  const byId = new Map(publishedSurface().map((action) => [action.actionId, action] as const));
  const examined: string[] = [];
  for (const actionId of EXPRESSION_ONLY_ACTION_IDS) {
    const action = byId.get(actionId);
    assert.ok(action !== undefined, `${actionId} is declared expression-only but the Mod publishes no such action`);
    const closed = Object.entries(action.argumentSchema ?? {}).filter(([, schema]) => schema.enum !== undefined);
    assert.ok(closed.length > 0, `blocked: ${actionId} declares no closed-set argument, so this gate examines nothing`);
    const registration = registrationFor(action);
    assert.ok(registration.descriptor !== undefined, `${actionId} publishes no descriptor for its mount arm to read`);
    const schema = buildCandidateToolSchema(actionId, registration.descriptor) as unknown as Readonly<{
      properties?: Readonly<Record<string, unknown>>;
    }>;
    for (const [name, declared] of closed) {
      const values = closedSetOf(schema.properties?.[name]);
      assert.deepEqual(
        values,
        [...(declared.enum ?? [])],
        `${actionId}.${name}: the mounted tool's closed set must be the one the Mod declares, in its own order`,
      );
      examined.push(`${actionId}.${name}=${String(values.length)}`);
    }
  }
  assert.ok(examined.length > 0, "blocked: no expression action's closed set was read, so this gate examines nothing");
});

/**
 * A whole-number value a mounted tool ADMITS and the Host's own validator REFUSES.
 *
 * <p>
 * The suite's other probes hand each declared argument its schema's FLOOR, which is how a schema that declares too
 * little is caught; none of them ever hands it the CEILING, so a schema that declares too MUCH passed every one of
 * them. That is the defect this test exists for, and it had already shipped: measured 2026-11-16, fifteen
 * descriptor-derived mounts described `x`/`y` and `slot` as any whole number up to 100000, while `tileRow`/`slotRow`
 * answered `invalid_*_tile`/`invalid_*_slot` above 1000 and 36 - 34 values the schemas admitted and the Host refused. The model was told the value was admissible and the
 * Host refused the call built from it before the bridge - the `charge` class one layer down, where the schema and the
 * validator disagree about the RANGE instead of about the argument set.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE TOOLS THE HOST REALLY BUILDS: every registration comes from the generated
 * `action-surface.v1.json`, `createStardewActionTools` builds the set a session is handed, and each whole-number
 * argument that declares a ceiling contributes one probe. THE AUTHORITY IS THE VALIDATOR ITSELF - the refusal
 * compared is the product's own `reasonCode`, not a second description of the range written here.
 * </p>
 *
 * <p>
 * TWO CONTROLS decide whether an argument can be probed at all, because a refusal does not say WHY it refused. Some
 * tools take a tile or a slot that must equal one the snapshot published, so EVERY value but that one is refused and
 * the ceiling says nothing about the range; those actions are excluded and NAMED, never counted as measured. The
 * controls are the schema's own floor and the next value up: where both are accepted, the range really is what the
 * validator is judging.
 * </p>
 */
test("every whole-number value a mounted tool admits is one the Host's own validator accepts", async () => {
  const mounted = mountedTools();
  assert.ok(mounted.length > 0, "blocked: no tool was mounted, so this gate examines nothing");
  const findings: string[] = [];
  const notMeasured: string[] = [];
  let examined = 0;
  for (const tool of mounted) {
    const required = declaredArgumentKeys(tool.schema, true);
    const args = argsFor(tool.schema, required, tool.action);
    for (const key of required) {
      const node = propertiesOf(tool.schema)[key] as JsonObject | undefined;
      if (node?.type !== "integer" && node?.type !== "number") continue;
      if (typeof node.maximum !== "number") continue;
      const floor = typeof node.minimum === "number" ? node.minimum : 1;
      // The controls: two values INSIDE the declared range. A refusal at either means this action pins the value to
      // one the snapshot published, so the ceiling is not a statement about its range.
      const inside = floor + 1 <= node.maximum ? floor + 1 : node.maximum;
      const control = await tool.call(args);
      const interior = await tool.call({ ...args, [key]: inside });
      if (control.refusal !== null || interior.refusal !== null) {
        notMeasured.push(`${tool.action}.${key}:${control.refusal ?? interior.refusal}`);
        continue;
      }
      examined += 1;
      const ceiling = await tool.call({ ...args, [key]: node.maximum });
      if (ceiling.refusal !== null)
        findings.push(`host_offers_a_value_the_wire_refuses:${tool.name}:${key}=${node.maximum}:${ceiling.refusal}`);
    }
  }
  assert.ok(
    examined > 0,
    "blocked: no mounted tool declares a bounded whole-number argument whose range the validator judges, so every schema agrees with itself",
  );
  assert.deepEqual(
    findings,
    [],
    `a value the schema admits and the validator refuses is a call the model is told it may make: ${findings.join(" | ")}` +
      ` [not measured, the action pins the value to a published target: ${notMeasured.join(", ")}]`,
  );
});

/**
 * The loop closes: a call built ONLY from the rendered `till_soil` schema passes the real validator.
 * Every other test here compares statements about the schema - its names, its bounds, what the mount forwards. This one
 * hands the schema's own required arguments to `validateExecutionRequest`, so the two halves are tied by behaviour: while
 * the schema lacked `charge`, the arguments it declared were refused with `invalid_args` before the bridge, which is the
 * Host-side spelling of the Mod's `row_argument_missing:charge`.
 */
test("a call built from the rendered till_soil schema passes the real validator", () => {
  const tool = mountedTools().find((candidate) => candidate.action === "till_soil");
  assert.ok(tool !== undefined, "till_soil must be mounted");
  const snapshot = buildSnapshot(["till_soil"]);
  const args = argsFor(tool.schema, declaredArgumentKeys(tool.schema, true), "till_soil");
  const verdict = validateExecutionRequest(
    {
      requestId: "gateTillRequestId",
      idempotencyKey: "gateTillIdempotencyKey",
      action: "till_soil",
      args,
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    },
    snapshot,
  );
  assert.equal(
    verdict,
    null,
    `a schema-conformant till_soil call must pass the wire, but the schema's own ${JSON.stringify(args)} was refused with "${String(verdict)}"`,
  );
  // The bounded range is the declaration's, held against it rather than against a number this test would have to write
  // twice: the schema must refuse what the wire refuses, so the two are compared as the same fact.
  const declared = executionRequestIntegerBounds("till_soil").find((candidate) => candidate.argument === "charge");
  assert.ok(declared !== undefined, "the till_soil declaration must pin a charge range");
  const charge = propertiesOf(tool.schema).charge as JsonObject;
  assert.equal(charge.minimum, declared.minimum, "the schema's charge floor must be the wire's");
  assert.equal(charge.maximum, declared.maximum, "the schema's charge ceiling must be the wire's");
});
