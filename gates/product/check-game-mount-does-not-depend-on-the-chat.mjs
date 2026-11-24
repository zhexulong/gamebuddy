#!/usr/bin/env node
/**
 * A Chat half that cannot be read is not a Game that cannot mount - the direction the Chat-side gate does
 * not keep.
 *
 * WHY THIS EXISTS. `gates/product/check-chat-reads-the-chat-route.mjs` keeps one direction of the two
 * surfaces' isolation: a Game projection the Host cannot produce must not take the conversation with it.
 * The other direction has no gate. It has two STRUCTURAL facts, and both were wrong at once:
 *
 *   - the root schema (`host/src/composed-browser-contract/index.ts`) declared `chat` REQUIRED beside a
 *     `game` that is `Type.Optional(...)`, so a mount whose Chat half could not be read was a root the
 *     broker refuses - the Game surface was never answered at all;
 *   - the module that renders the shell (`ComposedReferenceGameApp.tsx:1287`) then did the same thing a
 *     second time: `{view.kind === "ready" && view.session.snapshot.chat !== null && (...)}` held the AppBar,
 *     the ready `<main className="app-main-content">` and `<GameSurface />` inside a condition on the Chat
 *     half. Fixing the schema alone would have changed nothing visible; fixing the shell alone would have
 *     left the root refused by the broker.
 *
 * `dialogue-web/tests/game-projection-failure-is-not-the-chats.spec.ts` measures the behaviour those two
 * facts produce. A journey proves the shell mounted for the root a stub answered; it cannot prove the
 * contract LETS the Host answer such a root, and it cannot see a second `chat !== null` added inside the
 * ready branch by a surface nobody has written yet. That is what this gate reads.
 *
 * WHAT NO COMPILER CAN SAY, which is why this gate exists beside the types. Optionality is expressible
 * (`Type.Optional`), but "the two halves must occupy the SAME optionality" is a relation between two
 * members of one schema, and a compiler checks neither member against the other. And nothing in a type
 * says which condition a JSX subtree hangs from: `<AppBar />` typechecks identically inside the ready
 * branch and inside `chat !== null && ...`, because the condition is a value and the subtree is a child.
 * The third reading is a debt rather than an invariant, and no compiler can say when a debt has expired.
 *
 * THE THREE READINGS, each printed with the population it examined:
 *
 *   1. CONTRACT PARITY. The root schema's `chat` and `game` must be the same kind of member: both
 *      required or both optional, and both answering the same non-projection shape. The two members are
 *      read out of the schema declaration itself (never a list here), printed with their line, their
 *      optionality and their text, and a disagreement is `root_half_optionality_differs` naming BOTH
 *      members and both shapes.
 *
 *   2. NO SHELL SUBJECT IS WITHHELD BY A CHAT-HALF CONDITION. The population is every module under
 *      `dialogue-web/src/components`, minus its tests: this gate parses them and derives two sets. The
 *      SHELL SUBJECTS are the elements that ARE the shell - the `<AppBar />`, the `<GameSurface />`, and
 *      the two containers the whole shell is drawn in (`className="tavern-app-shell"` and
 *      `className="app-main-content"`), declared once in `SHELL_SUBJECTS` because they are the shell's own
 *      vocabulary. The CHAT-HALF FACTS are derived from the code: a member named `chat` or `session` (the
 *      shell view's `session` is `createReferencePipelineSession(root.chat)`, so its nullity IS the Chat
 *      half's presence), and any variable whose initializer reaches one of them without a fallback that
 *      could answer on its own (`a ?? null` is a Chat-half fact, `chatToken ?? gameToken` is neither).
 *      Every comparison between a Chat-half fact and a value is printed with its file:line - that is the
 *      population - and a CONDITION built out of one (`if (...)`, `cond ? ... : ...`, `cond && <X/>`) is a
 *      violation when a shell subject is drawn inside what it withholds:
 *      `game_mount_is_gated_on_the_chat_half`, naming the condition's own site.
 *
 *   3. PLATFORM ROUTE PURITY, as DECLARED DEBT. Four public platform concerns - the provider connection,
 *      the UI locale, the appearance and the session's CSRF token - are public platform facts that today
 *      are reachable only through the Chat half: `/api/tavern/v1/settings/connection*`,
 *      `/api/tavern/v1/settings/ui-language`, `/api/tavern/v1/settings/appearance` and `snapshot.csrfToken`.
 *      Moving them is a separate unit, so each is a row in `PLATFORM_DEBT` with an OWNER and an EXPIRY, and
 *      the gate holds the row current in both directions: a row whose declared reach is no longer in the
 *      tree is `platform_debt_reach_gone` (the row is stale and its owner must rewrite it), and a
 *      `/api/platform/v1/...` caller in the browser expires the row it serves - `platform_debt_expired`
 *      naming the row, the site and the owner, so the debt cannot outlive its subject by one commit. A
 *      platform route no row names is `platform_route_unjudged`, because a new public route with no concern
 *      on record is the one case this reading must not pass over.
 *
 * ZERO IS NOT GREEN. Six populations can come back empty and each of them BLOCKS rather than passing,
 * because a reading that lost its subject cannot tell a clean tree from a renamed one:
 *
 *   root_schema_unreadable            the root schema or its two members could not be read
 *   shell_modules_empty               no module under the shell's directory
 *   shell_subjects_not_found          no `<AppBar />`, `<GameSurface />` or shell container in any module
 *   chat_half_conditions_empty        no condition anywhere reaches the Chat half
 *   platform_debt_rows_empty          no declared debt row
 *   platform_reaches_not_found        no declared reach (route literal or `snapshot.csrfToken`) in the tree
 *
 * Usage:
 *   node gates/product/check-game-mount-does-not-depend-on-the-chat.mjs              # the verdict; exit 1 on a violation, 2 blocked
 *   node gates/product/check-game-mount-does-not-depend-on-the-chat.mjs --json       # the same reading, machine-readable
 *   node gates/product/check-game-mount-does-not-depend-on-the-chat.mjs --root <dir> # the gate's own fixture
 *
 * red-proof: history  `chat: TavernStateSnapshotV1Schema` at HEAD's line 160 (the member before the
 *   PLATFORMSPLIT lane) -> `root_half_optionality_differs`, naming `chat` as required and `game` as
 *   optional with both shapes (`.tmp/lane-gamemount/head/`)
 * red-proof: history  `{view.kind === "ready" && view.session.snapshot.chat !== null && (` at HEAD's
 *   `ComposedReferenceGameApp.tsx:1287` -> `game_mount_is_gated_on_the_chat_half` naming that line and the
 *   AppBar, the ready region and the Game surface it withholds (`.tmp/lane-gamemount/head/`)
 * red-proof: inject   a `/api/platform/v1/settings/connection` read in `management-pipeline-api.ts` ->
 *   `platform_debt_expired:connection` naming the row's owner, and a `/api/platform/v1/status` read no row
 *   names -> `platform_route_unjudged` (gates/product/check-game-mount-does-not-depend-on-the-chat.test.mjs)
 * red-proof: inject   a shell condition on a Chat-half fact (`mountedChat !== null && (<AppBar ... />)`) ->
 *   `game_mount_is_gated_on_the_chat_half`; the same condition over a fallback that the Game half also
 *   answers (`chatToken ?? gameToken`) is not a Chat-half fact and stays green
 *   (gates/product/check-game-mount-does-not-depend-on-the-chat.test.mjs)
 */

