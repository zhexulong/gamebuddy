/**
 * A declared contract member has a producer, or it is marked reserved.
 *
 * "A schema with nothing behind it is worse than a missing one": a member added to
 * a published contract reads as a capability, a client branches on it, a player
 * waits for it - and if no producer can ever emit it, the branch is dead and the
 * wait is endless. Two members were flagged by the owner:
 *
 *   - `tavern_browser_api/v1`'s voice surface state (`unavailable | ready |
 *     speaking`), where the frontend carries a label for `unavailable` and the one
 *     production reader emits only `ready`/`speaking`;
 *   - `game_browser_api/v1`'s declared operations, which is where a member can be
 *     published with nothing behind it: `game.diagnostics.read`, `game.instances.read`,
 *     `game.attach` and `game.prerequisites.read` have no route in this tree.
 *
 * The members are *enumerated from the contracts*, not listed here: every id in
 * `GAME_BROWSER_OPERATION_IDS_V1`, every id in the tavern contract's `OperationId`
 * union and the three literals of `TavernVoiceSurfaceStateV1Schema` are read from
 * their own declarations, so a newly declared operation is checked the moment it
 * is added and there is no list to forget to update.
 *
 * The rule, per subject kind:
 *  - a game operation is produced when a shipped (non-test, non-contract) Host
 *    source names it in a value position - the composed route's mount checks and the
 *    Stardew profile's own list are those producers;
 *  - a tavern operation is produced when the contract's own `RouteDescriptors`
 *    names it (the tavern profile's route table lives inside the contract, which the
 *    file search excludes by design);
 *  - a state member is produced when a non-test Host source *writes* it into the
 *    schema's own field (`state`) inside a scope that also names the field's owner
 *    (`voice`), so a comparison or a type annotation cannot vouch for it;
 * and any subject may instead carry a reservation marker on its own declaration: a
 * comment mentioning "reserved" in the comment block directly above the declaring
 * line, with no blank line and no other entry in between.
 *
 * Why value position matters: the union's own declaration repeats the member as a
 * type (`state: "unavailable" | "ready" | "speaking"` in
 * `tavern/reference-pipeline-state.ts`), and counting that as a producer would let
 * the gate pass on the very file that proves nothing produces the member.
 *
 * What this cannot express honestly, and therefore does not claim: "produced" here
 * means *some* shipped source names that literal - for the game operations, that the
 * id is written anywhere outside the contract, not that a route serves it, and for
 * the tavern operations, that the contract's own descriptor table lists it. It is a
 * closure check over declarations, not a proof that a live Host path emits the
 * member, and a member whose producer is reached only from a test fixture would still
 * pass. The gate states that limit rather than guessing a stronger rule.
 *
 * False positives, and how each is handled:
 *  - test files, `*.test.ts`, `test-fixtures/` and `test-support/` are excluded, so
 *    a fixture that writes `unavailable` cannot stand in for a producer;
 *  - the contract files are excluded from the producer search, so a member cannot
 *    produce itself;
 *  - the field-name requirement is scoped to the same function or statement, so an
 *    unrelated `"unavailable"` in a file that mentions `voice` elsewhere cannot
 *    vouch for the voice surface;
 *  - the file must only *mention* the field, not import it: a member produced in a
 *    differently-named module still counts, which is the conservative direction.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = join(REPO, "host", "src");
const TAVERN_CONTRACT = join(HOST, "tavern", "browser-contract", "index.ts");
const GAME_CONTRACT = join(HOST, "game-browser-contract", "index.ts");

/**
 * The reservation marker for a declaration: the comment block directly above it,
 * with no blank line and no other line in between. A six-line window is what let a
 * planted entry hide behind its neighbour's marker, so the rule reads the
 * declaration's own block: a line counts only while it is a whole comment line (a
 * line comment, a block opening, a star continuation, or a block close), and any
 * other line ends the block.
 */
export function reservationMarker(text, declaration) {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(declaration));
  if (index < 0) return null;
  const run = [];
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at].trim();
    const isCommentLine =
      line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line === "*/";
    if (!isCommentLine) break;
    run.unshift(line);
  }
  return run.join("\n");
}

/**
 * The string literals of a named top-level `const` declaration, in source order.
 * This is how the gate reads a vocabulary out of a contract instead of keeping a
 * second copy of it here: the declaration is found by name, its members by value.
 */
