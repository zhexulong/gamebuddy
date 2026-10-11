/**
 * A player never sees a raw enum.
 *
 * Design/104 §10: the Host publishes machine values (`connected_idle`,
 * `attach_pending`, `state_unavailable`, `not_configured`, ...) and the surface
 * renders *localized player outcomes*. Rendering the member itself - which is what
 * the game panel did before `game-presentation.ts` existed - puts implementation
 * vocabulary in the product's face, and it is untranslatable by construction.
 *
 * The runtime spec asserts this for one panel with one state. This generalises it
 * for the whole tree, and it derives the vocabulary instead of hand-listing it:
 * every snake_case string literal inside a `Type.Literal(...)` in the two browser
 * contracts is a member, so a member added to a contract tomorrow is covered today
 * without touching this file.
 *
 * What is a finding: a JSX text node, or a `title`/`aria-label`/`placeholder`/`alt`
 * literal, whose whole value is one of those members. What is not: the same string
 * in a comparison (`status === "not_configured"`), in a test hook
 * (`data-state={state}` is an expression, and `data-game-state="available"` is not
 * snake_case), in a type annotation, or in a comment.
 *
 * False positives, and how each is handled:
 *  - the member set is filtered to snake_case *with an underscore*, so a contract
 *    literal like `game_preview`, `chat_core` or `player` cannot collide with
 *    ordinary attribute values such as `role="status"`, `type="button"` or
 *    `data-tone="progress"`;
 *  - only a whole-value match counts, so prose that merely contains a member
 *    ("the game_unavailable case") is not a finding - the reader can see it is a
 *    sentence;
 *  - an attribute whose value is an expression is never inspected.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO, "dialogue-web", "src");

/** The contracts that own the machine vocabulary a surface may render. */
const CONTRACTS = [
  join(REPO, "host", "src", "game-browser-contract", "index.ts"),
  join(REPO, "host", "src", "tavern", "browser-contract", "index.ts"),
];

const USER_VISIBLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

/** A machine member: snake_case with at least one underscore. */
const MEMBER_SHAPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/u;

/** Every snake_case `Type.Literal(...)` argument in the contracts. */
export function enumVocabulary(cssFiles = CONTRACTS) {
  const members = new Map();
  for (const file of cssFiles) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "Literal" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        MEMBER_SHAPE.test(node.arguments[0].text)
      ) {
        const member = node.arguments[0].text;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        if (!members.has(member))
          members.set(member, `${file.replace(/\\/gu, "/").split("/host/").pop()}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return members;
}

export function tsxFiles(directory = SRC) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...tsxFiles(path));
      continue;
    }
    if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

export function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop()}:${line + 1}`;
}

/** Rendered values that are a raw contract member. */
export function leakedEnums(text, fileName, vocabulary) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const value = node.text.trim();
      if (vocabulary.has(value)) found.push({ line: at(node, sourceFile), value, where: "JSX text" });
    }
    if (ts.isJsxAttribute(node) && USER_VISIBLE_ATTRIBUTES.includes(node.name.getText())) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isStringLiteral(initializer) && vocabulary.has(initializer.text))
        found.push({ line: at(initializer, sourceFile), value: initializer.text, where: node.name.getText() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

test("enum.1: no surface renders a raw contract member", (t) => {
  const vocabulary = enumVocabulary();
  const failures = [];
  let files = 0;
  for (const file of tsxFiles()) {
    files += 1;
    const text = readFileSync(file, "utf8");
    for (const finding of leakedEnums(text, file, vocabulary))
      failures.push(`${finding.line} ${finding.where} renders the raw member ${JSON.stringify(finding.value)}`);
  }
  t.diagnostic(
    `enum.1: ${files} tsx file(s), ${vocabulary.size} contract member(s) derived from ${CONTRACTS.length} contract(s), ${failures.length} leak(s)`,
  );
  assert.deepEqual(failures, [], "a machine member is not a player outcome; render it through the presentation module");
});

test("enum.2: the vocabulary really comes from the contracts", (t) => {
  const vocabulary = enumVocabulary();
  assert.ok(vocabulary.size >= 30, `expected a vocabulary of real members, found ${vocabulary.size}`);
  for (const member of ["connected_idle", "attach_pending", "not_configured", "game_unavailable"]) {
    assert.ok(vocabulary.has(member), `${member} must be derived from the contracts, not listed by hand`);
  }
  const sample = ["connected_idle", "attach_pending", "not_configured"]
    .map((member) => `${member}<-${vocabulary.get(member)}`)
    .join(", ");
  t.diagnostic(`enum.2: ${vocabulary.size} member(s); ${sample}`);
});

test("enum.3 (mutation): a rendered member fails, and a comparison does not", (t) => {
  const vocabulary = enumVocabulary();
  const mutated = [
    "export const Probe = ({ status }: { status: string }) => (",
    '  <div title="attach_pending">',
    "    connected_idle",
    "    {status === 'attach_pending' && <span>{status}</span>}",
    "  </div>",
    ");",
  ].join("\n");
  assert.deepEqual(
    leakedEnums(mutated, "src/components/Mutation.tsx", vocabulary).map((finding) => [finding.line, finding.where]),
    [
      ["src/components/Mutation.tsx:2", "title"],
      ["src/components/Mutation.tsx:3", "JSX text"],
    ],
  );
  t.diagnostic("enum.3: a title and a JSX text node reported; a comparison and an expression are not");
});

test("enum.4: ordinary attribute values are not mistaken for members", (t) => {
  const vocabulary = enumVocabulary();
  const clean = [
    "export const Probe = ({ state }: { state: string }) => (",
    '  <section role="status" data-tone="progress" data-game-state="available" data-state={state}>',
    '    <button type="button" className="game-action" aria-label="Stop game">Stop</button>',
    "  </section>",
    ");",
  ].join("\n");
  assert.deepEqual(leakedEnums(clean, "src/components/Clean.tsx", vocabulary), []);
  t.diagnostic("enum.4: role/type/data-tone/data-game-state literals and a dynamic data hook are clean");
});