export const gateDeclaration = {
  id: "check-game-mount-does-not-depend-on-the-chat",
  domain: "product",
  tier: "l0",
  kind: "contract",
};

// source-invariant: no compiler relates two members of one schema to each other, and none says which
//   condition a JSX subtree hangs from - `<AppBar />` typechecks identically inside the ready branch and
//   inside `chat !== null && ...` - so this gate reads the root schema's two halves for the same
//   optionality and resolves, per module, whether a shell subject is drawn inside a condition on the Chat
//   half. The third reading is debt: it can only expire against a caller in the tree.
// source-expiry: when a Chat fault and a Game fault can no longer differ in what the browser can mount (a
//   mount that always has both halves, or a shell that no longer renders either half conditionally), the
//   first two readings have no subject; when every concern in `PLATFORM_DEBT` has moved to
//   `/api/platform/v1/*` and the table is empty, the third has none. Retire the reading with that change
//   rather than keeping it green over nothing.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { blockedOnEmptyPopulation } from "../../tools/lib/gate-population.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import { sourceModules } from "./check-chat-reads-the-chat-route.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** The browser tree, and the directory the shell is rendered from: this gate's two scopes. */
export const WEB_SOURCES = "dialogue-web/src";
export const SHELL_COMPONENTS = "dialogue-web/src/components";

/** The root schema's declaration and the two members that must answer the same question. */
export const ROOT_SCHEMA = "host/src/composed-browser-contract/index.ts";
export const ROOT_SCHEMA_DECLARATION = "ComposedReferenceGameBrowserRootV1Schema";
export const HALVES = Object.freeze(["chat", "game"]);

