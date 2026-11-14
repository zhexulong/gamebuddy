/**
 * The contract format one action slice can be expressed in, and the rules that keep it from becoming a fourth
 * hand-written table.
 *
 * WHY THIS EXISTS. `tools/run-stardew-native-local-player-*-smoke.mjs` is 126 files, and most of them are not
 * programs: they discover one target from one published projection, build one argument object, expect one terminal
 * state with a handful of `key=value` evidence entries, then re-send the stale id and expect a named refusal. That
 * is a contract. The parts that are genuinely code are the ones that compute (an arc's geometry, a stamina delta, a
 * debris count) - and those are exactly what this format refuses to express instead of quietly approximating.
 *
 * DERIVED, NOT RESTATED. The action's own declaration already owns five of the facts a contract would otherwise
 * repeat, so none of them may appear in a contract file:
 *
 *   - expected reason code   <- `postcondition.name` in the generated action surface
 *   - discovery source field <- `targetFamily` in the same row
 *   - argument names/types   <- `argumentSchema` in the same row
 *   - required capabilities  <- the Mod's own `FarmhandCapabilitySet.ProtocolControls` plus the action itself
 *   - fixture scenario       <- `fixtureScenario(fixtureActions(action), action)`, the launcher's own selector
 *
 * A contract that spells one of those out is refused by name (`smoke_contract_rederived_key`), because a second
 * spelling that agrees today is a disagreement scheduled for later.
 *
 * WHAT A CONTRACT MAY SAY (and nothing else, because a key nobody reads is a key that lies):
 *   action, discovery, args, evidence, worldAfter, stale,
 * and `expectedReasonCode` only where the declaration is generic (`native_action_postcondition`) and therefore
 * derives nothing.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureActions, fixtureScenario } from "./stardew-native-local-player-fixture.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const SMOKE_CONTRACT_SCHEMA = "stardew-action-smoke-contract/v1";
/** The postcondition name every action carries when its declaration says only "the native call did something". */
export const GENERIC_POSTCONDITION = "native_action_postcondition";
export const ACTION_SURFACE_PATH = resolve(
  ROOT,
  "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);
export const CAPABILITY_SET_PATH = resolve(ROOT, "integrations/stardew/src/Core/Policy/FarmhandCapabilitySet.cs");

const CONTRACT_KEYS = Object.freeze([
  "schema",
  "action",
  "expectedReasonCode",
  "discovery",
  "args",
  "evidence",
  "worldAfter",
  "stale",
]);
/** Keys a contract may not carry because the action's own declaration (or the engine) already answers them. */
const DERIVED_KEYS = Object.freeze([
  "targetFamily",
  "argumentSchema",
  "requiredCapabilities",
  "fixtureScenario",
  "watchdogMs",
  "postcondition",
]);
/**
 * Keys that would turn this format into a DSL, named separately from `CONTRACT_KEYS` so the refusal says what the
 * author asked for and where it has to live instead: a chain, a computed comparison, or a spatial setup stays code.
 */
const INEXPRESSIBLE_KEYS = Object.freeze({
  steps: "a chain of actions is a program, not a slice: write a runner",
  chain: "a chain of actions is a program, not a slice: write a runner",
  sequence: "a chain of actions is a program, not a slice: write a runner",
  arithmetic: "a computed postcondition cannot be expressed as data: write a runner",
  delta: "a difference between two postcondition numbers cannot be expressed as data: write a runner",
  express: "a computed quantity cannot be expressed as data: write a runner",
  setup: "a spatial or inventory precondition beyond the fixture scenario: write a runner",
  prerequisites: "a chain of prerequisite actions is a program, not a slice: write a runner",
});

const DISCOVERY_KEYS = Object.freeze(["source", "cardinality", "select", "requiredFields", "require"]);
const WORLD_AFTER_KEYS = Object.freeze([
  "field",
  "excludesTarget",
  "size",
  "equals",
  "includesTargetField",
  "rowAtTargetTile",
]);
const STALE_KEYS = Object.freeze(["args", "refusedWith"]);

const CARDINALITIES = Object.freeze(["exactly_one", "at_least_one"]);
const SELECTORS = Object.freeze(["only", "first"]);

class ContractError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "SmokeContractError";
    this.code = code;
  }
}

