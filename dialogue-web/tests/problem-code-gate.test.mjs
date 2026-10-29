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
 * `problem-code.8` adds the direction none of the above had. Naming a code is not telling the
 * player what happened: every member of the tavern union was declared by the contract, mirrored by
 * both clients, and fourteen of them were still rendered as "GameBuddy reported an internal
 * error" - so a stale draft, a busy turn and an oversized avatar all reached the player as a
 * system fault. The rule reads the union from the contract, drives each member through the real
 * `composedProblemView` in both catalogues, and fails the internal-error sentence for any member,
 * which is the assertion that would have caught the gap.
 *
 * `problem-code.9` and `problem-code.10` are the same pair for the second contract the composed
 * shell serves, `game_browser_api/v1`. `.8` could not see that surface at all: it drives the tavern
 * union through a `TavernProblemError`, and the game client's own twenty-three codes arrive as a
 * `ComposedReferenceGameProblemError`. Nine of them had a tavern sentence (the codes the two unions
 * share) and every other one reached the player as the internal-error line. `.9` pins the game
 * client's `GAME_PROBLEM_CODES` mirror to EQUALITY with the contract's union - the browser cannot
 * import the Host package, so the gate is what holds the copy honest - and `.10` drives every
 * member through the real view in both catalogues, failing the internal-error reading for any of
 * them.
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
 *
 * `problem-code.11` is the other direction of the same honesty, for one surface. The reviewed
 * card import's three routes caught every failure of their service and answered it with the
 * code that means "the fields you submitted cannot be accepted" - a storage failure, a runtime
 * outage and a bug inside the service all reached the player as a detailed accusation of a form
 * they never sent, and the cause was gone. Every code involved was declared and had its own
 * sentence; what was wrong was which code a failure chose. So this rule pins the pairing in both
 * catalogues: the request-shaped refusals read as the import form being refused, and the Host's
 * own failures read as the service sentence - and the two can never be the same words.
 *
 * `problem-code.12` closes the blind spot `.8`-`.11` all share. Every rule above drives
 * `composedProblemView` - the composed CHAT pane's view - and none of them ever looked at the
 * management surface, whose panels word a refused save with `problemTextWithCode` instead. That
 * mapper appended the server's code in parentheses, so a player who saved a World Info entry over
 * a stale revision read "Save failed. (world_info_revision_conflict)" while this gate reported
 * zero violations: it was certifying a mapper the management surface never calls. `.12` drives
 * every declared code through the real management mapper in both catalogues and fails any
 * parenthesised code-shaped token in the string the player is handed - the shape the old
 * concatenation produced - with the developer half (`problemCodeFor`) asserted beside it so the
 * code is not simply lost.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ComposedReferenceGameProblemError } from "../src/composed-reference-game-browser-api.ts";
import { composedProblemView, problemTextWithCode } from "../src/composed-problem-view.ts";
import { messages } from "../src/i18n.ts";
import { problemCodeFor } from "../src/management-pipeline-api.ts";
import { TavernProblemError } from "../src/reference-pipeline-api.ts";

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

/** The composed game client mirrors the game contract's own problem union. */
const GAME_CLIENT = join(WEB, "composed-reference-game-browser-api.ts");

/**
 * The management surface's own mapper module. `problem-code.12` reads it two ways: it drives
 * `problemTextWithCode` for every declared code, and it scans the module's own string builders for
 * one that reads a `.code`.
 *
 * The mapper lives in the problem catalogue, not in the wire contract: a contract may not import a UI
 * module (`.dependency-cruiser.dialogue-web.cjs`, `no-contract-imports-ui`), so moving the wording here
 * was the fix. Both modules are scanned - the contract still carries `problemCodeFor`, and a second
 * mapper growing beside it would be the same defect.
 */