/**
 * The members the Chat half publishes into the shell's view.
 *
 * `chat` is the contract's own member. `session` is the shell view's pipeline session, built by
 * `createReferencePipelineSession(root.chat)` in `composed-reference-game-view.ts` - its nullity is the
 * Chat half's presence, which is why a condition on it withholds exactly what a condition on `chat` does.
 */
export const CHAT_HALF_MEMBERS = Object.freeze(["chat", "session"]);

/** The elements that ARE the shell: the bar, the Game surface, and the two containers it is drawn in. */
export const SHELL_SUBJECTS = Object.freeze([
  { id: "app-bar", element: "AppBar" },
  { id: "game-surface", element: "GameSurface" },
  { id: "shell-root", className: "tavern-app-shell" },
  { id: "shell-region", className: "app-main-content" },
]);

/** The platform routes a moved concern would be read from. */
export const PLATFORM_ROUTE_PREFIX = "/api/platform/v1/";

/**
 * The public platform concerns that are reachable only through the Chat half, as declared debt.
 *
 * Each row is a unit of work that has not happened yet: the `owner` is what must be edited, the `expires`
 * is the commit that ends the row, `today` is the source text that must still be there (a route literal or
 * the Chat half's own token), and `platform` is the route whose arrival expires it. Moving a concern is a
 * separate change; this gate only refuses to let the debt go un-noticed in either direction.
 */
export const PLATFORM_DEBT = Object.freeze([
  Object.freeze({
    concern: "connection",
    owner: "dialogue-web/src/management-pipeline-api.ts (SettingsSurface's connection panel) and its Host route",
    expires: "when the browser reads /api/platform/v1/connection - delete this row in that commit",
    today: Object.freeze(["/api/tavern/v1/settings/connection", "/api/tavern/v1/settings/connections"]),
    platform: Object.freeze(["/api/platform/v1/connection"]),
  }),
  Object.freeze({
    concern: "locale",
    owner: "dialogue-web/src/management-pipeline-api.ts (SettingsSurface's UI language) and dialogue-web/src/i18n.ts",
    expires: "when the browser reads /api/platform/v1/locale - delete this row in that commit",
    today: Object.freeze(["/api/tavern/v1/settings/ui-language"]),
    platform: Object.freeze(["/api/platform/v1/locale"]),
  }),
  Object.freeze({
    concern: "appearance",
    owner:
      "dialogue-web/src/management-pipeline-api.ts (SettingsSurface's appearance) and dialogue-web/src/appearance.ts",
    expires: "when the browser reads /api/platform/v1/appearance - delete this row in that commit",
    today: Object.freeze(["/api/tavern/v1/settings/appearance"]),
    platform: Object.freeze(["/api/platform/v1/appearance"]),
  }),
  Object.freeze({
    concern: "csrf",
    owner: "the Tavern broker session (dialogue-web/src/components/use-composed-bootstrap.ts mints it)",
    expires: "when a platform session route answers the browser's CSRF token - delete this row in that commit",
    today: Object.freeze(["snapshot.csrfToken"]),
    platform: Object.freeze(["/api/platform/v1/session", "/api/platform/v1/csrf"]),
  }),
]);

const COMPARISON_OPERATORS = Object.freeze([
  "EqualsEqualsEqualsToken",
  "ExclamationEqualsEqualsToken",
  "EqualsEqualsToken",
  "ExclamationEqualsToken",
]);

/** The TypeScript parser the web workspace compiles with, so this gate reads the tree the build reads. */
const typescript = createRequire(join(REPOSITORY_ROOT, "dialogue-web", "package.json"))("typescript");

const lineOf = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
const textOf = (sourceFile, node) => node.getText(sourceFile).replace(/\s+/gu, " ");

/** Parentheses, `!`, `as` and `await` are spellings, not decisions: read through them. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      typescript.isParenthesizedExpression(current) ||
      typescript.isNonNullExpression(current) ||
      typescript.isAsExpression(current) ||
      typescript.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

const isNullish = (node) => {
  const inner = node === undefined ? undefined : unwrap(node);
  if (inner === undefined) return false;
  if (inner.kind === typescript.SyntaxKind.NullKeyword) return true;
  return typescript.isIdentifier(inner) && inner.text === "undefined";
};

/** Every name in a property chain, outermost first, or `null` when the expression is not a chain. */
function chainMemberNames(node) {
  const names = [];
  let current = unwrap(node);
  for (;;) {
    if (typescript.isPropertyAccessExpression(current)) {
      names.push(current.name.text);
      current = unwrap(current.expression);
      continue;
    }
    if (typescript.isElementAccessExpression(current)) {
      names.push(current.argumentExpression === undefined ? "" : current.argumentExpression.getText());
      current = unwrap(current.expression);
      continue;
    }
    break;
  }
  return typescript.isIdentifier(current) ? { root: current, names } : null;
}

