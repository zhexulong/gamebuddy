/**
 * Every refusal `tools/lib/stardew-action-smoke-contract.mjs` can make, and the corpus it loads.
 *
 * WHY THIS FILE EXISTS. The loader's central rule - a contract may not restate a fact the action's own
 * declaration already owns - was real code with no test, which is the shape of a gate nobody calls: the
 * refusal could be deleted, or moved behind an earlier `return`, and every contract in the tree would keep
 * loading. So each refusal below is exercised, and the corpus test loads the committed contracts and prints
 * `contracts examined N · loaded M · refused K`.
 *
 * THE REFUSAL POPULATION IS THE LOADER'S OWN SOURCE: every `fail("<code>"` in that file is a refusal the
 * loader can make, read on each run. A refusal written tomorrow arrives with no probe and this suite goes red
 * naming it, which a hand-written list of six could never do. The corpus population is the directory scan of
 * `contracts/smoke`, for the same reason: a fourteenth contract joins by existing.
 *
 * ZERO POPULATION FAILS, in both halves. `examined 0 contracts` is a reading that agrees with itself, so the
 * corpus guard blocks it and the falsifier below proves it blocks it. A loader source with no `fail(` call
 * at all is a reader that lost the file, not a loader with nothing to refuse.
 *
 * red-proof: inject  a contract that restates its action's declared postcondition as `expectedReasonCode`
 *            -> `smoke_contract_reason_code_redeclared` naming the action, and an empty corpus directory
 *            -> `examined 0 contracts` rather than a pass (tools/lib/stardew-action-smoke-contract.test.mjs).
 *            A refusal code with no probe is injected too, and the gate names the code.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONTRACT_ROUTE, resolveStardewActionGateRoute } from "./stardew-action-gate-route.mjs";
import {
  assertContractCoverage,
  ContractError,
  checkContractCoverage,
  deriveActionFacts,
  GENERIC_POSTCONDITION,
  loadSmokeContractFile,
  readActionSurface,
  readObservationFamilies,
  readProtocolControls,
  runnerFileName,
  SMOKE_CONTRACT_SCHEMA,
  validateSmokeContract,
} from "./stardew-action-smoke-contract.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LOADER_PATH = join(ROOT, "tools/lib/stardew-action-smoke-contract.mjs");
const CONTRACT_DIRECTORY = join(ROOT, "contracts/smoke");

const surface = readActionSurface();
const protocolControls = readProtocolControls();
const rows = [...surface.values()];

const roots = [];
function tempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}
let scratch = null;
function tempFile(name, contents) {
  scratch ??= tempDirectory("smoke-contract-probe-");
  const path = join(scratch, name);
  writeFileSync(path, contents, "utf8");
  return path;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** One row of the generated action surface, chosen by what it declares. */
function rowWhere(predicate, description) {
  const row = rows.find(
    (candidate) => candidate.kind === "execution" && predicate(candidate) && factsOrNull(candidate.actionId) !== null,
  );
  assert.ok(row !== undefined, `the action surface declares no execution action ${description}`);
  return row;
}

/**
 * The derived facts, or `null` when the launcher has no fixture world for the action.
 *
 * That refusal is a population, not an exception: seven of the 103 declared execution actions are in it, and a
 * contract cannot be written for one of them at all. Every other refusal is rethrown, so a defect in the
 * derivation is never read as "this action has no world".
 */
function factsOrNull(actionId) {
  try {
    return deriveActionFacts(actionId, { surface, protocolControls });
  } catch (error) {
    if (error.code === "smoke_contract_fixture_scenario_underivable") return null;
    throw error;
  }
}

const SPECIFIC_ROW = rowWhere(
  (row) => row.targetFamily !== undefined && row.postcondition?.name !== GENERIC_POSTCONDITION,
  "with a specific postcondition and a target family",
);
const GENERIC_ROW = rowWhere(
  (row) => row.targetFamily !== undefined && row.postcondition?.name === GENERIC_POSTCONDITION,
  "with a generic postcondition and a target family",
);
const NO_TARGET_ROW = rowWhere((row) => row.targetFamily === undefined, "without a target family");
const READ_ONLY_ROW = rows.find((row) => row.kind === "read_only");
assert.ok(READ_ONLY_ROW !== undefined, "the action surface declares no read-only action");

/** An argument object the declared `argumentSchema` accepts - the declaration owns the names and types. */
function argsFor(row) {
  const args = {};
  for (const [name, spec] of Object.entries(row.argumentSchema ?? {})) {
    if (spec.type === "integer") args[name] = 1;
    else if (spec.type === "boolean") args[name] = true;
    else args[name] = Array.isArray(spec.enum) ? spec.enum[0] : "probe";
  }
  return args;
}

/** The argument of one declared type, so a probe can break exactly that one. */
function argumentNamed(row, type) {
  const entry = Object.entries(row.argumentSchema ?? {}).find(([, spec]) => spec.type === type);
  assert.ok(entry !== undefined, `${row.actionId} declares no ${type} argument`);
  return entry[0];
}

/** The same question with `null` instead of an assertion, for a row chosen by having one. */
function argumentNamedOrNull(row, type) {
  const entry = Object.entries(row.argumentSchema ?? {}).find(([, spec]) => spec.type === type);
  return entry === undefined ? null : entry[0];
}

/**
 * A contract the loader accepts for this row, before the probe breaks one thing.
 *
 * A generic declaration derives no success word, so the contract supplies one; a specific declaration derives
 * its own and supplying one is the refusal tested below.
 */
