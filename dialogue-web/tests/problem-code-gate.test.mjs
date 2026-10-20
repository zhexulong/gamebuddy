/**
 * Problem codes are closed sets, and a handler does not swallow its cause.
 *
 * Two halves of the same complaint. "The failure does not say what it is": a
 * browser route answered a 401 with no session, an unknown code, a malformed
 * response and a real reconciliation conflict all with one sentence, so the text
 * pointed the reader at a fault that did not exist. The first half of the fix is a
 * *closed* vocabulary - the contract declares the codes, `sendProblem` validates
 * against them, the client mirrors them - so this gate derives each declared set
 * from the contract (`ProblemCode`, `GameProblemCode`, the turn's `problemCode`)
 * and asserts that every code a handler can produce is a member. A new code must be
 * declared, and a deleted one cannot linger in a producer.
 *
 * The second half is the opposite failure: a `catch` that catches to do nothing
 * with what it caught, so the cause is gone before anyone can name it. In the
 * browser-contract handlers a catch is a failure exactly when it discards its
 * cause *and* decides nothing: no reference to the bound error, no rethrow, no
 * bounded-code mapping (`sendProblem(response, status, "...")`, `{ code: "..." }`
 * or a `*ProblemCode(...)` call), and no other observable outcome (a call, a
 * returned value, an assignment). A catch that returns a sentinel or calls an error
 * hook has decided what the failure means; this gate cannot judge that decision
 * from syntax and does not pretend to - it counts those and prints them, and fails
 * the shape that decides nothing at all.
 *
 * Scope, stated honestly: a general "every string returned as a code anywhere in
 * `host/src`" rule is not deterministic (`protocol.ts` alone has dozens of unrelated
 * `code:` unions), so this is scoped to the browser-contract handlers and the client
 * mirrors, which is the boundary the owner named.
 *
 * The mirror half of the defect is the opposite direction, and subset-only checking let
 * it live: `problem-code.3` fails a mirror that declares a code the contract does not,
 * and a mirror that does *not know* a declared code passes it. Both mirrors had drifted
 * that way - `reference-pipeline-api.ts` knew 19 of the 41 codes the tavern router can
 * send, `management-pipeline-api.ts` 40 - so `payload_too_large`, the typed 413 the Host
 * sends for an over-ceiling body (`reference-pipeline-dialogue-web.ts:434`, deliberately
 * outside the schema check at `:539`), arrived as an unrecognised code and the client
 * turned a legitimate, actionable refusal into an opaque `TavernProtocolError`. Rule
 * `problem-code.7` asserts EQUALITY with the same derived authority, so a contract that
 * grows a code fails here until every mirror learns it.
 *
 * Why equality and not a longer hand-written list: the browser bundle cannot import the
 * contract (`dialogue-web/src/management-pipeline-api.ts:9` - "no Host package, no
 * typebox, no runtime code"; `dialogue-web` has no typebox dependency, so the Vite bundle
 * cannot resolve `host/src/tavern/browser-contract`), so the Host's declaration is read
 * here, in the gate, from the repository source root - and this gate is what holds the
 * mirrors to it.
 *
 * Reading a code out of a call is positional, not "any string argument": the
 * argument index comes from the callee's own parameter named `code`, so
 * `sendSseResync(response, stream, "ambiguous_cursor", generation)` - whose third
 * argument is a *resync reason*, declared as one - is never mistaken for a problem
 * code. The gate asserts the four sender signatures it read, so a renamed parameter
 * fails loudly instead of silently narrowing the scan.
 *
 * The composed reference-game route is the one surface with no problem union of
 * its own: it composes the tavern and game routes and its client accepts any bounded
 * token by design (`composed-reference-game-browser-api.ts:593`). Its five own codes
 * (`closed`, `malformed_request`, `not_found`, `state_unavailable`,
 * `game_endgame_settlement_unavailable`) are members of the game contract now, so
 * this gate carries no allowlist: every code the route can produce is declared, and
 * a sixth one added without a declaration fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = join(REPO, "host", "src");
const WEB = join(REPO, "dialogue-web", "src");

const TAVERN_CONTRACT = join(HOST, "tavern", "browser-contract", "index.ts");
const GAME_CONTRACT = join(HOST, "game-browser-contract", "index.ts");
const CORE_HANDLER = join(HOST, "reference-pipeline-dialogue-web.core.ts");

/** The handlers whose vocabulary the contracts declare. */
const TAVERN_HANDLERS = [CORE_HANDLER, join(HOST, "reference-pipeline-dialogue-web.ts"), join(HOST, "tavern-management-dialogue-web.ts")];

