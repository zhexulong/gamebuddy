/**
 * A mirrored vocabulary is the contract's vocabulary, or it is a trap.
 *
 * `reference-pipeline-api.ts` and `management-pipeline-api.ts` are hand-written
 * browser mirrors of `host/src/tavern/browser-contract/index.ts`: the browser bundle
 * cannot import the contract (no typebox dependency, "no Host package, no runtime
 * code"), so every closed union is spelled by hand - and every one of them is read by
 * that module's own exact-shape validator. A mirror narrower than the contract refuses
 * a value the contract calls legal, and the refusal is an opaque `TavernProtocolError`
 * that tells the player nothing. That is the defect `problem-code-gate.test.mjs` holds
 * for `PROBLEM_CODES`; this gate holds it for the rest of the vocabulary.
 *
 * The measured drift: `reference-pipeline-api.ts` declared `NAVIGATION_ITEM_IDS` as
 * `["chat","memory"]` against the contract's `["chat","memory","characters"]`, and
 * `WORLD_INFO_STATES` as `["none","selected","locked","unavailable"]` against the
 * contract's `["none","selected","pending","unavailable"]` - a missing member, an
 * invented one and a second missing one, all three read by `validateSnapshot`.
 *
 * Both halves are derived, never listed here: the authority is the contract's own
 * source (`Type.Union([Type.Literal(...)])`, or one property of a TypeBox schema),
 * read the way `host/src/opaque-handle-shape-gate.test.ts` reads its declaration, and
 * the mirror side is the mirror's own `const`. Reading the source rather than
 * importing is what lets the gate see `NavigationItemId`/`WorldInfoBindingState`,
 * which the contract does not export.
 *
 * Scope, stated honestly:
 *  - `PROBLEM_CODES`/`TURN_PROBLEM_CODES` are `problem-code.7`'s subject, against a
 *    wider authority (the contract union plus the router's transport-only
 *    `payload_too_large`), so they are not repeated here;
 *  - the `*_KEYS` key allowlists belong to `contract-mirror-keys-gate.test.mjs`, which derives the
 *    shape from the exported schemas and fails a validator stricter than the contract. That rule
 *    can only see a key set that IS a shape's required keys, so a mirror that names FEWER keys than
 *    the contract requires drops quietly out of its reach - measured, not assumed: the subset rule
 *    reports 443 findings across the four modules, because a command's key set is a subset of many
 *    shapes. A key allowlist whose whole authority is one declared object shape is therefore gated
 *    HERE, by name, against that shape's declared key names (`WORLD_INFO_KEYS` and its item); the
 *    drift that lived there was exactly the invisible kind - the mirror's `["state", "items"]`
 *    against `WorldInfoStateV1Schema`'s `state` + `revision` + `items`, which made `revision` fail the
 *    mirror's exact-key check and took the reference surface's whole snapshot read down;
 *  - `LABEL_KEYS` and `REFERENCE_PIPELINE_OPERATION_IDS` (in
 *    `reference-pipeline-api.ts`) are projections of the *profile* the reference client
 *    serves (`chat_core`, which declares no `world-info.*`/`companion.*` operation), not of
 *    the contract's ~50-member unions. That wire can never carry a wider label or operation
 *    id, so a shorter list there is not the narrowed-mirror defect this gate is for. They are
 *    named in `EXCLUDED_VOCABULARIES` and counted in the diagnostic, so the exclusion is
 *    visible rather than silent. The management mirror's own two allowlists are NOT excluded:
 *    that mount can carry every operation the contract declares, and both were measured
 *    stale - `OPERATION_IDS` knew 48 of 50 (`chat.select`, `companion.avatar.update`) and
 *    `MANAGEMENT_LABEL_KEYS` 52 of 53 (`tavern.operation.companion.avatar.update`), so a
 *    snapshot projecting either refused as protocol corruption and the surface went quiet.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = join(REPO, "dialogue-web", "src");
const CONTRACT = join(REPO, "host", "src", "tavern", "browser-contract", "index.ts");

/** The hand-written browser mirrors whose closed vocabularies must equal the contract's. */
export const MIRROR_FILES = [
  join(WEB, "reference-pipeline-api.ts"),
  join(WEB, "management-pipeline-api.ts"),
];