const MANAGEMENT_MODULES = [join(WEB, "composed-problem-view.ts"), join(WEB, "management-pipeline-api.ts")];

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
  // The composed game client's own mirror is `.3`-shaped too (a game code it invents is
  // unreachable), and `problem-code.9` holds it to EQUALITY so it cannot be a stale subset.
  for (const entry of literalsInDeclaration(GAME_CLIENT, "GAME_PROBLEM_CODES")) {
    mirrored += 1;
    if (!game.has(entry.value))
      failures.push(`${entry.where} mirrors undeclared game code ${JSON.stringify(entry.value)}`);
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
  // 61 (no `chat_edit_opening_retained`), and retiring `chat_edit_not_player_message` - the edit guard's
  // unreachable row shape, not a refusal a player can meet - moved it 61 to 60, and the companion
  // removal's own refusal (companion_delete_in_play, the companion whose Chats are the mounted
  // conversation) moved it 60 to 61, and the directive save that would re-pin the Chats of a
  // companion who is answering right now (character_voice_turn_active) moved it 61 to 62. The
  // player's own Stardew settings save joining the game union
  // (stardew_settings_revision_conflict, a record that moved under the writer) moved the game
  // count 23 to 24, and discarding one variant of a reply refuses the last one by name
  // (chat_swipe_last_variant, so a reply can never end with no text) moved the tavern count
  // 62 to 63. It still fails the moment the reader stops seeing a member.
  assert.equal(tavern.size, 63, `the tavern problem union should have 63 members, read ${tavern.size}`);
  assert.equal(game.size, 24, `the game problem union should have 24 members, read ${game.size}`);
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
export function codeSetDrift(where, mirrored, authority, noun = "tavern route") {
  return [
    ...[...authority]
      .filter((code) => !mirrored.has(code))
      .map((code) => `${where} does not recognise declared code ${JSON.stringify(code)}`),
    ...[...mirrored]
      .filter((code) => !authority.has(code))
      .map((code) => `${where} recognises a code no ${noun} declares ${JSON.stringify(code)}`),
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

/**
 * A wire problem carrying one code, in the shape the client raises for a validated refusal.
 * `retryable` is a field the class carries and the code does not, so both readings appear below.
 */
function problemFor(code, retryable = false) {
  return new TavernProblemError({
    type: "about:blank",
    title: "Refused",
    status: 409,
    code,
    requestId: "A".repeat(22),
    retryable,
  });
}

test("problem-code.8: every declared code reaches the player as its own sentence, never as an internal error", (t) => {
  // The measured defect this rule exists for: the contract declared 61 codes, the view named 14,
  // and the other 47 - `selection_conflict`, `turn_busy`, `dialogue_busy`, `connection_not_ready`,
  // `companion_avatar_too_large`, `world_info_revision_conflict` and 41 more - arrived as
  // "GameBuddy reported an internal error", i.e. as a system fault rather than as the business
  // refusal they are. Declaring a code and mirroring it (problem-code.1/.7) says nothing about
  // whether the player is told what happened; this rule is that missing direction.
  const { tavern, transport } = authorities();
  const declared = [...new Set([...tavern, ...transport])].sort();
  const failures = [];
  const families = new Map();
  let internalReadings = 0;
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    for (const code of declared) {
      const view = composedProblemView(problemFor(code), labels);
      // The detail is the sentence: several families legitimately share a title ("Unable to read
      // chat" is the heading of the internal, reconciliation, retryable and route sentences), and
      // what told the player they had hit a system fault was the detail naming a raw code.
      const internalDetails = [
        labels.problemInternalErrorDetail.replace("{{code}}", code),
        labels.problemInternalErrorCauseDetail
          .replace("{{code}}", code)
          .replace("{{cause}}", labels.problemInternalErrorNoCode),
      ];
      if (internalDetails.includes(view.detail)) internalReadings += 1;
      if (view.kind !== "problem" || view.title.length === 0 || view.detail.length === 0)
        failures.push(`${locale} ${code} has no sentence`);
      // A code is contract vocabulary; the sentence may never print it back at the player.
      if (view.title.includes(code) || view.detail.includes(code))
        failures.push(`${locale} ${code} prints the raw code`);
      // The sentence belongs to the code, not to the `retryable` flag beside it: the same refusal
      // reads the same way whether or not the Host offers a retry.
      const retried = composedProblemView(problemFor(code, true), labels);
      if (retried.title !== view.title || retried.detail !== view.detail)
        failures.push(`${locale} ${code} reads differently when the refusal is retryable`);
      if (locale === "en") {
        const sentence = `${view.title}\n${view.detail}`;
        families.set(sentence, [...(families.get(sentence) ?? []), code]);
      }
    }
  }
  const groups = [...families.entries()].sort((left, right) => right[1].length - left[1].length);
  for (const [, codes] of groups)
    t.diagnostic(`problem-code.8 family (${codes.length}): ${codes.join(", ")}`);
  t.diagnostic(
    `problem-code.8: ${declared.length} declared code(s) through the real view in 2 catalogues, ${groups.length} sentence family/families, ${internalReadings} internal-error reading(s), ${failures.length} violation(s)`,
  );
  assert.equal(
    internalReadings,
    0,
    "a declared code is a refusal the player can act on; showing it as an internal error is the dishonesty this rule exists for",
  );
  assert.deepEqual(failures, [], "every declared code must reach the player as its own sentence");
});

/**
 * A code-shaped token in prose: `world_info_revision_conflict`, `draft_conflict`, `payload_too_large`.
 * Every declared code matches it, and none of the catalogue's sentences should.
 */
const CODE_SHAPED_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;

/**
 * Every string this source BUILDS (a `+` with a string operand, or a template literal) that reads a
 * `.code` on the way. This is the shape the defect had, kept as its own detector so the rule can
 * fail on the module's own text and not only on the values it happens to produce for the codes we
 * remembered to drive.
 */
export function codeInStringBuildersIn(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const builds = (node) =>
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isTemplateExpression(node);
  walk(sourceFile, (node) => {
    if (!builds(node)) return;
    const own = [];
    walk(node, (inner) => {
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === "code") own.push(inner);
    });
    if (own.length > 0)
      found.push(
        `${lineAt(own[0], sourceFile, fileName)} builds a string from \`.code\`: ${node.getText(sourceFile).slice(0, 120)}`,
      );
  });
  return found;
}

function codeInStringBuilders(file) {
  return codeInStringBuildersIn(readFileSync(file, "utf8"), file);
}

test("problem-code.12: the management mapper words a code as a sentence too, and never prints it", (t) => {
  // The blind spot this closes: `.8` drives `composedProblemView`, which is the CHAT pane's view.
  // The management surface's panels call `problemTextWithCode` instead - and that mapper appended
  // the server's code in parentheses. Every rule above passed while a player reading a refused
  // World Info save saw "Save failed. (world_info_revision_conflict)", because the gate certified
  // a mapper no management panel called.
  const labels_ = messages;
  const { tavern, transport } = authorities();
  const declared = [...new Set([...tavern, ...transport])].sort();
  const failures = [];
  const fallback = "That change was not saved.";
  let sentenced = 0;
  for (const locale of ["en", "zh-CN"]) {
    const labels = labels_(locale);
    for (const code of declared) {
      const error = problemFor(code);
      const player = problemTextWithCode(fallback, error, labels);
      sentenced += 1;
      // The developer half still names it: moving the code out of the sentence must not lose it.
      if (problemCodeFor(error) !== code) failures.push(`problemCodeFor(${code}) lost the code`);
      if (player.length === 0) failures.push(`${locale} ${code} has no sentence`);
      // The strong half, in the shape the defect actually took: the code in parentheses.
      if (player.includes(`(${code})`)) failures.push(`${locale} ${code} is printed as a parenthesised code`);
      // ... and in the general shape, so a future mapper that formats it differently still fails.
      const leaked = [...(player.match(CODE_SHAPED_TOKEN) ?? [])].filter(
        (token) => token === code || declared.includes(token),
      );
      if (leaked.length > 0) failures.push(`${locale} ${code} prints the contract token ${leaked.join(", ")}`);
      // A declared code is a refusal the player can act on: the sentence is the catalogue's, not
      // the caller's generic fallback. `draft_conflict` and every family member must differ.
      if (player === fallback) failures.push(`${locale} ${code} collapsed into the caller's fallback`);
    }
  }

  // The other direction: the module's own text. A mapper that builds a string out of `.code` is
  // the defect regardless of which codes the loops above happened to drive.
  const builders = MANAGEMENT_MODULES.flatMap((file) => codeInStringBuilders(file));
  failures.push(...builders);

  t.diagnostic(
    `problem-code.12: ${sentenced} management sentence(s) from ${declared.length} declared code(s) in 2 catalogues, ${builders.length} string builder(s) reading .code across ${MANAGEMENT_MODULES.length} mapper module(s), ${failures.length} violation(s)`,
  );
  for (const failure of failures.slice(0, 8)) t.diagnostic(`problem-code.12 violation: ${failure}`);
  assert.deepEqual(
    failures,
    [],
    "a code is contract vocabulary: the management mapper must word it, and must never print it back at the player",
  );

  // A failure the catalogue has no words for keeps the caller's honest sentence - the fallback is
  // still a real path (an unmirrored code, an opaque protocol error), not dead code.
  const labels = labels_("en");
  assert.equal(problemTextWithCode(fallback, problemFor("gate_invented_code"), labels), fallback);
  assert.equal(problemTextWithCode(fallback, new Error("boom"), labels), fallback);

  // The detector itself, on the exact line the defect lived on: a mapper that appends the code. If
  // this stops reporting, the rule above has stopped seeing the shape it exists for.
  const injected = [
    "export function problemTextWithCode(base: string, error: unknown): string {",
    "  return error instanceof TavernProblemError ? `${base} (${error.code})` : base;",
    "}",
  ].join("\n");
  const probe = join(WEB, "gate-mutation.ts");
  const report = codeInStringBuildersIn(injected, probe);
  assert.deepEqual(
    report.map((entry) => entry.split(" builds a string")[0]),
    ["gate-mutation.ts:2"],
    "the detector must report the concatenation it forbids",
  );
  t.diagnostic(`problem-code.12 mutation: ${report.join(" | ")}`);
});

/**
 * A wire problem carrying one game code, in the shape the composed game client raises for a
 * validated refusal.
 */
function gameProblemFor(code, status = 409, cause = null) {
  return new ComposedReferenceGameProblemError(code, status, null, cause);
}

test("problem-code.9: the composed game client's mirror IS the game contract's union", (t) => {
  // The direction `problem-code.7` holds the tavern mirrors to, for the other contract. The bundle
  // cannot import the Host package, so `GAME_PROBLEM_CODES` is the browser's only copy of the game
  // union - and a copy that silently misses a member is how a typed refusal reads as protocol
  // corruption, or (here) as an internal error.
  const { game } = authorities();
  const entries = literalsInDeclaration(GAME_CLIENT, "GAME_PROBLEM_CODES");
  const mirrored = new Set(entries.map((entry) => entry.value));
  const findings = codeSetDrift("composed-reference-game-browser-api.ts", mirrored, game, "game route");
  t.diagnostic(
    `problem-code.9: ${mirrored.size} mirrored game code(s) checked for equality against ${game.size} declared, ${findings.length} drifted`,
  );
  assert.deepEqual(
    findings,
    [],
    "a game mirror that does not know a declared code cannot give that refusal the player's own words",
  );

  // The comparison itself: one member short and one invented both fail, so a future edit that turns
  // this back into a subset check fails here instead of passing on the drift it exists to catch.
  assert.deepEqual(
    codeSetDrift(
      "mutation.ts",
      new Set([...game].filter((code) => code !== "state_unavailable")),
      game,
      "game route",
    ),
    ['mutation.ts does not recognise declared code "state_unavailable"'],
  );
  assert.deepEqual(codeSetDrift("mutation.ts", new Set([...game, "invented_code"]), game, "game route"), [
    'mutation.ts recognises a code no game route declares "invented_code"',
  ]);
});

test("problem-code.10: every declared game code reaches the player as its own sentence", (t) => {
  // The measured defect this rule exists for: the game contract declares twenty-three codes, the
  // composed view named nine of them by reusing a tavern sentence, and the rest arrived as
  // "GameBuddy reported an internal error" - as a system fault rather than as the game refusal they
  // are. `problem-code.8` is the same rule for the tavern union; this is its second contract.
  const { game } = authorities();
  const declared = [...game].sort();
  const failures = [];
  const families = new Map();
  let internalReadings = 0;
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    for (const code of declared) {
      const view = composedProblemView(gameProblemFor(code), labels);
      const internalDetails = [
        labels.problemInternalErrorDetail.replace("{{code}}", code),
        labels.problemInternalErrorCauseDetail
          .replace("{{code}}", code)
          .replace("{{cause}}", labels.problemInternalErrorNoCode),
      ];
      if (internalDetails.includes(view.detail)) internalReadings += 1;
      if (view.kind !== "problem" || view.title.length === 0 || view.detail.length === 0)
        failures.push(`${locale} ${code} has no sentence`);
      // A code is contract vocabulary; the sentence may never print it back at the player.
      if (view.title.includes(code) || view.detail.includes(code))
        failures.push(`${locale} ${code} prints the raw code`);
      // The sentence belongs to the code, not to the `retryable` flag beside it.
      const retried = composedProblemView(gameProblemFor(code, 503), labels);
      if (retried.title !== view.title || retried.detail !== view.detail)
        failures.push(`${locale} ${code} reads differently when the refusal is retryable`);
      if (locale === "en") {
        const sentence = `${view.title}\n${view.detail}`;
        families.set(sentence, [...(families.get(sentence) ?? []), code]);
      }
    }
  }
  const groups = [...families.entries()].sort((left, right) => right[1].length - left[1].length);
  for (const [, codes] of groups)
    t.diagnostic(`problem-code.10 family (${codes.length}): ${codes.join(", ")}`);
  t.diagnostic(
    `problem-code.10: ${declared.length} declared game code(s) through the real view in 2 catalogues, ${groups.length} sentence family/families, ${internalReadings} internal-error reading(s), ${failures.length} violation(s)`,
  );
  assert.equal(
    internalReadings,
    0,
    "a declared game code is a refusal the player can act on; showing it as an internal error is the dishonesty this rule exists for",
  );
  assert.deepEqual(failures, [], "every declared game code must reach the player as its own sentence");

  // The one game sentence that carries producer vocabulary: `game_unavailable` is the wrapper the
  // Host answers with when a step of the game's lifecycle failed, and the bounded `stardew_*` cause
  // it registers is what names the step. That diagnostic must survive - and the code itself must
  // not, which is what separates the sentence from the internal-error line it replaced.
  const labels = messages("en");
  const diagnosed = composedProblemView(
    gameProblemFor("game_unavailable", 409, "stardew_private_launch_admission_failed"),
    labels,
  );
  t.diagnostic(`problem-code.10 diagnostic: ${diagnosed.title} / ${diagnosed.detail}`);
  assert.ok(
    diagnosed.detail.includes("stardew_private_launch_admission_failed"),
    "the bounded cause the Host registered is the only thing that names which step failed",
  );
  assert.equal(diagnosed.detail.includes("game_unavailable"), false);

  // The mutation half: a game code with no entry in the map falls through to the internal-error
  // sentence, which is the reading the assertion above fails on.
  const undeclared = composedProblemView(gameProblemFor("gate_invented_game_code"), labels);
  assert.equal(
    undeclared.detail,
    labels.problemInternalErrorDetail.replace("{{code}}", "gate_invented_game_code"),
    "an undeclared game code is the shape a missing sentence takes",
  );
});

