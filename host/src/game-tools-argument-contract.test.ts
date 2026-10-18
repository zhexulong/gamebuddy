import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import { createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import {
  type ActionRegistration,
  type ActionRegistrationDescriptor,
  type ExecutionReceipt,
  type ExecutionRequest,
  type Scope,
  type Snapshot,
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
 * description never mentioned.
 *
 * Each test asserts one rule over whatever the Mod publishes, so it follows the catalog rather than a
 * hand-maintained list.
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
    ...(action.actionId === "pickup_forage"
      ? {
          sceneTarget: {
            type: "ObservationBinding",
            version: 1,
            required: true,
            requiredProperties: ["observationId", "ref"],
          },
        }
      : {}),
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
    if (action.actionId === "pickup_forage") args.sceneTarget = { observationId: "gateObservation", ref: SCENE_REF };
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