/**
 * Each mirrored vocabulary: the mirror's own declaration name, and the contract
 * declaration it mirrors. The locator reads the members one of three ways:
 *  - `property` names one property of a TypeBox schema, whose `Type.Literal(...)` arguments are
 *    the members;
 *  - `properties` reads the declared KEY NAMES of the object shape a declaration hands to its
 *    schema helper - a vocabulary the contract spells as an object's keys rather than as a union
 *    of literals (`WorldInfoStateV1Schema`) - and `within` names one property of that shape whose
 *    own object shape is the one meant;
 *  - with neither, the named const is itself a `Type.Union([Type.Literal(...)])`.
 */
export const MIRRORED_VOCABULARIES = [
  { mirror: "MESSAGE_ROLES", contract: { name: "BrowserMessageV1Schema", property: "role" } },
  { mirror: "MESSAGE_LOCALES", contract: { name: "BrowserMessageV1Schema", property: "locale" } },
  { mirror: "TURN_STATES", contract: { name: "BrowserTurnV1Schema", property: "state" } },
  { mirror: "SUBMIT_DISPOSITIONS", contract: { name: "SubmitResultV1Schema", property: "disposition" } },
  { mirror: "CANCEL_DISPOSITIONS", contract: { name: "CancelTurnResultV1Schema", property: "disposition" } },
  { mirror: "STATUS_DISPOSITIONS", contract: { name: "MessageSubmissionStatusV1Schema", property: "disposition" } },
  { mirror: "OPERATION_AVAILABILITY", contract: { name: "TavernBrowserOperationV1Schema", property: "availability" } },
  { mirror: "NAVIGATION_ITEM_IDS", contract: { name: "NavigationItemId" } },
  { mirror: "NAVIGATION_AVAILABILITY", contract: { name: "NavigationItem", property: "availability" } },
  { mirror: "WORLD_INFO_STATES", contract: { name: "WorldInfoBindingState" } },
  { mirror: "VOICE_SURFACE_STATES", contract: { name: "TavernVoiceSurfaceStateV1Schema", property: "state" } },
  { mirror: "EVENT_TYPES", contract: { name: "BrowserEventV1Schema", property: "eventType" } },
  { mirror: "RESYNC_REASONS", contract: { name: "BrowserEventV1Schema", property: "reason" } },
  { mirror: "SUBMIT_LOCALES", contract: { name: "SubmitMessageCommandV1Schema", property: "locale" } },
  { mirror: "WORLD_INFO_KEYS", contract: { name: "WorldInfoStateV1Schema", properties: true } },
  {
    mirror: "WORLD_INFO_ITEM_KEYS",
    contract: { name: "WorldInfoStateV1Schema", properties: true, within: "items" },
  },
  // The management mount can carry every operation and label the contract declares, and the two
  // runtime allowlists below are what its own validators consult - a member missing from either
  // refuses a legal operation (or the whole snapshot carrying it) as protocol corruption.
  { mirror: "OPERATION_IDS", contract: { name: "OperationId" } },
  { mirror: "MANAGEMENT_LABEL_KEYS", contract: { name: "LabelKey" } },
];

/**
 * Closed vocabularies the mirrors declare that are deliberately NOT the contract's
 * whole union: each is the operation/label set of the one profile that client serves.
 * Named, so the exclusion is a decision rather than an omission.
 */
export const EXCLUDED_VOCABULARIES = ["LABEL_KEYS", "REFERENCE_PIPELINE_OPERATION_IDS"];

const SOURCE_CACHE = new Map();

