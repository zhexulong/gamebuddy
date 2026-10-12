/**
 * A player never sees a raw enum - statically OR dynamically.
 *
 * Design/104 §10: the Host publishes machine values (`connected_idle`,
 * `attach_pending`, `state_unavailable`, `not_configured`, ...) and the surface
 * renders *localized player outcomes*. Rendering the member itself - which is what
 * the game panel did before `game-presentation.ts` existed - puts implementation
 * vocabulary in the product's face, and it is untranslatable by construction.
 *
 * Two rules, because a string scan is blind to the obvious dodge:
 *
 *  1. the static rule reads JSX text nodes and `title`/`aria-label`/`placeholder`/
 *     `alt` literals whose whole value is a member. A vocabulary is derived from
 *     the contracts (`Type.Literal(...)`) rather than hand-listed, so a member
 *     added to a contract tomorrow is covered today;
 *  2. the dynamic rule uses the TypeScript checker. `{someState}` renders a value
 *     straight into the DOM, so the static rule never sees the literal that lands
 *     in front of the player. The checker now flags any JSX *child* expression
 *     container whose expression type is a closed union of string literals equal
 *     to one of the contracts' `Type.Union([Type.Literal(...), ...])` unions AND
 *     carrying at least one machine member - a member rule 1 recognises as
 *     implementation vocabulary (snake_case with an underscore). The type is
 *     closed over literals, so a computed string, a `string`-typed label or an
 *     i18n message is never a finding; a `"queued" | ... | "failed"` turn state
 *     (which carries `response_visible`) is. The machine-member requirement is
 *     what keeps an external protocol identifier out: the connection panel's
 *     `anthropic-messages | openai-completions | ...` api-shape selector renders a
 *     contract union whose members name provider protocols, not the product's own
 *     vocabulary, and rule 1 never flagged it either.
 *
 * What is a finding: a JSX text node or a user-visible attribute literal whose
 * whole value is a member (rule 1); a JSX child `{expr}` whose type is a contract
 * enum union (rule 2). What is not: the same string in a comparison
 * (`status === "not_configured"`), in a test hook (`data-state={state}` is an
 * attribute, and `data-game-state="available"` is not snake_case), in a type
 * annotation, or in a comment.
 *
 * False positives, and how each is handled:
 *  - rule 1 filters the member set to snake_case *with an underscore*, so a contract
 *    literal like `game_preview`, `chat_core` or `player` cannot collide with
 *    ordinary attribute values such as `role="status"`, `type="button"` or
 *    `data-tone="progress"`;
 *  - only a whole-value match counts in rule 1, so prose that merely contains a
 *    member ("the game_unavailable case") is not a finding;
 *  - rule 2 only inspects containers that render a *child* (not attribute values),
 *    skips values that are themselves JSX elements, and requires the expression
 *    type to be a union of string literals that is entirely contained in one
 *    contract union - so `{count}`, `{label}`, `{isOpen && <span/>}` and a
 *    component-local `StatusDotTone` union are clean.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO, "dialogue-web", "src");
const TS_CONFIG = join(REPO, "dialogue-web", "tsconfig.json");
const FIXTURES = join(REPO, "dialogue-web", "tests", "fixtures");

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

/**
 * Every closed union of string literals the contracts declare as
 * `Type.Union([Type.Literal("a"), Type.Literal("b"), ...])`, as an array of value
 * sets. These are the unions rule 2 matches a rendered value's type against; the
 * comparison is by value, so a component that declares its own mirror of a
 * contract union is matched too.
 */
export function enumUnions(contractFiles = CONTRACTS) {
  const unions = [];
  const seen = new Set();
  for (const file of contractFiles) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "Union" &&
        node.arguments.length === 1 &&
        ts.isArrayLiteralExpression(node.arguments[0]) &&
        node.arguments[0].elements.length >= 2 &&
        node.arguments[0].elements.every(
          (element) =>
            ts.isCallExpression(element) &&
            ts.isPropertyAccessExpression(element.expression) &&
            element.expression.name.text === "Literal" &&
            element.arguments.length === 1 &&
            ts.isStringLiteral(element.arguments[0]),
        )
      ) {
        const values = node.arguments[0].elements.map((element) => element.arguments[0].text);
        const key = [...values].sort().join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          unions.push(new Set(values));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unions;
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

/** Rendered values that are a raw contract member, by the static text rule. */
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

/** The string-literal values of a type, or null when the type is not a closed literal union. */
export function closedStringLiterals(type) {
  const members = type.isUnion() ? type.types : [type];
  const values = [];
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
    if ((member.flags & ts.TypeFlags.StringLiteral) === 0) return null;
    values.push(member.value);
  }
  return values.length === 0 ? null : values;
}