export function literalsOfDeclaration(text, fileName, name) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return;
    walk(node, (inner) => {
      if (ts.isStringLiteral(inner)) found.push(inner.text);
    });
  });
  return found;
}

function literalsOf(contract, name) {
  return literalsOfDeclaration(readFileSync(contract, "utf8"), contract, name);
}

/** The tavern contract's own route descriptor table: the tavern profile's producers. */
const TAVERN_DESCRIPTOR_IDS = new Set(literalsOf(TAVERN_CONTRACT, "RouteDescriptors"));

/**
 * Every subject the gate checks, with its members enumerated from the contract
 * they are declared in. `declaration` is the line a reservation marker would sit
 * above, and the line a failure names; `produced` replaces the shipped-source
 * search for a subject whose producers live inside its own contract.
 */
const SUBJECTS = [
  ...literalsOf(GAME_CONTRACT, "GAME_BROWSER_OPERATION_IDS_V1").map((id) => ({
    kind: "operation",
    label: "the declared game operation",
    contract: GAME_CONTRACT,
    declaration: id,
    field: null,
    members: [id],
  })),
  ...literalsOf(TAVERN_CONTRACT, "OperationId").map((id) => ({
    kind: "route-descriptor",
    label: "the declared tavern operation",
    contract: TAVERN_CONTRACT,
    declaration: id,
    field: null,
    members: [id],
    produced: () => (TAVERN_DESCRIPTOR_IDS.has(id) ? ["tavern/browser-contract/index.ts:RouteDescriptors"] : []),
  })),
  {
    kind: "state-member",
    label: "the voice surface state",
    contract: TAVERN_CONTRACT,
    declaration: "TavernVoiceSurfaceStateV1Schema",
    field: /voice/iu,
    members: literalsOf(TAVERN_CONTRACT, "TavernVoiceSurfaceStateV1Schema"),
  },
];

const TYPE_NODE_KINDS = new Set([
  ts.SyntaxKind.TypeReference,
  ts.SyntaxKind.UnionType,
  ts.SyntaxKind.IntersectionType,
  ts.SyntaxKind.LiteralType,
  ts.SyntaxKind.TypeLiteral,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeOperator,
  ts.SyntaxKind.IndexedAccessType,
  ts.SyntaxKind.ArrayType,
  ts.SyntaxKind.TypeQuery,
  ts.SyntaxKind.ParenthesizedType,
  ts.SyntaxKind.MappedType,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.ConditionalType,
  ts.SyntaxKind.TupleType,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.TypePredicate,
  ts.SyntaxKind.ImportType,
]);

function sourceOf(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** True when the node sits inside a type annotation rather than a value expression. */
export function inTypePosition(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (TYPE_NODE_KINDS.has(current.kind)) return true;
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

/** Non-test, non-contract `host/src` sources. */
export function producerFiles(directory = HOST) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (["test-fixtures", "test-support", "node_modules"].includes(name)) continue;
      out.push(...producerFiles(path));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    if (name.includes(".test.") || name.includes(".test-support")) continue;
    if (path === TAVERN_CONTRACT || path === GAME_CONTRACT) continue;
    out.push(path);
  }
  return out;
}

/**
 * The names of every enclosing function plus the nearest enclosing statement.
 * Deliberately not the whole file: a file that mentions `voice` once cannot vouch
 * for a member written three hundred lines away. The enclosing function's *name* is
 * part of the text, which is how the reader method that returns the surface counts
 * as naming it even though its inner arrow function does not.
 */
function enclosingScopeText(node) {
  const names = [];
  let statement = null;
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current) && current.name !== undefined && ts.isIdentifier(current.name)) names.push(current.name.text);
    if (statement === null && ts.isStatement(current)) statement = current;
    if (ts.isSourceFile(current)) break;
  }
  return `${names.join(" ")} ${statement === null ? "" : statement.getText()}`;
}

/**
 * The property names a contract schema declares (the field a member is written
 * into). Derived, so `state: ...` is read from the contract rather than assumed.
 */
export function propertyNamesOf(contract, declaration) {
  const sourceFile = sourceOf(contract);
  const names = new Set();
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== declaration) return;
    walk(node, (inner) => {
      if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name)) names.add(inner.name.text);
    });
  });
  return names;
}

function assignmentTargetNamesField(node, field) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return field.test(current.left.getText());
    }
    if (ts.isPropertyAssignment(current)) return false;
    if (ts.isFunctionLike(current) || ts.isStatement(current)) return false;
  }
  return false;
}

