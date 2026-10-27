/**
 * A declared contract member has a producer, or the gate's own ledger reserves it.
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
 *     published with nothing behind it: `game.attach` and `game.prerequisites.read`
 *     have no route in this tree.
 *
 * The members are *enumerated from the contracts*, not listed here: every id in
 * `GAME_BROWSER_OPERATION_IDS_V1`, every id in the tavern contract's `OperationId`
 * union, the three literals of `TavernVoiceSurfaceStateV1Schema.state`, the seven
 * of `BrowserTurnV1Schema.state`, the three of `MemoryItemV1Schema.status`, and
 * the card-import classification/eligibility unions are read from their own
 * declarations, so a newly declared member is checked the moment it is added and
 * there is no list to forget to update.
 *
 * The producer rule, per subject:
 *  - a game operation is produced when a shipped (non-test, non-contract) Host
 *    source names it in a value position;
 *  - a tavern operation is produced when a module the composed static shell MOUNTS
 *    as a route server names it in a value position - see `mountedRouteModules`.
 *    The contract's own `RouteDescriptors` table is deliberately NOT a producer:
 *    the contract declares both the `OperationId` union and that table, so letting
 *    the table vouch for the union is the contract certifying itself;
 *  - a voice state member is produced when a non-test Host source *writes* it into
 *    the schema's own field (`state`) inside a scope that also names the field's
 *    owner (`voice`), so a comparison or a type annotation cannot vouch for it;
 *  - a turn/memory/card-import member is produced the way an operation is, because
 *    the browser projection emits those vocabularies through ternaries, call
 *    arguments and passthroughs rather than property writes, and the strict write
 *    rule would leave every member of them bare. The owner scope must still be
 *    named (`turn`, `memor`, `import`), and the type-position exclusion still
 *    applies.
 *
 * Reservations are the ONLY escape hatch, and they are not free text: each contract
 * exports its own frozen ledger (`TAVERN_BROWSER_CONTRACT_RESERVATIONS_V1` in
 * tavern/browser-contract, `GAME_BROWSER_CONTRACT_RESERVATIONS_V1` in
 * game-browser-contract), one structured entry per reserved member, each carrying a
 * `servedBy` path that must resolve to a shipped source on disk and an `instead`
 * member that must be declared by the same contract and itself produced. This file holds
 * no entry of its own - it imports both ledgers and consumes them as
 * `CONTRACT_RESERVATIONS` below - which is the point: a gate satisfied by editing the
 * gate is the self-certification the ledger exists to stop, and a comment in the product
 * can no longer silence it, because no comment is read.
 *
 * Why value position matters: a union declaration repeats its members as a type
 * (`state: "unavailable" | "ready" | "speaking"`), and counting that as a producer
 * would let the gate pass on the very file that proves nothing produces the member.
 *
 * What this cannot express honestly, and therefore does not claim (the tavern contract's
 * ledger header states the same two limits, where a future reader looks first):
 * "produced" here means *some* shipped source names that literal in a scope naming its
 * owner; for the game and state members that is not a proof that a live Host path emits
 * it, and a member whose producer is reached only from a test fixture would still
 * pass. For the tavern operations it is stronger - the naming source must be a
 * mounted route server - but still a name in a served module, not a request that
 * the dispatcher actually answers. The turn/memory/card-import members use the
 * value-position rule because a strict write rule would leave every one of them bare.
 * The gate states that limit rather than guessing a stronger rule.
 *
 * False positives, and how each is handled:
 *  - test files, `*.test.ts`, `test-fixtures/` and `test-support/` are excluded, so
 *    a fixture that writes `unavailable` cannot stand in for a producer;
 *  - the contract files are excluded from the producer search, so a member cannot
 *    produce itself;
 *  - the field-name requirement is scoped to the same function or statement, so an
 *    unrelated `"unavailable"` in a file that mentions `voice` elsewhere cannot
 *    vouch for the voice surface;
 *  - the turn owner regex is `(?<!re)turn`, so the common word "return" does not
 *    vouge for a turn member;
 *  - the file must only *mention* the field, not import it: a member produced in a
 *    differently-named module still counts, which is the conservative direction.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { GAME_BROWSER_CONTRACT_RESERVATIONS_V1 } from "../../host/src/game-browser-contract/index.ts";
import { TAVERN_BROWSER_CONTRACT_RESERVATIONS_V1 } from "../../host/src/tavern/browser-contract/index.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = join(REPO, "host", "src");
const TAVERN_CONTRACT = join(HOST, "tavern", "browser-contract", "index.ts");
const GAME_CONTRACT = join(HOST, "game-browser-contract", "index.ts");
/** The file that registers the browser routes and mounts the handlers that serve them. */
const COMPOSITION = join(HOST, "tavern", "composed-reference-game-static-shell-composition.ts");

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