/**
 * Whether an expression's VALUE is the Chat half's presence - the only shape a condition on it can withhold
 * a Game surface with.
 *
 * A chain counts when its own last member is one of `CHAT_HALF_MEMBERS` (`view.session.snapshot.chat`,
 * `current.session`), and NOT when the Chat half is merely somewhere inside it: `session.snapshot.selection`
 * is a value read through the Chat half, and a condition on it withholds a selection, not a Game surface.
 *
 * `a ?? null` keeps the presence (`null` is not an answer); `chatToken ?? gameToken` does not, because the
 * Game half can answer it alone. `&&`, `||`, `!`, a ternary and a comparison against a nullish literal
 * propagate it, because each is decided BY the Chat half's presence; a comparison against anything else
 * (`view.kind === "ready"`, `turn?.state === "cancelled"`) does not.
 */
function isChatHalfPresence(expression, facts) {
  if (expression === undefined) return false;
  const node = unwrap(expression);
  const chain = chainMemberNames(node);
  if (chain !== null) {
    if (CHAT_HALF_MEMBERS.includes(chain.names[0])) return true;
    return facts.get(chain.root.text) === true;
  }
  if (typescript.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === typescript.SyntaxKind.QuestionQuestionToken || kind === typescript.SyntaxKind.BarBarToken) {
      if (isChatHalfPresence(node.left, facts) && isNullish(node.right)) return true;
      return isChatHalfPresence(node.right, facts) && isNullish(node.left);
    }
    if (
      COMPARISON_OPERATORS.some((name) => typescript.SyntaxKind[name] === kind) &&
      (isNullish(node.left) || isNullish(node.right))
    ) {
      if (isChatHalfPresence(node.left, facts) && isNullish(node.right)) return true;
      return isChatHalfPresence(node.right, facts) && isNullish(node.left);
    }
    if (kind === typescript.SyntaxKind.AmpersandAmpersandToken)
      return isChatHalfPresence(node.left, facts) || isChatHalfPresence(node.right, facts);
    return false;
  }
  if (typescript.isConditionalExpression(node))
    return isChatHalfPresence(node.whenTrue, facts) || isChatHalfPresence(node.whenFalse, facts);
  if (typescript.isPrefixUnaryExpression(node) && node.operator === typescript.SyntaxKind.ExclamationToken)
    return isChatHalfPresence(node.operand, facts);
  return false;
}

/** The variables one module declares whose own value is the Chat half's presence, to a fixpoint. */
function chatHalfFacts(sourceFile) {
  const declared = new Map();
  const visit = (node) => {
    if (typescript.isVariableDeclaration(node) && typescript.isIdentifier(node.name))
      declared.set(node.name.text, node.initializer);
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  const facts = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [name, initializer] of declared) facts.set(name, isChatHalfPresence(initializer, facts));
  }
  return facts;
}

/**
 * The condition an expression is the TEST of, as `{ root, scope }`, or `null` when it is not one.
 *
 * `root` is the whole condition (`a && b` and notjust `b`), because that is the site a reader has to look
 * at; `scope` is the subtree the condition WITHHOLDS - the ternary, the `if`, or the `&&` chain that holds
 * the JSX child - which is where a shell subject would have to be to make this a violation.
 */
function conditionOf(expression) {
  let current = expression;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined || parent === null) return null;
    if (
      typescript.isParenthesizedExpression(parent) ||
      (typescript.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === typescript.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === typescript.SyntaxKind.BarBarToken)) ||
      (typescript.isPrefixUnaryExpression(parent) && parent.operator === typescript.SyntaxKind.ExclamationToken)
    ) {
      current = parent;
      continue;
    }
    if (typescript.isIfStatement(parent) && parent.expression === current) return { root: current, scope: parent };
    if (typescript.isConditionalExpression(parent) && parent.condition === current)
      return { root: current, scope: parent };
    if (typescript.isJsxExpression(parent) && parent.expression === current) return { root: current, scope: current };
    if (typescript.isWhileStatement(parent) && parent.expression === current) return { root: current, scope: parent };
    return null;
  }
}

