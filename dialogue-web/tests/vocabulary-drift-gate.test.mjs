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
 * THE GAME CONTRACT IS THE SECOND MIRROR of the same kind, and this gate holds it the same way.
 * The composed game client spells the `game_browser_api/v1` status vocabularies by hand, because
 * the same bundle cannot import `host/src/game-browser-contract`, and it validates every one of
 * them before it renders a stage: a member the mirror does not know turns a legal `/game` snapshot
 * into `invalid_game_state`, and the panel has nothing to say. A shared JSON declaration would be
 * the one-file answer and cannot be used here - a JSON import types as `string[]`, so
 * `Type.Literal(value)` would widen every status in the Host's own schemas to `string`. So the two
 * ends are held by EQUALITY, asserted in `vocabulary-drift.4`/`.5` and recorded by
 * `tools/check-fact-seams.mjs` as `asserted-by` this file.
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
const GAME_CONTRACT = join(REPO, "host", "src", "game-browser-contract", "index.ts");

/** The hand-written browser mirrors whose closed vocabularies must equal the contract's. */
export const MIRROR_FILES = [
  join(WEB, "reference-pipeline-api.ts"),
  join(WEB, "management-pipeline-api.ts"),
];

/**
 * The composed game client's mirrors of `game_browser_api/v1`.
 *
 * Two modules, because the companion Mod's outcome vocabulary is declared in both: the client's own
 * validator list and the presentation module's label list are one fact with two spellings, and a
 * token one of them does not know refuses the whole registration reply.
 */
export const GAME_MIRROR_FILES = [join(WEB, "composed-reference-game-browser-api.ts"), join(WEB, "game-presentation.ts")];

/**
 * Each mirrored vocabulary: the mirror's own declaration name, and the contract
 * declaration it mirrors. The locator reads the members one of three ways:
 *  - `property` names one property of a TypeBox schema, whose `Type.Literal(...)` arguments are
 *    the members;
 *  - `properties` reads the declared KEY NAMES of the object shape a declaration hands to its
 *    schema helper - a vocabulary the contract spells as an object's keys rather than as a union
 *    of literals (`WorldInfoStateV1Schema`) - and `within` names one property of that shape whose
 *    own object shape is the one meant;
 *  - with neither, the named const is itself a `Type.Union([Type.Literal(...)])` - or a frozen list
 *    of strings, which is the same vocabulary stated as a value the schema is derived from.
 *
 * Two optional fields move a vocabulary off the two request/response mirrors: `file` on the locator
 * names the Host module that OWNS the list when the contract only restates it, and `mirrorFile` on
 * the entry names the one module that restates it - a browser surface, or a Host module that checks an
 * untrusted value against its own copy.
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
  // The release gate's own three id list. It is in `tools/`, not the bundle, but it is the same fact spelled by
  // hand: a gate that pins the contract's navigation items must know the item the contract added, by name.
  {
    mirror: "CONTRACT_NAVIGATION_ITEM_IDS",
    mirrorFile: join(REPO, "tools/run-tavern-release-live-gate.mjs"),
    contract: { name: "NavigationItemId" },
  },
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
  // The connection probe's closed failure vocabulary. A member the mirror does not know is refused
  // as protocol corruption, so a player whose endpoint throttled them would read a blank result.
  { mirror: "CONNECTION_FAILURES", contract: { name: "ConnectionFailure" } },
  // The four states a connection row can be in. `connection-store.ts` derives both its record type and its
  // untrusted-record check from this one union, so this list is the only hand copy of it left.
  { mirror: "CONNECTION_READINESS", contract: { name: "TavernConnectionReadinessV1Schema" } },
  // The embedded runtime's thinking levels. The connection contract now derives its union from
  // `COMPANION_THINKING_LEVELS`, so what is left to hold is the two browser ends that cannot import it: the
  // connection panel's own list and the model-profile editor's suggestions.
  {
    mirror: "MODEL_PROFILE_THINKING_LEVEL_SUGGESTIONS",
    mirrorFile: join(WEB, "components/management-panels.tsx"),
    contract: { file: "host/src/runtime-identity.ts", name: "COMPANION_THINKING_LEVELS" },
  },
  {
    mirror: "CONNECTION_THINKING_LEVELS",
    contract: { file: "host/src/runtime-identity.ts", name: "COMPANION_THINKING_LEVELS" },
  },
  // The fields the player may fill on a connection, and the shapes the escape hatch may name. Both are
  // closed unions on the wire and both are read by the management mirror's own validators: a field the
  // mirror does not list is refused (`setupFields.every(isOneOf)`), so a Host that admits `apiKeyRequired`
  // while the panel knows four fields reads a legal projection as protocol corruption.
  { mirror: "CONNECTION_SETUP_FIELDS", contract: { name: "TavernConnectionSetupFieldV1Schema" } },
  // The escape hatch's shape list. The chain is closed at both ends: the contract's union is pinned to
  // `TAVERN_PI_API_SHAPES` by `host/src/tavern/browser-contract/index.private.test.ts` (a shape Pi cannot
  // speak must never reach the runtime's provider entry), and the mirror is pinned to the contract here.
  { mirror: "CONNECTION_API_SHAPES", contract: { name: "TavernConnectionApiShapeV1Schema" } },
  // Why a field this product recognises is not sent. The code is the Host's (`preset-sampling.ts`
  // states the four reasons and the sentence beside each), the panel shows the player a line in their
  // own language, and a code the surface has no line for is refused by name - so a code added to the
  // Host alone turns a legal readout into a refusal.
  {
    mirror: "PRESET_NOT_APPLIED_CODES",
    mirrorFile: join(WEB, "preset-assembly-surface.ts"),
    contract: { file: "host/src/tavern/preset-sampling.ts", name: "PRESET_NOT_APPLIED_CODES" },
  },
  // The probe's closed failure vocabulary has a Host-side restatement too: `connection-store.ts` checks
  // an untrusted record's `failure` against its own set before it is projected. `mirrorFile` names it,
  // because the rule is the same one - a declaration that restates a fact is compared to the
  // declaration that owns it, wherever the two live.
  {
    mirror: "PROBE_FAILURES",
    mirrorFile: join(REPO, "host/src/tavern/connection-store.ts"),
    contract: { name: "ConnectionFailure" },
  },
];

/**
 * Closed vocabularies the mirrors declare that are deliberately NOT the contract's
 * whole union: each is the operation/label set of the one profile that client serves.
 * Named, so the exclusion is a decision rather than an omission.
 */