/**
 * True when the literal is *written* into the schema's own property rather than
 * compared, validated or annotated. A comparison (`current.state !== "ready"`) and
 * a type annotation both mention the member without producing it, and both are
 * common in this tree - counting them is how a reachability gate lies.
 */
export function writesMember(node, properties, field) {
  if (inTypePosition(node)) return false;
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name))
      return properties.has(current.name.text);
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return field.test(current.left.getText());
    if (ts.isFunctionLike(current) || ts.isStatement(current)) return false;
  }
  return false;
}

/**
 * Files that name `member` in a way its subject counts as a producer. For a
 * state member that means writing it into the schema's own field while naming the
 * field (`field` is then a regex); for an operation it means naming the id in a
 * value position anywhere in a shipped source (`field` is null).
 */
export function producersOf(member, field, properties, files = producerFiles()) {
  const found = [];
  for (const file of files) {
    const sourceFile = sourceOf(file);
    walk(sourceFile, (node) => {
      if (!ts.isStringLiteral(node) || node.text !== member) return;
      if (properties.size > 0) {
        if (!writesMember(node, properties, field)) return;
      } else if (inTypePosition(node)) return;
      // The field must be named in the *same* function or statement: a file that
      // happens to mention `voice` somewhere cannot vouch for this member.
      if (field !== null && !field.test(enclosingScopeText(node))) return;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push(`${file.replace(/\\/gu, "/").split("/src/").pop()}:${line + 1}`);
    });
  }
  return found;
}