const fail = (code, detail) => {
  throw new ContractError(`smoke_contract_${code}`, detail);
};
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * The Mod's own protocol controls (`inspect_self`, `cancel_active_execution`).
 *
 * Read from `FarmhandCapabilitySet.ProtocolControls` rather than copied: every regular runner writes
 * `["cancel_active_execution", "inspect_self", ACTION]`, and a fourth spelling of that list would be the same
 * defect as the hand-written experimental action list that went stale.
 */
export function readProtocolControls({ capabilitySetPath = CAPABILITY_SET_PATH } = {}) {
  const source = readFileSync(capabilitySetPath, "utf8");
  const body = /ProtocolControls\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\)/u.exec(source)?.[1];
  if (body === undefined) fail("protocol_controls_missing", capabilitySetPath);
  const controls = [...body.matchAll(/"([a-z][a-z0-9_]{1,127})"/gu)].map((match) => match[1]);
  if (controls.length === 0) fail("protocol_controls_missing", capabilitySetPath);
  return Object.freeze(controls);
}

/** Every row of the generated action surface, keyed by action id. */
export function readActionSurface({ surfacePath = ACTION_SURFACE_PATH } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(surfacePath, "utf8"));
  } catch (error) {
    fail("surface_unreadable", `${surfacePath}:${String(error?.message ?? error).slice(0, 120)}`);
  }
  if (!Array.isArray(parsed?.actions) || parsed.actions.length === 0) fail("surface_empty", surfacePath);
  return new Map(parsed.actions.map((row) => [row.actionId, Object.freeze(row)]));
}

/**
 * The five facts a contract may not restate, derived for one action from the declarations that own them.
 *
 * `expectedReasonCode` is `null` when the declaration is generic, and the shape that says so is
 * `not_derived:<why>` rather than a silent null: the caller must then either supply `expectedReasonCode` in the
 * contract or accept that no success code is known.
 */

/**
 * The launcher's own fixture selection for one action - the world the slice would be run in.
 *
 * `fixtureActions` refuses an action its route table does not carry with a bare `Error`, which names neither the
 * action nor this layer: seven of the 103 declared execution actions (`dismiss_modal`, `answer_dialogue`,
 * `face_direction`, `send_multiplayer_chat`, ...) reached a contract author as
 * `Error: invalid_native_local_fixture_action`. A contract cannot be run in a world the launcher has no Given for,
 * so the refusal stands; what changes here is that it is one of this file's named refusals and it names the action.
 */
function fixtureSelection(actionId) {
  let actions;
  try {
    actions = fixtureActions(actionId);
  } catch {
    fail("fixture_scenario_underivable", actionId);
  }
  return fixtureScenario(actions, actionId);
}

export function deriveActionFacts(actionId, { surface = null, protocolControls = null } = {}) {
  if (!isNonEmptyString(actionId)) fail("action_missing");
  const rows = surface ?? readActionSurface();
  const row = rows.get(actionId);
  if (row === undefined) fail("action_not_declared", actionId);
  if (row.kind !== "execution") fail("action_is_read_only", `${actionId}:${String(row.kind)}`);
  const declaredPostcondition = row.postcondition?.name ?? null;
  if (!isNonEmptyString(declaredPostcondition)) fail("postcondition_undeclared", actionId);
  const controls = protocolControls ?? readProtocolControls();
  const fixture = fixtureSelection(actionId);
  return Object.freeze({
    actionId,
    lifecycle: row.lifecycle ?? null,
    nativeBinding: row.nativeBinding ?? null,
    argumentSchema: Object.freeze(row.argumentSchema ?? {}),
    targetFamily: row.targetFamily ?? null,
    declaredPostcondition,
    // 62 of the 106 declared actions say only "the native call did something"; for those the success word cannot be
    // derived and the contract has to carry one, which is the one derived-key exception below.
    expectedReasonCode: declaredPostcondition === GENERIC_POSTCONDITION ? null : declaredPostcondition,
    notDerived:
      declaredPostcondition === GENERIC_POSTCONDITION
        ? `not_derived:postcondition_is_generic:${GENERIC_POSTCONDITION}`
        : null,
    requiredCapabilities: Object.freeze([...new Set([...controls, actionId])].sort()),
    fixtureScenario: fixture,
  });
}