function sourceOf(file) {
  const cached = SOURCE_CACHE.get(file);
  if (cached !== undefined) return cached;
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  SOURCE_CACHE.set(file, sourceFile);
  return sourceFile;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Every variable declaration with this name, anywhere in the file. */
function declarationsNamed(sourceFile, name) {
  const found = [];
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
  });
  return found;
}

/** Every property with this name inside a node (`eventType` has one per union arm). */
function propertiesNamed(node, name) {
  const found = [];
  walk(node, (inner) => {
    if (ts.isPropertyAssignment(inner) && inner.name.getText() === name) found.push(inner);
  });
  return found;
}

/** Every `Type.Literal("...")` argument in a node: the contract's spelling of a member. */
function literalValues(node) {
  const found = [];
  walk(node, (inner) => {
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === "Literal" &&
      inner.arguments.length === 1 &&
      ts.isStringLiteral(inner.arguments[0])
    )
      found.push(inner.arguments[0].text);
  });
  return found;
}

/** Every string literal in a node: the shape a mirror spells a vocabulary in. */
function stringValues(node) {
  const found = [];
  walk(node, (inner) => {
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) found.push(inner.text);
  });
  return found;
}

/** The first object literal a node hands to its schema helper: the shape's own properties. */
function objectShapeOf(node) {
  let found = null;
  walk(node, (inner) => {
    if (found === null && ts.isObjectLiteralExpression(inner)) found = inner;
  });
  return found;
}

/** The object shape inside one named property of an object shape (`items`, in `WorldInfoStateV1Schema`). */
function objectShapeWithin(shape, name) {
  let found = null;
  walk(shape, (inner) => {
    if (found !== null) return;
    if (ts.isPropertyAssignment(inner) && inner.name.getText() === name) found = objectShapeOf(inner.initializer);
  });
  return found;
}

/** The keys an object shape declares: the vocabulary of a contract that spells one as a strict object. */
function declaredKeys(shape) {
  return shape.properties.filter((property) => ts.isPropertyAssignment(property)).map((property) => property.name.getText());
}

/** The contract's declared members of one vocabulary, read out of the contract's own source. */
export function contractVocabulary(locator, contract = CONTRACT) {
  const sourceFile = sourceOf(contract);
  const members = new Set();
  for (const declaration of declarationsNamed(sourceFile, locator.name)) {
    if (locator.properties === true) {
      const outer = objectShapeOf(declaration);
      const shape = locator.within === undefined ? outer : outer === null ? null : objectShapeWithin(outer, locator.within);
      if (shape !== null) for (const key of declaredKeys(shape)) members.add(key);
      continue;
    }
    const scopes = locator.property === undefined ? [declaration] : propertiesNamed(declaration, locator.property);
    for (const scope of scopes) for (const value of literalValues(scope)) members.add(value);
  }
  return members;
}

/** One mirror's declared members, or `null` when that mirror declares no such const. */
export function mirrorVocabulary(file, name) {
  const declarations = declarationsNamed(sourceOf(file), name);
  if (declarations.length === 0) return null;
  return new Set(declarations.flatMap((declaration) => stringValues(declaration)));
}

/**
 * The two ways a mirror can drift from a derived authority, by member. Pure, so the
 * mutation test below runs the exact comparison `vocabulary-drift.2` asserts.
 */
export function vocabularyDrift(where, mirrored, authority) {
  return [
    ...[...authority]
      .filter((member) => !mirrored.has(member))
      .map((member) => `${where} does not know declared member ${JSON.stringify(member)}`),
    ...[...mirrored]
      .filter((member) => !authority.has(member))
      .map((member) => `${where} invents a member no contract declares ${JSON.stringify(member)}`),
  ];
}

/** The mirror's file name as a finding names it. */
function mirrorName(file) {
  return file.replace(/\\/gu, "/").split("/dialogue-web/").pop();
}