function contractRow(row, extra = {}) {
  const declared = row.postcondition?.name;
  return {
    schema: SMOKE_CONTRACT_SCHEMA,
    action: row.actionId,
    ...(declared === GENERIC_POSTCONDITION ? { expectedReasonCode: `${row.actionId}_probe_succeeded` } : {}),
    discovery: {},
    args: argsFor(row),
    ...extra,
  };
}

/** The actions the launcher has a fixture world for, and the ones it does not - both read from the loader. */
const FIXTURE_LESS_ACTIONS = rows.filter((row) => row.kind === "execution" && factsOrNull(row.actionId) === null);
assert.ok(
  FIXTURE_LESS_ACTIONS.length > 0,
  "no execution action refuses for want of a fixture: the refusal is unchecked",
);
const FIXTURE_LESS_ACTION = FIXTURE_LESS_ACTIONS[0].actionId;

const GENERIC_CONTRACT = contractRow(GENERIC_ROW);

/**
 * The reason the explicit no-target form demands, per action.
 *
 * A blank declaration cannot be told from a forgotten one, so the form requires words; the sweep below writes words
 * that name the action, which is also what a reader of the loaded contract sees in `derived.discoveryNone`.
 */
function noneReason(actionId) {
  return `the ${actionId} declaration carries no targetFamily, so this slice discovers no target`;
}

/** The committed contracts, and a corpus assembled from them in a directory of its own. */
const CORPUS_FILES = readdirSync(CONTRACT_DIRECTORY)
  .filter((name) => name.endsWith(".json"))
  .sort();

function corpusOf(transform, name = "corpus") {
  const directory = tempDirectory(`smoke-contract-${name}-`);
  for (const file of CORPUS_FILES) {
    const rewritten = transform(JSON.parse(readFileSync(join(CONTRACT_DIRECTORY, file), "utf8")), file);
    if (rewritten !== null) writeFileSync(join(directory, file), JSON.stringify(rewritten), "utf8");
  }
  return directory;
}

const validate = (raw, options = {}) => validateSmokeContract(raw, { surface, protocolControls, ...options });

function expectRefusal(probe, code) {
  const expected = `smoke_contract_${code}`;
  let thrown;
  try {
    probe();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, `expected ${expected}; the call was accepted`);
  assert.equal(thrown.code, expected, `expected ${expected}, got ${thrown.code} (${thrown.message})`);
  assert.ok(thrown instanceof ContractError && thrown.name === "SmokeContractError", "a refusal is a ContractError");
  return thrown;
}

/** The same reader for the coverage gate, whose readings are awaited. */
async function expectRefusalAsync(probe, code) {
  const expected = `smoke_contract_${code}`;
  let thrown;
  try {
    await probe();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, `expected ${expected}; the call was accepted`);
  assert.equal(thrown.code, expected, `expected ${expected}, got ${thrown.code} (${thrown.message})`);
  assert.ok(thrown instanceof ContractError && thrown.name === "SmokeContractError", "a refusal is a ContractError");
  return thrown;
}