let cachedProgram = null;

/** The dialogue-web program, built once from its own tsconfig. */
export function dialogueWebProgram(extraRoots = []) {
  if (extraRoots.length === 0 && cachedProgram !== null) return cachedProgram;
  const { config } = ts.readConfigFile(TS_CONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(TS_CONFIG));
  const program = ts.createProgram([...parsed.fileNames, ...extraRoots], parsed.options);
  if (extraRoots.length === 0) cachedProgram = program;
  return program;
}

/**
 * JSX child containers that render a value whose type is one of the contract
 * enum unions and carries at least one machine member. `rootFiles` are the files
 * whose containers are reported; the whole project is still loaded so every type
 * resolves.
 */
export function checkerLeaks(rootFiles, options = {}) {
  const vocabulary = options.vocabulary ?? enumVocabulary();
  const unions = options.unions ?? enumUnions();
  const program = options.program ?? dialogueWebProgram(rootFiles);
  const checker = program.getTypeChecker();
  const byPath = new Map(program.getSourceFiles().map((file) => [file.fileName.replace(/\\/gu, "/"), file]));
  const found = [];
  for (const file of rootFiles) {
    const sourceFile = program.getSourceFile(file) ?? byPath.get(file.replace(/\\/gu, "/"));
    if (sourceFile === undefined) continue;
    const visit = (node) => {
      if (
        ts.isJsxExpression(node) &&
        node.expression !== undefined &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
        !ts.isJsxElement(node.expression) &&
        !ts.isJsxFragment(node.expression)
      ) {
        const literals = closedStringLiterals(checker.getTypeAtLocation(node.expression));
        if (
          literals !== null &&
          literals.some((value) => vocabulary.has(value)) &&
          unions.some((union) => literals.every((value) => union.has(value)))
        ) {
          found.push({ line: at(node, sourceFile), value: literals.join(" | "), where: "JSX expression" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

test("enum.1: no surface renders a raw contract member statically", (t) => {
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

test("enum.5 (planted): a JSX expression rendering {turn.state} is a finding", (t) => {
  const unions = enumUnions();
  const planted = join(FIXTURES, "turn-state-leak.tsx");
  const cleanFixture = join(FIXTURES, "turn-state-clean.tsx");
  const program = dialogueWebProgram([planted, cleanFixture]);
  const findings = checkerLeaks([planted], { unions, program });
  t.diagnostic(`enum.5: ${JSON.stringify(findings)}`);
  assert.equal(findings.length, 1, "the checker must flag the one container that renders the raw turn state");
  assert.match(findings[0].line, /turn-state-leak\.tsx:/u);
  assert.match(findings[0].value, /queued/u);

  const cleanFindings = checkerLeaks([cleanFixture], { unions, program });
  assert.deepEqual(cleanFindings, [], "a value rendered through a presentation function is not a finding");
  t.diagnostic("enum.5: the planted container fails; the presented value is clean");
});

test("enum.6: no surface renders a contract enum union dynamically", (t) => {
  const failures = checkerLeaks(tsxFiles());
  const unions = enumUnions();
  t.diagnostic(
    `enum.6: ${tsxFiles().length} tsx file(s), ${unions.length} contract enum union(s) matched by the checker, ${failures.length} leak(s)`,
  );
  for (const finding of failures)
    t.diagnostic(`enum.6: ${finding.line} JSX expression renders ${JSON.stringify(finding.value)}`);
  assert.deepEqual(
    failures.map((finding) => finding.line),
    [],
    "a JSX container that renders a contract enum union puts a raw machine value in front of the player",
  );
});
