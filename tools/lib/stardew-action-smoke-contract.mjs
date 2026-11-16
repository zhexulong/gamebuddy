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
 * DERIVED, AND THEREFORE COMPLETE. `args` is the one block whose KEYS are not free: it must carry every argument the
 * declaration carries, and nothing else, because the Mod's inbound parser demands the frame's `args` match its own
 * `ExecutionArgumentProperties` set exactly (`HasExactProperties`). A contract that omits one loads, dispatches, and is
 * answered `bridge_rejected:invalid_envelope` with `dispatchMs` 0 - the frame was never sent. That is what happened to
 * `deposit_silo_hay`, whose draft carried `{x, y, expectedTargetId}` against a declaration of
 * `{x, y, slot, expectedTargetId}`, and two gates said yes: this format loaded it, and a fake-world equivalence that
 * compared verdicts rather than requests saw the two drivers agree. So the refusal is
 * `contract_args_disagree_with_the_declaration:<action>:<missing|extra|wrongtype>:...`, and it is the gate that would
 * have caught it before a game launch.
 *
 * WHAT A CONTRACT MAY SAY (and nothing else, because a key nobody reads is a key that lies):
 *   action, discovery, args, evidence, worldAfter, afterStale, stale, unasserted, assertion,
 * and `expectedReasonCode` only where the declaration is generic (`native_action_postcondition`) and therefore
 * derives nothing.
 *
 * THE ONE CLAUSE CODE HOLDS. A comparison that orders one number against another - "at least as many ground debris
 * carrying the pond's fish type as the pond held occupants" - is not a `worldAfter` form and never will be, so the
 * contract names a HOOK instead: `"assertion": "clear_fish_pond"` is `tools/assertions/clear_fish_pond.mjs`, which
 * `tools/run-native-action-slice.mjs` runs after its own checks and whose declared clauses (`asserts`) the coverage
 * gate counts as covered. The name must exist (`assertion_missing`) and a clause the hook declares must be one this
 * contract can name - a receipt key the contract states, or an observation family the protocol publishes
 * (`assertion_clause_unknown`) - because an excuse nobody can find, or one that asserts something the contract never
 * mentions, is a comment rather than a test.
 *
 * AN ACTION THAT NAMES NO TARGET IS STILL A SLICE. 14 of the 103 execution declarations carry no `targetFamily`
 * (`sleep`, `advance_day`, `dismiss_modal`, ...) and are perfectly testable: they take arguments and answer a
 * terminal. Deriving a discovery source from a row that has none is impossible, so the format used to refuse them
 * **by their nature** - a format defect, not a fact about the action. Absence is not the same as a declaration,
 * though: a missing `discovery` key is still refused (`discovery_source_undeclared`), and an action that names no
 * target says so in words: `"discovery": { "none": "<why>" }`. The reason is required for the same reason every
 * other declaration-needs-a-reason here is required - a blank one cannot be told from a forgotten one.
 *
 * THE THIRD PART OF A STALE RE-SEND. `stale: { args, refusedWith }` says "re-send the consumed id and expect this
 * refusal", and `worldAfter` is read BEFORE that re-send - so a runner that reads the world again once the refusal
 * arrived ("nothing moved: the door is still open, the offer was not re-advertised") had no way to be stated. 33 of
 * the 124 runners in this tree did exactly that, and a contract without the block still read `dropped 0`: the clause
 * had no spelling, so it could not be missed. `afterStale` is that spelling - the same assertion entries `worldAfter`
 * takes, evaluated against a fresh observation read after the stale terminal - and `checkContractCoverage` refuses a
 * contract whose runner re-reads without it. The inverse is refused too: a block on a runner that never re-reads is an
 * assertion about a shape the runner does not have, which is a guess rather than a proof.
 *
 * A CONTRACT THAT LOADS IS NOT A CONTRACT THAT COVERS. `checkContractCoverage` reads the hand-written runner for
 * the action - the authority this format was built to carry - extracts the assertions it makes (receipt keys and
 * how it compares them, the terminal state and word, the number of frames, the projection fields), and refuses a
 * contract that drops one. A contract may drop an assertion only by declaring it in `unasserted`, in words that
 * name the clause: `"unasserted": { "evidence.count_after": "the runner also asserts count_after = count_before
 * + 1; the format compares one receipt key to one value" }`. The declaration expires: naming a clause the runner
 * no longer makes is refused too (`unasserted_clause_unknown`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJavaScript } from "./javascript-ast.mjs";
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
  "afterStale",
  "stale",
  "delta",
  "unasserted",
  "assertion",
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
  express: "a computed quantity cannot be expressed as data: write a runner",
  setup: "a spatial or inventory precondition beyond the fixture scenario: write a runner",
  prerequisites: "a chain of prerequisite actions is a program, not a slice: write a runner",
});

const DISCOVERY_KEYS = Object.freeze(["source", "cardinality", "select", "requiredFields", "require", "none"]);
const WORLD_AFTER_KEYS = Object.freeze([
  "field",
  "excludesTarget",
  "size",
  "equals",
  "includesTargetField",
  "rowAtTargetTile",
]);
const STALE_KEYS = Object.freeze(["args", "refusedWith"]);

/**
 * The flat comparison forms a receipt key may carry.
 *
 * WHY THESE AND NOT A LANGUAGE. Measured over the 126 hand-written runners (795 postcondition assertions), the
 * comparison shapes recur across many actions and every one is a single comparison of one receipt key against one
 * operand: a literal, one field of the discovered target, or another key of the same receipt. A flat entry per key
 * carries the first two, and the `delta` list below carries the third, so the format states them without loops,
 * conditionals or nesting - the things that would make it a DSL.
 */
const EVIDENCE_FORM_KEYS = Object.freeze(["equals", "equalsTarget"]);
/** One relation between two receipt keys, or between one key and a bound: flat, and never an expression. */
const DELTA_KEYS = Object.freeze(["from", "to", "equals", "atLeast"]);

const CARDINALITIES = Object.freeze(["exactly_one", "at_least_one"]);
const SELECTORS = Object.freeze(["only", "first"]);

/**
 * The shortest reason this format will accept for a clause it does not assert.
 *
 * The number is not a style rule: a one-word entry cannot say which comparison the runner made, and `"complex"`
 * would become the new "unasserted: everything". The three mechanical checks below (length, subject, and a refused
 * set of bare words) together mean the author had to look at the clause.
 */
const UNASSERTED_MIN_REASON_CHARS = 24;
/** Words that name the KIND of a clause instead of the clause, refused verbatim. */
const GENERIC_UNASSERTED_REASONS = Object.freeze(
  new Set([
    "complex",
    "too complex",
    "arithmetic",
    "math",
    "not expressible",
    "inexpressible",
    "cannot express",
    "cannot be expressed",
    "n/a",
    "na",
    "none",
    "todo",
    "tbd",
    "unknown",
    "see runner",
    "not applicable",
    "unsupported",
  ]),
);
const UNASSERTED_CLAUSE = /^(?:evidence|worldAfter)\.([A-Za-z][A-Za-z0-9_]{0,63})$/u;