/** `$target.<field>` - the only substitution a contract may make. */
function substitutionField(value) {
  if (typeof value !== "string") return null;
  const match = /^\$target\.([A-Za-z][A-Za-z0-9_]{0,63})$/u.exec(value);
  return match === null ? null : match[1];
}

function assertKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (INEXPRESSIBLE_KEYS[key] !== undefined) fail("not_expressible", `${where}.${key}:${INEXPRESSIBLE_KEYS[key]}`);
    if (!allowed.includes(key)) fail("unknown_key", `${where}.${key}`);
  }
}

function validateDiscovery(discovery, facts) {
  if (!isPlainObject(discovery)) fail("discovery_not_object");
  assertKeys(discovery, DISCOVERY_KEYS, "discovery");
  const source = discovery.source ?? facts.targetFamily;
  if (!isNonEmptyString(source)) fail("discovery_source_undeclared", facts.actionId);
  if (facts.targetFamily === null) fail("discovery_source_not_derived", `${facts.actionId}:no_target_family`);
  if (source !== facts.targetFamily)
    fail("discovery_source_disagrees_with_declaration", `${source}:${facts.targetFamily}`);
  const cardinality = discovery.cardinality ?? "exactly_one";
  if (!CARDINALITIES.includes(cardinality)) fail("discovery_cardinality_unknown", String(cardinality));
  const select = discovery.select ?? (cardinality === "exactly_one" ? "only" : "first");
  if (!SELECTORS.includes(select)) fail("discovery_select_unknown", String(select));
  if (select === "only" && cardinality !== "exactly_one") fail("discovery_select_needs_exactly_one", select);
  const requiredFields = discovery.requiredFields ?? [];
  if (!Array.isArray(requiredFields) || requiredFields.some((field) => !isNonEmptyString(field)))
    fail("discovery_required_fields_invalid");
  const require = discovery.require ?? {};
  if (!isPlainObject(require)) fail("discovery_require_invalid");
  for (const [field, expected] of Object.entries(require)) {
    if (!["string", "boolean", "number"].includes(typeof expected)) fail("discovery_require_value_invalid", field);
  }
  return Object.freeze({
    source,
    cardinality,
    select,
    requiredFields: Object.freeze([...requiredFields]),
    require: Object.freeze({ ...require }),
  });
}

function validateArgs(args, facts) {
  if (!isPlainObject(args)) fail("args_not_object");
  const declared = facts.argumentSchema;
  if (Object.keys(args).length === 0) fail("args_empty", facts.actionId);
  for (const [name, value] of Object.entries(args)) {
    if (declared[name] === undefined)
      fail("args_undeclared", `${name}:declared=${Object.keys(declared).sort().join(",")}`);
    const substituted = substitutionField(value);
    if (substituted !== null) continue;
    const type = declared[name].type;
    if (type === "integer" && !Number.isInteger(value)) fail("args_type_mismatch", `${name}:expected_integer`);
    if (type === "string" && typeof value !== "string") fail("args_type_mismatch", `${name}:expected_string`);
    if (type === "boolean" && typeof value !== "boolean") fail("args_type_mismatch", `${name}:expected_boolean`);
  }
  return Object.freeze({ ...args });
}

function validateEvidence(evidence) {
  if (evidence === undefined) return Object.freeze({});
  if (!isPlainObject(evidence)) fail("evidence_not_object");
  const normalised = {};
  for (const [key, expectation] of Object.entries(evidence)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) fail("evidence_key_invalid", key);
    if (typeof expectation === "string") {
      if (expectation.length === 0) fail("evidence_expectation_empty", key);
      normalised[key] = Object.freeze({ equals: expectation });
      continue;
    }
    if (!isPlainObject(expectation)) fail("evidence_expectation_invalid", key);
    assertKeys(expectation, ["equals", "equalsTarget"], `evidence.${key}`);
    const keys = Object.keys(expectation);
    if (keys.length !== 1) fail("evidence_expectation_invalid", key);
    if (keys[0] === "equals" && typeof expectation.equals !== "string") fail("evidence_expectation_invalid", key);
    if (keys[0] === "equalsTarget" && !isNonEmptyString(expectation.equalsTarget))
      fail("evidence_expectation_invalid", key);
    normalised[key] = Object.freeze({ [keys[0]]: expectation[keys[0]] });
  }
  return Object.freeze(normalised);
}

