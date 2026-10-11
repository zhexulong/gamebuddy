/**
 * User-visible text is reachable by the locale switch, or it is not shipped.
 *
 * The recurring defect this exists for: a sentence written straight into a
 * component. It looks right in one language and is untranslatable in the other,
 * and nothing in the suite ever looked at the *text*, only at the markup. The
 * decisive case is Chinese - a CJK string literal in a component file cannot be
 * reached by the locale switch - and the attribute case is the same defect in the
 * one place a player *hears* it: `title`, `aria-label`, `placeholder` and `alt`
 * are read aloud, so a hard-coded English sentence there is a screen reader bug,
 * not a polish item.
 *
 * The rule, exactly:
 *   raw-text.1  every CJK string literal in `src/**` is either in a catalogue file
 *               or *locally bilingual* - it sits in an object literal that also
 *               declares a non-empty, CJK-free `en` sibling, in one of a pair of
 *               `return { ... }` object literals with identical key sets inside one
 *               function (the shape `advancedPiSettingsText` uses), or in one branch
 *               of a `locale === ... ? "zh" : "en"` conditional.
 *   raw-text.2  no `title`/`aria-label`/`placeholder`/`alt` *string literal* reads
 *               as prose (two or more words, or any CJK).
 *   raw-text.3  no JSX text node reads as prose.
 *
 * Why not the strictest reading ("any CJK in a component is a finding"): this tree
 * has exactly one such site outside a catalogue - `MEMORY_STATUS_LABELS` in
 * management-panels.tsx - and it is *already* bilingual (`{ en: "Active", zh: "活跃" }`),
 * so the strict rule would fire on correct code and the gate would be switched off
 * for crying wolf. The rule above still catches the defect class it is for (one
 * language only), and it is checked structurally, so a comment cannot hide a
 * violation and a duplicated key cannot fake a sibling. The bilingual sites are
 * still reported to the owner as structure findings: text that lives outside a
 * catalogue cannot be covered by the parity gate.
 *
 * False positives, and how each is handled:
 *  - an example value a player types verbatim (`zh-CN`, `ollama`, a URL) is data:
 *    one word and no CJK is never prose;
 *  - a brand mark ("GB") is one word, so it needs no allowlist entry;
 *  - an attribute whose value is an expression (`aria-label={labels.x}`) is never
 *    inspected - the gate cannot know what it resolves to and guessing is the
 *    false positive;
 *  - a non-string attribute value is not text at all.
 *
 * The one declared exception below is a real finding that is not this lane's to
 * fix (it needs a prop threaded through `MemoryCreateForm` and three Playwright
 * specs read the literal). The gate asserts the exception still exists, so it
 * cannot silently outlive the fix.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");

/** The files where user-visible text is declared. Prose here is the point. */
const CATALOGUE_FILES = [join(SRC, "i18n.ts"), join(SRC, "components", "character-domain-labels.ts")];

/** The attributes a player reads or hears. A written-out sentence in one is a leak. */
const USER_VISIBLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

/**
 * Findings that are real but are not one-line fixes in the files this lane owns.
 * The gate fails if such a finding disappears, so this list has to be emptied by
 * whoever fixes it rather than left behind.
 */
const REPORTED_PROSE_ATTRIBUTES = [
  {
    path: "src/components/management-panels.tsx",
    value: "Memory content",
    reason:
      "MemoryCreateForm's textarea hard-codes the English accessible name while the edit field beside it (line 1051) reads labels.memoryContent; the fix threads a copy prop through the component, and four Playwright specs assert the literal",
  },
];

const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

export function isCjkLiteral(value) {
  return CJK.test(value);
}

/** A value a player reads as a written sentence: any CJK, or two or more words. */
export function isProse(value) {
  if (value.trim().length === 0) return false;
  if (CJK.test(value)) return true;
  const words = value.trim().split(/\s+/u).filter((word) => /[A-Za-z]{2}/u.test(word));
  return words.length >= 2;
}

export function sourceFiles(directory = SRC) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

export function relativeToDialogueWeb(file) {
  return relative(DIALOGUE_WEB, file).replace(/\\/gu, "/");
}