/** The protocol's own list of top-level observation fields, generated from the sample world. */
const PROJECTION_SAMPLE_PATH = resolve(
  ROOT,
  "integrations/stardew/action-development/contracts/generated/snapshot-sample.v1.json",
);
const CONTRACT_DIRECTORY = resolve(ROOT, "contracts/smoke");
/** The directory a contract's `assertion` name is resolved in, and the one `tools/check-assertion-hooks.mjs` scans. */
export const ASSERTION_DIRECTORY = resolve(ROOT, "tools/assertions");
/** A hook name is a module name: lowercase, no path, no extension. */
const ASSERTION_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
/** `<evidence|worldAfter>.<subject>` - the clause vocabulary the coverage gate already names clauses in. */
const ASSERTION_CLAUSE = /^(?:evidence|worldAfter)\.([A-Za-z][A-Za-z0-9_]{0,63})$/u;
const RUNNER_DIRECTORY = resolve(ROOT, "tools");
const RUNNER_PREFIX = "run-stardew-native-local-player-";
const EVIDENCE_OBJECT = "evidence";
/** The one field of the evidence ENVELOPE (`{ detail: "key=value;..." }`), never a receipt key. */
const EVIDENCE_ENVELOPE = Object.freeze(new Set(["detail"]));
/** A variable that holds a parsed receipt evidence bag: `evidence`, or `<something>Evidence`. */
const EVIDENCE_BAG = /^(?:evidence|[a-z][A-Za-z0-9_]*Evidence)$/u;
/** A binding that holds an observation: `observeFresh`, `waitForFreshSnapshot`, ... but never a terminal. */
const OBSERVATION_CALL = /^(?:observe[A-Z]|waitFor(?!Terminal)[A-Z])/u;
/** Calls that narrow a value to one number, string or boolean without changing which key it reads. */
const NARROWING_CALL = Object.freeze(new Set(["Number", "String", "Boolean"]));
const LITERAL_TYPES = Object.freeze(new Set(["string", "number", "true", "false", "null"]));
const DISPATCH_CALL = "executeFresh";
const TERMINAL_ALIAS = /terminal/u;
const STALE_ALIAS = /stale/u;
const COMPARISON_OPERATORS = Object.freeze(new Set(["===", "!==", "==", "!=", ">", ">=", "<", "<="]));
const EQUALITY_OPERATORS = Object.freeze(new Set(["===", "==", "!==", "!="]));
const MAX_RESOLUTION_DEPTH = 6;

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

/**
 * The five facts a contract may not restate, derived for one action from the declarations that own them.
 *
 * `expectedReasonCode` is `null` when the declaration is generic, and the shape that says so is
 * `not_derived:<why>` rather than a silent null: the caller must then either supply `expectedReasonCode` in the
 * contract or accept that no success code is known.
 */
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
  if (discovery.none !== undefined)
    return { discovery: null, noneReason: validateTargetlessDiscovery(discovery, facts) };
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
  return {
    discovery: Object.freeze({
      source,
      cardinality,
      select,
      requiredFields: Object.freeze([...requiredFields]),
      require: Object.freeze({ ...require }),
    }),
    noneReason: null,
  };
}

/**
 * The contract's argument names and types, against the ones the action's declaration carries - every one of them.
 *
 * A CONTRACT THAT LOADS IS NOT A FRAME THAT CAN BE SENT, and until this check existed the format only knew the first
 * fact. `deposit_silo_hay`'s draft carried `{x, y, expectedTargetId}`; the declaration carries `{x, y, slot,
 * expectedTargetId}` and the Mod's `ExecutionArgumentProperties` switch demands the frame's `args` match it exactly
 * (`HasExactProperties`), so the live slice came back `bridge_rejected:invalid_envelope` with `dispatchMs` 0. The
 * frame was never sent, and two gates had already said yes - this one, and a fake-world equivalence that compared
 * verdicts between two drivers whose arguments it never looked at.
 *
 * THREE DISAGREEMENTS, ONE REFUSAL. `missing` is an argument the declaration requires and the contract omits (the
 * deposit case); `extra` is one the declaration does not carry; `wrongtype` is a value that is not the declared type.
 * One code rather than three, because they are one fact - this argument object is not this action's - and a reader of
 * a blocked run should not have to learn three names to find that out.
 *
 * A `$target.<field>` SUBSTITUTION IS EXEMPT FROM THE TYPE CHECK. Discovery rows are untyped data published by the
 * Mod, so the format cannot know whether `$target.x` is an integer; what it CAN know is that the name is declared,
 * and that is what the other two branches read.
 */
function assertArgsAgreeWithDeclaration(args, facts) {
  const declared = facts.argumentSchema;
  const declaredNames = Object.keys(declared).sort();
  const parts = [];
  const missing = declaredNames.filter((name) => args[name] === undefined);
  if (missing.length > 0) parts.push(`missing:${missing.join(",")}`);
  const extra = Object.keys(args)
    .filter((name) => declared[name] === undefined)
    .sort();
  if (extra.length > 0) parts.push(`extra:${extra.join(",")}`);
  const wrongType = [];
  for (const [name, value] of Object.entries(args)) {
    if (declared[name] === undefined || substitutionField(value) !== null) continue;
    const type = declared[name].type;
    const agrees = DECLARED_TYPE_AGREES[type]?.(value) ?? true;
    if (!agrees) wrongType.push(`${name}(expected_${type}:actual=${JSON.stringify(value)})`);
  }
  if (wrongType.length > 0) parts.push(`wrongtype:${wrongType.join(",")}`);
  if (parts.length === 0) return;
  fail(
    "contract_args_disagree_with_the_declaration",
    `${facts.actionId}:${parts.join(":")}:declared=${declaredNames.join(",")}`,
  );
}

/**
 * One predicate per declared argument type, so the type check is a lookup rather than a chain of conditionals.
 *
 * A type this table does not carry is not checked here: the surface could publish a fourth one tomorrow, and refusing
 * it would be this file inventing a rule the declaration does not state.
 */
const DECLARED_TYPE_AGREES = Object.freeze({
  integer: (value) => Number.isInteger(value),
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
});

function validateArgs(args, facts) {
  if (!isPlainObject(args)) fail("args_not_object");
  assertArgsAgreeWithDeclaration(args, facts);
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
    assertKeys(expectation, EVIDENCE_FORM_KEYS, `evidence.${key}`);
    const keys = Object.keys(expectation);
    if (keys.length !== 1) fail("evidence_expectation_invalid", key);
    if (keys[0] === "equals" && typeof expectation.equals !== "string") fail("evidence_expectation_invalid", key);
    if (keys[0] === "equalsTarget" && !isNonEmptyString(expectation.equalsTarget))
      fail("evidence_expectation_invalid", key);
    normalised[key] = Object.freeze({ [keys[0]]: expectation[keys[0]] });
  }
  return Object.freeze(normalised);
}

/**
 * The `delta` list: `to` minus `from` equals - or is at least - the bound, and `from` may be absent for a plain bound.
 *
 * One entry per relation, four scalars at most, no nesting and no expression: `{ "from": "count_before", "to":
 * "count_after", "equals": 1 }` is `count_after = count_before + 1` as data. Naming `from` and `to` explicitly rather
 * than hanging the relation off one key is what keeps it flat: the relation belongs to a pair, and a pair is two
 * strings, not a path.
 */
function validateDelta(delta) {
  if (delta === undefined) return Object.freeze([]);
  if (!Array.isArray(delta) || delta.length === 0) fail("delta_invalid");
  return Object.freeze(
    delta.map((entry) => {
      if (!isPlainObject(entry)) fail("delta_invalid");
      assertKeys(entry, DELTA_KEYS, "delta[]");
      if (!isNonEmptyString(entry.to)) fail("delta_key_missing", "to");
      if (entry.from !== undefined && !isNonEmptyString(entry.from)) fail("delta_key_invalid", entry.to);
      if (entry.from === entry.to) fail("delta_from_equals_to", entry.to);
      const bounds = ["equals", "atLeast"].filter((key) => entry[key] !== undefined);
      if (bounds.length !== 1) fail("delta_bound_invalid", `${entry.to}:${bounds.join("+") || "none"}`);
      if (!Number.isInteger(entry[bounds[0]])) fail("delta_bound_invalid", `${entry.to}:${bounds[0]}`);
      return Object.freeze({
        to: entry.to,
        from: entry.from ?? null,
        bound: Object.freeze({ form: bounds[0], value: entry[bounds[0]] }),
      });
    }),
  );
}