/** Every `fail("<code>"` in the loader - the refusals it can make, derived rather than listed. */
function loaderRefusalCodes(source = readFileSync(LOADER_PATH, "utf8")) {
  return new Set([...source.matchAll(/fail\(\s*"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1]));
}

function assertEveryCodeProbed(declared, probes) {
  assert.ok(
    declared.size > 0,
    "the loader source declares no refusal at all: the reader lost it, it did not find zero",
  );
  const probed = new Set(probes.map((entry) => entry.code));
  assert.deepEqual(
    [...declared].filter((code) => !probed.has(code)),
    [],
    "these refusal codes have no probe - a refusal nobody exercises is a refusal nobody can lose",
  );
  assert.deepEqual(
    [...probed].filter((code) => !declared.has(code)),
    [],
    "these probes name codes the loader no longer declares - the suite would pass on a stale reading",
  );
}

/**
 * One probe per refusal: the input that makes the loader say this code, and nothing earlier in the chain.
 *
 * Each is built from the surface row it needs, so renaming or retyping an action moves the probe with it. A
 * probe for a code that stops being reachable fails here with `got <other code>`, which is what makes the
 * refusal codes above binding rather than decorative.
 */
const REFUSAL_PROBES = Object.freeze([
  {
    code: "protocol_controls_missing",
    probe: () =>
      readProtocolControls({
        capabilitySetPath: tempFile("empty-controls.cs", "ProtocolControls = Array.AsReadOnly(new[] { });"),
      }),
  },
  {
    code: "surface_unreadable",
    probe: () => readActionSurface({ surfacePath: tempFile("broken-surface.json", "{ not json") }),
  },
  {
    code: "surface_empty",
    probe: () => readActionSurface({ surfacePath: tempFile("empty-surface.json", '{"actions":[]}') }),
  },
  { code: "action_missing", probe: () => deriveActionFacts("") },
  { code: "action_not_declared", probe: () => deriveActionFacts("walk_to_moon") },
  { code: "action_is_read_only", probe: () => deriveActionFacts(READ_ONLY_ROW.actionId) },
  {
    code: "postcondition_undeclared",
    probe: () =>
      deriveActionFacts("undeclared_postcondition", {
        surface: new Map([
          ["undeclared_postcondition", { kind: "execution", argumentSchema: {}, postcondition: null }],
        ]),
        protocolControls,
      }),
  },
  {
    code: "fixture_scenario_underivable",
    probe: () => deriveActionFacts(FIXTURE_LESS_ACTION, { surface, protocolControls }),
  },
  { code: "not_expressible", probe: () => validate({ ...GENERIC_CONTRACT, steps: [] }) },
  { code: "unknown_key", probe: () => validate({ ...GENERIC_CONTRACT, retries: 3 }) },
  { code: "rederived_key", probe: () => validate({ ...GENERIC_CONTRACT, watchdogMs: 1000 }) },
  { code: "discovery_not_object", probe: () => validate({ ...GENERIC_CONTRACT, discovery: "petTargets" }) },
  {
    code: "discovery_source_undeclared",
    probe: () => validate({ ...contractRow(NO_TARGET_ROW), discovery: {} }),
  },
  {
    code: "discovery_source_not_derived",
    probe: () => validate({ ...contractRow(NO_TARGET_ROW), discovery: { source: "warps" } }),
  },
  {
    code: "discovery_source_disagrees_with_declaration",
    probe: () => validate({ ...GENERIC_CONTRACT, discovery: { source: "warps" } }),
  },
  {
    code: "discovery_cardinality_unknown",
    probe: () => validate({ ...GENERIC_CONTRACT, discovery: { cardinality: "many" } }),
  },
  { code: "discovery_select_unknown", probe: () => validate({ ...GENERIC_CONTRACT, discovery: { select: "last" } }) },
  {
    code: "discovery_select_needs_exactly_one",
    probe: () => validate({ ...GENERIC_CONTRACT, discovery: { cardinality: "at_least_one", select: "only" } }),
  },
  {
    code: "discovery_required_fields_invalid",
    probe: () => validate({ ...GENERIC_CONTRACT, discovery: { requiredFields: [1] } }),
  },
  { code: "discovery_require_invalid", probe: () => validate({ ...GENERIC_CONTRACT, discovery: { require: "open" } }) },
  {
    code: "discovery_require_value_invalid",
    probe: () => validate({ ...GENERIC_CONTRACT, discovery: { require: { isOpen: null } } }),
  },
  { code: "args_not_object", probe: () => validate({ ...GENERIC_CONTRACT, args: [] }) },
  { code: "args_empty", probe: () => validate({ ...GENERIC_CONTRACT, args: {} }) },
  { code: "args_undeclared", probe: () => validate({ ...GENERIC_CONTRACT, args: { nope: 1 } }) },
  {
    code: "args_type_mismatch",
    probe: () =>
      validate({
        ...contractRow(SPECIFIC_ROW),
        args: { ...argsFor(SPECIFIC_ROW), [argumentNamed(SPECIFIC_ROW, "integer")]: 1.5 },
      }),
  },
  {
    code: "args_type_mismatch",
    probe: () => {
      const row = rowWhere((candidate) => argumentNamedOrNull(candidate, "string") !== null, "with a string argument");
      return validate({ ...contractRow(row), args: { ...argsFor(row), [argumentNamedOrNull(row, "string")]: 5 } });
    },
  },
  { code: "evidence_not_object", probe: () => validate({ ...GENERIC_CONTRACT, evidence: [] }) },
  { code: "evidence_key_invalid", probe: () => validate({ ...GENERIC_CONTRACT, evidence: { "Bad-Key": "x" } }) },
  { code: "evidence_expectation_empty", probe: () => validate({ ...GENERIC_CONTRACT, evidence: { ok: "" } }) },
  { code: "evidence_expectation_invalid", probe: () => validate({ ...GENERIC_CONTRACT, evidence: { ok: 5 } }) },
  { code: "world_after_invalid", probe: () => validate({ ...GENERIC_CONTRACT, worldAfter: [] }) },
  {
    code: "world_after_field_missing",
    probe: () => validate({ ...GENERIC_CONTRACT, worldAfter: [{ equals: true }] }),
  },
  {
    code: "world_after_form_invalid",
    probe: () => validate({ ...GENERIC_CONTRACT, worldAfter: [{ field: GENERIC_ROW.targetFamily }] }),
  },
  { code: "stale_not_object", probe: () => validate({ ...GENERIC_CONTRACT, stale: "x" }) },
  { code: "stale_refusals_invalid", probe: () => validate({ ...GENERIC_CONTRACT, stale: { refusedWith: [] } }) },
  {
    code: "stale_args_not_object",
    probe: () => validate({ ...GENERIC_CONTRACT, stale: { refusedWith: ["gone"], args: 5 } }),
  },
  {
    code: "stale_args_value_invalid",
    probe: () => validate({ ...GENERIC_CONTRACT, stale: { refusedWith: ["gone"], args: { x: 5 } } }),
  },
  { code: "not_object", probe: () => validate(null) },
  {
    code: "schema_unknown",
    probe: () => validate({ ...GENERIC_CONTRACT, schema: "stardew-action-smoke-contract/v2" }),
  },
  {
    code: "action_mismatch",
    probe: () =>
      validate(
        { ...contractRow(SPECIFIC_ROW), action: GENERIC_ROW.actionId },
        { facts: deriveActionFacts(SPECIFIC_ROW.actionId) },
      ),
  },
  {
    code: "reason_code_redeclared",
    probe: () => validate({ ...contractRow(SPECIFIC_ROW), expectedReasonCode: SPECIFIC_ROW.postcondition.name }),
  },
  {
    code: "reason_code_invalid",
    probe: () => validate({ ...GENERIC_CONTRACT, expectedReasonCode: 42 }),
  },
  {
    code: "reason_code_underivable",
    probe: () => validate({ ...GENERIC_CONTRACT, expectedReasonCode: undefined }),
  },
  { code: "path_missing", probe: () => loadSmokeContractFile("") },
  {
    code: "unreadable",
    probe: () => loadSmokeContractFile(join(tempDirectory("smoke-contract-absent-"), "absent.json")),
  },
  {
    code: "discovery_none_but_declaration_names_target",
    probe: () => validate({ ...contractRow(GENERIC_ROW), discovery: { none: noneReason(GENERIC_ROW.actionId) } }),
  },
  {
    code: "discovery_none_excludes",
    probe: () =>
      validate({
        ...contractRow(NO_TARGET_ROW),
        discovery: { none: noneReason(NO_TARGET_ROW.actionId), cardinality: "exactly_one" },
      }),
  },
  {
    code: "discovery_none_reason_missing",
    probe: () => validate({ ...contractRow(NO_TARGET_ROW), discovery: { none: "   " } }),
  },
  {
    code: "discovery_none_reason_too_short",
    probe: () => validate({ ...contractRow(NO_TARGET_ROW), discovery: { none: "no target" } }),
  },
  { code: "unasserted_not_object", probe: () => validate({ ...GENERIC_CONTRACT, unasserted: [] }) },
  { code: "unasserted_empty", probe: () => validate({ ...GENERIC_CONTRACT, unasserted: {} }) },
  {
    code: "unasserted_clause_unnameable",
    probe: () =>
      validate({
        ...GENERIC_CONTRACT,
        unasserted: { "discovery.size": "the runner compares the count against a target field here" },
      }),
  },
  {
    code: "unasserted_reason_missing",
    probe: () => validate({ ...GENERIC_CONTRACT, unasserted: { "evidence.probe": "  " } }),
  },
  {
    code: "unasserted_reason_generic",
    probe: () => validate({ ...GENERIC_CONTRACT, unasserted: { "evidence.probe": "complex" } }),
  },
  {
    code: "unasserted_reason_too_short",
    probe: () => validate({ ...GENERIC_CONTRACT, unasserted: { "evidence.probe": "probe is short" } }),
  },
  {
    code: "unasserted_reason_does_not_name_the_clause",
    probe: () =>
      validate({
        ...GENERIC_CONTRACT,
        unasserted: { "evidence.probe": "the runner compares two receipt numbers with each other here" },
      }),
  },
]);
/**
 * One probe per refusal the COVERAGE gate can make.
 *
 * These need a corpus and a runner directory, so each writes its own in a temp directory: an empty directory is
 * `corpus_empty`, a corpus whose runner file is absent is `runner_missing`, and one whose runner does not parse is
 * `runner_unparsed`. The three guards that judge a finished reading are driven with a reading literal, because that
 * is what they are: pure predicates over the reading.
 */
const COVERAGE_PROBES = Object.freeze([
  {
    code: "projection_sample_unreadable",
    probe: () => checkContractCoverage({ samplePath: tempFile("broken-sample.json", "{ not json") }),
  },
  {
    code: "projection_sample_empty",
    probe: () => checkContractCoverage({ samplePath: tempFile("empty-sample.json", '{"absent":[],"real":{}}') }),
  },
  {
    code: "corpus_empty",
    probe: () => checkContractCoverage({ contractDirectory: tempDirectory("smoke-contract-empty-") }),
  },
  {
    code: "runner_missing",
    probe: () =>
      checkContractCoverage({
        contractDirectory: corpusOf((raw) => raw, "no-runner"),
        runnerDirectory: tempDirectory("smoke-contract-norunner-"),
        routeFor: () => ({ route: null, gate: null, problem: { code: "stardew_action_gate_route_absent" } }),
      }),
  },
  {
    code: "runner_unparsed",
    probe: () => {
      const directory = tempDirectory("smoke-contract-bad-runner-");
      const first = JSON.parse(readFileSync(join(CONTRACT_DIRECTORY, CORPUS_FILES[0]), "utf8"));
      writeFileSync(join(directory, runnerFileName(first.action)), "export const broken = ;", "utf8");
      return checkContractCoverage({ runnerDirectory: directory });
    },
  },
  {
    code: "coverage_examined_nothing",
    probe: () => assertContractCoverage({ directory: "probe", examined: 0, dropped: [], unknown: [] }),
  },
  {
    code: "drops_a_runner_assertion",
    probe: () =>
      assertContractCoverage({ directory: "probe", examined: 1, dropped: ["pet_animal:evidence.tile"], unknown: [] }),
  },
  {
    code: "unasserted_clause_unknown",
    probe: () =>
      assertContractCoverage({ directory: "probe", examined: 1, dropped: [], unknown: ["craft_item:evidence.absent"] }),
  },
]);

const PROBES = Object.freeze([...REFUSAL_PROBES, ...COVERAGE_PROBES]);

test("every refusal the loader declares is refused by its own probe, and no probe outlives its code", async () => {
  const declared = loaderRefusalCodes();
  assertEveryCodeProbed(declared, PROBES);
  const fired = [];
  for (const { code, probe } of PROBES) fired.push((await expectRefusalAsync(probe, code)).code);
  console.log(
    `refusals examined ${PROBES.length} · declared ${declared.size} · fired ${fired.length} distinct ${new Set(fired).size}`,
  );
  assert.equal(new Set(fired).size, declared.size, "every declared refusal was fired by a probe");
});

test("the refusal gate is red on a code with no probe, on a phantom code, and on a lost source", () => {
  const declared = loaderRefusalCodes();
  assert.throws(
    () =>
      assertEveryCodeProbed(
        declared,
        PROBES.filter((entry) => entry.code !== "unknown_key"),
      ),
    /unknown_key/u,
  );
  assert.throws(
    () => assertEveryCodeProbed(declared, [...PROBES, { code: "no_such_refusal", probe: () => {} }]),
    /no_such_refusal/u,
  );
  assert.throws(() => assertEveryCodeProbed(new Set(), PROBES), /declares no refusal/u);
  assert.equal(loaderRefusalCodes("const nothing = 1;").size, 0, "a source with no fail() call reads as empty");
});

test("the refusal reader is red when a call is accepted, and names both codes when the wrong one fires", () => {
  assert.throws(() => expectRefusal(() => validate(GENERIC_CONTRACT), "unknown_key"), /the call was accepted/u);
  assert.throws(
    () => expectRefusal(() => validate({ ...GENERIC_CONTRACT, retries: 3 }), "reason_code_invalid"),
    /reason_code_invalid[\s\S]*unknown_key/u,
  );
});

test("a contract may not restate the success word its action already declares", () => {
  const declared = SPECIFIC_ROW.postcondition.name;
  const restated = { ...contractRow(SPECIFIC_ROW), expectedReasonCode: declared };
  const error = expectRefusal(() => validate(restated), "reason_code_redeclared");
  assert.match(
    error.message,
    new RegExp(`expectedReasonCode=${declared}`, "u"),
    "the refusal names the declaration it refused to restate",
  );
  assert.ok(
    error.message.includes(SPECIFIC_ROW.actionId),
    `the refusal names the action whose declaration it read: ${error.message}`,
  );
  // The control: the same contract without the restatement loads, and takes the declaration's word for it.
  const loaded = validate({ ...restated, expectedReasonCode: undefined });
  assert.equal(loaded.action, SPECIFIC_ROW.actionId);
  assert.equal(loaded.expectedReasonCode, declared);
  assert.equal(loaded.derived.reasonCodeSource, `postcondition.name:${declared}`);
});

test("a success word that is not a non-empty string is refused, never read as absent", () => {
  for (const value of [42, "", "   ", null, ["crafted"], true]) {
    expectRefusal(() => validate({ ...GENERIC_CONTRACT, expectedReasonCode: value }), "reason_code_invalid");
  }
  // A generic declaration with no success word at all is a third, separately named refusal: the contract
  // cannot judge its own terminal, so it is not loaded with `undefined` standing in for "any code will do".
  const underivable = expectRefusal(
    () => validate({ ...GENERIC_CONTRACT, expectedReasonCode: undefined }),
    "reason_code_underivable",
  );
  assert.ok(underivable.message.includes(GENERIC_ROW.actionId), "the refusal names the action");
  // The control: a non-empty string on the same generic declaration is accepted and becomes the contract's word.
  const own = validate({ ...GENERIC_CONTRACT, expectedReasonCode: "own_word" });
  assert.equal(own.expectedReasonCode, "own_word");
  assert.equal(own.derived.reasonCodeSource, `contract:${GENERIC_ROW.actionId}`);
});

test("a key nobody reads is refused by name, and a derived fact is refused separately", () => {
  const unknown = expectRefusal(() => validate({ ...GENERIC_CONTRACT, retries: 3 }), "unknown_key");
  assert.match(unknown.message, /contract\.retries$/u, "the refusal names the key and where it sits");
  const derived = expectRefusal(
    () => validate({ ...GENERIC_CONTRACT, targetFamily: GENERIC_ROW.targetFamily }),
    "rederived_key",
  );
  assert.ok(derived.message.includes("targetFamily"), "the refusal names the fact the declaration already owns");
  const inexpressible = expectRefusal(() => validate({ ...GENERIC_CONTRACT, steps: [] }), "not_expressible");
  assert.ok(inexpressible.message.includes("write a runner"), "the refusal says where the program has to live");
  // Controls: the same contract without the extra keys loads, and each declared key carries through.
  assert.equal(validate(GENERIC_CONTRACT).action, GENERIC_ROW.actionId);
  const withOwnKeys = validate({
    ...GENERIC_CONTRACT,
    evidence: { ok: "true" },
    worldAfter: [{ field: "targets", size: 0 }],
  });
  assert.deepEqual(withOwnKeys.evidence.ok, { equals: "true" });
  assert.equal(withOwnKeys.worldAfter[0].form, "size");
});

test("a fact that cannot be derived reads not_derived:<why>, never a null a caller mistakes for 'not required'", () => {
  const genericFacts = deriveActionFacts(GENERIC_ROW.actionId, { surface, protocolControls });
  assert.equal(genericFacts.expectedReasonCode, null);
  assert.match(String(genericFacts.notDerived), /^not_derived:[a-z_]+:/u, "a null success word carries its reason");
  assert.ok(
    genericFacts.notDerived.includes(GENERIC_POSTCONDITION),
    `the reason names the generic declaration it read: ${genericFacts.notDerived}`,
  );
  const specificFacts = deriveActionFacts(SPECIFIC_ROW.actionId, { surface, protocolControls });
  assert.equal(specificFacts.expectedReasonCode, SPECIFIC_ROW.postcondition.name);
  assert.equal(specificFacts.notDerived, null, "a derived fact carries no not_derived reason");

  // Surface-wide: a null success word is paired with a reason, a reason never sits beside a derived word, and
  // an action with no world to run in is refused by name rather than throwing out of the fixture module.
  let derived = 0;
  let fixtureLess = 0;
  for (const row of rows) {
    if (row.kind !== "execution") continue;
    const facts = factsOrNull(row.actionId);
    if (facts === null) {
      fixtureLess++;
      const refusal = expectRefusal(
        () => deriveActionFacts(row.actionId, { surface, protocolControls }),
        "fixture_scenario_underivable",
      );
      assert.ok(refusal.message.includes(row.actionId), `the refusal names the action: ${refusal.message}`);
      continue;
    }
    derived++;
    assert.equal(
      facts.expectedReasonCode === null,
      facts.notDerived !== null,
      `${row.actionId}: a null success word must carry not_derived, and a derived one must not`,
    );
    assert.ok(
      typeof facts.fixtureScenario === "string",
      `${row.actionId}: a derivable action must carry the launcher's scenario name`,
    );
  }
  console.log(
    `actions examined ${derived + fixtureLess} · derived ${derived} · refused for want of a world ${fixtureLess}`,
  );
  assert.ok(derived > 0, "no execution action derived its facts");

  // Through the contract surface: the reason travels, and the source of the word says who supplied it.
  const loaded = validate(GENERIC_CONTRACT);
  assert.equal(loaded.derived.notDerived, genericFacts.notDerived);
  assert.equal(loaded.derived.reasonCodeSource, `contract:${GENERIC_ROW.actionId}`);

  // And a fact a contract cannot derive is REFUSED rather than loaded as a null discovery.
  const notDerived = expectRefusal(
    () => validate({ ...contractRow(NO_TARGET_ROW), discovery: { source: "warps" } }),
    "discovery_source_not_derived",
  );
  assert.ok(notDerived.message.includes(NO_TARGET_ROW.actionId), `the refusal names the action: ${notDerived.message}`);
});

test("a contract naming an action the catalogue does not declare is refused by that name", () => {
  const unknown = expectRefusal(
    () => validate({ schema: SMOKE_CONTRACT_SCHEMA, action: "walk_to_moon", args: {} }),
    "action_not_declared",
  );
  assert.match(unknown.message, /walk_to_moon$/u, "the refusal names the action it could not find");
  const readOnly = expectRefusal(
    () => validate({ schema: SMOKE_CONTRACT_SCHEMA, action: READ_ONLY_ROW.actionId, args: {} }),
    "action_is_read_only",
  );
  assert.ok(readOnly.message.includes(READ_ONLY_ROW.actionId), "the read-only refusal names the action too");
  const missing = expectRefusal(() => validate({ schema: SMOKE_CONTRACT_SCHEMA, args: {} }), "action_missing");
  assert.equal(missing.code, "smoke_contract_action_missing", "an action nobody named does not default to one");
  // Control: every action this suite derives its probes from is declared, so none of the refusals above is
  // the one a renamed action would produce.
  for (const row of [SPECIFIC_ROW, GENERIC_ROW, NO_TARGET_ROW, READ_ONLY_ROW]) {
    assert.ok(surface.has(row.actionId), `${row.actionId} must be declared`);
  }
});

function loadCorpus(directory) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const loaded = [];
  const refused = [];
  for (const file of files) {
    try {
      loaded.push(loadSmokeContractFile(join(directory, file)));
    } catch (error) {
      refused.push(`${file}: ${error.message}`);
    }
  }
  const reading = Object.freeze({ directory, examined: files.length, loaded: Object.freeze(loaded), refused });
  console.log(
    `contracts examined ${reading.examined} · loaded ${loaded.length} · refused ${refused.length}` +
      (refused.length === 0 ? "" : `: ${refused.join("; ")}`),
  );
  return reading;
}

function assertCorpusLoaded(reading) {
  assert.ok(
    reading.examined > 0,
    `examined 0 contracts in ${reading.directory}: a corpus that read nothing is not a corpus that passed`,
  );
  assert.deepEqual(reading.refused, [], `the loader refused committed contracts: ${reading.refused.join("; ")}`);
  assert.equal(reading.loaded.length, reading.examined, "every examined contract must load");
}

test("the committed corpus loads whole, and a contract it cannot load is named", () => {
  const reading = loadCorpus(CONTRACT_DIRECTORY);
  assertCorpusLoaded(reading);
  const actions = reading.loaded.map((contract) => contract.action);
  assert.equal(new Set(actions).size, actions.length, `two contracts describe one action: ${actions.join(",")}`);
  for (const contract of reading.loaded) {
    assert.equal(contract.schema, SMOKE_CONTRACT_SCHEMA);
    assert.equal(contract.expectedState, "succeeded");
    assert.ok(surface.has(contract.action), `${contract.path} names ${contract.action}, which no declaration carries`);
    assert.ok(
      typeof contract.expectedReasonCode === "string" && contract.expectedReasonCode.length > 0,
      `${contract.path} loads without a success word`,
    );
    assert.ok(
      contract.derived.requiredCapabilities.includes(contract.action),
      `${contract.path}: the action is not among its own required capabilities`,
    );
    // A target family is one of the derived facts, and a contract either has one or declares in words that its
    // action names no target. The two readings are one fact, so they must agree: no contract loads with a null
    // family and no words to explain it, and none carries words while claiming a family.
    const declaredNone =
      typeof contract.derived.discoveryNone === "string" && contract.derived.discoveryNone.length > 0;
    assert.equal(
      contract.discovery === null,
      declaredNone,
      `${contract.path}: a null discovery must carry the reason it declared, and a family-bearing one must not`,
    );
    if (contract.discovery === null) {
      assert.equal(contract.derived.targetFamily, null, `${contract.path}: no discovery, so no family to derive`);
    } else {
      assert.equal(typeof contract.derived.targetFamily, "string", `${contract.path} loaded with a null target family`);
      assert.ok(contract.derived.targetFamily.length > 0, `${contract.path} loaded with an empty target family`);
    }
    // The success word's source and the not_derived reason are one reading, not two: a contract that supplied
    // its own word is exactly the one whose declaration derived nothing.
    assert.equal(
      contract.derived.reasonCodeSource,
      contract.derived.notDerived === null
        ? `postcondition.name:${contract.derived.declaredPostcondition}`
        : `contract:${contract.action}`,
      `${contract.path}: the reason-code source disagrees with the derived facts`,
    );
  }
});

test("the corpus guard is red on a corpus that read nothing and on a contract the loader refuses", () => {
  const directory = tempDirectory("smoke-contract-corpus-");
  const empty = loadCorpus(directory);
  assert.equal(empty.examined, 0);
  assert.throws(() => assertCorpusLoaded(empty), /examined 0 contracts/u);

  writeFileSync(
    join(directory, "not_a_declared_action.json"),
    JSON.stringify({ schema: SMOKE_CONTRACT_SCHEMA, action: "walk_to_moon", args: {} }),
    "utf8",
  );
  const broken = loadCorpus(directory);
  assert.equal(broken.examined, 1);
  assert.equal(broken.loaded.length, 0);
  assert.throws(() => assertCorpusLoaded(broken), /action_not_declared:walk_to_moon/u);
});

/**
 * COVERAGE: the contract against the hand-written runner it stands in for.
 *
 * Loadability is not coverage. Ten of these contracts once loaded green while dropping a comparison their runner
 * makes, because nothing compared the two. The population here is the corpus on disk and the clauses come from the
 * runner's own syntax tree, so a contract added tomorrow is measured without being listed anywhere.
 */
const coverage = await checkContractCoverage();

/** The clauses the committed contracts declare unasserted, as `<action>:<clause>`, in the gate's own spelling. */
const DECLARED_CLAUSES = coverage.readings
  .flatMap((reading) => reading.declared.map((clause) => `${reading.action}:${clause}`))
  .sort();

test("the committed corpus covers every assertion its runner makes, or declares the gap in words", async () => {
  console.log(
    `contracts examined ${coverage.examined} · assertions compared ${coverage.compared} · dropped ${coverage.dropped.length} · declared ${coverage.declared}`,
  );
  console.log(
    `promoted ${coverage.promoted} · with a family ${coverage.withFamily} · declared none ${coverage.declaredNone}`,
  );
  assertContractCoverage(coverage);
  assert.ok(coverage.examined > 0, "the corpus read nothing");
  assert.equal(coverage.examined, CORPUS_FILES.length, "every committed contract is a reading");
  assert.equal(
    coverage.withFamily + coverage.declaredNone,
    coverage.examined,
    "a contract either names a target family or declares that it names none",
  );
  const families = readObservationFamilies();
  assert.ok(families.size > 0, "the protocol sample declares no observation family");
  // Cross-check the promotion reading against the route resolver itself: a reading is promoted only when its row's live
  // gate is its contract. The route answer has one owner, and this is the second method that must agree with it.
  const routes = { CONTRACT_ROUTE, resolveStardewActionGateRoute };
  for (const reading of coverage.readings) {
    if (!reading.promoted) {
      const total = reading.covered.length + reading.declared.length + reading.dropped.length;
      assert.ok(total > 0, `${reading.action}: its runner yielded no clause, so the reading agrees with itself`);
      assert.deepEqual(reading.dropped, [], `${reading.action} drops an assertion ${reading.runner} makes`);
      assert.deepEqual(reading.unknown, [], `${reading.action} declares a clause its runner does not make`);
      // A declaration and a coverage are two answers to one question, so a clause cannot be both.
      assert.deepEqual(
        reading.declared.filter((clause) => reading.covered.includes(clause)),
        [],
        `${reading.action}: a clause is both covered and declared unasserted`,
      );
      continue;
    }
    assert.equal(reading.runner, null, `${reading.action}: a promoted contract has no runner to compare against`);
    assert.equal(
      routes.resolveStardewActionGateRoute(reading.action).route,
      routes.CONTRACT_ROUTE,
      `${reading.action} was read as promoted while its gate row does not route through its contract`,
    );
    assert.deepEqual(
      [reading.covered.length, reading.declared.length, reading.dropped.length],
      [0, 0, 0],
      `${reading.action}: a promoted contract has nothing left to be held to`,
    );
  }
  assert.equal(
    coverage.promoted,
    coverage.readings.filter((reading) => reading.promoted).length,
    "the promoted count is the promoted readings",
  );
  // The families a `worldAfter` assertion may name come from the generated protocol sample, never from this file.
  assert.ok(families.has("petTargets"), "the sample lost a family this corpus asserts");
});

test("a contract whose runner is gone is promoted when its row routes through it, and orphaned when it does not", async () => {
  const contractsOnly = tempDirectory("smoke-contract-promoted-");
  // A runner directory with nothing in it: every contract is measured only through its route.
  const promoted = await checkContractCoverage({
    runnerDirectory: contractsOnly,
    routeFor: () => ({ route: "contract", gate: "contracts/smoke/probe.json", problem: null }),
  });
  assertContractCoverage(promoted);
  assert.equal(promoted.promoted, promoted.examined, "every contract was routed through itself");
  assert.equal(promoted.compared, 0, "a promoted contract has no runner assertion to compare");
  assert.equal(promoted.examined, coverage.examined, "promotion must not drop a contract from the population");
  console.log(
    `contract-routed rows ${promoted.promoted} · promoted ${promoted.promoted} · orphaned ${promoted.readings.filter((r) => !r.promoted).length}`,
  );

  // The control: the same missing runner is an orphan the moment the row does not route through the contract.
  const orphaned = await expectRefusalAsync(
    () =>
      checkContractCoverage({
        runnerDirectory: contractsOnly,
        routeFor: () => ({ route: null, gate: null, problem: { code: "stardew_action_gate_route_absent" } }),
      }),
    "runner_missing",
  );
  assert.ok(
    orphaned.message.includes("stardew_action_gate_route_absent"),
    `the refusal says why the row has no route: ${orphaned.message}`,
  );
});

test("a contract that drops an assertion its runner makes is refused, naming the contract and the clause", async () => {
  // Exactly the state before the declarations landed: the same committed contracts, every `unasserted` block removed.
  const stripped = await checkContractCoverage({
    contractDirectory: corpusOf((raw) => {
      const next = { ...raw };
      delete next.unasserted;
      return next;
    }, "undeclared"),
  });
  const error = expectRefusal(() => assertContractCoverage(stripped), "drops_a_runner_assertion");
  // The inverse: what the declarations excuse is exactly what the gate reports once they are gone. A declaration
  // that excused nothing, or a drop that no declaration covered, makes these two readings disagree.
  assert.deepEqual(stripped.dropped, DECLARED_CLAUSES, "the gate's red is the declarations' own contents");
  for (const clause of stripped.dropped)
    assert.ok(error.message.includes(clause), `${clause} is not named: ${error.message}`);
  const namedActions = new Set(stripped.dropped.map((clause) => clause.split(":")[0]));
  assert.deepEqual(
    [...namedActions].sort(),
    coverage.readings
      .filter((reading) => reading.declared.length > 0)
      .map((reading) => reading.action)
      .sort(),
    "the contracts the gate names are the contracts that declare a gap",
  );
  console.log(
    `dropped ${stripped.dropped.length} clauses across ${namedActions.size} contracts · examined ${stripped.examined}`,
  );
});

test("a declaration that outlives its clause is refused, so an exemption expires with the thing it exempted", async () => {
  const stale = await checkContractCoverage({
    contractDirectory: corpusOf(
      (raw, file) =>
        file === "pet_animal.json"
          ? {
              ...raw,
              unasserted: {
                ...(raw.unasserted ?? {}),
                "evidence.pet_day": "pet_day is compared with itself inside the runner, so no contract states it",
              },
            }
          : raw,
      "stale-declaration",
    ),
  });
  const error = expectRefusal(() => assertContractCoverage(stale), "unasserted_clause_unknown");
  assert.ok(
    error.message.includes("pet_animal:evidence.pet_day"),
    `the refusal names the declaration that outlived its clause: ${error.message}`,
  );
});

test("a contract that states a covered clause wrongly is refused, so the comparison is not a registration step", async () => {
  const wrongValue = await checkContractCoverage({
    contractDirectory: corpusOf(
      (raw, file) =>
        file === "pet_animal.json" ? { ...raw, evidence: { ...raw.evidence, friendship_after: "13" } } : raw,
      "wrong-value",
    ),
  });
  const valueError = expectRefusal(() => assertContractCoverage(wrongValue), "drops_a_runner_assertion");
  assert.ok(
    valueError.message.includes("pet_animal:evidence.friendship_after"),
    `a value the runner does not accept is a dropped clause: ${valueError.message}`,
  );

  // A world change the runner reads: taken from a contract the gate still compares, so promoting an action does not
  // silently disarm this falsifier.
  const worldClause = coverage.readings
    .filter((reading) => !reading.promoted)
    .flatMap((reading) =>
      reading.covered
        .filter((clause) => clause.startsWith("worldAfter."))
        .map((clause) => ({ action: reading.action, clause })),
    )[0];
  assert.ok(worldClause !== undefined, "no compared contract asserts a world change: the falsifier has no subject");
  const missingWorld = await checkContractCoverage({
    contractDirectory: corpusOf((raw, file) => {
      if (file !== `${worldClause.action}.json`) return raw;
      const next = { ...raw };
      delete next.worldAfter;
      return next;
    }, "missing-world"),
  });
  const worldError = expectRefusal(() => assertContractCoverage(missingWorld), "drops_a_runner_assertion");
  assert.ok(
    worldError.message.includes(`${worldClause.action}:${worldClause.clause}`),
    `a world change the runner reads and the contract omits is a dropped clause: ${worldError.message}`,
  );
});

/**
 * THE FORMAT MUST NOT REFUSE AN ACTION BY ITS NATURE.
 *
 * An action whose declaration carries no `targetFamily` has nothing to discover, and deriving a source for it was
 * impossible - so the format used to refuse `sleep`, `advance_day` and the rest of the seven, not by a fact about
 * those actions but by a hole in the format. The explicit `none` form closes it, and absence is still refused: the
 * sweep is over every targetless execution action the launcher has a fixture world for, which is the real population.
 */
test("an action that names no target says so in words, and silence is still refused", () => {
  const targetless = rows.filter(
    (row) => row.kind === "execution" && row.targetFamily === undefined && factsOrNull(row.actionId) !== null,
  );
  assert.ok(targetless.length > 0, "the action surface declares no execution action without a target family");
  const loaded = [];
  for (const row of targetless) {
    const contract = validate(contractRow(row, { discovery: { none: noneReason(row.actionId) } }));
    assert.equal(contract.discovery, null, `${row.actionId}: the none form is the null the engine already reads`);
    assert.equal(contract.derived.targetFamily, null, `${row.actionId}: a targetless action derives no family`);
    assert.equal(
      contract.derived.discoveryNone,
      noneReason(row.actionId),
      `${row.actionId}: the reason the contract declared must survive into the loaded contract`,
    );
    loaded.push(contract);
  }
  console.log(
    `actions with no target family ${targetless.length} · loaded with the none form ${loaded.length} · declared none in the corpus ${coverage.declaredNone}`,
  );
  assert.equal(loaded.length, targetless.length, "every targetless action must be expressible");

  // The controls. Absence is not a declaration, a declared source is not derivable from a row that has none, and an
  // action that DOES name a family cannot declare itself targetless.
  expectRefusal(() => validate(contractRow(NO_TARGET_ROW)), "discovery_source_undeclared");
  expectRefusal(
    () => validate({ ...contractRow(NO_TARGET_ROW), discovery: { source: "warps" } }),
    "discovery_source_not_derived",
  );
  expectRefusal(
    () => validate({ ...contractRow(GENERIC_ROW), discovery: { none: noneReason(GENERIC_ROW.actionId) } }),
    "discovery_none_but_declaration_names_target",
  );
});