/** The composed route: tavern + game, with no union of its own. */
const COMPOSED_HANDLER = join(HOST, "composed-reference-game-browser.ts");

const ALL_HANDLERS = [...TAVERN_HANDLERS, COMPOSED_HANDLER];

/** The client mirrors of the declared vocabularies. */
const CLIENT_MIRRORS = [join(WEB, "reference-pipeline-api.ts"), join(WEB, "management-pipeline-api.ts")];

/** A bounded token: the shape every problem code has. */
const BOUNDED_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Sender signatures this gate reads, asserted in `problem-code.5`. If a parameter
 * is renamed the scan would silently stop seeing that sender's code, so the read is
 * itself a finding.
 */
const EXPECTED_CODE_ARITY = { sendProblem: 2, sendBootstrapProblem: 2, sendLifecycleProblem: 3, refuseBootstrap: 1 };

/** A bounded token: the shape every problem code has. */

function sourceOf(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function lineAt(node, sourceFile, file) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${file.replace(/\\/gu, "/").split("/src/").pop()}:${line + 1}`;
}

/** String literals inside a named variable declaration, optionally one property. */
export function literalsInDeclaration(file, name, property = null) {
  const sourceFile = sourceOf(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return;
    const scope =
      property === null
        ? node
        : (() => {
            let hit = null;
            walk(node, (inner) => {
              if (ts.isPropertyAssignment(inner) && inner.name.getText() === property) hit = inner;
            });
            return hit;
          })();
    if (scope === null) return;
    walk(scope, (inner) => {
      if (ts.isStringLiteral(inner) && BOUNDED_CODE.test(inner.text))
        found.push({ value: inner.text, where: lineAt(inner, sourceFile, file) });
    });
  });
  return found;
}

/** The literal *union members* of a named type alias (`"code"` inside `T["code"]` is not one). */
export function literalsInTypeAlias(file, name) {
  const sourceFile = sourceOf(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== name) return;
    const members = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
    for (const member of members) {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) continue;
      found.push({ value: member.literal.text, where: lineAt(member, sourceFile, file) });
    }
  });
  return found;
}

/** callee name -> index of its parameter named `code`, read from the handlers themselves. */
export function codeArity() {
  const map = new Map();
  for (const file of ALL_HANDLERS) {
    const sourceFile = sourceOf(file);
    const record = (name, parameters) => {
      const index = parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "code",
      );
      if (index >= 0) map.set(name, index);
    };
    walk(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) record(node.name.text, node.parameters);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          record(node.name.text, node.initializer.parameters);
      }
    });
  }
  return map;
}

function insideProblemCodeFunction(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name !== undefined && /ProblemCode$/u.test(current.name.text);
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

/** Every problem code a handler file can produce, with the line that names it. */
export function producedCodes(file, arity = codeArity()) {
  const sourceFile = sourceOf(file);
  const found = [];
  walk(sourceFile, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "code" &&
      ts.isStringLiteral(node.initializer) &&
      BOUNDED_CODE.test(node.initializer.text)
    )
      found.push({ value: node.initializer.text, where: lineAt(node.initializer, sourceFile, file) });
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isStringLiteral(node.expression) &&
      BOUNDED_CODE.test(node.expression.text) &&
      insideProblemCodeFunction(node)
    )
      found.push({ value: node.expression.text, where: lineAt(node.expression, sourceFile, file) });
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const index = arity.get(node.expression.text);
    if (index === undefined) return;
    const argument = node.arguments[index];
    if (argument !== undefined && ts.isStringLiteral(argument) && BOUNDED_CODE.test(argument.text))
      found.push({ value: argument.text, where: lineAt(argument, sourceFile, file) });
  });
  return found;
}

/** Both catch categories in one source text: `{ undecided, causeDropping }`, by line. */
export function catchesIn(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const undecided = [];
  const causeDropping = [];
  walk(sourceFile, (node) => {
    if (!ts.isCatchClause(node)) return;
    const name =
      node.variableDeclaration !== undefined && ts.isIdentifier(node.variableDeclaration.name)
        ? node.variableDeclaration.name.text
        : null;
    const body = node.block.getText();
    const usesCause = name !== null && new RegExp(`\\b${name}\\b`, "u").test(body);
    let decidesSomething = false;
    walk(node.block, (inner) => {
      if (ts.isThrowStatement(inner)) decidesSomething = true;
      if (ts.isReturnStatement(inner) && inner.expression !== undefined) decidesSomething = true;
      if (ts.isCallExpression(inner)) decidesSomething = true;
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        decidesSomething = true;
    });
    if (!usesCause) causeDropping.push(lineAt(node, sourceFile, fileName));
    if (!usesCause && !decidesSomething) undecided.push({ line: lineAt(node, sourceFile, fileName), body: body.trim().slice(0, 80) });
  });
  return { undecided, causeDropping };
}

/** A catch that neither uses its cause nor decides any outcome. */
export function undecidedCatches(file) {
  return catchesIn(readFileSync(file, "utf8"), file).undecided;
}

/**
 * Catches that decide an outcome without naming their cause. Printed, not failed:
 * the gate cannot judge whether the sentinel each one returns is the right reading
 * of the failure, and failing here would flag deliberate, commented code.
 */
export function causeDroppingCatches(file) {
  return catchesIn(readFileSync(file, "utf8"), file).causeDropping;
}

function authorities() {
  const tavern = new Set(literalsInDeclaration(TAVERN_CONTRACT, "ProblemCode").map((entry) => entry.value));
  const turn = new Set(
    literalsInDeclaration(TAVERN_CONTRACT, "BrowserTurnV1Schema", "problemCode").map((entry) => entry.value),
  );
  const game = new Set(literalsInDeclaration(GAME_CONTRACT, "GameProblemCode").map((entry) => entry.value));
  const transport = new Set(literalsInTypeAlias(CORE_HANDLER, "ProblemCode").map((entry) => entry.value));
  return { tavern, turn, game, transport };
}

test("problem-code.1: every tavern handler code is declared by the contract", (t) => {
  const { tavern, transport } = authorities();
  const allowed = new Set([...tavern, ...transport]);
  const failures = [];
  let codes = 0;
  for (const file of TAVERN_HANDLERS) {
    for (const produced of producedCodes(file)) {
      codes += 1;
      if (!allowed.has(produced.value))
        failures.push(`${produced.where} produces undeclared code ${JSON.stringify(produced.value)}`);
    }
  }
  t.diagnostic(
    `problem-code.1: ${codes} produced code(s) across ${TAVERN_HANDLERS.length} handler(s), ${allowed.size} allowed (${tavern.size} declared + transport ${[...transport].join("/")}), ${failures.length} undeclared`,
  );
  assert.deepEqual(failures, [], "a code a handler produces must be a member of the contract's declared set");
});

test("problem-code.2: every composed route code is declared by a contract", (t) => {
  const { tavern, game } = authorities();
  const allowed = new Set([...tavern, ...game]);
  const failures = [];
  const seen = new Set();
  let codes = 0;
  for (const produced of producedCodes(COMPOSED_HANDLER)) {
    codes += 1;
    seen.add(produced.value);
    if (!allowed.has(produced.value))
      failures.push(`${produced.where} produces a code outside both contracts ${JSON.stringify(produced.value)}`);
  }
  t.diagnostic(
    `problem-code.2: ${codes} produced code(s), ${seen.size} distinct, all checked against ${tavern.size} tavern + ${game.size} game declared, ${failures.length} undeclared`,
  );
  assert.deepEqual(failures, [], "a code the composed route invents is a code no client can reason about");
});

test("problem-code.3: every client mirror is a subset of the declared set", (t) => {
  const { tavern, turn, game, transport } = authorities();
  // The router's own `ProblemCode` alias declares the transport refusal
  // (`payload_too_large`) beside the schema union, so a mirror naming it is declaring a
  // code the contract declares - the same authority `problem-code.1` holds handlers to.
  const declared = new Set([...tavern, ...transport]);
  const failures = [];
  let mirrored = 0;
  for (const file of CLIENT_MIRRORS) {
    for (const entry of literalsInDeclaration(file, "PROBLEM_CODES")) {
      mirrored += 1;
      if (!declared.has(entry.value))
        failures.push(`${entry.where} mirrors undeclared code ${JSON.stringify(entry.value)}`);
    }
    for (const entry of literalsInDeclaration(file, "TURN_PROBLEM_CODES")) {
      mirrored += 1;
      if (!turn.has(entry.value))
        failures.push(`${entry.where} mirrors undeclared turn code ${JSON.stringify(entry.value)}`);
    }
  }
  for (const list of ["AUTHENTICATION_PROBLEM_CODES", "RECONCILIATION_PROBLEM_CODES", "ABSENT_ROUTE_PROBLEM_CODES"]) {
    for (const entry of literalsInDeclaration(join(WEB, "composed-problem-view.ts"), list)) {
      mirrored += 1;
      if (!tavern.has(entry.value) && !game.has(entry.value) && !turn.has(entry.value))
        failures.push(`${entry.where} classifies undeclared code ${JSON.stringify(entry.value)}`);
    }
  }
  t.diagnostic(
    `problem-code.3: ${mirrored} mirrored code(s) checked against ${tavern.size} tavern + ${turn.size} turn + ${game.size} game declared, ${failures.length} undeclared`,
  );
  assert.deepEqual(failures, [], "a client that classifies a code nobody declares has an unreachable branch");
});

test("problem-code.4: no browser-contract handler catches and decides nothing", (t) => {
  const failures = [];
  let catches = 0;
  let causeDropping = 0;
  for (const file of ALL_HANDLERS) {
    const sourceFile = sourceOf(file);
    walk(sourceFile, (node) => {
      if (ts.isCatchClause(node)) catches += 1;
    });
    causeDropping += causeDroppingCatches(file).length;
    for (const finding of undecidedCatches(file))
      failures.push(`${finding.line} catch discards its cause and decides nothing: ${JSON.stringify(finding.body)}`);
  }
  t.diagnostic(
    `problem-code.4: ${catches} catch clause(s) in ${ALL_HANDLERS.length} handler(s), ${failures.length} deciding nothing, ${causeDropping} deciding an outcome without naming the cause`,
  );
  assert.deepEqual(failures, [], "a catch that decides nothing loses the failure entirely");
});

test("problem-code.5: the authorities and the sender signatures are read, not assumed", (t) => {
  const { tavern, turn, game, transport } = authorities();
  // The count is the premise of "the reader really read the union", nothing more: the rewind's four
  // refusals moved it from 44 to 48, the world book's own edit refusals moved it 48 to 51, the
  // edit's two moved it 51 to 53, the card export's one (companion_card_too_large) moved it
  // 53 to 54, the delete's three moved it 54 to 57, the PNG card's own refusal
  // (companion_card_image_absent, the picture-less export) moved it 57 to 58, the edit's own
  // greeting refusal (chat_edit_opening_retained, when a companion's reply became editable) moved
  // it 58 to 59, and the avatar upload's two (companion_avatar_too_large, the picture over the
  // avatar module's own ceiling, and companion_avatar_malformed, bytes that are not a complete
  // PNG) moved it 59 to 61, and the chat-management rename/archive/trash working on any Chat of the
  // partition rather than only the mounted one moved it 61 to 62 (`chat_not_found`, the handle that
  // names no Chat), and the greeting the Chat opened on becoming editable in place moved it 62 to
  // 61 (no `chat_edit_opening_retained`) - and it still fails the moment the reader stops seeing a
  // member.
  assert.equal(tavern.size, 61, `the tavern problem union should have 61 members, read ${tavern.size}`);
  assert.equal(game.size, 23, `the game problem union should have 23 members, read ${game.size}`);
  assert.equal(turn.size, 4, `the turn's problemCode union should have 4 members, read ${turn.size}`);
  assert.deepEqual([...transport], ["payload_too_large"], "the transport extra is the ProblemCode alias literal");
  const arity = codeArity();
  for (const [callee, index] of Object.entries(EXPECTED_CODE_ARITY)) {
    assert.equal(arity.get(callee), index, `${callee}'s code parameter moved; the scan would silently narrow`);
  }
  t.diagnostic(
    `problem-code.5: derived ${tavern.size} tavern, ${turn.size} turn, ${game.size} game, ${transport.size} transport code(s); senders ${[...arity.entries()].map(([name, index]) => `${name}#${index}`).join(" ")}`,
  );
});