function validateWorldAfter(worldAfter) {
  if (worldAfter === undefined) return Object.freeze([]);
  if (!Array.isArray(worldAfter) || worldAfter.length === 0) fail("world_after_invalid");
  return Object.freeze(
    worldAfter.map((assertion) => {
      if (!isPlainObject(assertion)) fail("world_after_invalid");
      assertKeys(assertion, WORLD_AFTER_KEYS, "worldAfter[]");
      if (!isNonEmptyString(assertion.field)) fail("world_after_field_missing");
      const forms = ["excludesTarget", "size", "equals", "includesTargetField", "rowAtTargetTile"].filter(
        (key) => assertion[key] !== undefined,
      );
      if (forms.length !== 1) fail("world_after_form_invalid", `${assertion.field}:${forms.join("+") || "none"}`);
      const form = forms[0];
      if (form === "excludesTarget" && assertion.excludesTarget !== true) fail("world_after_form_invalid", form);
      if (form === "size" && !Number.isInteger(assertion.size)) fail("world_after_form_invalid", form);
      if (form === "equals" && !["string", "boolean", "number"].includes(typeof assertion.equals))
        fail("world_after_form_invalid", form);
      if (form === "includesTargetField" && !isNonEmptyString(assertion.includesTargetField))
        fail("world_after_form_invalid", form);
      if (form === "rowAtTargetTile") {
        // The row in this array that stands on the discovered target's own tile, compared field by field: the
        // animal-door slice proves the door it toggled is the door that opened.
        if (!isPlainObject(assertion.rowAtTargetTile) || Object.keys(assertion.rowAtTargetTile).length === 0)
          fail("world_after_form_invalid", form);
      }
      return Object.freeze({ field: assertion.field, form, value: assertion[form] });
    }),
  );
}

function validateStale(stale, args) {
  if (stale === undefined) return null;
  if (!isPlainObject(stale)) fail("stale_not_object");
  assertKeys(stale, STALE_KEYS, "stale");
  const refusedWith = stale.refusedWith;
  if (!Array.isArray(refusedWith) || refusedWith.length === 0 || refusedWith.some((code) => !isNonEmptyString(code)))
    fail("stale_refusals_invalid");
  const staleArgs = stale.args === undefined ? args : validateStaleArgs(stale.args);
  return Object.freeze({ args: staleArgs, refusedWith: Object.freeze([...refusedWith]) });
}

function validateStaleArgs(args) {
  if (!isPlainObject(args)) fail("stale_args_not_object");
  for (const [name, value] of Object.entries(args)) {
    if (typeof value !== "string" && substitutionField(value) === null)
      fail("stale_args_value_invalid", `${name}:${typeof value}`);
  }
  return Object.freeze({ ...args });
}

/**
 * Validate one contract against the action's declarations.
 *
 * `facts` defaults to `deriveActionFacts(action)`; a caller may pass it so many contracts are validated against one
 * surface read. Every refusal names the key or the disagreement, never just "invalid".
 */