/**
 * `worldAfter` and `afterStale` - the same assertion entries, read at two different moments.
 *
 * `worldAfter` is read after the terminal; `afterStale` after the stale re-send has been refused. One validator for
 * both, because a second spelling of these five forms would be a second answer to "what may a world assertion say".
 * `where` names which block a refusal came from, so an author is sent to the key they wrote.
 */
function validateWorldAfter(worldAfter, where = "worldAfter") {
  if (worldAfter === undefined) return Object.freeze([]);
  if (!Array.isArray(worldAfter) || worldAfter.length === 0) fail("world_after_invalid", where);
  return Object.freeze(
    worldAfter.map((assertion) => {
      if (!isPlainObject(assertion)) fail("world_after_invalid", where);
      assertKeys(assertion, WORLD_AFTER_KEYS, `${where}[]`);
      if (!isNonEmptyString(assertion.field)) fail("world_after_field_missing", where);
      const forms = ["excludesTarget", "size", "equals", "includesTargetField", "rowAtTargetTile"].filter(
        (key) => assertion[key] !== undefined,
      );
      if (forms.length !== 1)
        fail("world_after_form_invalid", `${where}.${assertion.field}:${forms.join("+") || "none"}`);
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

/**
 * `"discovery": { "none": "<why>" }` - the action names no target, and the contract says so in words.
 *
 * Answers the trimmed reason, which the loaded contract carries as `derived.discoveryNone`: a reader of a loaded
 * contract has to be able to see WHY it has no discovery, and `discovery: null` alone cannot say. The engine already
 * understands `null` as "there is no discovery": `chooseTarget` answers `{ rows: null, chosen: null, source: null }`,
 * and an argument that substitutes `$target.<field>` then fails at `slice_target_field_missing` - the right refusal,
 * because an action that names no target has nothing for the substitution to read. Every other discovery key is
 * refused beside `none`: a `none` next to a `cardinality` is two answers to one question.
 */
function validateTargetlessDiscovery(discovery, facts) {
  if (facts.targetFamily !== null)
    fail("discovery_none_but_declaration_names_target", `${facts.actionId}:${facts.targetFamily}`);
  const beside = Object.keys(discovery).filter((key) => key !== "none");
  if (beside.length > 0) fail("discovery_none_excludes", `${facts.actionId}:${beside.join(",")}`);
  if (!isNonEmptyString(discovery.none)) fail("discovery_none_reason_missing", facts.actionId);
  const reason = discovery.none.trim();
  if (reason.length < UNASSERTED_MIN_REASON_CHARS)
    fail("discovery_none_reason_too_short", `${facts.actionId}:${reason.length}`);
  return reason;
}

/**
 * `unasserted` - the clauses this contract drops, each named, each with a reason someone had to read to write.
 *
 * The name is `evidence.<key>` or `worldAfter.<field>`, the same spelling the coverage gate uses, so a declaration
 * and the clause it excuses are compared as strings: a renamed key cannot leave the excuse behind.
 */
function validateUnasserted(unasserted) {
  if (unasserted === undefined) return Object.freeze({});
  if (!isPlainObject(unasserted)) fail("unasserted_not_object");
  const entries = Object.entries(unasserted);
  if (entries.length === 0) fail("unasserted_empty");
  const normalised = {};
  for (const [clause, value] of entries) {
    const subject = UNASSERTED_CLAUSE.exec(clause)?.[1];
    if (subject === undefined) fail("unasserted_clause_unnameable", clause);
    if (!isNonEmptyString(value)) fail("unasserted_reason_missing", clause);
    const reason = value.trim();
    if (GENERIC_UNASSERTED_REASONS.has(genericKey(reason))) fail("unasserted_reason_generic", clause);
    if (reason.length < UNASSERTED_MIN_REASON_CHARS) fail("unasserted_reason_too_short", `${clause}:${reason.length}`);
    if (!reason.includes(subject)) fail("unasserted_reason_does_not_name_the_clause", clause);
    normalised[clause] = reason;
  }
  return Object.freeze(normalised);
}

/** A reason lowered and stripped of the punctuation a one-word answer arrives with. */
function genericKey(reason) {
  return reason
    .toLowerCase()
    .replace(/[.!\s]+$/u, "")
    .replace(/\s+/gu, " ");
}

/**
 * `assertion` - the hook a contract names for the clauses its data cannot state.
 *
 * The value is checked, not just the key: a name that is not a module name is `assertion_invalid`, and one no file in
 * the hook directory carries is `assertion_missing`. A key whose value is never looked up is a comment.
 */
function validateAssertion(assertion, { assertionDirectory }) {
  if (assertion === undefined) return null;
  if (!isNonEmptyString(assertion)) fail("assertion_invalid", JSON.stringify(assertion));
  const name = assertion.trim();
  if (!ASSERTION_NAME.test(name)) fail("assertion_invalid", name);
  if (!existsSync(join(assertionDirectory, `${name}.mjs`)))
    fail("assertion_missing", `${name}:${join(assertionDirectory, `${name}.mjs`)}`);
  return name;
}

/**
 * The hook one contract names: the clauses it declares, and the one function the engine calls.
 *
 * The clauses are checked against what THIS contract can name. A receipt key the hook asserts must be a key the
 * contract states - otherwise the hook is asserting something the contract never mentions, which is either a stale
 * hook or a missing clause. An observation family must be one the protocol publishes, read from the generated sample
 * rather than from a list here, because a hook cannot invent a family name either.
 */
export async function loadAssertionHook(contract, { assertionDirectory = ASSERTION_DIRECTORY, families = null } = {}) {
  const name = contract.assertion ?? null;
  if (name === null) return null;
  const path = join(assertionDirectory, `${name}.mjs`);
  const module = await import(pathToFileURL(path).href);
  const functions = Object.entries(module).filter(([, value]) => typeof value === "function");
  if (functions.length !== 1)
    fail("assertion_hook_functions", `${name}:${functions.length}:the engine calls the one function`);
  const asserted = module.asserts;
  if (!Array.isArray(asserted) || asserted.length === 0 || asserted.some((clause) => !isNonEmptyString(clause)))
    fail("assertion_clauses_missing", `${name}:the hook declares no clause list, so nothing can be counted as covered`);
  const published = families ?? readObservationFamilies();
  for (const clause of asserted) {
    const subject = ASSERTION_CLAUSE.exec(clause)?.[1];
    if (subject === undefined) fail("assertion_clause_unnameable", `${name}:${clause}`);
    if (clause.startsWith("evidence.") && contract.evidence[subject] === undefined)
      fail("assertion_clause_unknown", `${name}:${clause}:the contract states no such receipt key`);
    if (clause.startsWith("worldAfter.") && !published.has(subject))
      fail("assertion_clause_unknown", `${name}:${clause}:the protocol publishes no such observation family`);
  }
  return Object.freeze({ name, path, clauses: Object.freeze([...asserted]), run: functions[0][1] });
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
export function validateSmokeContract(
  raw,
  { facts = null, surface = null, protocolControls = null, assertionDirectory = ASSERTION_DIRECTORY } = {},
) {
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

  const { discovery, noneReason } = validateDiscovery(raw.discovery, resolvedFacts);
  const args = validateArgs(raw.args, resolvedFacts);
  const evidence = validateEvidence(raw.evidence);
  const worldAfter = validateWorldAfter(raw.worldAfter);
  const stale = validateStale(raw.stale, args);
  const afterStale = validateWorldAfter(raw.afterStale, "afterStale");
  // `afterStale` is read once the stale re-send has been REFUSED, so a contract carrying it without a re-send to
  // refuse describes a moment its own slice never reaches: the engine would have no terminal to read after.
  if (afterStale.length > 0 && stale === null)
    fail("after_stale_without_stale", `${resolvedFacts.actionId}:declare the stale re-send the block is read after`);
  const delta = validateDelta(raw.delta);
  const unasserted = validateUnasserted(raw.unasserted);
  const assertion = validateAssertion(raw.assertion, { assertionDirectory });

  return Object.freeze({
    schema: SMOKE_CONTRACT_SCHEMA,
    action: resolvedFacts.actionId,
    expectedState: "succeeded",
    expectedReasonCode,
    discovery,
    args,
    evidence,
    worldAfter,
    afterStale,
    stale,
    delta,
    unasserted,
    assertion,
    derived: Object.freeze({
      lifecycle: resolvedFacts.lifecycle,
      nativeBinding: resolvedFacts.nativeBinding,
      argumentSchema: resolvedFacts.argumentSchema,
      targetFamily: resolvedFacts.targetFamily,
      discoveryNone: noneReason,
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
  if (!isPlainObject(args)) fail("args_not_object");
  // The same reader the file form uses: an ad-hoc frame the format itself would refuse is not a frame to launch a
  // game for. The difference between the two forms is where the arguments come from, never what they must say.
  assertArgsAgreeWithDeclaration(args, facts);
  return Object.freeze({
    schema: SMOKE_CONTRACT_SCHEMA,
    action,
    expectedState: "succeeded",
    expectedReasonCode,
    discovery: null,
    args: Object.freeze({ ...args }),
    evidence: Object.freeze({}),
    worldAfter: Object.freeze([]),
    afterStale: Object.freeze([]),
    stale: null,
    delta: Object.freeze([]),
    unasserted: Object.freeze({}),
    assertion: null,
    derived: Object.freeze({
      lifecycle: facts.lifecycle,
      nativeBinding: facts.nativeBinding,
      argumentSchema: facts.argumentSchema,
      targetFamily: facts.targetFamily,
      discoveryNone: null,
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

/**
 * The observation families the generated sample declares - the fields a `worldAfter` assertion can name.
 *
 * Read from the artifact the protocol generates (its `real` sample plus the families the sample world cannot
 * construct), so a family added to the protocol joins the coverage population by existing rather than by being
 * remembered here. `revision`, `location`, `tile` and `capabilities` are not families: they are the transport's own
 * scalars, and no contract ever asserted one as a world change.
 */
export function readObservationFamilies({ samplePath = PROJECTION_SAMPLE_PATH } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(samplePath, "utf8"));
  } catch (error) {
    fail("projection_sample_unreadable", `${samplePath}:${String(error?.message ?? error).slice(0, 120)}`);
  }
  const sampled = Object.keys(parsed?.real ?? {});
  const absent = (parsed?.absent ?? []).map((entry) => entry?.field).filter(isNonEmptyString);
  const families = [...new Set([...sampled, ...absent])].sort();
  if (families.length === 0) fail("projection_sample_empty", samplePath);
  return Object.freeze(new Set(families));
}

/** Every named node under `root`, in source order, without recursion. */
function eachNode(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    visit(node);
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
}

function nodesOfType(root, type) {
  const found = [];
  eachNode(root, (node) => {
    if (node.type === type) found.push(node);
  });
  return found;
}

/**
 * `Number(x)`, `String(x)`, `Boolean(x)`, `(x)` and `await x`, stripped.
 *
 * They narrow a value to a type without changing which receipt key it read, which is why the arithmetic under
 * `Number(evidence.count_after) === Number(evidence.count_before) + 1` is named by its keys and not by its calls.
 */
function narrowed(node) {
  let current = node;
  for (let depth = 0; depth < MAX_RESOLUTION_DEPTH; depth++) {
    if (current === null || current === undefined) return null;
    if (current.type === "parenthesized_expression" || current.type === "await_expression") {
      current = current.namedChildren[0] ?? null;
      continue;
    }
    if (current.type === "call_expression" && NARROWING_CALL.has(current.childForFieldName("function")?.text)) {
      current = current.childForFieldName("arguments")?.namedChildren[0] ?? null;
      continue;
    }
    return current;
  }
  return current;
}

/** A string literal's text without its quotes; a number, boolean or null as written. */
function literalText(node) {
  if (node.type !== "string") return node.text;
  return node.namedChildren.length === 1 ? node.namedChildren[0].text : node.text.slice(1, -1);
}

/**
 * The names a parameter list binds, and for a destructured bag the property each one reads.
 *
 * `key` is `null` for a plain parameter, whose argument a call site passes positionally, and the property name for a
 * destructured one (`{ target, evidence }`), whose name is not bound to the whole argument object.
 */
function parameterNames(parameters) {
  const names = [];
  for (const parameter of parameters.namedChildren) {
    if (parameter.type === "identifier") {
      names.push({ name: parameter.text, key: null });
      continue;
    }
    const pattern = parameter.type === "assignment_pattern" ? parameter.childForFieldName("left") : parameter;
    if (pattern?.type === "object_pattern") {
      for (const property of pattern.namedChildren) {
        const key = property.childForFieldName("key") ?? property;
        if (isNonEmptyString(key.text)) names.push({ name: key.text, key: key.text });
      }
      continue;
    }
    if (isNonEmptyString(pattern?.text)) names.push({ name: pattern.text, key: null });
  }
  return names;
}

/**
 * The assertions one hand-written runner makes, as the clauses a contract has to answer for.
 *
 * Four kinds, because those are the four things the contract format can carry:
 *
 *   evidence.<key>       every receipt key the runner COMPARES, with the form of the comparison: `equals` for a
 *                        literal, `equalsTarget` for one field of the discovered target, and `other` for the
 *                        comparisons the format cannot write down (key against key, a range, a delta, a composite
 *                       `${target.x},${target.y}`).
 *   worldAfter.<field>   every observation family the runner reads off a snapshot taken AFTER the dispatch. A
 *                        snapshot's `revision` or `location` is not one: only the generated families are, so the
 *                        population comes from the protocol, not from a list here.
 *   terminal.state, terminal.reasonCode, terminal.stale   the terminal the runner demands, and whether it re-sends
 *                        the stale target.
 *   dispatch.<n>         the second and later dispatches: the format expresses one dispatch plus one stale re-send.
 *   afterStale           ONE clause for the class `stale` cannot state: the runner reads a world family off an
 *                        observation taken after the stale re-send was refused. One clause rather than one per field,
 *                        because what the block declares is a MOMENT the contract has to reach; which fields it pins
 *                        is the contract's own claim, and `worldAfter` already owns the per-field reading.
 *
 * A key compared to itself (`evidence.pet_day === String(evidence.pet_day)`) is not a clause: it asserts the value
 * is a string, which the evidence envelope already guarantees.
 */
function runnerAssertions(root, { families }) {
  const dispatchSites = nodesOfType(root, "call_expression")
    .filter((call) => call.childForFieldName("function")?.text === DISPATCH_CALL)
    .sort((left, right) => left.startIndex - right.startIndex);
  const firstDispatch = dispatchSites.length === 0 ? Number.POSITIVE_INFINITY : dispatchSites[0].startIndex;
  const staleDispatch = staleReSendPosition(dispatchSites);

  const functions = new Map();
  for (const declaration of nodesOfType(root, "function_declaration")) {
    const name = declaration.childForFieldName("name")?.text;
    const body = declaration.childForFieldName("body");
    const parameters = declaration.childForFieldName("parameters");
    if (!isNonEmptyString(name) || body === null || parameters === null) continue;
    functions.set(name, { body, params: Object.freeze(parameterNames(parameters)) });
  }

  /** name -> [{ at, value }] in source order: where a name last took a value, to know if it holds an observation. */
  const bindings = new Map();
  const bind = (name, at, value) => {
    if (!isNonEmptyString(name) || value === null) return;
    const entries = bindings.get(name) ?? [];
    if (entries.length === 0) bindings.set(name, entries);
    entries.push({ at, value });
  };
  for (const declarator of nodesOfType(root, "variable_declarator")) {
    const name = declarator.childForFieldName("name");
    if (name?.type === "identifier") bind(name.text, name.startIndex, declarator.childForFieldName("value"));
  }
  for (const assignment of nodesOfType(root, "assignment_expression")) {
    const left = assignment.childForFieldName("left");
    if (left?.type === "identifier") bind(left.text, left.startIndex, assignment.childForFieldName("right"));
  }
  for (const entries of bindings.values()) entries.sort((left, right) => left.at - right.at);

  const lastBindingBefore = (name, position) => {
    const entries = bindings.get(name) ?? [];
    let found = null;
    for (const entry of entries) {
      if (entry.at > position) break;
      found = entry.value;
    }
    return found;
  };

  const isObservationCall = (node) => {
    const inner = narrowed(node);
    return inner?.type === "call_expression" && OBSERVATION_CALL.test(inner.childForFieldName("function")?.text ?? "");
  };
  /** Whether some binding of this name ever holds an observation - what separates a snapshot from a target object. */
  const observesName = (name) => (bindings.get(name) ?? []).some((entry) => isObservationCall(entry.value));

  const holdsObservation = (identifier, scope, depth) => {
    if (scope.params.has(identifier.text)) return scope.post.has(identifier.text);
    if (depth > MAX_RESOLUTION_DEPTH) return false;
    return isPost(lastBindingBefore(identifier.text, identifier.startIndex), scope, depth + 1);
  };
  function isPost(node, scope, depth = 0) {
    const inner = narrowed(node);
    if (inner === null || depth > MAX_RESOLUTION_DEPTH) return false;
    if (inner.type === "identifier") return holdsObservation(inner, scope, depth);
    if (inner.type !== "call_expression") return false;
    const callee = inner.childForFieldName("function")?.text;
    if (isNonEmptyString(callee) && OBSERVATION_CALL.test(callee) && inner.startIndex > scope.frontier) return true;
    const local = functions.get(callee);
    if (local === undefined) return false;
    // A helper that hands back part of an observation (`fishPondTargets(after)`) carries the observation with it.
    const args = inner.childForFieldName("arguments")?.namedChildren ?? [];
    return args.some((arg) => isPost(arg, scope, depth + 1));
  }

  const index = { lastBindingBefore, observesName, functions, isPost };

  /**
   * One walk, one scope per set of arguments a local helper was called with: a comparison inside
   * `assertEvidence(evidence, "animal_door_open_before", "false")` is only readable once `key` is resolved to the
   * literal its own call site passed, and a snapshot read inside `fishPondTargets(after)` is only a world-after
   * reading once `after` is known to be an observation taken after the frame the walk is measuring against.
   *
   * `frontier` is that frame. Two walks share the parse: the first measures against the dispatch, the second against
   * the stale re-send - so "the world after the action" and "the world after the refusal" are two readings of one
   * source, not two parsers that could disagree.
   */
  const walk = (frontier) => {
    const sinks = {
      world: new Set(),
      evidence: new Map(),
      relations: new Map(),
      states: new Set(),
      reasonCodes: new Set(),
      staleTerminal: false,
    };
    const context = {
      index,
      families,
      scopes: [{ body: root, post: new Set(), params: new Set(), bound: new Map(), frontier }],
    };
    const visited = new Set();
    while (context.scopes.length > 0) {
      const scope = context.scopes.shift();
      const mark = scopeMark(scope);
      if (visited.has(mark)) continue;
      visited.add(mark);
      eachNode(scope.body, (node) => noteNode(sinks, node, scope, context));
    }
    return sinks;
  };

  const read = walk(firstDispatch);
  // `staleDispatch` is the frame that sent a request an earlier frame already sent, so a world read after it is the
  // reading `stale` has no spelling for. A second ACTION is not this: `equip_tool` then `cut_grass` sends different
  // arguments, and the world after the cut is that action's own postcondition.
  const afterStale = staleDispatch === null ? null : walk(staleDispatch);
  return Object.freeze({
    clauses: Object.freeze(clauseNames(read, dispatchSites.length, afterStale !== null && afterStale.world.size > 0)),
    evidence: read.evidence,
    relations: read.relations,
    world: read.world,
    afterStaleWorld: afterStale === null ? new Set() : afterStale.world,
    states: read.states,
    reasonCodes: read.reasonCodes,
    staleTerminal: read.staleTerminal,
    dispatches: dispatchSites.length,
  });
}

/** The property values of one dispatch's `args` bag, normalised and sorted: two frames sending the same request. */
function dispatchArgsKey(call) {
  const bag = (call.childForFieldName("arguments")?.namedChildren ?? []).find((node) => node.type === "object");
  const args = (bag?.namedChildren ?? []).find(
    (node) => node.type === "pair" && node.childForFieldName("key")?.text === "args",
  );
  const value = args?.childForFieldName("value");
  if (value?.type !== "object") return null;
  const entries = value.namedChildren
    .filter((node) => node.type === "pair")
    .map(
      (pair) =>
        `${pair.childForFieldName("key")?.text}=${String(pair.childForFieldName("value")?.text ?? "")
          .replace(/\s+/gu, " ")
          .trim()}`,
    );
  return entries.length === 0 ? null : JSON.stringify(entries.sort());
}

/**
 * The first dispatch that sends a request an earlier dispatch already sent - the stale re-send, by its own arguments.
 *
 * A SECOND FRAME IS NOT ENOUGH. 31 of the 119 runners dispatch more than once, and most of those are a preview action
 * (`equip_tool`) followed by the action under test, or a chain of two different actions. The stale re-send is the one
 * frame that sends the arguments of a frame that has already been consumed, and it is the only one whose refusal, and
 * whose world, the `stale` key describes. Measured by arguments rather than by position, so a chain's third frame is
 * never mistaken for a re-send just because it is second.
 */
function staleReSendPosition(dispatchSites) {
  const keys = dispatchSites.map(dispatchArgsKey);
  for (let index = 1; index < keys.length; index++) {
    if (keys[index] === null) continue;
    if (keys.slice(0, index).includes(keys[index])) return dispatchSites[index].startIndex;
  }
  return null;
}

function noteNode(sinks, node, scope, context) {
  if (node.type === "member_expression") noteWorldField(sinks, node, scope, context);
  else if (node.type === "binary_expression") noteComparison(sinks, node, scope, context.index);
  else if (node.type === "call_expression") pushCalleeScope(node, scope, context);
}

/** A world-after clause: a generated observation family, read off a snapshot taken after the dispatch. */
function noteWorldField(sinks, node, scope, { index, families }) {
  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  if (
    object?.type === "identifier" &&
    property?.type === "property_identifier" &&
    families.has(property.text) &&
    index.isPost(object, scope)
  )
    sinks.world.add(property.text);
}

function noteComparison(sinks, node, scope, index) {
  const operator = node.childForFieldName("operator")?.text;
  if (!COMPARISON_OPERATORS.has(operator)) return;
  const left = classifyValue(node.childForFieldName("left"), scope, index);
  const right = classifyValue(node.childForFieldName("right"), scope, index);
  // A key compared with itself (`evidence.pet_day === String(evidence.pet_day)`) asserts only that the value is a
  // string, which the evidence envelope already carries; it is not a clause a contract could state.
  if (left.kind === "evidence" && right.kind === "evidence" && left.key === right.key) return;
  noteClause(sinks, left, right, operator);
  noteClause(sinks, right, left, operator);
  // Every OTHER key the comparison reads is a comparison the format cannot write down: the arithmetic under
  // `Number(evidence.count_after) === Number(evidence.count_before) + 1` reads count_before, and a contract that never
  // names it has dropped the half of the relation that says what the first half was measured against. The pair is
  // recorded, not just the keys: a `delta` entry states ONE relation between TWO keys, and coverage has to be able to
  // ask whether the contract named that relation rather than merely mentioning the keys.
  const keysIn = [...evidenceKeysIn(node)];
  for (const key of keysIn) if (left.key !== key && right.key !== key) noteEvidence(sinks, key, "other");
  for (const key of keysIn) for (const partner of keysIn) if (partner !== key) notePartner(sinks, key, partner);
  // The pair is also readable from the two sides themselves: `delivered === returned` compares two LOCALS, so no
  // member expression names either key and the walk above sees an empty key set while the comparison is still a
  // relation between them.
  if (left.kind === "evidence" && right.kind === "evidence" && left.key !== right.key) {
    notePartner(sinks, left.key, right.key);
    notePartner(sinks, right.key, left.key);
  }
}

/** One scope per set of arguments a local helper was called with, so its reads are read in its caller's terms. */
function pushCalleeScope(node, scope, { index, scopes }) {
  const local = index.functions.get(node.childForFieldName("function")?.text);
  if (local === undefined) return;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const post = new Set();
  const bound = new Map(scope.bound);
  local.params.forEach((param, position) => {
    const argument = args[position];
    if (argument === undefined) return;
    if (param.key === null) bound.set(param.name, argument);
    if (index.isPost(argument, scope)) post.add(param.name);
  });
  scopes.push({
    body: local.body,
    post,
    params: new Set(local.params.map((param) => param.name)),
    bound,
    frontier: scope.frontier,
  });
}

function scopeMark(scope) {
  const bound = [...scope.bound.values()]
    .map((node) => node.startIndex)
    .sort((left, right) => left - right)
    .join(",");
  return [scope.body.startIndex, scope.frontier, [...scope.post].sort().join(","), bound].join("|");
}

function noteEvidence(sinks, key, form) {
  const forms = sinks.evidence.get(key) ?? { equals: new Set(), equalsTarget: new Set(), other: false };
  if (!sinks.evidence.has(key)) sinks.evidence.set(key, forms);
  if (form === "other") forms.other = true;
  else if (form.equals !== undefined) forms.equals.add(form.equals);
  else forms.equalsTarget.add(form.equalsTarget);
}

/** The other receipt keys one comparison reads beside this one. */
function notePartner(sinks, key, partner) {
  const partners = sinks.relations.get(key) ?? new Set();
  if (!sinks.relations.has(key)) sinks.relations.set(key, partners);
  partners.add(partner);
}

function noteClause(sinks, side, other, operator) {
  if (side.kind === "evidence") {
    if (other.kind === "evidence") return noteEvidence(sinks, side.key, "other");
    if (other.kind === "literal")
      return EQUALITY_OPERATORS.has(operator)
        ? noteEvidence(sinks, side.key, { equals: other.text })
        : noteEvidence(sinks, side.key, "other");
    if (other.kind === "member")
      return EQUALITY_OPERATORS.has(operator)
        ? noteEvidence(sinks, side.key, { equalsTarget: other.field })
        : noteEvidence(sinks, side.key, "other");
    return noteEvidence(sinks, side.key, "other");
  }
  if (side.kind !== "terminal" || other.kind !== "literal") return;
  if (side.stale) {
    sinks.staleTerminal = true;
    return;
  }
  if (side.field === "state") sinks.states.add(other.text);
  if (side.field === "reasonCode") sinks.reasonCodes.add(other.text);
}

function clauseNames(sinks, dispatches, reReadsAfterStale) {
  return [
    ...[...sinks.evidence.keys()].map((key) => `${EVIDENCE_OBJECT}.${key}`),
    ...[...sinks.world].map((field) => `worldAfter.${field}`),
    ...(sinks.states.size > 0 ? ["terminal.state"] : []),
    ...(sinks.reasonCodes.size > 0 ? ["terminal.reasonCode"] : []),
    ...(sinks.staleTerminal ? ["terminal.stale"] : []),
    ...(reReadsAfterStale ? ["afterStale"] : []),
    ...Array.from({ length: Math.max(0, dispatches - 1) }, (_, position) => `dispatch.${position + 2}`),
  ].sort();
}

/** The receipt keys an expression subtree reads, `integerEvidence(evidence.rewards_before)` included. */
function evidenceKeysIn(node) {
  const keys = new Set();
  eachNode(node, (current) => {
    if (current.type !== "member_expression") return;
    const object = current.childForFieldName("object");
    const property = current.childForFieldName("property");
    if (object?.type !== "identifier" || property?.type !== "property_identifier") return;
    if (!EVIDENCE_BAG.test(object.text) || EVIDENCE_ENVELOPE.has(property.text)) return;
    keys.add(property.text);
  });
  return keys;
}

/**
 * The receipt key a local holds, when a runner narrows one into a variable before comparing it.
 *
 * `claim_museum_reward` reads `const before = integerEvidence(evidence.rewards_before)` and then compares
 * `before >= 1 && before === returned`; the comparison is on locals, so the keys have to be followed through the
 * binding or that runner's judgement would read as "compares nothing".
 */
function heldEvidenceKey(identifier, index) {
  const value = index.lastBindingBefore(identifier.text, identifier.startIndex);
  if (value === null) return null;
  const keys = evidenceKeysIn(value);
  return keys.size === 1 ? [...keys][0] : null;
}

/** A name resolved through the arguments the calling scope passed for it, never through itself. */
function resolveValue(node, scope) {
  let current = node;
  for (let depth = 0; depth < MAX_RESOLUTION_DEPTH; depth++) {
    const inner = narrowed(current);
    if (inner === null) return null;
    if (inner.type === "identifier" && scope.bound.has(inner.text)) {
      const bound = scope.bound.get(inner.text);
      if (bound.type === "identifier" && bound.text === inner.text) return inner;
      current = bound;
      continue;
    }
    return inner;
  }
  return null;
}

/** What one side of a comparison is, in the vocabulary a clause is named in. */
function classifyValue(node, scope, index) {
  const inner = resolveValue(node, scope);
  if (inner === null) return { kind: "other" };
  if (inner.type === "identifier") {
    const held = heldEvidenceKey(inner, index);
    return held === null ? { kind: "other" } : { kind: "evidence", key: held };
  }
  if (inner.type === "subscript_expression") {
    // `assertEvidence(evidence, "animal_door_open_before", "false")` compares `evidence[key]` inside a helper.
    const object = inner.childForFieldName("object");
    const subscript = inner.childForFieldName("index");
    const key = subscript === null ? null : resolveValue(subscript, scope);
    if (
      object?.type === "identifier" &&
      EVIDENCE_BAG.test(object.text) &&
      key?.type === "string" &&
      !EVIDENCE_ENVELOPE.has(literalText(key))
    )
      return { kind: "evidence", key: literalText(key) };
    return { kind: "other" };
  }
  if (inner.type === "member_expression") {
    const object = inner.childForFieldName("object");
    const property = inner.childForFieldName("property");
    if (object?.type === "identifier" && property?.type === "property_identifier") {
      if (EVIDENCE_BAG.test(object.text))
        return EVIDENCE_ENVELOPE.has(property.text) ? { kind: "other" } : { kind: "evidence", key: property.text };
      if (TERMINAL_ALIAS.test(object.text))
        return { kind: "terminal", field: property.text, stale: STALE_ALIAS.test(object.text) };
      if (index.observesName(object.text)) return { kind: "observation", field: property.text };
      return { kind: "member", field: property.text };
    }
    return { kind: "other" };
  }
  if (LITERAL_TYPES.has(inner.type)) return { kind: "literal", text: literalText(inner) };
  return { kind: "other" };
}

/** The runner the contract for `action` stands in for, named the way the tree names it. */
export function runnerFileName(actionId) {
  return `${RUNNER_PREFIX}${actionId.replaceAll("_", "-")}-smoke.mjs`;
}

/**
 * Whether the contract carries the clause, in the form the runner demands where the format can express it.
 *
 * A receipt key whose runner comparisons are relations - `count_after === count_before + 1`, `mail_flags_after >
 * mail_flags_before`, `rewards_before >= 1` - is covered by a `delta` entry that names the SAME relation, and by
 * nothing less: the entry must name this key, it must name every key this one was compared against, and a bound with
 * no partner needs an entry with no `from`. A value the format can state (`count_after: "3"`) never covers a relation:
 * it pins today's answer in place of the relation, which is the defect this whole format exists to stop.
 */
function contractCovers(clause, contract, runner) {
  if (clause.startsWith(`${EVIDENCE_OBJECT}.`)) {
    const key = clause.slice(EVIDENCE_OBJECT.length + 1);
    const forms = runner.evidence.get(key);
    if (forms === undefined) return false;
    const assertion = contract.evidence[key];
    const named = contract.delta.some((entry) => entry.to === key || entry.from === key);
    if (forms.other) {
      if (assertion !== undefined) return false;
      return deltaCovers(contract.delta, key, runner.relations.get(key) ?? new Set());
    }
    if (assertion === undefined) {
      // The runner's only comparison may be `!== null`: an integer-parse guard, not a claim about the value. The
      // engine already fails a missing or non-numeric key on every form, so a `delta` entry naming this key covers
      // the guard; anything else the runner compared needs its own entry.
      const guardOnly = forms.equalsTarget.size === 0 && [...forms.equals].every((text) => text === "null");
      return guardOnly && named;
    }
    if (forms.equals.size > 0 && !forms.equals.has(assertion.equals)) return false;
    if (forms.equalsTarget.size > 0 && !forms.equalsTarget.has(assertion.equalsTarget)) return false;
    return forms.equals.size > 0 || forms.equalsTarget.size > 0;
  }
  if (clause.startsWith("worldAfter.")) {
    const field = clause.slice("worldAfter.".length);
    return contract.worldAfter.some((assertion) => assertion.field === field);
  }
  if (clause === "terminal.state")
    return contract.expectedState === "succeeded" && (runner.states.size === 0 || runner.states.has("succeeded"));
  if (clause === "terminal.reasonCode")
    return runner.reasonCodes.size === 0 || runner.reasonCodes.has(contract.expectedReasonCode);
  if (clause === "terminal.stale") return contract.stale !== null;
  if (clause === "dispatch.2") return contract.stale !== null;
  // The moment, not the fields: a block of any size reaches the reading the runner took after the refusal.
  if (clause === "afterStale") return contract.afterStale.length > 0;
  return false;
}

/**
 * The `delta` list against one key's own relations.
 *
 * Every key this one was compared against must be the other side of an entry naming it, and a bound compared with no
 * other key (`rewards_before >= 1`) needs an entry that names this key as `to` with no `from`. Requiring both is what
 * keeps the coverage reading from passing a contract that states half the relation.
 */
function deltaCovers(entries, key, partners) {
  const naming = entries.filter((entry) => entry.to === key || entry.from === key);
  if (naming.length === 0) return false;
  for (const partner of partners)
    if (!naming.some((entry) => (entry.to === key ? entry.from : entry.to) === partner)) return false;
  if (partners.size === 0) return naming.some((entry) => entry.to === key && entry.from === null);
  return true;
}

/**
 * The contract against the runner it replaces: what it covers, what it declares unasserted, what it drops.
 *
 * `unknown` is the other direction, and it is the one that keeps a declaration from outliving its clause: a
 * contract naming `evidence.count_after` after the runner stopped comparing it is refused too.
 */
function compareContractToRunner(contract, runner, hook) {
  const declarations = contract.unasserted ?? {};
  const asserted = hook === null ? [] : hook.clauses;
  const covered = [];
  const declared = [];
  const dropped = [];
  for (const clause of runner.clauses) {
    // A hook answers what the format cannot write down, so its clauses are covered - before the declaration is
    // consulted, because a clause a hook asserts cannot also be an exception nobody asserts.
    if (asserted.includes(clause)) covered.push(clause);
    else if (declarations[clause] !== undefined) declared.push(clause);
    else if (contractCovers(clause, contract, runner)) covered.push(clause);
    else dropped.push(clause);
  }
  // A declaration the hook now asserts has outlived itself: the exemption expires with the gap it excused.
  const unknown = Object.keys(declarations)
    .filter((clause) => !runner.clauses.includes(clause) || asserted.includes(clause))
    .sort();
  // The inverse of the `afterStale` clause: a block declaring a moment this runner never reaches. Nothing else in
  // this format refuses a contract for asserting MORE than its runner does - an extra `worldAfter` field is a claim,
  // and a live slice judges it. But a `afterStale` block is a claim about a SHAPE (the runner re-reads after the
  // refusal), and a shape nobody can point at is a guess: the engine would read a moment the runner never took.
  const afterStaleUnread = contract.afterStale.length > 0 && runner.afterStaleWorld.size === 0 ? [contract.action] : [];
  return Object.freeze({
    covered: Object.freeze(covered),
    declared: Object.freeze(declared),
    dropped: Object.freeze(dropped),
    unknown: Object.freeze(unknown),
    afterStaleUnread: Object.freeze(afterStaleUnread),
    withFamily: contract.derived.targetFamily !== null,
    declaredNone: contract.discovery === null,
  });
}

/**
 * Every committed contract, against the hand-written runner it stands in for.
 *
 * The population is the directory: a fourteenth contract joins by existing. A contract whose runner was DELETED is
 * not orphaned when its gate row routes through the contract - that is what promotion means, and the answer comes from
 * the route resolver rather than from a second assumption here. A row still routed through a runner that is not there
 * is the anomaly, and is refused by name. The reading names its own population - `examined`, `compared`, `promoted`,
 * `withFamily`, `declaredNone` - because `0 dropped` over `0 examined` is a reading that agrees with itself.
 */
export async function checkContractCoverage({
  contractDirectory = CONTRACT_DIRECTORY,
  runnerDirectory = RUNNER_DIRECTORY,
  samplePath = PROJECTION_SAMPLE_PATH,
  routeFor = gateRouteFor,
  assertionDirectory = ASSERTION_DIRECTORY,
} = {}) {
  const families = readObservationFamilies({ samplePath });
  const routes = await loadGateRoute();
  const files = readdirSync(contractDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) fail("corpus_empty", contractDirectory);
  const readings = [];
  for (const file of files) {
    const contract = loadSmokeContractFile(join(contractDirectory, file), { assertionDirectory });
    // The hook is read for EVERY contract that names one, promoted or compared: a name that resolves to no file, a
    // hook that exports no clause list, or a clause this contract cannot name is a finding here rather than a silence
    // in the live run that would have called it.
    const hook = await loadAssertionHook(contract, { assertionDirectory, families });
    const runner = runnerFileName(contract.action);
    const runnerPath = resolve(runnerDirectory, runner);
    const base = {
      file: join(contractDirectory, file),
      action: contract.action,
      assertion: hook === null ? null : hook.name,
      withFamily: contract.derived.targetFamily !== null,
      declaredNone: contract.discovery === null,
    };
    if (!existsSync(runnerPath)) {
      const route = await routeFor(contract.action);
      if (route.route !== routes.CONTRACT_ROUTE)
        fail(
          "runner_missing",
          `${contract.action}:${runner}${route.problem === null ? ":no_contract_route" : `:${route.problem.code}`}`,
        );
      // The contract IS the live gate: there is no runner left to hold it to, so nothing is dropped and nothing is
      // compared. Recorded as `promoted` rather than as an empty reading, so `0 dropped` cannot be read as `0 clauses`.
      readings.push(
        Object.freeze({
          ...base,
          runner: null,
          promoted: true,
          covered: Object.freeze([]),
          declared: Object.freeze([]),
          dropped: Object.freeze([]),
          unknown: Object.freeze([]),
          afterStaleUnread: Object.freeze([]),
        }),
      );
      continue;
    }
    const tree = await parseJavaScript(readFileSync(runnerPath, "utf8"), runner);
    if (tree.rootNode.hasError) fail("runner_unparsed", `${contract.action}:${runner}`);
    readings.push(
      Object.freeze({
        ...base,
        runner,
        promoted: false,
        ...compareContractToRunner(contract, runnerAssertions(tree.rootNode, { families }), hook),
      }),
    );
  }
  const dropped = readings.flatMap((entry) => entry.dropped.map((clause) => `${entry.action}:${clause}`));
  const unknown = readings.flatMap((entry) => entry.unknown.map((clause) => `${entry.action}:${clause}`));
  const census = await classCensus({ runnerDirectory, families });
  const represented = readings.filter((entry) => !entry.promoted && census.readers.has(entry.runner));
  return Object.freeze({
    directory: contractDirectory,
    examined: readings.length,
    promoted: readings.filter((entry) => entry.promoted).length,
    withFamily: readings.filter((entry) => entry.withFamily).length,
    declaredNone: readings.filter((entry) => entry.declaredNone).length,
    compared: readings.reduce(
      (total, entry) => total + entry.covered.length + entry.declared.length + entry.dropped.length,
      0,
    ),
    covered: readings.reduce((total, entry) => total + entry.covered.length, 0),
    declared: readings.reduce((total, entry) => total + entry.declared.length, 0),
    dropped: Object.freeze(dropped.sort()),
    unknown: Object.freeze(unknown.sort()),
    // THE CLASS, not only the contracts. `stale` could not say "and the world did not move", so a runner that read the
    // world again after the refusal lost the only test of that clause the moment its runner was retired - and the
    // gate read `dropped 0` because the clause had no spelling. The population here is the runner DIRECTORY, so a
    // runner written tomorrow is measured by existing, and the reading says how many of them the format was blind to.
    afterStale: Object.freeze({
      runners: census.runners,
      reread: census.readers.size,
      // The members, so the number is auditable: "18 of 119" without the list is a rumour a reader cannot check.
      readers: Object.freeze([...census.readers].map(runnerAction).sort()),
      represented: represented.length,
      declared: represented.filter((entry) => !entry.dropped.includes("afterStale")).length,
      undeclared: Object.freeze(
        readings
          .filter((entry) => entry.dropped.includes("afterStale"))
          .map((entry) => entry.action)
          .sort(),
      ),
    }),
    afterStaleUnread: Object.freeze(
      readings.flatMap((entry) => (entry.afterStaleUnread ?? []).map((action) => `${action}:afterStale`)).sort(),
    ),
    readings: Object.freeze(readings),
  });
}

/** `run-stardew-native-local-player-<action>-smoke.mjs` -> `<action>`: the inverse of `runnerFileName`, exactly. */
function runnerAction(runner) {
  return runner.slice(RUNNER_PREFIX.length, -"-smoke.mjs".length).replaceAll("-", "_");
}

/**
 * The runners that read a world family off an observation taken after their stale re-send.
 *
 * This is the population the `afterStale` clause is about, measured over the runner directory rather than over the
 * contracts, so the number is the SIZE OF THE CLASS and not the size of the corpus that happens to answer for it
 * today. A runner whose file does not parse is a refusal, not a silent omission: an unreadable member of the
 * population would make the class look smaller than it is.
 */
async function classCensus({ runnerDirectory, families }) {
  const runnerFiles = readdirSync(runnerDirectory)
    .filter((name) => name.startsWith(RUNNER_PREFIX) && name.endsWith("-smoke.mjs"))
    .sort();
  const readers = new Set();
  for (const runner of runnerFiles) {
    const tree = await parseJavaScript(readFileSync(resolve(runnerDirectory, runner), "utf8"), runner);
    if (tree.rootNode.hasError) fail("runner_unparsed", `${runner}:class_census`);
    if (runnerAssertions(tree.rootNode, { families }).afterStaleWorld.size > 0) readers.add(runner);
  }
  return { runners: runnerFiles.length, readers };
}

/**
 * The route resolver, loaded once and lazily.
 *
 * `stardew-action-gate-route.mjs` reads `SMOKE_CONTRACT_SCHEMA` from this module, so a static import here would be a
 * cycle started from whichever side the test loaded first. Deferring the import keeps the route answer where the route
 * resolver owns it - a row's route is not restated here.
 */
let gateRouteModule = null;
async function loadGateRoute() {
  gateRouteModule ??= await import("./stardew-action-gate-route.mjs");
  return gateRouteModule;
}

async function gateRouteFor(action) {
  return (await loadGateRoute()).resolveStardewActionGateRoute(action);
}

/**
 * The corpus guard: refuse a dropped assertion, a declaration that outlived the clause it excuses, and an
 * `afterStale` block on a runner that has no such moment to declare.
 *
 * Zero examined is blocked with its reason instead of passing, because a directory that read nothing is not a corpus
 * that covered everything.
 */
export function assertContractCoverage(reading) {
  if (reading.examined === 0)
    fail("coverage_examined_nothing", `${reading.directory}: a corpus that read nothing is not a corpus that passed`);
  if (reading.dropped.length > 0) fail("drops_a_runner_assertion", reading.dropped.join(" "));
  if (reading.unknown.length > 0) fail("unasserted_clause_unknown", reading.unknown.join(" "));
  if (reading.afterStaleUnread.length > 0)
    fail("afterStale_declared_but_the_runner_does_not_re_read", reading.afterStaleUnread.join(" "));
  return reading;
}

export { ContractError };