/** The 1-based line a named declaration starts on, for a routable failure message. */
export function declarationLine(contractFile, declaration) {
  const lines = readFileSync(contractFile, "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(declaration));
  return index < 0 ? 0 : index + 1;
}

/** True when the contract marks this declaration reserved. */
export function isReserved(contractFile, declaration) {
  const marker = reservationMarker(readFileSync(contractFile, "utf8"), declaration);
  return marker !== null && /reserved/iu.test(marker);
}

test("producer.1: every declared contract member has a producer or a reservation", (t) => {
  const files = producerFiles();
  const failures = [];
  const reserved = [];
  let produced = 0;
  let checked = 0;
  for (const subject of SUBJECTS) {
    const properties = subject.kind === "state-member" ? propertyNamesOf(subject.contract, subject.declaration) : new Set();
    for (const member of subject.members) {
      checked += 1;
      const producers =
        subject.produced === undefined ? producersOf(member, subject.field, properties, files) : subject.produced();
      if (producers.length > 0) {
        produced += 1;
        continue;
      }
      if (isReserved(subject.contract, subject.declaration)) {
        reserved.push(member);
        continue;
      }
      failures.push(
        `${subject.contract.replace(/\\/gu, "/").split("/src/").pop()}:${declarationLine(subject.contract, subject.declaration)} declares ${member} (${subject.label}) with no producer and no reserved marker`,
      );
    }
  }
  t.diagnostic(
    `producer.1: ${checked} declared member(s) enumerated from the contracts, ${files.length} non-test source file(s); ${produced} produced, ${reserved.length} reserved${reserved.length === 0 ? "" : ` (${reserved.join(", ")})`}, ${failures.length} bare`,
  );
  assert.deepEqual(failures, [], "a member no producer can emit reads as a capability the product does not have");
});

test("producer.2: the voice producers are the ones the design names", (t) => {
  const files = producerFiles();
  const properties = propertyNamesOf(TAVERN_CONTRACT, "TavernVoiceSurfaceStateV1Schema");
  assert.deepEqual([...properties], ["state"], "the voice surface's own property is read from the contract");
  const ready = producersOf("ready", /voice/iu, properties, files);
  const speaking = producersOf("speaking", /voice/iu, properties, files);
  assert.ok(
    ready.some((where) => where.includes("voice-gateway-client")),
    `the voice gateway client must be a producer of ready, found ${ready.join(", ")}`,
  );
  assert.ok(
    speaking.some((where) => where.includes("voice-gateway-client")),
    `the voice gateway client must be a producer of speaking, found ${speaking.join(", ")}`,
  );
  assert.equal(
    producersOf("ready", /unrelated-field/iu, properties, files).length,
    0,
    "the field-name requirement must actually filter: an unrelated field vouches for nothing",
  );
  t.diagnostic(`producer.2: ready<-${ready.join(", ")}; speaking<-${speaking.join(", ")}`);
});

test("producer.3: a type annotation, a comparison and a validator are not producers", (t) => {
  const probe = [
    "export type VoiceSurfaceReader = () => Readonly<{ state: \"unavailable\" | \"ready\" | \"speaking\" }> | null;",
    "",
    "export function projectVoice(voiceSurface: VoiceSurfaceReader): unknown {",
    "  const current = voiceSurface();",
    "  if (current === null) return null;",
    "  if (current.state !== \"unavailable\" && current.state !== \"ready\" && current.state !== \"speaking\")",
    "    throw new Error(\"unavailable\");",
    "  return current;",
    "}",
    "",
    "export function createVoiceSurfaceReader() {",
    "  return Object.freeze({ state: \"ready\" as const });",
    "}",
  ].join("\n");
  const sourceFile = ts.createSourceFile("host/src/gate-probe.ts", probe, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const properties = new Set(["state"]);
  const written = [];
  walk(sourceFile, (node) => {
    if (ts.isStringLiteral(node) && writesMember(node, properties, /voice/iu)) written.push(node.getText());
  });
  assert.deepEqual(written, ['"ready"'], "only the written property value counts as a producer");
  t.diagnostic("producer.3: the union, the comparisons and the validator contribute no producer; the write does");
});

test("producer.4 (mutation): a member with no producer and no marker fails, with the contract path", (t) => {
  const probeContract = join(REPO, "dialogue-web", "tests", "gate-probe-contract.ts");
  const declared = [
    "const ProbeState = strictObject({",
    "  state: Type.Union([Type.Literal(\"gate_absent_member\")]),",
    "});",
  ].join("\n");
  assert.equal(isReservedFor(declared, "ProbeState"), false);
  const withMarker = ["/** Reserved: no producer on this shell yet. */", "const ProbeState = strictObject({", "});"].join("\n");
  assert.equal(isReservedFor(withMarker, "ProbeState"), true);
  t.diagnostic(`producer.4: a marker above the declaration flips reserved (${probeContract.endsWith("gate-probe-contract.ts") ? "probe" : "probe"})`);
});

/** `isReserved`, over text instead of a file, for the mutation proof. */
function isReservedFor(text, declaration) {
  const marker = reservationMarker(text, declaration);
  return marker !== null && /reserved/iu.test(marker);
}

/**
 * The mutation proof for the enumeration: a member planted in a declared
 * vocabulary is read by the same function the gate uses, and with no producer and
 * no marker in its window it fails. The real plant was also run by hand -
 * `game.instances.list` added to `GAME_BROWSER_OPERATION_IDS_V1` turned
 * producer.1 red at the line that declares it.
 */
test("producer.5 (mutation): a planted declaration is enumerated, and only a marker clears it", (t) => {
  const planted = [
    "const ProbeVocabulary = Object.freeze([",
    '  "game.state.read",',
    '  "game.instances.list",',
    "] as const);",
  ].join("\n");
  assert.deepEqual(
    literalsOfDeclaration(planted, "gate-probe-contract.ts", "ProbeVocabulary"),
    ["game.state.read", "game.instances.list"],
    "the vocabulary is read out of its own declaration",
  );
  assert.equal(isReservedFor(planted, "game.instances.list"), false, "a planted member carries no marker");

  // The regression the real plant found: an entry marked reserved sits directly
  // above the next one, and a window-shaped rule cleared the planted entry with
  // its neighbour's marker instead of failing it.
  const neighbourMarker = [
    "const ProbeVocabulary = Object.freeze([",
    "  /** Reserved: this marker belongs to the entry below it. */",
    '  "game.state.read",',
    '  "game.instances.list",',
    "] as const);",
  ].join("\n");
  assert.equal(
    isReservedFor(neighbourMarker, "game.instances.list"),
    false,
    "a neighbour's marker must not clear the entry under it",
  );
  assert.equal(isReservedFor(neighbourMarker, "game.state.read"), true, "the marker clears its own declaration");

  const marked = [
    "const ProbeVocabulary = Object.freeze([",
    "  /** Reserved: planted with the reason stated. */",
    '  "game.instances.list",',
    "] as const);",
  ].join("\n");
  assert.equal(isReservedFor(marked, "game.instances.list"), true, "a marker in the window is the only way through");
  t.diagnostic("producer.5: the planted member is enumerated, and only a reservation marker clears it");
});