test("vocabulary-drift.1: the contract's declarations are read, not assumed", (t) => {
  const derived = new Map(MIRRORED_VOCABULARIES.map((entry) => [entry.mirror, contractVocabulary(entry.contract)]));
  assert.equal(derived.get("NAVIGATION_ITEM_IDS").size, 3, "NavigationItemId is a three-member union");
  assert.equal(derived.get("WORLD_INFO_STATES").size, 4, "WorldInfoBindingState is a four-member union");
  assert.equal(derived.get("EVENT_TYPES").size, 5, "BrowserEventV1Schema declares five eventType members");
  assert.equal(derived.get("RESYNC_REASONS").size, 4, "the resync payload declares four reasons");
  assert.equal(derived.get("SUBMIT_LOCALES").size, 2, "chat.submit accepts two locales");
  assert.deepEqual(
    [...derived.get("WORLD_INFO_KEYS")].sort(),
    ["items", "revision", "state"],
    "the object-shape derivation reads the schema's declared key names, not a literal union",
  );
  assert.deepEqual(
    [...derived.get("WORLD_INFO_ITEM_KEYS")].sort(),
    ["handle", "pending", "selected", "summary", "title"],
    "and `within` reads the key names of the shape one property hands to its own schema helper",
  );
  for (const entry of MIRRORED_VOCABULARIES)
    assert.ok(derived.get(entry.mirror).size >= 2, `${entry.mirror} derived an empty or single-member union`);
  const declared = MIRRORED_VOCABULARIES.map((entry) => entry.mirror);
  for (const file of MIRROR_FILES) {
    const owned = declared.filter((name) => mirrorVocabulary(file, name) !== null);
    assert.ok(owned.length >= 5, `${mirrorName(file)} declares only ${owned.length} gated vocabulary/vocabularies`);
  }
  t.diagnostic(
    `vocabulary-drift.1: ${MIRRORED_VOCABULARIES.length} contract vocabulary/vocabularies derived from the contract source; ${MIRROR_FILES.map((file) => `${mirrorName(file)}:${declared.filter((name) => mirrorVocabulary(file, name) !== null).length}`).join(", ")}; excluded by name: ${EXCLUDED_VOCABULARIES.join(", ")}`,
  );
});

test("vocabulary-drift.2: every mirror IS the contract's vocabulary, not a stale copy of it", (t) => {
  const failures = [];
  let mirrored = 0;
  for (const file of MIRROR_FILES) {
    for (const entry of MIRRORED_VOCABULARIES) {
      const declared = mirrorVocabulary(file, entry.mirror);
      if (declared === null) continue;
      mirrored += declared.size;
      failures.push(...vocabularyDrift(`${mirrorName(file)} ${entry.mirror}`, declared, contractVocabulary(entry.contract)));
    }
  }
  t.diagnostic(
    `vocabulary-drift.2: ${mirrored} mirrored member(s) across ${MIRROR_FILES.length} mirror(s) checked for equality against ${MIRRORED_VOCABULARIES.length} contract declaration(s), ${failures.length} drifted`,
  );
  assert.deepEqual(
    failures,
    [],
    "a mirror that does not know a declared member reads a legal value as protocol corruption",
  );
});

test("vocabulary-drift.3 (mutation): a short mirror and an invented member are both reported", (t) => {
  const authority = contractVocabulary({ name: "NavigationItemId" });
  const short = new Set([...authority].filter((member) => member !== "characters"));
  assert.deepEqual(vocabularyDrift("mutation.ts NAVIGATION_ITEM_IDS", short, authority), [
    'mutation.ts NAVIGATION_ITEM_IDS does not know declared member "characters"',
  ]);
  assert.deepEqual(vocabularyDrift("mutation.ts WORLD_INFO_STATES", new Set([...authority, "locked"]), authority), [
    'mutation.ts WORLD_INFO_STATES invents a member no contract declares "locked"',
  ]);
  assert.deepEqual(vocabularyDrift("mutation.ts NAVIGATION_ITEM_IDS", new Set(authority), authority), []);
  t.diagnostic("vocabulary-drift.3: a missing member and an invented member are each reported by member, not by position");
});