export function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop()}:${line + 1}`;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function ancestorsOf(node) {
  const chain = [];
  for (let current = node.parent; current !== undefined; current = current.parent) chain.push(current);
  return chain;
}

function nearestObject(node) {
  return ancestorsOf(node).find(ts.isObjectLiteralExpression) ?? null;
}

function propertyNamed(object, name) {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) return property;
  }
  return null;
}

/** The value of a property when it is a plain string literal. */
function stringValueOf(property) {
  if (property === null) return null;
  const initializer = property.initializer;
  return ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer) ? initializer.text : null;
}

/** `{ en: "...", zh: "..." }`: the local bilingual pair. */
function hasLocalPair(object) {
  const en = stringValueOf(propertyNamed(object, "en"));
  const zh = stringValueOf(propertyNamed(object, "zh"));
  return en !== null && en.trim().length > 0 && !CJK.test(en) && zh !== null && zh.trim().length > 0;
}

/** Two `return { ... }` object literals with identical keys, one of them CJK-free. */
function hasReturnPair(object) {
  if (!ancestorsOf(object).some((node) => ts.isReturnStatement(node))) return null;
  const scope = ancestorsOf(object).find((node) => ts.isFunctionLike(node)) ?? object.getSourceFile();
  const keys = object.properties.map((property) => property.name?.getText() ?? "").join(",");
  const returns = [];
  walk(scope, (node) => {
    if (!ts.isReturnStatement(node) || node.expression === undefined) return;
    const expression = node.expression;
    if (ts.isObjectLiteralExpression(expression)) returns.push(expression);
  });
  for (const candidate of returns) {
    if (candidate === object) continue;
    const candidateKeys = candidate.properties.map((property) => property.name?.getText() ?? "").join(",");
    if (candidateKeys !== keys) continue;
    const values = candidate.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => property.initializer)
      .filter((initializer) => ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
      .map((initializer) => initializer.text);
    if (values.length > 0 && values.every((value) => !CJK.test(value))) return candidate;
  }
  return null;
}

/** `locale === "zh-CN" ? "固定" : "Pinned"`: both languages at the branch. */
function hasLocaleBranch(literal) {
  const conditional = ancestorsOf(literal).find(ts.isConditionalExpression);
  if (conditional === undefined) return false;
  if (!/\blocale\b|\bzh\b/iu.test(conditional.condition.getText())) return false;
  const sibling = conditional.whenTrue === literal ? conditional.whenFalse : conditional.whenTrue;
  return (
    (ts.isStringLiteral(sibling) || ts.isNoSubstitutionTemplateLiteral(sibling)) &&
    sibling.text.trim().length > 0 &&
    !CJK.test(sibling.text)
  );
}

export function isLocallyBilingual(literal) {
  const object = nearestObject(literal);
  if (object !== null && (hasLocalPair(object) || hasReturnPair(object) !== null)) return true;
  return hasLocaleBranch(literal);
}

/** Every CJK string literal in one source text that is not locale-reachable. */
export function unlocalizedCjkLiterals(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
    if (!isCjkLiteral(node.text)) return;
    if (isLocallyBilingual(node)) return;
    found.push({ line: at(node, sourceFile), value: node.text });
  });
  return found;
}

/** Every user-visible attribute whose literal reads as prose. */
export function proseAttributeLiterals(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isJsxAttribute(node) || !USER_VISIBLE_ATTRIBUTES.includes(node.name.getText())) return;
    const initializer = node.initializer;
    const literal =
      initializer !== undefined && ts.isStringLiteral(initializer)
        ? initializer
        : initializer !== undefined && ts.isJsxExpression(initializer) && ts.isStringLiteral(initializer.expression)
          ? initializer.expression
          : null;
    if (literal !== null && isProse(literal.text)) found.push({ line: at(literal, sourceFile), value: literal.text });
  });
  return found;
}

/** Every JSX text node that reads as prose. */
export function proseTextNodes(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isJsxText(node)) return;
    const value = node.text.replace(/\s+/gu, " ").trim();
    if (isProse(value)) found.push({ line: at(node, sourceFile), value });
  });
  return found;
}

test("raw-text.1: a CJK literal is in a catalogue or locally bilingual", (t) => {
  const failures = [];
  let files = 0;
  for (const file of sourceFiles()) {
    if (CATALOGUE_FILES.includes(file)) continue;
    files += 1;
    for (const finding of unlocalizedCjkLiterals(readFileSync(file, "utf8"), file))
      failures.push(`${finding.line} CJK literal with no local translation: ${JSON.stringify(finding.value)}`);
  }
  t.diagnostic(`raw-text.1: ${files} non-catalogue source file(s) scanned, ${failures.length} unlocalized CJK literal(s)`);
  assert.deepEqual(failures, [], "a CJK literal that is not reachable by the locale switch renders in one language only");
});

test("raw-text.2: a user-visible attribute literal is not a written-out sentence", (t) => {
  const failures = [];
  let files = 0;
  let literals = 0;
  for (const file of sourceFiles()) {
    if (CATALOGUE_FILES.includes(file)) continue;
    files += 1;
    const text = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(sourceFile, (node) => {
      if (!ts.isJsxAttribute(node) || !USER_VISIBLE_ATTRIBUTES.includes(node.name.getText())) return;
      if (node.initializer !== undefined && ts.isStringLiteral(node.initializer)) literals += 1;
    });
    for (const finding of proseAttributeLiterals(text, file)) {
      const path = relativeToDialogueWeb(file);
      const reported = REPORTED_PROSE_ATTRIBUTES.find(
        (entry) => entry.path === path && finding.value === entry.value,
      );
      if (reported !== undefined) continue;
      failures.push(`${finding.line} user-visible attribute literal is prose: ${JSON.stringify(finding.value)}`);
    }
  }
  t.diagnostic(
    `raw-text.2: ${files} file(s), ${literals} literal user-visible attribute(s), ${failures.length} prose literal(s), ${REPORTED_PROSE_ATTRIBUTES.length} reported exception(s)`,
  );
  assert.deepEqual(failures, [], "a written-out sentence in a user-visible attribute is copy nothing can translate");
});

test("raw-text.3: no JSX text node outside a catalogue is prose", (t) => {
  const failures = [];
  let files = 0;
  let nodes = 0;
  for (const file of sourceFiles()) {
    if (CATALOGUE_FILES.includes(file)) continue;
    files += 1;
    const text = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(sourceFile, (node) => {
      if (ts.isJsxText(node) && node.text.replace(/\s+/gu, " ").trim().length > 0) nodes += 1;
    });
    for (const finding of proseTextNodes(text, file))
      failures.push(`${finding.line} JSX text is prose: ${JSON.stringify(finding.value)}`);
  }
  t.diagnostic(`raw-text.3: ${files} file(s), ${nodes} non-empty JSX text node(s), ${failures.length} prose node(s)`);
  assert.deepEqual(failures, [], "a JSX text node is not reachable by the locale switch; read it from the catalogue");
});

test("raw-text.4: every reported exception is still a finding", (t) => {
  // Self-cleaning: an exception that no longer describes a real finding is a
  // failure, so the list cannot outlive the fix and quietly bless a new leak.
  for (const entry of REPORTED_PROSE_ATTRIBUTES) {
    const file = join(DIALOGUE_WEB, entry.path);
    const findings = proseAttributeLiterals(readFileSync(file, "utf8"), file);
    assert.ok(
      findings.some((finding) => finding.value === entry.value),
      `${entry.path} no longer carries the reported literal ${JSON.stringify(entry.value)}; remove the exception`,
    );
  }
  t.diagnostic(`raw-text.4: ${REPORTED_PROSE_ATTRIBUTES.length} reported exception(s) still reproduce`);
});

test("raw-text.5: the live bilingual sites are accepted because both languages are present", (t) => {
  const panels = readFileSync(join(SRC, "components", "management-panels.tsx"), "utf8");
  const pi = readFileSync(join(SRC, "pi-settings-model.ts"), "utf8");
  assert.deepEqual(unlocalizedCjkLiterals(panels, join(SRC, "components", "management-panels.tsx")), []);
  assert.deepEqual(unlocalizedCjkLiterals(pi, join(SRC, "pi-settings-model.ts")), []);
  const pairs = ["active: { en: \"Active\", zh: \"活跃\" }"];
  assert.ok(panels.includes(pairs[0]), "the memory status vocabulary keeps its en/zh pair");
  t.diagnostic("raw-text.5: MEMORY_STATUS_LABELS ({ en, zh }), the pinned chip (locale branch) and advancedPiSettingsText (return pair) are bilingual");
});

test("raw-text.6 (mutation): a monolingual CJK literal and a prose attribute fail with file and line", (t) => {
  const monolingual = [
    "export function Probe() {",
    '  const status = "活跃";',
    '  const zh = { active: { zh: "活跃" } };',
    "  return status + JSON.stringify(zh);",
    "}",
  ].join("\n");
  assert.deepEqual(unlocalizedCjkLiterals(monolingual, "src/components/Mutation.tsx"), [
    { line: "src/components/Mutation.tsx:2", value: "活跃" },
    { line: "src/components/Mutation.tsx:3", value: "活跃" },
  ]);

  const bilingual = [
    'const M = { active: { en: "Active", zh: "活跃" } };',
    'const pinned = (locale: string) => locale === "zh-CN" ? "固定" : "Pinned";',
  ].join("\n");
  assert.deepEqual(unlocalizedCjkLiterals(bilingual, "src/components/Pair.tsx"), []);

  const prose = ['export const P = () => <textarea aria-label="Memory content" />;'].join("\n");
  assert.deepEqual(proseAttributeLiterals(prose, "src/components/Mutation.tsx"), [
    { line: "src/components/Mutation.tsx:1", value: "Memory content" },
  ]);
  t.diagnostic("raw-text.6: monolingual CJK at :2, paired CJK clean, prose attribute at :1");
});

test("raw-text.7: a comment, a locale token and a one-word mark are not findings", (t) => {
  const clean = [
    "// 这是注释，不是玩家可见文案",
    'const token = "zh-CN";',
    "export function Probe() {",
    '  return <button aria-label="GB" data-testid="nav">Go</button>;',
    "}",
  ].join("\n");
  assert.deepEqual(unlocalizedCjkLiterals(clean, "src/components/Clean.tsx"), []);
  assert.deepEqual(proseAttributeLiterals(clean, "src/components/Clean.tsx"), []);
  t.diagnostic("raw-text.7: comment CJK, a locale token and a one-word mark are all clean");
});

test("raw-text.8: the live sources are counted, so the gate is not vacuously green", (t) => {
  const files = sourceFiles().filter((file) => !CATALOGUE_FILES.includes(file));
  assert.ok(files.length >= 20, `expected the component tree, found ${files.length} file(s)`);
  const withJsx = files.filter((file) => readFileSync(file, "utf8").includes("</"));
  assert.ok(withJsx.length >= 15, `expected JSX files, found ${withJsx.length}`);
  t.diagnostic(`raw-text.8: ${files.length} non-catalogue source file(s), ${withJsx.length} with JSX`);
});