test("problem-code.6 (mutation): an invented code and a catch that decides nothing both fail", (t) => {
  const invented = [
    "export function problemFor(error: unknown): string {",
    "  if (error instanceof Error && error.message === 'nope') return 'gate_invented_code';",
    "  return 'invalid_request';",
    "}",
    "",
    "export function handle(request: unknown): void {",
    "  try {",
    "    void request;",
    "  } catch (error) {",
    "    void 0;",
    "  }",
    "}",
  ].join("\n");
  const file = "host/src/gate-mutation.ts";
  const { tavern, transport } = authorities();
  const allowed = new Set([...tavern, ...transport]);

  const sourceFile = ts.createSourceFile(file, invented, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const returned = [];
  walk(sourceFile, (node) => {
    if (ts.isReturnStatement(node) && node.expression !== undefined && ts.isStringLiteral(node.expression))
      returned.push(node.expression.text);
  });
  assert.deepEqual(returned, ["gate_invented_code", "invalid_request"]);
  assert.deepEqual(
    returned.filter((code) => !allowed.has(code)),
    ["gate_invented_code"],
    "an invented code is outside the declared set",
  );

  const tempFile = "host/src/gate-mutation.ts";
  const { undecided, causeDropping } = catchesIn(invented, tempFile);
  assert.deepEqual(
    undecided.map((finding) => finding.line),
    ["gate-mutation.ts:9"],
    "a catch whose body decides nothing is the swallowing shape",
  );
  assert.deepEqual(causeDropping, ["gate-mutation.ts:9"]);
  t.diagnostic("problem-code.6: invented code at :2, catch that decides nothing at gate-mutation.ts:9");
});

/**
 * The two ways a mirror can drift from the derived authority, by code: a declared code the
 * mirror does not know (a typed refusal the client reads as protocol corruption), and a
 * code the mirror knows that no tavern route declares (unreachable branch). Pure, so the
 * mutation half of `problem-code.7` exercises the same comparison the gate asserts.
 */
export function codeSetDrift(where, mirrored, authority) {
  return [
    ...[...authority]
      .filter((code) => !mirrored.has(code))
      .map((code) => `${where} does not recognise declared code ${JSON.stringify(code)}`),
    ...[...mirrored]
      .filter((code) => !authority.has(code))
      .map((code) => `${where} recognises a code no tavern route declares ${JSON.stringify(code)}`),
  ];
}

/** The mirror's declared vocabulary, as a set, with the source path a finding names. */
function mirrorVocabulary(file, authority) {
  const entries = literalsInDeclaration(file, "PROBLEM_CODES");
  const where = file.replace(/\\/gu, "/").split("/dialogue-web/").pop();
  const mirrored = new Set(entries.map((entry) => entry.value));
  return { where, size: mirrored.size, findings: codeSetDrift(where, mirrored, authority) };
}

test("problem-code.7: every client mirror IS the declared set, not a stale subset of it", (t) => {
  const { tavern, transport } = authorities();
  const authority = new Set([...tavern, ...transport]);
  const failures = [];
  let mirrored = 0;
  for (const file of CLIENT_MIRRORS) {
    const vocabulary = mirrorVocabulary(file, authority);
    mirrored += vocabulary.size;
    failures.push(...vocabulary.findings);
  }
  t.diagnostic(
    `problem-code.7: ${mirrored} mirrored code(s) across ${CLIENT_MIRRORS.length} mirror(s) checked for equality against ${authority.size} declared (${tavern.size} tavern + ${transport.size} transport), ${failures.length} drifted`,
  );
  assert.deepEqual(
    failures,
    [],
    "a mirror that does not know a declared code reads that typed refusal as protocol corruption",
  );

  // The comparison itself, exercised on a vocabulary one member short and on one that
  // invents a member: a future edit that turns this back into a subset check fails here
  // instead of passing quietly on the drift it is here to catch.
  const short = new Set([...authority].filter((code) => code !== "payload_too_large"));
  assert.deepEqual(codeSetDrift("mutation.ts", short, authority), [
    'mutation.ts does not recognise declared code "payload_too_large"',
  ]);
  assert.deepEqual(codeSetDrift("mutation.ts", new Set([...authority, "invented_code"]), authority), [
    'mutation.ts recognises a code no tavern route declares "invented_code"',
  ]);
});
