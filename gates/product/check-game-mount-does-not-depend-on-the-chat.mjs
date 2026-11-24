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
 *   3. THE PLATFORM'S ROUTE FAMILY IS ITS OWN, as an INVARIANT rather than debt. The four public platform facts -
 *      the session's CSRF token, the appearance, the interface language and the connection directory - used to be
 *      reachable only through the Chat half (`/api/tavern/v1/settings/{appearance,ui-language,connection*}` and
 *      `snapshot.csrfToken`), which is why a mount with no readable Chat half could not paint itself or
 *      authenticate. They now have a family of their own (`/api/platform/v1/*`, served by the composed broker) and
 *      a member on the root. The POPULATION is the Host's own declaration of that family,
 *      `COMPOSED_PLATFORM_ROUTES_V1` in the root schema module - never a second list here - and each declared row
 *      is held in BOTH directions: a route no browser module reads is `platform_route_unread` (the Host publishes a
 *      wire shape nobody asks for), and a Chat-half spelling the route took over (`replaces`) that is still read is
 *      `platform_fact_read_through_the_chat_half` at its own line, naming the concern, the route that replaced it
 *      and the owner to move. A platform route the declaration does not name is `platform_route_unjudged`, because
 *      a new public route with no concern on record is the one case this reading must not pass over.
 *
 * ZERO IS NOT GREEN. Six populations can come back empty and each of them BLOCKS rather than passing,
 * because a reading that lost its subject cannot tell a clean tree from a renamed one:
 *
 *   root_schema_unreadable            the root schema or its two members could not be read
 *   shell_modules_empty               no module under the shell's directory
 *   shell_subjects_not_found          no `<AppBar />`, `<GameSurface />` or shell container in any module
 *   chat_half_conditions_empty        no condition anywhere reaches the Chat half
 *   platform_routes_not_declared      the Host's platform route family could not be read, or declares no route
 *   platform_reaches_not_found        no declared platform route is read by any browser module
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
 * red-proof: inject   a browser read of `/api/tavern/v1/settings/appearance` after the platform route exists ->
 *   `platform_fact_read_through_the_chat_half` naming the concern, the retired spelling and the route that replaced
 *   it; a declared platform route with no browser caller -> `platform_route_unread`; a `/api/platform/v1/status`
 *   read no declaration names -> `platform_route_unjudged`
 *   (gates/product/check-game-mount-does-not-depend-on-the-chat.test.mjs)
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

/** The prefix a platform route lives under, and the declaration the family is read from. */
export const PLATFORM_ROUTE_PREFIX = "/api/platform/v1/";
export const PLATFORM_ROUTE_DECLARATION = "COMPOSED_PLATFORM_ROUTES_V1";

/**
 * The Host's own declaration of the platform's route family, read out of the root schema module.
 *
 * It is a DECLARATION rather than an implementation the gate infers: `composed-browser-contract/index.ts` exports
 * `COMPOSED_PLATFORM_ROUTES_V1` as a frozen table of `{ concern, method, path, replaces }`, the handler builds its
 * routes from it (`createComposedReferenceGameBrowserRequestHandler`), and this gate reads the same table instead of
 * keeping a second copy of the paths. A second copy would agree today and drift on the first route anybody adds -
 * which is exactly the shape `PLATFORM_DEBT` had, and why the reading it served could only expire.
 *
 * `replaces` is the Chat-half spelling the route took over. It is empty for a route that took over nothing, and a
 * non-empty one is a claim the gate holds the browser to: read `path`, and no longer read what `replaces` names.
 */