export function validateSmokeContract(raw, { facts = null, surface = null, protocolControls = null } = {}) {
  if (!isPlainObject(raw)) fail("not_object");
  if (raw.schema !== SMOKE_CONTRACT_SCHEMA) fail("schema_unknown", String(raw.schema));
  for (const key of DERIVED_KEYS) {
    if (raw[key] !== undefined) fail("rederived_key", `${key}:${JSON.stringify(raw[key])}`);
  }
  assertKeys(raw, CONTRACT_KEYS, "contract");
  const resolvedFacts = facts ?? deriveActionFacts(raw.action, { surface, protocolControls });
  if (raw.action !== resolvedFacts.actionId) fail("action_mismatch", `${String(raw.action)}:${resolvedFacts.actionId}`);

  let expectedReasonCode = resolvedFacts.expectedReasonCode;
  if (raw.expectedReasonCode !== undefined) {
    // Only an action whose declaration says nothing specific may name its own success word - and it must be
    // named, because the alternative is a contract that cannot judge the terminal at all.
    if (resolvedFacts.expectedReasonCode !== null)
      fail("reason_code_redeclared", `${resolvedFacts.actionId}:expectedReasonCode=${raw.expectedReasonCode}`);
    if (!isNonEmptyString(raw.expectedReasonCode)) fail("reason_code_invalid");
    expectedReasonCode = raw.expectedReasonCode;
  }
  if (expectedReasonCode === null)
    fail("reason_code_underivable", `${resolvedFacts.actionId}:${GENERIC_POSTCONDITION}`);

  const discovery = validateDiscovery(raw.discovery, resolvedFacts);
  const args = validateArgs(raw.args, resolvedFacts);
  const evidence = validateEvidence(raw.evidence);
  const worldAfter = validateWorldAfter(raw.worldAfter);
  const stale = validateStale(raw.stale, args);

  return Object.freeze({
    schema: SMOKE_CONTRACT_SCHEMA,
    action: resolvedFacts.actionId,
    expectedState: "succeeded",
    expectedReasonCode,
    discovery,
    args,
    evidence,
    worldAfter,
    stale,
    derived: Object.freeze({
      lifecycle: resolvedFacts.lifecycle,
      nativeBinding: resolvedFacts.nativeBinding,
      argumentSchema: resolvedFacts.argumentSchema,
      targetFamily: resolvedFacts.targetFamily,
      declaredPostcondition: resolvedFacts.declaredPostcondition,
      reasonCodeSource:
        resolvedFacts.expectedReasonCode === null
          ? `contract:${resolvedFacts.actionId}`
          : `postcondition.name:${resolvedFacts.declaredPostcondition}`,
      requiredCapabilities: resolvedFacts.requiredCapabilities,
      fixtureScenario: resolvedFacts.fixtureScenario,
      notDerived: resolvedFacts.notDerived,
    }),
  });
}

/** Read and validate one contract file. */
export function loadSmokeContractFile(path, options = {}) {
  if (!isNonEmptyString(path)) fail("path_missing");
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    fail("unreadable", `${absolute}:${String(error?.message ?? error).slice(0, 160)}`);
  }
  return Object.freeze({ ...validateSmokeContract(raw, options), path: absolute });
}

/**
 * The contract a bare `--action`/`--args` invocation stands for.
 *
 * Nothing is guessed: the terminal state and reason code are the declaration's, the argument names and types are
 * checked against the declaration, and a declaration too generic to name a success word demands `--expect` rather
 * than accepting whatever the Mod answers. Everything the contract format adds (evidence keys, world-after
 * assertions, the stale re-send) is absent on purpose and the result says so in `unassertedEvidence`.
 */
export function adHocContract({ action, args, expectReasonCode = null }, options = {}) {
  const facts = deriveActionFacts(action, options);
  const expectedReasonCode = facts.expectedReasonCode ?? expectReasonCode;
  if (expectedReasonCode === null) fail("reason_code_underivable", `${action}:${GENERIC_POSTCONDITION}:pass_--expect`);
  const declared = facts.argumentSchema;
  if (!isPlainObject(args)) fail("args_not_object");
  for (const [name, value] of Object.entries(args)) {
    if (declared[name] === undefined)
      fail("args_undeclared", `${name}:declared=${Object.keys(declared).sort().join(",")}`);
    const type = declared[name].type;
    if (type === "integer" && !Number.isInteger(value)) fail("args_type_mismatch", `${name}:expected_integer`);
    if (type === "string" && typeof value !== "string") fail("args_type_mismatch", `${name}:expected_string`);
  }
  return Object.freeze({
    schema: SMOKE_CONTRACT_SCHEMA,
    action,
    expectedState: "succeeded",
    expectedReasonCode,
    discovery: null,
    args: Object.freeze({ ...args }),
    evidence: Object.freeze({}),
    worldAfter: Object.freeze([]),
    stale: null,
    derived: Object.freeze({
      lifecycle: facts.lifecycle,
      nativeBinding: facts.nativeBinding,
      argumentSchema: facts.argumentSchema,
      targetFamily: facts.targetFamily,
      declaredPostcondition: facts.declaredPostcondition,
      reasonCodeSource:
        facts.expectedReasonCode === null ? "operator:--expect" : `postcondition.name:${facts.declaredPostcondition}`,
      requiredCapabilities: facts.requiredCapabilities,
      fixtureScenario: facts.fixtureScenario,
      notDerived: facts.notDerived,
    }),
    path: null,
  });
}

export { ContractError };