export const EXCLUDED_VOCABULARIES = ["LABEL_KEYS", "REFERENCE_PIPELINE_OPERATION_IDS"];

const SOURCE_CACHE = new Map();

/**
 * Each game vocabulary: the mirror's own declaration name and the contract declaration it restates.
 *
 * The locator reads the members the way `MIRRORED_VOCABULARIES` does - a `Type.Union([Type.Literal(...)])`
 * named by the locator itself - plus one shape that contract uses and the tavern one does not:
 * `discriminant` names a property of each arm schema, for a union whose members ARE the arms
 * (`GameFactPatchV1Schema` states "which facts can travel" as three arm schemas, each carrying its own
 * `fact: Type.Literal(...)`, so the vocabulary is those discriminants rather than a literal list).
 */
export const GAME_MIRRORED_VOCABULARIES = [
  { mirror: "ACTION_AUTHORITY_STATUSES", contract: { name: "ActionAuthority" } },
  { mirror: "OUTCOMES", contract: { name: "Outcome" } },
  { mirror: "COMPATIBILITY_STATUSES", contract: { name: "CompatibilityStatus" } },
  { mirror: "ATTACHMENT_STATUSES", contract: { name: "AttachmentStatus" } },
  { mirror: "PREREQUISITE_STATUSES", contract: { name: "PrerequisiteStatus" } },
  { mirror: "INSTANCE_STATUSES", contract: { name: "InstanceStatus" } },
  { mirror: "CONNECTION_STATUSES", contract: { name: "ConnectionStatus" } },
  { mirror: "COMPANION_MOD_OUTCOMES", contract: { name: "CompanionModOutcome" } },
  { mirror: "GAME_FACTS", contract: { name: "GameFactPatchV1Schema", discriminant: "fact" } },
];