/** The shell subject a JSX element IS, or `null` when the element is not one. */
function shellSubjectOf(node, sourceFile) {
  const opening = typescript.isJsxElement(node) ? node.openingElement : node;
  if (typescript.isIdentifier(opening.tagName)) {
    const subject = SHELL_SUBJECTS.find((entry) => entry.element === opening.tagName.text);
    if (subject !== undefined)
      return { id: subject.id, at: `${lineOf(sourceFile, node)} (${textOf(sourceFile, opening.tagName)})` };
  }
  for (const attribute of opening.attributes.properties) {
    if (!typescript.isJsxAttribute(attribute)) continue;
    if (attribute.name.getText(sourceFile) !== "className") continue;
    const initializer = attribute.initializer;
    if (initializer === undefined || !typescript.isStringLiteral(initializer)) continue;
    const subject = SHELL_SUBJECTS.find((entry) => entry.className === initializer.text);
    if (subject !== undefined) return { id: subject.id, at: `${lineOf(sourceFile, node)} (.${initializer.text})` };
  }
  return null;
}

/** Every shell subject drawn inside a subtree, with the line each is drawn on. */
function shellSubjectsIn(scope, sourceFile) {
  const found = [];
  const visit = (node) => {
    if (typescript.isJsxElement(node) || typescript.isJsxSelfClosingElement(node)) {
      const subject = shellSubjectOf(node, sourceFile);
      if (subject !== null) found.push(subject);
    }
    typescript.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** A quote short enough to read in a failure line, with the tail said rather than pasted. */
function clip(text) {
  return text.length <= 140 ? text : `${text.slice(0, 137)}...`;
}

const isComparison = (node) =>
  typescript.isBinaryExpression(node) &&
  COMPARISON_OPERATORS.some((name) => typescript.SyntaxKind[name] === node.operatorToken.kind) &&
  (isNullish(node.left) || isNullish(node.right));

/** Whether a child of this expression already IS the Chat half's presence, so this one is only its spelling. */
function hasPresenceChild(node, facts) {
  let found = false;
  typescript.forEachChild(node, (child) => {
    if (!found && isChatHalfPresence(child, facts)) found = true;
  });
  return found;
}

/**
 * Every condition and comparison in one module that tests the Chat half's presence.
 *
 * The POPULATION is the comparisons, each with its own file:line. The CONDITIONS are the guards those
 * comparisons are the test of, keyed by the condition's own position so one `a && b && <X/>` is one guard
 * carrying both tests rather than two - and each condition quotes only the tests that reached the Chat half, so
 * the failure names the test rather than pasting the subtree it withholds.
 */
function chatHalfSites(sourceFile) {
  const facts = chatHalfFacts(sourceFile);
  const comparisons = [];
  const guards = new Map();
  const remember = (node, test) => {
    const condition = conditionOf(node);
    if (condition === null) return;
    const key = condition.root.getStart(sourceFile);
    if (!guards.has(key))
      guards.set(key, {
        line: lineOf(sourceFile, condition.root),
        tests: [],
        subjects: shellSubjectsIn(condition.scope, sourceFile),
      });
    const guard = guards.get(key);
    if (!guard.tests.includes(test)) guard.tests.push(test);
  };
  const visit = (node) => {
    const comparison = isComparison(node) && isChatHalfPresence(node, facts);
    if (comparison) {
      const text = clip(textOf(sourceFile, node));
      comparisons.push({ line: lineOf(sourceFile, node), text });
      remember(node, text);
    } else if (isChatHalfPresence(node, facts) && !isComparison(node) && !hasPresenceChild(node, facts)) {
      remember(node, clip(textOf(sourceFile, node)));
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { comparisons, conditions: [...guards.values()] };
}

/** One module of the shell's tree, parsed, or the reason it could not be. */
function parseModule({ root, file }) {
  const source = readFileSync(join(root, file), "utf8");
  const sourceFile = typescript.createSourceFile(
    file,
    source,
    typescript.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics !== undefined && sourceFile.parseDiagnostics.length > 0)
    return { file, unparsed: `${file}: ${String(sourceFile.parseDiagnostics[0].messageText)}` };
  return { file, sourceFile };
}

/** The root schema's `chat` and `game`, read out of the declaration rather than from a list here. */
function rootHalves({ root }) {
  const path = join(root, ROOT_SCHEMA);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return { members: [], unreadable: `root_schema_unreadable: ${ROOT_SCHEMA} could not be read` };
  }
  const sourceFile = typescript.createSourceFile(
    ROOT_SCHEMA,
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  let literal = null;
  const visit = (node) => {
    if (literal !== null) return;
    if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.name.text === ROOT_SCHEMA_DECLARATION &&
      node.initializer !== undefined &&
      typescript.isCallExpression(node.initializer)
    ) {
      const first = node.initializer.arguments[0];
      if (first !== undefined && typescript.isObjectLiteralExpression(unwrap(first))) literal = unwrap(first);
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (literal === null)
    return {
      members: [],
      unreadable: `root_schema_unreadable: \`${ROOT_SCHEMA_DECLARATION}\` in ${ROOT_SCHEMA} is not an object literal`,
    };
  const members = [];
  for (const property of literal.properties) {
    if (!typescript.isPropertyAssignment(property)) continue;
    const name = property.name.getText(sourceFile);
    if (!HALVES.includes(name)) continue;
    const shape = textOf(sourceFile, property.initializer);
    members.push({
      name,
      line: lineOf(sourceFile, property),
      shape,
      optional: /^Type\.Optional\(/u.test(shape),
      nullable: shape.includes("Type.Null()"),
    });
  }
  return { members, unreadable: null };
}

const describeHalf = (member) =>
  `${member.optional ? "optional" : "REQUIRED"} at line ${member.line} (\`${member.shape}\`)`;

/** Reading 1: the two halves of the root schema are the same kind of member. */
export function checkRootHalfParity({ root = REPOSITORY_ROOT } = {}) {
  const reading = { scope: ROOT_SCHEMA, members: [], violations: [], blocked: null };
  const { members, unreadable } = rootHalves({ root });
  reading.members = members;
  if (unreadable !== null) return { ...reading, status: "blocked", blocked: unreadable };
  const missing = HALVES.filter((name) => !members.some((member) => member.name === name));
  if (members.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `root_schema_unreadable: ${ROOT_SCHEMA} declares none of ${HALVES.join(", ")}`,
    };
  for (const name of missing)
    reading.violations.push({
      code: "root_half_not_declared",
      at: `${ROOT_SCHEMA}`,
      detail: `the root schema declares no \`${name}\` member; the reader tells a half it could not read from a profile without it by the member's own presence`,
    });
  const chat = members.find((member) => member.name === "chat");
  const game = members.find((member) => member.name === "game");
  if (chat !== undefined && game !== undefined) {
    if (chat.optional !== game.optional)
      reading.violations.push({
        code: "root_half_optionality_differs",
        at: `${ROOT_SCHEMA}:${chat.line},${game.line}`,
        detail:
          `\`chat\` is ${describeHalf(chat)} while \`game\` is ${describeHalf(game)}; ` +
          "the two halves are peers, so a root that a missing Chat member refuses is a Game surface that cannot mount",
      });
    if (chat.nullable !== game.nullable)
      reading.violations.push({
        code: "root_half_nullability_differs",
        at: `${ROOT_SCHEMA}:${chat.line},${game.line}`,
        detail:
          `\`chat\` is ${describeHalf(chat)} while \`game\` is ${describeHalf(game)}; ` +
          "both members answer `null` for a profile that carries no such half, or the reader cannot tell the two non-projections apart",
      });
  }
  return { ...reading, status: reading.violations.length === 0 ? "passed" : "failed" };
}

/** Reading 2: no shell subject is drawn inside a condition on the Chat half. */
export function checkTheShellIsNotGatedOnTheChat({ root = REPOSITORY_ROOT, scope = SHELL_COMPONENTS } = {}) {
  const reading = {
    scope,
    population: 0,
    parsed: 0,
    comparisons: [],
    conditions: [],
    shellSubjects: [],
    violations: [],
    unparsed: [],
    blocked: null,
  };
  const modules = sourceModules({ root, web: scope });
  reading.population = modules.length;
  if (modules.length === 0)
    return { ...reading, status: "blocked", blocked: `shell_modules_empty: no module under ${scope}` };
  for (const file of modules) {
    const parsed = parseModule({ root, file });
    if (parsed.sourceFile === undefined) {
      reading.unparsed.push(parsed.unparsed);
      continue;
    }
    reading.parsed += 1;
    const sites = chatHalfSites(parsed.sourceFile);
    for (const comparison of sites.comparisons)
      reading.comparisons.push({ at: `${file}:${comparison.line}`, text: comparison.text });
    for (const condition of sites.conditions) {
      reading.conditions.push({
        at: `${file}:${condition.line}`,
        tests: condition.tests,
        withholds: condition.subjects.map((subject) => subject.id),
      });
      if (condition.subjects.length === 0) continue;
      reading.violations.push({
        code: "game_mount_is_gated_on_the_chat_half",
        at: `${file}:${condition.line}`,
        detail:
          `the condition tests ${condition.tests.map((test) => `\`${test}\``).join(" and ")}, and inside ` +
          `what it withholds are ${condition.subjects.map((subject) => `${subject.id} at line ${subject.at}`).join(", ")}; ` +
          "a Chat half that cannot be read is not a Game that cannot mount",
      });
    }
    const subjects = shellSubjectsIn(parsed.sourceFile, parsed.sourceFile);
    for (const subject of subjects) reading.shellSubjects.push({ id: subject.id, at: `${file}:${subject.at}` });
  }
  if (reading.parsed === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `shell_subjects_not_found: none of ${reading.population} module(s) under ${scope} parsed`,
    };
  if (reading.shellSubjects.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `shell_subjects_not_found: no shell subject (${SHELL_SUBJECTS.map((entry) => entry.id).join(", ")}) is drawn under ${scope}`,
    };
  if (reading.conditions.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `chat_half_conditions_empty: no condition under ${scope} reaches ${CHAT_HALF_MEMBERS.join(" or ")}`,
    };
  return { ...reading, status: reading.violations.length === 0 ? "passed" : "failed" };
}

/** Every route and member literal a module names, with the line it is on. */
function literalSites({ root, modules, needle }) {
  const sites = [];
  for (const file of modules) {
    const source = readFileSync(join(root, file), "utf8");
    source.split("\n").forEach((line, index) => {
      if (line.includes(needle)) sites.push({ file, line: index + 1, text: line.trim() });
    });
  }
  return sites;
}

/** Reading 3: the platform concerns are declared debt, and the debt expires by name. */
export function checkPlatformRoutePurity({ root = REPOSITORY_ROOT, scope = WEB_SOURCES } = {}) {
  const reading = {
    scope,
    population: 0,
    rows: [],
    reaches: [],
    platformRoutes: [],
    violations: [],
    blocked: null,
  };
  const modules = sourceModules({ root, web: scope });
  reading.population = modules.length;
  if (modules.length === 0)
    return { ...reading, status: "blocked", blocked: `platform_reaches_not_found: no module under ${scope}` };
  if (PLATFORM_DEBT.length === 0)
    return { ...reading, status: "blocked", blocked: "platform_debt_rows_empty: no declared platform debt" };
  for (const row of PLATFORM_DEBT) {
    const reach = row.today.flatMap((needle) =>
      literalSites({ root, modules, needle }).map((site) => ({ ...site, needle })),
    );
    reading.rows.push({ concern: row.concern, owner: row.owner, expires: row.expires, reach: reach.length });
    reading.reaches.push(
      ...reach.map((site) => ({ concern: row.concern, at: `${site.file}:${site.line}`, text: site.needle })),
    );
    if (reach.length === 0)
      reading.violations.push({
        code: "platform_debt_reach_gone",
        at: `${scope} (${row.concern})`,
        detail:
          `${row.concern}'s declared reach (${row.today.join(", ")}) is no longer in the tree; the row is stale - ` +
          `${row.owner} must rewrite it, and the expiry is: ${row.expires}`,
      });
    const arrived = row.platform.flatMap((prefix) => {
      const found = literalSites({ root, modules, needle: prefix });
      return found.map((site) => ({ ...site, prefix }));
    });
    for (const site of arrived)
      reading.violations.push({
        code: "platform_debt_expired",
        at: `${site.file}:${site.line}`,
        detail:
          `${site.prefix} is read by the browser, so the ${row.concern} debt has expired: delete its row in ` +
          `PLATFORM_DEBT (owner ${row.owner}) with this commit, and update the expiry (${row.expires})`,
      });
  }
  const declaredPlatform = PLATFORM_DEBT.flatMap((row) => row.platform);
  for (const site of literalSites({ root, modules, needle: PLATFORM_ROUTE_PREFIX })) {
    const named = declaredPlatform.some((prefix) => site.text.includes(prefix));
    reading.platformRoutes.push({ at: `${site.file}:${site.line}`, text: site.text });
    if (!named)
      reading.violations.push({
        code: "platform_route_unjudged",
        at: `${site.file}:${site.line}`,
        detail: `\`${site.text}\` reads ${PLATFORM_ROUTE_PREFIX}* and no concern in PLATFORM_DEBT names it; declare which public concern it serves, or it is a route with no owner`,
      });
  }
  if (reading.reaches.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `platform_reaches_not_found: none of the ${PLATFORM_DEBT.length} declared concern(s) has its reach in ${scope}`,
    };
  return { ...reading, status: reading.violations.length === 0 ? "passed" : "failed" };
}

/** A check's verdict as a `checks[]` entry, so the three readings report the same way. */
const verdictOf = (reading) => {
  if (reading.status === "blocked") return "blocked";
  return reading.violations.length === 0 ? "passed" : "failed";
};

/** The whole reading: the three checks, their populations, and every violation they produced. */
export function checkTheGameMountDoesNotDependOnTheChat({ root = REPOSITORY_ROOT } = {}) {
  const parity = checkRootHalfParity({ root });
  const shell = checkTheShellIsNotGatedOnTheChat({ root });
  const platform = checkPlatformRoutePurity({ root });
  const violations = [...parity.violations, ...shell.violations, ...platform.violations];
  const blocked = [parity.blocked, shell.blocked, platform.blocked].filter((reason) => reason !== null);
  const checks = [
    {
      id: "the_root_halves_share_their_optionality",
      status: verdictOf(parity),
      detail: `${parity.members.length} member(s) read: ${parity.members
        .map((member) => `${member.name} ${member.optional ? "optional" : "required"} at line ${member.line}`)
        .join(", ")}`,
    },
    {
      id: "no_shell_subject_is_gated_on_the_chat_half",
      status: verdictOf(shell),
      detail:
        `${shell.population} module(s) under ${SHELL_COMPONENTS}, ${shell.shellSubjects.length} shell subject(s), ` +
        `${shell.comparisons.length} Chat-half comparison(s) in ${shell.conditions.length} condition(s)`,
    },
    {
      id: "the_platform_debt_is_current",
      status: verdictOf(platform),
      detail: `${platform.rows.length} declared concern(s), ${platform.reaches.length} reach(es), ${platform.platformRoutes.length} platform route site(s)`,
    },
    {
      id: "every_module_parsed",
      status: shell.unparsed.length === 0 ? "passed" : "failed",
      detail: `${shell.unparsed.length} unparsed module(s)`,
    },
  ];
  let status = "passed";
  if (blocked.length > 0) status = "blocked";
  else if (violations.length > 0) status = "failed";
  return {
    gate: "game-mount-does-not-depend-on-the-chat",
    status,
    population: shell.population,
    platformPopulation: platform.population,
    members: parity.members,
    shellSubjects: shell.shellSubjects,
    comparisons: shell.comparisons,
    conditions: shell.conditions,
    debtRows: platform.rows,
    reaches: platform.reaches,
    violations,
    unparsed: shell.unparsed,
    blocked: blocked.length === 0 ? null : blocked.join(" · "),
    checks,
  };
}

/** The reading as the lines a reader needs: the populations first, then the sites, then the report. */
export function renderGameMountReport(result, out = process.stdout) {
  out.write(
    `root members examined ${result.members.length} in ${ROOT_SCHEMA}: ` +
      `${result.members.map((member) => `${member.name} ${member.optional ? "optional" : "required"}@${member.line}`).join(", ") || "none"}\n`,
  );
  out.write(
    `modules examined ${result.population} under ${SHELL_COMPONENTS} · shell subject(s) ${result.shellSubjects.length} · ` +
      `Chat-half comparison(s) ${result.comparisons.length} · condition(s) reading the Chat half ${result.conditions.length}\n`,
  );
  for (const subject of result.shellSubjects) out.write(`  shell subject ${subject.id}: ${subject.at}\n`);
  for (const comparison of result.comparisons) out.write(`  comparison ${comparison.at} - ${comparison.text}\n`);
  out.write(
    `modules examined ${result.platformPopulation} under ${WEB_SOURCES} · platform debt row(s) ${result.debtRows.length} · ` +
      `reach(es) ${result.reaches.length}\n`,
  );
  for (const row of result.debtRows)
    out.write(`  debt ${row.concern}: owner ${row.owner}; expires ${row.expires} (${row.reach} reach site(s))\n`);
  for (const violation of result.violations) out.write(`✖ ${violation.code}: ${violation.at} - ${violation.detail}\n`);
  for (const entry of result.unparsed) out.write(`✖ module_unparsed: ${entry}\n`);
  if (result.blocked !== null && result.blocked !== undefined) out.write(`blocked: ${result.blocked}\n`);
  if (result.status === "passed") out.write("game_mount_does_not_depend_on_the_chat: passed\n");
  out.write(
    `${JSON.stringify({
      gate: result.gate,
      status: result.status,
      population: result.population,
      platformPopulation: result.platformPopulation,
      members: result.members,
      shellSubjects: result.shellSubjects,
      comparisons: result.comparisons,
      conditions: result.conditions,
      debtRows: result.debtRows,
      reaches: result.reaches,
      violations: result.violations,
      unparsed: result.unparsed,
      ...(result.blocked === null || result.blocked === undefined ? {} : { blocked: result.blocked }),
      checks: result.checks,
    })}\n`,
  );
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : argv[rootIndex + 1];
  if (root === undefined || root === "")
    return blockedOnEmptyPopulation("game_mount_does_not_depend_on_the_chat", "--root was named with no directory");
  const result = checkTheGameMountDoesNotDependOnTheChat({ root });
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`);
  else renderGameMountReport(result, process.stdout);
  if (result.status === "passed") return 0;
  return result.status === "blocked" ? 2 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