/**
 * The reviewed-card import's codes, and the two readings they must keep apart.
 *
 * The measured defect: the three import routes caught every failure of their service and answered
 * it with the code that means "the fields you submitted cannot be accepted", so a storage failure,
 * a runtime outage or a bug inside the service reached the player as a detailed accusation of a
 * form they never sent - and the cause was discarded on the way. The codes were all declared and
 * all had their own sentence; what was wrong was which one a failure chose. This pins the pairing,
 * in both catalogues, so a route that reaches for the accusing code on a Host failure fails here.
 */
test("problem-code.11: an import the Host failed on never reads as an import the player sent wrong", (t) => {
  const reading = (labels, code) => {
    const view = composedProblemView(problemFor(code), labels);
    return `${view.title}\n${view.detail}`;
  };
  const pairings = [];
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const formRefused = `${labels.problemImportFormInvalidTitle}\n${labels.problemImportFormInvalidDetail}`;
    const hostFailed = `${labels.problemServiceUnavailableTitle}\n${labels.problemServiceUnavailableDetail}`;
    const namesNothing = `${labels.problemNoSuchItemTitle}\n${labels.problemNoSuchItemDetail}`;
    // The request-shaped refusals: the review or the confirm carried nothing the import accepts.
    for (const code of ["character_import_review_invalid", "character_import_confirm_invalid"])
      assert.equal(reading(labels, code), formRefused, `${locale}: ${code} is a refusal of the request`);
    // The import id names nothing any more - gone, not refused.
    assert.equal(reading(labels, "character_import_not_found"), namesNothing, `${locale}: a gone import id`);
    // The Host's own failures: the store, the runtime, and the service behind the route.
    for (const code of ["storage_unavailable", "runtime_unavailable"])
      assert.equal(reading(labels, code), hostFailed, `${locale}: ${code} is the Host's own failure`);
    // The whole point: the two readings are distinct sentences in the language the player reads.
    assert.notEqual(hostFailed, formRefused, `${locale}: a Host failure and a refused form must not read alike`);
    if (locale === "en")
      pairings.push(`refused="${formRefused.replace("\n", " / ")}" host="${hostFailed.replace("\n", " / ")}"`);
  }
  t.diagnostic(`problem-code.11: ${pairings.join("; ")}`);
});