/** The browser module(s) a vocabulary is declared in: the two mirrors, unless the entry names its own. */
function mirrorFilesOf(entry) {
  return entry.mirrorFile === undefined ? MIRROR_FILES : [entry.mirrorFile];
}

/** The file the authority declaration lives in: the tavern contract, unless the locator names another. */
function authorityFileOf(locator) {
  return locator.file === undefined ? CONTRACT : join(REPO, locator.file);
}

/**
 * The members a declaration spells. `Type.Literal("x")` inside a TypeBox union and a plain string in a
 * frozen list are the same vocabulary - the second is what such a union is derived FROM - so one
 * reading serves both.
 */
function membersOf(scope) {
  const literals = literalValues(scope);
  return literals.length > 0 ? literals : stringValues(scope);
}

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

/** The arm schemas a `Type.Union([A, B, C])` names, in declaration order. */
function unionArms(declaration) {
  const arms = [];
  const call = declaration.initializer;
  if (call === undefined || !ts.isCallExpression(call)) return arms;
  const [members] = call.arguments;
  if (members === undefined || !ts.isArrayLiteralExpression(members)) return arms;
  for (const element of members.elements) if (ts.isIdentifier(element)) arms.push(element.text);
  return arms;
}

/** The contract's declared members of one vocabulary, read out of the contract's own source. */
export function contractVocabulary(locator, contract = authorityFileOf(locator)) {
  const sourceFile = sourceOf(contract);
  const members = new Set();
  for (const declaration of declarationsNamed(sourceFile, locator.name)) {
    if (locator.discriminant !== undefined) {
      for (const arm of unionArms(declaration))
        for (const armDeclaration of declarationsNamed(sourceFile, arm))
          for (const property of propertiesNamed(armDeclaration, locator.discriminant))
            for (const value of membersOf(property)) members.add(value);
      continue;
    }
    if (locator.properties === true) {
      const outer = objectShapeOf(declaration);
      const shape = locator.within === undefined ? outer : outer === null ? null : objectShapeWithin(outer, locator.within);
      if (shape !== null) for (const key of declaredKeys(shape)) members.add(key);
      continue;
    }
    const scopes = locator.property === undefined ? [declaration] : propertiesNamed(declaration, locator.property);
    for (const scope of scopes) for (const value of membersOf(scope)) members.add(value);
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

/** The mirror's file name as a finding names it: relative to the checkout, so a failure reads the same everywhere. */
function mirrorName(file) {
  const portable = file.replace(/\\/gu, "/");
  const root = `${REPO.replace(/\\/gu, "/")}/`;
  return portable.startsWith(root) ? portable.slice(root.length) : portable;
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
  assert.deepEqual(
    [...derived.get("CONNECTION_FAILURES")].sort(),
    [
      "endpoint_error",
      "invalid_endpoint",
      "invalid_response",
      "not_configured",
      "not_found",
      "rate_limited",
      "timeout",
      "unauthorized",
      "unreachable",
    ],
    "the probe's failure union is read off the contract, the null arm contributing no literal",
  );
  for (const entry of MIRRORED_VOCABULARIES)
    assert.ok(derived.get(entry.mirror).size >= 2, `${entry.mirror} derived an empty or single-member union`);
  const declared = MIRRORED_VOCABULARIES.map((entry) => entry.mirror);
  for (const file of MIRROR_FILES) {
    const owned = declared.filter((name) => mirrorVocabulary(file, name) !== null);
    assert.ok(owned.length >= 5, `${mirrorName(file)} declares only ${owned.length} gated vocabulary/vocabularies`);
  }
  // Every vocabulary is declared somewhere: an entry whose mirror name no file spells holds nothing.
  for (const entry of MIRRORED_VOCABULARIES)
    assert.ok(
      mirrorFilesOf(entry).some((file) => mirrorVocabulary(file, entry.mirror) !== null),
      `no file declares ${entry.mirror}, so this rule holds nothing for it`,
    );
  t.diagnostic(
    `vocabulary-drift.1: ${MIRRORED_VOCABULARIES.length} contract vocabulary/vocabularies derived from the contract source; ${MIRROR_FILES.map((file) => `${mirrorName(file)}:${declared.filter((name) => mirrorVocabulary(file, name) !== null).length}`).join(", ")}; excluded by name: ${EXCLUDED_VOCABULARIES.join(", ")}`,
  );
});

test("vocabulary-drift.2: every mirror IS the contract's vocabulary, not a stale copy of it", (t) => {
  const failures = [];
  let mirrored = 0;
  for (const entry of MIRRORED_VOCABULARIES) {
    for (const file of mirrorFilesOf(entry)) {
      const declared = mirrorVocabulary(file, entry.mirror);
      if (declared === null) continue;
      mirrored += declared.size;
      failures.push(...vocabularyDrift(`${mirrorName(file)} ${entry.mirror}`, declared, contractVocabulary(entry.contract)));
    }
  }
  t.diagnostic(
    `vocabulary-drift.2: ${mirrored} mirrored member(s) across ${new Set(MIRRORED_VOCABULARIES.flatMap((entry) => mirrorFilesOf(entry).map(mirrorName))).size} mirror file(s) checked for equality against ${MIRRORED_VOCABULARIES.length} contract declaration(s), ${failures.length} drifted`,
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

test("vocabulary-drift.4: the game contract's declarations are read, not assumed", (t) => {
  const derived = new Map(
    GAME_MIRRORED_VOCABULARIES.map((entry) => [entry.mirror, contractVocabulary(entry.contract, GAME_CONTRACT)]),
  );
  // The anchor: one vocabulary read back member for member, so a reader that silently derived a wrong
  // union cannot pass the counts below.
  assert.deepEqual(
    [...derived.get("ACTION_AUTHORITY_STATUSES")].sort(),
    ["active", "paused", "unavailable"],
    "ActionAuthority is the coordinator's three-member authority union",
  );
  // The second anchor, for the reader shape the tavern contract never uses: the fact union states its members as the
  // discriminants of three arm schemas, so a reader that looked for a literal list beside the union would read nothing.
  assert.deepEqual(
    [...derived.get("GAME_FACTS")].sort(),
    ["attachment", "instance", "selectedWorld"],
    "GameFactPatchV1Schema's members are its arms' own `fact` literals",
  );
  for (const entry of GAME_MIRRORED_VOCABULARIES) {
    assert.ok(derived.get(entry.mirror).size >= 2, `${entry.mirror} derived an empty or single-member union`);
    assert.ok(
      GAME_MIRROR_FILES.some((file) => mirrorVocabulary(file, entry.mirror) !== null),
      `no game mirror declares ${entry.mirror}, so this rule holds nothing for it`,
    );
  }
  t.diagnostic(
    `vocabulary-drift.4: ${GAME_MIRRORED_VOCABULARIES.length} game contract vocabulary/vocabularies derived from the game contract source; ${GAME_MIRROR_FILES.map((file) => `${mirrorName(file)}:${GAME_MIRRORED_VOCABULARIES.filter((entry) => mirrorVocabulary(file, entry.mirror) !== null).length}`).join(", ")}`,
  );
});

test("vocabulary-drift.5: every game mirror IS the game contract's vocabulary, not a stale copy of it", (t) => {
  const failures = [];
  let mirrored = 0;
  for (const file of GAME_MIRROR_FILES) {
    for (const entry of GAME_MIRRORED_VOCABULARIES) {
      const declared = mirrorVocabulary(file, entry.mirror);
      if (declared === null) continue;
      mirrored += declared.size;
      failures.push(
        ...vocabularyDrift(
          `${mirrorName(file)} ${entry.mirror}`,
          declared,
          contractVocabulary(entry.contract, GAME_CONTRACT),
        ),
      );
    }
  }
  t.diagnostic(
    `vocabulary-drift.5: ${mirrored} mirrored member(s) across ${GAME_MIRROR_FILES.length} game mirror(s) checked for equality against ${GAME_MIRRORED_VOCABULARIES.length} game contract declaration(s), ${failures.length} drifted`,
  );
  assert.deepEqual(
    failures,
    [],
    "a game mirror that does not know a declared member refuses a legal /game snapshot as protocol corruption for the whole panel",
  );
});