function declaredPlatformRoutes({ root }) {
  const path = join(root, ROOT_SCHEMA);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return { rows: [], unreadable: `platform_routes_not_declared: ${ROOT_SCHEMA} could not be read` };
  }
  const sourceFile = typescript.createSourceFile(
    ROOT_SCHEMA,
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  let declaration = null;
  const visit = (node) => {
    if (declaration !== null) return;
    if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.name.text === PLATFORM_ROUTE_DECLARATION &&
      node.initializer !== undefined
    ) {
      declaration = node.initializer;
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (declaration === null)
    return {
      rows: [],
      unreadable: `platform_routes_not_declared: ${ROOT_SCHEMA} declares no \`${PLATFORM_ROUTE_DECLARATION}\``,
    };
  const array = asArrayLiteral(declaration);
  if (array === null)
    return {
      rows: [],
      unreadable: `platform_routes_not_declared: \`${PLATFORM_ROUTE_DECLARATION}\` is not an array literal`,
    };
  const rows = [];
  for (const element of array.elements) {
    const object = asObjectLiteral(element);
    if (object === null) continue;
    const fields = new Map();
    for (const property of object.properties) {
      if (!typescript.isPropertyAssignment(property)) continue;
      fields.set(property.name.getText(sourceFile), property.initializer);
    }
    const concern = stringOf(fields.get("concern"), sourceFile);
    const method = stringOf(fields.get("method"), sourceFile);
    const routePath = stringOf(fields.get("path"), sourceFile);
    if (concern === null || method === null || routePath === null) continue;
    rows.push({ concern, method, path: routePath, replaces: stringsOf(fields.get("replaces"), sourceFile) });
  }
  return { rows, unreadable: null };
}

/** `Object.freeze([...])` and a bare `[...]` are the same array; `Object.freeze({...})` and `{...}` the same object. */
function asArrayLiteral(node) {
  const inner = unwrap(node);
  if (typescript.isArrayLiteralExpression(inner)) return inner;
  if (typescript.isCallExpression(inner) && inner.arguments.length === 1) {
    const argument = unwrap(inner.arguments[0]);
    return typescript.isArrayLiteralExpression(argument) ? argument : null;
  }
  return null;
}

function asObjectLiteral(node) {
  const inner = unwrap(node);
  if (typescript.isObjectLiteralExpression(inner)) return inner;
  if (typescript.isCallExpression(inner) && inner.arguments.length === 1) {
    const argument = unwrap(inner.arguments[0]);
    return typescript.isObjectLiteralExpression(argument) ? argument : null;
  }
  return null;
}

/** One string initializer's text, through `as const` and `Object.freeze("x")`. */
function stringOf(node, sourceFile) {
  if (node === undefined) return null;
  const inner = unwrap(node);
  if (typescript.isStringLiteral(inner) || typescript.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (typescript.isCallExpression(inner) && inner.arguments.length === 1) {
    const argument = unwrap(inner.arguments[0]);
    if (typescript.isStringLiteral(argument)) return argument.text;
  }
  return null;
}

/** A list of string initializers, each read the way `stringOf` reads one. */
function stringsOf(node, sourceFile) {
  if (node === undefined) return [];
  const array = asArrayLiteral(node);
  if (array === null) return [];
  return array.elements.map((element) => stringOf(element, sourceFile)).filter((text) => text !== null);
}

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

/**
 * Every STRING LITERAL in these modules whose text contains `needle`, with the line it is on.
 *
 * The population is the literals and not the lines, because a route is READ where a string names it: a doc comment
 * that quotes `/api/tavern/v1/settings/ui-language` while explaining why nothing goes there any more is not a read,
 * and a gate that counted it would demand the sentence be deleted to go green - which is how a gate teaches people
 * to delete the explanation instead of the defect.
 */
function routeSites({ root, modules, needle }) {
  const sites = [];
  for (const file of modules) {
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const sourceFile = typescript.createSourceFile(
      file,
      source,
      typescript.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS,
    );
    const visit = (node) => {
      if (typescript.isStringLiteral(node) && node.text.includes(needle))
        sites.push({ file, line: lineOf(sourceFile, node), text: node.text });
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

/** Reading 3: the platform's route family is its own, and the browser reads it and nothing else. */
export function checkPlatformRoutePurity({ root = REPOSITORY_ROOT, scope = WEB_SOURCES } = {}) {
  const reading = {
    scope,
    population: 0,
    routes: [],
    reaches: [],
    retired: [],
    platformRoutes: [],
    violations: [],
    blocked: null,
  };
  const modules = sourceModules({ root, web: scope });
  reading.population = modules.length;
  if (modules.length === 0)
    return { ...reading, status: "blocked", blocked: `platform_reaches_not_found: no module under ${scope}` };
  const declared = declaredPlatformRoutes({ root });
  if (declared.unreadable !== null) return { ...reading, status: "blocked", blocked: declared.unreadable };
  if (declared.rows.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked: `platform_routes_not_declared: \`${PLATFORM_ROUTE_DECLARATION}\` declares no route`,
    };
  for (const row of declared.rows) {
    const reach = routeSites({ root, modules, needle: row.path });
    reading.routes.push({
      concern: row.concern,
      method: row.method,
      path: row.path,
      clients: reach.length,
      replaces: row.replaces.length,
    });
    reading.reaches.push(...reach.map((site) => ({ concern: row.concern, at: `${site.file}:${site.line}`, text: row.path })));
    if (reach.length === 0)
      reading.violations.push({
        code: "platform_route_unread",
        at: `${ROOT_SCHEMA} (${row.concern})`,
        detail:
          `the Host declares \`${row.method} ${row.path}\` for the ${row.concern}, and no browser module under ` +
          `${scope} reads it; a wire shape nobody asks for is a platform fact the page cannot get`,
      });
    for (const retired of row.replaces) {
      const sites = routeSites({ root, modules, needle: retired });
      reading.retired.push({ concern: row.concern, needle: retired, sites: sites.length });
      for (const site of sites)
        reading.violations.push({
          code: "platform_fact_read_through_the_chat_half",
          at: `${site.file}:${site.line}`,
          detail:
            `\`${retired}\` is the Chat half's spelling of the ${row.concern}, and \`${row.method} ${row.path}\` took ` +
            `it over; ${site.file} still reads it, so this concern is reachable only where a Chat half is`,
        });
    }
  }
  const declaredPaths = new Set(declared.rows.map((row) => row.path));
  for (const site of routeSites({ root, modules, needle: PLATFORM_ROUTE_PREFIX })) {
    if ([...declaredPaths].some((routePath) => site.text.includes(routePath))) continue;
    reading.platformRoutes.push({ at: `${site.file}:${site.line}`, text: site.text });
    reading.violations.push({
      code: "platform_route_unjudged",
      at: `${site.file}:${site.line}`,
      detail: `\`${site.text}\` reads ${PLATFORM_ROUTE_PREFIX}* and \`${PLATFORM_ROUTE_DECLARATION}\` names no such route; declare it, or it is a route with no concern on record`,
    });
  }
  if (reading.reaches.length === 0)
    return {
      ...reading,
      status: "blocked",
      blocked:
        `platform_reaches_not_found: none of the ${declared.rows.length} declared platform route(s) is read under ` +
        `${scope} - the family exists on the Host and nothing in the browser asks for it`,
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
      id: "the_platform_family_is_the_browsers_only_source",
      status: verdictOf(platform),
      detail:
        `${platform.routes.length} declared route(s), ${platform.reaches.length} browser client(s), ` +
        `${platform.retired.length} retired Chat-half spelling(s) over ${platform.retired.reduce((total, row) => total + row.sites, 0)} site(s)`,
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
    debtRows: platform.routes,
    reaches: platform.reaches,
    retired: platform.retired,
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
    `modules examined ${result.platformPopulation} under ${WEB_SOURCES} · platform route(s) ${result.debtRows.length} · ` +
      `browser client(s) ${result.reaches.length} · retired Chat-half spelling(s) ${result.retired.length}\n`,
  );
  for (const row of result.debtRows)
    out.write(`  platform ${row.method} ${row.path} (${row.concern}): ${row.clients} client(s), ${row.replaces} retired\n`);
  for (const row of result.retired)
    out.write(`  retired ${row.concern}: ${row.needle} - ${row.sites} remaining site(s)\n`);
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
      retired: result.retired,
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