/** The string literals of one named property inside a named top-level schema. */
export function literalsOfProperty(text, fileName, declaration, property) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== declaration) return;
    walk(node, (inner) => {
      if (!ts.isPropertyAssignment(inner) || !ts.isIdentifier(inner.name) || inner.name.text !== property) return;
      walk(inner.initializer, (literal) => {
        if (ts.isStringLiteral(literal)) found.push(literal.text);
      });
    });
  });
  return found;
}

function literalsOf(contract, name) {
  return literalsOfDeclaration(readFileSync(contract, "utf8"), contract, name);
}

function propertyLiteralsOf(contract, declaration, property) {
  return literalsOfProperty(readFileSync(contract, "utf8"), contract, declaration, property);
}

/**
 * The modules the composed static shell MOUNTS as browser route servers: the
 * composition that registers the routes itself, plus every module it reaches
 * transitively through a `create*RequestHandler` / `create*DelegatedHandler`
 * import - i.e. the handlers that actually serve `/api/tavern/v1/`. The contract
 * is never in this set, so an operation cannot certify itself.
 */
export function mountedRouteModules(compositionFile = COMPOSITION) {
  const mounted = new Set();
  const queue = [compositionFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (mounted.has(file)) continue;
    mounted.add(file);
    walk(sourceOf(file), (node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const clause = node.importClause;
      if (clause === undefined) return;
      const names = [];
      if (clause.name !== undefined) names.push(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings)) names.push("*");
        else for (const element of bindings.elements) names.push(element.name.text);
      }
      if (!names.some((name) => /^create[A-Za-z0-9]*(?:RequestHandler|DelegatedHandler)$/u.test(name))) return;
      const resolved = resolveImport(file, node.moduleSpecifier.text);
      if (resolved !== null) queue.push(resolved);
    });
  }
  return [...mounted].sort();
}

/** Resolve a relative import specifier to the TypeScript source file it names. */
function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/u, ".ts"), `${base}.ts`, base.replace(/\.js$/u, ".tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not on disk: fall through to the next spelling.
    }
  }
  return null;
}

const MOUNTED_ROUTE_MODULES = mountedRouteModules();
/** Mounted modules that declare a `/api/tavern/v1/` route, so they serve that API. */
const TAVERN_ROUTE_SERVERS = MOUNTED_ROUTE_MODULES.filter((file) =>
  readFileSync(file, "utf8").includes("/api/tavern/v1/"),
);

/** True when a mounted tavern route server names `member` in a value position. */
export function tavernMountProducers(member, servers = TAVERN_ROUTE_SERVERS) {
  return producersOf(member, null, new Set(), servers);
}

/**
 * The reservation ledger, read from the contracts that own it. This file carries no
 * entry of its own: it concatenates the two exported ledgers, which is what makes
 * "reserve a member" a contract edit rather than a gate edit. Each entry is a
 * structured, verifiable fact about a member no producer can emit: which shipped source
 * serves the shell in its place (`servedBy`) and which declared, produced member answers
 * the request instead (`instead`). Nothing else reserves a member, and a comment never
 * can.
 *
 * What is reserved is the structured `(kind, member)` key alone; `reason` is prose for
 * the next reader and can be reworded freely without reserving or unfreezing anything. A
 * reason that reads like "this would have to exist first" turns a deliberate
 * architectural choice into a backlog item, so a structural reservation says WHY it is
 * not planned instead.
 */
