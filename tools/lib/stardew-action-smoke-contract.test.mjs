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

import {
  ContractError,
  deriveActionFacts,
  GENERIC_POSTCONDITION,
  loadSmokeContractFile,
  readActionSurface,
  readProtocolControls,
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
]);
test("every refusal the loader declares is refused by its own probe, and no probe outlives its code", () => {
  const declared = loaderRefusalCodes();
  assertEveryCodeProbed(declared, REFUSAL_PROBES);
  const fired = REFUSAL_PROBES.map(({ code, probe }) => expectRefusal(probe, code).code);
  console.log(
    `refusals examined ${REFUSAL_PROBES.length} · declared ${declared.size} · fired ${fired.length} distinct ${new Set(fired).size}`,
  );
  assert.equal(new Set(fired).size, declared.size, "every declared refusal was fired by a probe");
});

test("the refusal gate is red on a code with no probe, on a phantom code, and on a lost source", () => {
  const declared = loaderRefusalCodes();
  assert.throws(
    () =>
      assertEveryCodeProbed(
        declared,
        REFUSAL_PROBES.filter((entry) => entry.code !== "unknown_key"),
      ),
    /unknown_key/u,
  );
  assert.throws(
    () => assertEveryCodeProbed(declared, [...REFUSAL_PROBES, { code: "no_such_refusal", probe: () => {} }]),
    /no_such_refusal/u,
  );
  assert.throws(() => assertEveryCodeProbed(new Set(), REFUSAL_PROBES), /declares no refusal/u);
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
    // A target family is one of the derived facts, and a null one is refused rather than loaded: every
    // contract that loaded has a real family, so no reader can read null as "discovery not required".
    assert.equal(typeof contract.derived.targetFamily, "string", `${contract.path} loaded with a null target family`);
    assert.ok(contract.derived.targetFamily.length > 0, `${contract.path} loaded with an empty target family`);
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