export const CONTRACT_RESERVATIONS = Object.freeze([
  ...GAME_BROWSER_CONTRACT_RESERVATIONS_V1,
  ...TAVERN_BROWSER_CONTRACT_RESERVATIONS_V1,
]);

/**
 * Every subject the gate checks, with its members enumerated from the contract
 * they are declared in. `mode` selects the producer rule (`"value"` or `"write"`),
 * `field` is the owner scope a producer must name, and `produced` replaces the
 * shipped-source search for a subject whose producers are the mounted route
 * servers.
 */
const SUBJECTS = [
  ...literalsOf(GAME_CONTRACT, "GAME_BROWSER_OPERATION_IDS_V1").map((id) => ({
    kind: "game-operation",
    label: "the declared game operation",
    contract: GAME_CONTRACT,
    declaration: id,
    field: null,
    mode: "value",
    members: [id],
  })),
  ...literalsOf(TAVERN_CONTRACT, "OperationId").map((id) => ({
    kind: "tavern-operation",
    label: "the declared tavern operation",
    contract: TAVERN_CONTRACT,
    declaration: id,
    field: null,
    mode: "value",
    members: [id],
    produced: (member) => tavernMountProducers(member),
  })),
  {
    kind: "voice-state",
    label: "the voice surface state",
    contract: TAVERN_CONTRACT,
    declaration: "TavernVoiceSurfaceStateV1Schema",
    field: /voice/iu,
    mode: "write",
    members: literalsOf(TAVERN_CONTRACT, "TavernVoiceSurfaceStateV1Schema"),
  },
  {
    kind: "turn-state",
    label: "the browser turn state",
    contract: TAVERN_CONTRACT,
    declaration: "BrowserTurnV1Schema",
    field: /(?<!re)turn/iu,
    mode: "value",
    members: propertyLiteralsOf(TAVERN_CONTRACT, "BrowserTurnV1Schema", "state"),
  },
  {
    kind: "memory-status",
    label: "the memory row status",
    contract: TAVERN_CONTRACT,
    declaration: "MemoryItemV1Schema",
    field: /memor/iu,
    mode: "value",
    members: propertyLiteralsOf(TAVERN_CONTRACT, "MemoryItemV1Schema", "status"),
  },
  {
    kind: "memory-category",
    label: "the memory row category",
    contract: TAVERN_CONTRACT,
    declaration: "MemoryItemV1Schema",
    field: /memor/iu,
    mode: "value",
    members: propertyLiteralsOf(TAVERN_CONTRACT, "MemoryItemV1Schema", "category"),
  },
  {
    kind: "card-import-classification",
    label: "the card-import disposition class",
    contract: TAVERN_CONTRACT,
    declaration: "StCardImportDispositionV1Schema",
    field: /import/iu,
    mode: "value",
    members: propertyLiteralsOf(TAVERN_CONTRACT, "StCardImportDispositionV1Schema", "classification"),
  },
  {
    kind: "card-import-eligibility",
    label: "the card-import field eligibility",
    contract: TAVERN_CONTRACT,
    declaration: "StCardImportFieldSummaryV1Schema",
    field: /import/iu,
    mode: "value",
    members: propertyLiteralsOf(TAVERN_CONTRACT, "StCardImportFieldSummaryV1Schema", "eligibility"),
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

/** The producers of one member under its subject's own rule. */
export function producersForSubject(subject, member, files = producerFiles()) {
  if (subject.produced !== undefined) return subject.produced(member);
  const properties = subject.mode === "write" ? propertyNamesOf(subject.contract, subject.declaration) : new Set();
  return producersOf(member, subject.field, properties, files);
}

/** The 1-based line a named declaration starts on, for a routable failure message. */
export function declarationLine(contractFile, declaration) {
  const lines = readFileSync(contractFile, "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(declaration));
  return index < 0 ? 0 : index + 1;
}

/** The ledger entry for a subject kind and member, or null when it is unreserved. */
export function findReservation(kind, member) {
  return CONTRACT_RESERVATIONS.find((entry) => entry.kind === kind && entry.member === member) ?? null;
}

/**
 * The bare/full enumeration over any subject list. Exported so the planted
 * violation below runs the exact rule the real gate runs.
 */
export function enumerateSubjects(subjects, files = producerFiles()) {
  const failures = [];
  const reserved = [];
  let produced = 0;
  let checked = 0;
  for (const subject of subjects) {
    for (const member of subject.members) {
      checked += 1;
      if (producersForSubject(subject, member, files).length > 0) {
        produced += 1;
        continue;
      }
      if (findReservation(subject.kind, member) !== null) {
        reserved.push(member);
        continue;
      }
      failures.push(
        `${subject.contract.replace(/\\/gu, "/").split("/src/").pop()}:${declarationLine(subject.contract, subject.declaration)} declares ${member} (${subject.label}) with no producer and no ledger reservation`,
      );
    }
  }
  return { checked, produced, reserved, failures };
}

/** The subject that declares `member`. */
function subjectOf(kind, member) {
  return SUBJECTS.find((subject) => subject.kind === kind && subject.members.includes(member));
}

/** The subject, in the same contract, whose members include `member`. */
function subjectOfContractMember(contract, member) {
  return SUBJECTS.find((subject) => subject.contract === contract && subject.members.includes(member));
}

test("producer.1: every declared contract member has a producer or a ledger reservation", (t) => {
  const files = producerFiles();
  const { checked, produced, reserved, failures } = enumerateSubjects(SUBJECTS, files);
  t.diagnostic(
    `producer.1: ${checked} declared member(s) enumerated from the contracts, ${files.length} non-test source file(s); ${MOUNTED_ROUTE_MODULES.length} mounted route module(s), ${TAVERN_ROUTE_SERVERS.length} serving /api/tavern/v1/; ${produced} produced, ${reserved.length} reserved${reserved.length === 0 ? "" : ` (${reserved.join(", ")})`}, ${failures.length} bare`,
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

test("producer.4 (mutation): a tavern operation is produced by a mounted server, not the contract table", (t) => {
  // Every declared operation really is named by a mounted tavern route server.
  const servers = TAVERN_ROUTE_SERVERS.map((file) => file.replace(/\\/gu, "/").split("/host/src/").pop());
  assert.ok(
    servers.includes("tavern-management-dialogue-web.ts"),
    `the management handler must be a mounted route server, found ${servers.join(", ")}`,
  );
  assert.ok(
    servers.includes("reference-pipeline-dialogue-web.delegated.ts"),
    `the reference handler must be a mounted route server, found ${servers.join(", ")}`,
  );
  assert.ok(
    !MOUNTED_ROUTE_MODULES.includes(TAVERN_CONTRACT) && !MOUNTED_ROUTE_MODULES.includes(GAME_CONTRACT),
    "the contracts must never be their own mounting evidence",
  );
  // A planted operation no mounted server names has no producer, even though the
  // contract's own descriptor table would happily list it.
  assert.deepEqual(tavernMountProducers("chat.planted"), [], "an unmounted id has no producer");
  assert.ok(tavernMountProducers("chat.submit").length > 0, "a real operation is named by the reference handler");
  t.diagnostic(`producer.4: ${TAVERN_ROUTE_SERVERS.length} mounted tavern route server(s); the contract is not one`);
});

test("producer.5 (mutation): a planted declaration is enumerated, and only the ledger clears it", (t) => {
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
  assert.equal(
    findReservation("game-operation", "game.instances.list"),
    null,
    "a planted member is not in the ledger and cannot be reserved by a comment",
  );
  assert.notEqual(findReservation("game-operation", "game.prerequisites.read"), null, "the ledger reserves its own members");
  const marked = [
    "const ProbeVocabulary = Object.freeze([",
    "  /** Reserved: this comment must clear nothing. */",
    '  "game.instances.list",',
    "] as const);",
  ].join("\n");
  assert.ok(marked.includes("Reserved"), "the probe still carries the comment that used to be the escape hatch");
  assert.equal(
    findReservation("game-operation", "game.instances.list"),
    null,
    "a reservation comment in the product no longer clears anything",
  );
  t.diagnostic("producer.5: a planted member is enumerated, and only the structured ledger can reserve it");
});

test("producer.6: the reservation ledger is counted and every entry names a real substitute", (t) => {
  // The ledger is the contracts' own frozen export, imported rather than copied, so a
  // gate edit cannot reserve a member and the contracts cannot be silent about one.
  assert.ok(
    Object.isFrozen(GAME_BROWSER_CONTRACT_RESERVATIONS_V1) &&
      Object.isFrozen(TAVERN_BROWSER_CONTRACT_RESERVATIONS_V1) &&
      Object.isFrozen(CONTRACT_RESERVATIONS),
    "the reservation ledgers are frozen",
  );
  assert.equal(
    CONTRACT_RESERVATIONS.length,
    GAME_BROWSER_CONTRACT_RESERVATIONS_V1.length + TAVERN_BROWSER_CONTRACT_RESERVATIONS_V1.length,
    "the gate consumes the contract ledgers instead of carrying its own copy",
  );
  const files = producerFiles();
  const shipped = new Set(files);
  const problems = [];
  for (const entry of CONTRACT_RESERVATIONS) {
    const subject = subjectOf(entry.kind, entry.member);
    if (subject === undefined) {
      problems.push(`${entry.member}: reserved but not declared by any subject (stale reservation)`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 8)
      problems.push(`${entry.member}: a reservation must state why no producer can emit it`);
    if (typeof entry.servedBy !== "string" || !shipped.has(join(REPO, entry.servedBy)))
      problems.push(`${entry.member}: servedBy ${JSON.stringify(entry.servedBy)} does not resolve to a shipped source`);
    const substitute = subjectOfContractMember(subject.contract, entry.instead);
    if (substitute === undefined) {
      problems.push(`${entry.member}: instead ${JSON.stringify(entry.instead)} is not declared by the same contract`);
    } else if (producersForSubject(substitute, entry.instead, files).length === 0) {
      problems.push(`${entry.member}: instead ${entry.instead} is itself unproduced, so the substitute is not real`);
    }
  }
  t.diagnostic(
    `producer.6: ${CONTRACT_RESERVATIONS.length} reserved member(s), each with a resolvable servedBy and a produced instead`,
  );
  assert.deepEqual(problems, [], "a reservation is a structured, verifiable fact - not prose");
});

test("producer.7 (planted): an unproduced, unreserved member turns the enumeration red", (t) => {
  const files = producerFiles();
  const plantedSubject = {
    kind: "tavern-operation",
    label: "the declared tavern operation",
    contract: TAVERN_CONTRACT,
    declaration: "OperationId",
    field: null,
    mode: "value",
    members: ["chat.planted"],
    produced: (member) => tavernMountProducers(member),
  };
  const planted = enumerateSubjects([plantedSubject], files);
  assert.equal(
    planted.failures.length,
    1,
    "a mounted route server does not name chat.planted, so the enumeration must fail it",
  );
  assert.match(planted.failures[0], /declares chat\.planted .* with no producer and no ledger reservation/u);
  const clean = enumerateSubjects([{ ...plantedSubject, members: ["chat.submit"] }], files);
  assert.deepEqual(clean.failures, [], "the same enumeration over a real operation passes");
  t.diagnostic(`producer.7: planted -> ${planted.failures[0]}`);
});
