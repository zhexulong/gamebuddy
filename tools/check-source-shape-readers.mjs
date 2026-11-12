#!/usr/bin/env node
/**
 * The gate for "a test read a source file as raw text and then asserted a fact about its LAYOUT".
 *
 * WHY (measured 2026-11-12): `host/src/containment/runtime/contained-game-runtime.internal.test.ts` asserted
 * `/launchRole\(role, launchOperation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer\)/`
 * against the file's raw text. The formatter folded that signature onto four lines, the meaning did not change at all,
 * and the test went red: it was measuring where the line breaks sat, not the property it names ("native frame
 * construction stays out of the generic core"). Nothing in the product was wrong, and the assertion could not be made
 * right by relaxing it - the same pattern one line wide was a genuine claim about the parameter list.
 *
 * THE POPULATION, derived by parsing every `*.test.ts` under `host/src` and following values rather than matching
 * text: each text read (`readFileSync` / `readFile`, reached directly or through member calls such as
 * `.split(/\r?\n/u)`) that is then consumed by a matcher - `assert.match` / `assert.doesNotMatch`, or a string
 * `includes` / `match` / `search` on the read value - where the pattern's own text separates two or more code tokens
 * with whitespace. Whitespace here means whitespace the pattern MATCHES literally: a literal space, tab or newline in a
 * regex, or `\n`/`\t`/`\r`. An escape that tolerates any whitespace (`\s`, `\s+`, `\s*`) is not a separator, because that
 * pattern survives reformatting already. A token is a whitespace-separated run carrying at least one identifier or
 * numeric character; a run made only of punctuation (`\)`, `{`) does not separate tokens on its own.
 *
 * THE PROPERTY, and where the line falls: a pattern that separates two or more code tokens with whitespace is a layout
 * claim and must read the whitespace-normalised shape, which `readSourceShape`
 * (`host/src/test-support/source-shape.test-support.ts`) returns as `.shape`; `collapseWhitespace` is recognised as the
 * same reading. A pattern ONE token wide may read the committed bytes, and seeking a marker whose POSITION carries
 * meaning is meant to: `indexOf("Read-BoundedUtf8Frame")` followed by `indexOf("\n}", declared)` slices a function
 * body between a declaration and the brace that closes it in column 0, and neither marker has interior whitespace for a
 * formatter to rewrap. That is the supervisor's rule from 2026-11-12, encoded here rather than kept as an exemption
 * list: a single-token seek is outside the population by construction, so it is never named and never needs excusing.
 *
 * THE READING, before and after. On the tree that added this gate, before the fix, it printed `matches examined 23 ·
 * through the shape reader 0 · through raw text 23`: twenty-three assertions across six Host test files measured layout,
 * one of them red at HEAD (`contained-game-runtime.internal.test.ts:205`), and the rest one reformat away from the same
 * failure. The migration ran by directory afterwards, one commit per group, and on 2026-11-12 this printed `matches
 * examined 142 · through the shape reader 142 · through raw text 0 · reads 656 · files 400`. The 656 read sites over
 * 400 test files are the honest scale: 514 of them are read and never matched across tokens, because a one-token
 * pattern cannot be broken by a rewrap, so this reading is not 656 assertions at risk. (The first count of 23 in this
 * paragraph was measured before this gate's own fixtures existed in `source-shape.test-support.test.ts`.)
 *
 * TWO THINGS THE MIGRATION TAUGHT THIS GATE, recorded here because neither shows in the verdict:
 *
 *   - A read is followed by the NAME of the variable it was assigned to, so a file with two reads called `source`
 *     judges every `source` match against the LAST one's path. Six assertions in
 *     `host/src/windows-reparse-inspector/index.private.test.ts` compare against
 *     `host/native/windows-reparse-inspector/Program.cs` - C#, which no formatter in this repository rewraps - and the
 *     gate had been judging them against the `index.ts` read that came after them, and calling them formatted. Naming
 *     each read once fixed the attribution, not the rule: those six are counted as `notCode`, which is what they were.
 *   - A pattern that needs a LINE BREAK to match cannot be satisfied by a shape at all, and a `.*` or a `^...$` that was
 *     really pinning a line stops meaning what it looks like once everything is one line. Both were rewritten to say
 *     what they meant - `\n\s+` to `\s+`, `/^\s+field,$/m` to the field, `.*` to `\w*`, and a `.raw` read where the
 *     line really is the subject - one commit at a time, with the reason in each message. The one mistake this gate
 *     cannot see is a migrated pattern that still demands a newline: it will simply never match again.
 *
 * WHAT IS OUTSIDE THIS POPULATION, counted rather than left unsaid:
 *
 *   - A read `.split()` into lines and matched per line (`source.split("\n").some((line) => line.includes("a b"))`)
 *     is not followed through the callback parameter, so a multi-token pattern over one LINE is still layout-sensitive
 *     and this gate does not see it. Following it would mean tracking the split's element type through a closure; the
 *     shapes that recur are the whole-file ones this gate names.
 *   - A value passed through a call this gate does not know (`const t = decorate(source)` then a multi-token match on
 *     `t`) leaves the population, because the reader follows member calls and the two recognised entry points and
 *     nothing else. Both gaps fail in the direction of a red assertion someone notices, never a silent pass - and both
 *     are asserted in tools/check-source-shape-readers.test.mjs so the boundary is a decision, not a hole.
 *
 * ZERO POPULATION BLOCKS. A scan of 400 test files that finds no read, or no multi-token text match, has lost its
 * reader, not removed the class - and `matches examined 0 · through raw text 0` is a sentence that agrees with itself.
 *
 * Usage:
 *   node tools/check-source-shape-readers.mjs               # the gate; exit 0 passed, 1 failed, 2 blocked
 *   node tools/check-source-shape-readers.mjs --json        # the reading, machine-readable
 *   node tools/check-source-shape-readers.mjs --root <dir>  # the gate's own fixture
 *
 * red-proof: history and inject. tools/check-source-shape-readers.test.mjs replays the real 2026-11-12 defect: it
 *            `git show`s the Host test file that shipped the raw-text signature match at `1c38ab9d`, reads that
 *            revision through this gate, and requires the finding to name the file, the line, the token count and the
 *            pattern exactly - an assertion the formatter turned red with the product unchanged. Injecting a raw read
 *            matched across three tokens into a fixture reports the same finding shape
 *            (`source_shape_read_from_raw_text:<file>:<line>:<tokens>:<pattern>`), while the same pattern over `.shape`
 *            is examined and passes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The tests this gate reads: every `*.test.ts` under the Host source tree. */
const SCOPE = Object.freeze({ directory: "host/src", suffix: ".test.ts" });

/** A call that returns a text's bytes. */
const RAW_READERS = new Set(["readFileSync", "readFile"]);

/** The one helper a layout claim reads through, and the member that selects the normalised text. */
const SHAPE_READER = "readSourceShape";
const SHAPE_COLLAPSER = "collapseWhitespace";
const SHAPE_MEMBER = "shape";
const RAW_MEMBER = "raw";

/** `assert.match(text, pattern)` / `assert.doesNotMatch(text, pattern)`: the subject is the FIRST argument. */
const ASSERT_OBJECTS = new Set(["assert"]);
const ASSERT_MATCHERS = new Set(["match", "doesNotMatch"]);

/** `text.includes(pattern)` / `text.match(pattern)` / `text.search(pattern)`: the subject is the receiver. */
const STRING_MATCHERS = new Set(["match", "includes", "search"]);

/** What a value is, as far as layout sensitivity goes: the exact bytes, the normalised shape, or the pair. */
const RAW = "raw";
const SHAPE = "shape";
const PAIR = "pair";

/** A run that separates tokens: it carries at least one identifier or numeric character. */
const TOKEN_CHARACTER = /[\p{L}\p{N}_$]/u;

/** What each verdict exits with: a violation is a failure, and a scan that measured nothing is neither. */
const EXIT_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** Every `*.test.ts` under the scope, as repo-relative paths sorted so two runs read the same tree the same way. */
function populationFiles({ root = REPOSITORY_ROOT, scope = SCOPE } = {}) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(scope.suffix)) files.push(path);
    }
  };
  walk(join(root, scope.directory));
  return files.map((path) => path.slice(root.length + 1).replace(/\\/gu, "/")).sort();
}

/**
 * The pattern's token count: how many whitespace-separated runs it carries.
 *
 * A regex literal's body is read between its delimiters; `\s` and its quantifiers are replaced by a marker that is NOT
 * a separator (that pattern tolerates any whitespace, so reformatting cannot break it), while `\n`/`\t`/`\r` become a
 * literal space (that pattern demands exactly that whitespace, so reformatting CAN break it).
 */
export function patternTokens(text) {
  const body = text.startsWith("/")
    ? (/^\/([\s\S]*)\/[a-z]*$/u.exec(text)?.[1] ?? text)
    : text.replace(/^["'`]([\s\S]*)["'`]$/u, "$1");
  const runs = body
    .replace(/\\s[+*?]?/gu, "\u0001")
    .replace(/\\[nrt]/gu, " ")
    .split(/[ \t]+/u)
    .filter((run) => TOKEN_CHARACTER.test(run));
  return runs.length;
}

/** A code file a formatter owns: the only kind whose rewrap can break a pattern built from literal whitespace. */
const FORMATTER_OWNED = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)["'`)]/u;

/** The text a path argument names, resolving one hop through a variable that holds a literal. */
function pathText(node, context) {
  if (node === undefined) return null;
  const { typescript, sourceFile } = context;
  if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node))
    return node.getText(sourceFile);
  if (typescript.isIdentifier(node)) {
    const held = context.paths.get(node.text);
    return held === undefined ? null : pathText(held, context);
  }
  return node.getText(sourceFile);
}

/**
 * The reader call a value was taken from, if the chain leads to one: the SAME outward-in walk `qualityOf` makes, kept
 * beside it because the file a text came from decides whether a formatter can rewrap it.
 */
function readCallOf(node, context) {
  const { typescript } = context;
  if (node === undefined) return null;
  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isNonNullExpression(node) ||
    typescript.isAwaitExpression(node) ||
    typescript.isSatisfiesExpression(node)
  )
    return readCallOf(node.expression, context);
  if (typescript.isIdentifier(node)) return null;
  if (typescript.isCallExpression(node)) {
    const callee = node.expression;
    if (typescript.isIdentifier(callee) && (RAW_READERS.has(callee.text) || callee.text === SHAPE_READER)) return node;
    return readCallOf(callee, context);
  }
  if (typescript.isPropertyAccessExpression(node) || typescript.isElementAccessExpression(node))
    return readCallOf(node.expression, context);
  return null;
}
function patternText(node, context) {
  if (node === undefined) return null;
  if (context.typescript.isRegularExpressionLiteral(node)) return node.getText(context.sourceFile);
  if (context.typescript.isStringLiteral(node) || context.typescript.isNoSubstitutionTemplateLiteral(node))
    return node.getText(context.sourceFile);
  if (context.typescript.isIdentifier(node)) {
    const initializer = context.literals.get(node.text);
    return initializer === undefined ? null : patternText(initializer, context);
  }
  return null;
}

/**
 * What a value is: which of the reads it came from, and whether `.shape` or `.raw` was selected from the pair.
 *
 * The walk is outward-in over the expression's own chain, so `readFileSync(p, "utf8").split(/\n/u)` is raw text,
 * `readSourceShape(p).shape.split("\n")` is the normalised shape, and an identifier answers with what its initializer
 * was.
 */
function qualityOf(node, context) {
  const { typescript, bindings } = context;
  if (node === undefined) return null;
  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isNonNullExpression(node) ||
    // `await readFile(...)` holds the same text as `readFileSync(...)`. Without this the asynchronous reads leave the
    // population, and one of them (`continuity-semantic-game-runtime-materializer.test.ts`) went red on a rewrap while
    // this gate said nothing at all - the hole was found by the Host suite, not by the gate.
    typescript.isAwaitExpression(node) ||
    typescript.isSatisfiesExpression(node)
  )
    return qualityOf(node.expression, context);
  if (typescript.isIdentifier(node)) {
    if (RAW_READERS.has(node.text)) return RAW;
    if (node.text === SHAPE_READER) return PAIR;
    if (node.text === SHAPE_COLLAPSER) return SHAPE;
    return bindings.get(node.text)?.quality ?? null;
  }
  if (typescript.isCallExpression(node) || typescript.isElementAccessExpression(node))
    return qualityOf(node.expression, context);
  if (typescript.isPropertyAccessExpression(node)) {
    const base = qualityOf(node.expression, context);
    if (base !== PAIR) return base;
    if (node.name.text === SHAPE_MEMBER) return SHAPE;
    if (node.name.text === RAW_MEMBER) return RAW;
    return null;
  }
  return null;
}

/** A value written as a literal, so a pattern held in a variable can be read after one hop. */
function isLiteral(node, typescript) {
  return (
    typescript.isRegularExpressionLiteral(node) ||
    typescript.isStringLiteral(node) ||
    typescript.isNoSubstitutionTemplateLiteral(node)
  );
}

/**
 * The binding one destructured member introduces, when the pattern is `{ shape }` or `{ shape: name }`.
 *
 * `const { shape } = readSourceShape(p)` is the same choice `readSourceShape(p).shape` makes, so the name carries the
 * selected reading; without it the name is unknown and the match leaves the population, which is the fail-open this
 * gate exists to close.
 */
function destructuredMember(element, typescript) {
  if (!typescript.isIdentifier(element.name)) return null;
  const selected =
    element.propertyName !== undefined && typescript.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
  if (selected === SHAPE_MEMBER) return { name: element.name.text, quality: SHAPE };
  if (selected === RAW_MEMBER) return { name: element.name.text, quality: RAW };
  return null;
}

/** The reader call a value came from, following the same chain `qualityOf` reads. */
function readOf(node, context) {
  const { typescript, bindings } = context;
  if (node === undefined) return null;
  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isNonNullExpression(node) ||
    typescript.isAwaitExpression(node) ||
    typescript.isSatisfiesExpression(node)
  )
    return readOf(node.expression, context);
  if (typescript.isIdentifier(node)) return bindings.get(node.text)?.read ?? null;
  if (typescript.isCallExpression(node) || typescript.isElementAccessExpression(node))
    return readOf(node.expression, context);
  if (typescript.isPropertyAccessExpression(node)) return readOf(node.expression, context);
  return null;
}

/** Record what one `const <name> = <expression>` holds, when its expression resolves to a read. */
function recordDeclaration(node, bindings, context) {
  const { typescript, literals, paths } = context;
  if (!typescript.isVariableDeclaration(node) || node.initializer === undefined) return;
  if (typescript.isIdentifier(node.name)) {
    if (typescript.isStringLiteral(node.initializer) || typescript.isNoSubstitutionTemplateLiteral(node.initializer))
      paths.set(node.name.text, node.initializer);
  }
  const quality = qualityOf(node.initializer, context);
  const read = readCallOf(node.initializer, context);
  if (typescript.isObjectBindingPattern(node.name)) {
    if (quality !== PAIR) return;
    for (const element of node.name.elements) {
      const member = destructuredMember(element, typescript);
      if (member !== null) bindings.set(member.name, { quality: member.quality, read });
    }
    return;
  }
  if (!typescript.isIdentifier(node.name)) return;
  if (isLiteral(node.initializer, typescript)) literals.set(node.name.text, node.initializer);
  if (quality !== null) bindings.set(node.name.text, { quality, read });
}

/** Record what one `name = expression` assignment holds, for a binding declared without an initializer. */
function recordAssignment(node, bindings, context) {
  const { typescript } = context;
  if (!typescript.isBinaryExpression(node)) return;
  if (node.operatorToken.kind !== typescript.SyntaxKind.EqualsToken) return;
  if (!typescript.isIdentifier(node.left)) return;
  const quality = qualityOf(node.right, context);
  if (quality !== null) bindings.set(node.left.text, { quality, read: readCallOf(node.right, context) });
}

/** Every value in the file that a text read was assigned to, with what it is and which call produced it. */
function readBindings(sourceFile, typescript) {
  const bindings = new Map();
  const literals = new Map();
  const paths = new Map();
  const context = { typescript, sourceFile, bindings, literals, paths };
  const visit = (node) => {
    recordDeclaration(node, bindings, context);
    recordAssignment(node, bindings, context);
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { bindings, literals, paths };
}

/** The matcher calls in one file: the value judged, the pattern, and where it sits. */
function matcherSites(sourceFile, typescript) {
  const sites = [];
  const visit = (node) => {
    if (typescript.isCallExpression(node) && typescript.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const receiver = node.expression.expression;
      const receiverName = typescript.isIdentifier(receiver) ? receiver.text : null;
      if (ASSERT_OBJECTS.has(receiverName) && ASSERT_MATCHERS.has(name))
        sites.push({ subject: node.arguments[0], pattern: node.arguments[1], at: node });
      else if (STRING_MATCHERS.has(name)) sites.push({ subject: receiver, pattern: node.arguments[0], at: node });
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/**
 * The whole reading: every text read, and every match across tokens with the fidelity it was made against.
 *
 * `matches` carries one record per matcher call whose pattern separates two or more tokens and whose subject is a text
 * read; `notShape` is the subset that read the raw bytes instead of the normalised shape. `reads` is every read site,
 * including the reads no matcher touches, so the census distinguishes "no read" from "no layout claim".
 */
export function auditSourceShapeReaders({ root = REPOSITORY_ROOT, scope = SCOPE } = {}) {
  const typescript = createRequire(join(REPOSITORY_ROOT, "host", "package.json"))("typescript");
  const files = populationFiles({ root, scope });
  const matches = [];
  const unparsed = [];
  let reads = 0;
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const sourceFile = typescript.createSourceFile(
      file,
      source,
      typescript.ScriptTarget.Latest,
      true,
      typescript.ScriptKind.TS,
    );
    if (sourceFile.parseDiagnostics !== undefined && sourceFile.parseDiagnostics.length > 0) {
      unparsed.push(`${file}: ${String(sourceFile.parseDiagnostics[0].messageText)}`);
      continue;
    }
    const { bindings, literals, paths } = readBindings(sourceFile, typescript);
    const context = { typescript, sourceFile, bindings, literals, paths };
    typescript.forEachChild(sourceFile, function count(node) {
      if (
        typescript.isCallExpression(node) &&
        typescript.isIdentifier(node.expression) &&
        (RAW_READERS.has(node.expression.text) || node.expression.text === SHAPE_READER)
      )
        reads += 1;
      typescript.forEachChild(node, count);
    });
    for (const site of matcherSites(sourceFile, typescript)) {
      const quality = qualityOf(site.subject, context);
      if (quality === null) continue;
      const text = patternText(site.pattern, context);
      if (text === null) continue;
      const tokens = patternTokens(text);
      if (tokens < 2) continue;
      const readCall = readOf(site.subject, context);
      const path = readCall === null ? null : pathText(readCall.arguments[0], context);
      const { line } = sourceFile.getLineAndCharacterOfPosition(site.at.getStart(sourceFile));
      matches.push({
        file,
        line: line + 1,
        tokens,
        quality,
        path,
        formatted: path !== null && FORMATTER_OWNED.test(path),
        pattern: text.replace(/\s+/gu, " ").slice(0, 200),
      });
    }
  }
  // A prose file or a generated document has no formatter that will rewrap it, so a pattern across its tokens is not the
  // class this gate names. Those matches are counted (`notCode`) instead of judged.
  const code = matches.filter((entry) => entry.formatted);
  const notShape = code.filter((entry) => entry.quality !== SHAPE);
  return {
    files: files.length,
    reads,
    matches: code,
    notCode: matches.length - code.length,
    throughShape: code.length - notShape.length,
    notShape,
    findings: notShape.map(
      (entry) => `source_shape_read_from_raw_text:${entry.file}:${entry.line}:${entry.tokens}:${entry.pattern}`,
    ),
    unparsed,
  };
}

/** The verdict: a scan that read no file, or found no match across tokens, measured nothing and cannot pass. */
export function statusOf({ files, reads, matches, notShape, unparsed }) {
  if (files === 0 || reads === 0 || matches.length === 0) return "blocked";
  if (unparsed.length > 0) return "failed";
  return notShape.length > 0 ? "failed" : "passed";
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const json = argv.includes("--json");
  const reading = auditSourceShapeReaders({ root });
  const status = statusOf(reading);
  const checks = [
    {
      id: "test_files_examined",
      status: reading.files === 0 ? "blocked" : "passed",
      detail: `${reading.files} test file(s) under ${SCOPE.directory}`,
    },
    {
      id: "text_reads_found",
      status: reading.reads === 0 ? "blocked" : "passed",
      detail: `${reading.reads} read site(s) of a file's text`,
    },
    {
      id: "matches_across_tokens_found",
      status: reading.matches.length === 0 ? "blocked" : "passed",
      detail: `${reading.matches.length} match(es) whose pattern separates two or more tokens`,
    },
    {
      id: "every_match_reads_the_normalised_shape",
      status: reading.notShape.length === 0 ? "passed" : "failed",
      detail: `${reading.notShape.length} match(es) read the raw bytes`,
    },
    {
      id: "every_test_file_parsed",
      status: reading.unparsed.length === 0 ? "passed" : "failed",
      detail: `${reading.unparsed.length} unread file(s)`,
    },
  ];
  const report = {
    gate: "source-shape-readers",
    status,
    examined: reading.matches.length,
    files: reading.files,
    reads: reading.reads,
    throughShape: reading.throughShape,
    notShape: reading.notShape.length,
    checks,
    matches: reading.matches,
    findings: reading.findings,
    unparsed: reading.unparsed,
  };
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    process.stdout.write(
      `matches examined ${report.examined} · through the shape reader ${report.throughShape}` +
        ` · through raw text ${report.notShape} · reads ${report.reads} · files ${report.files}\n`,
    );
    for (const check of checks) process.stdout.write(`  ${check.id}: ${check.status} (${check.detail})\n`);
    for (const match of reading.matches)
      process.stdout.write(
        `  ${match.quality === SHAPE ? "shape" : "raw  "} ${match.file}:${match.line} ${match.pattern}\n`,
      );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  for (const finding of reading.findings) process.stderr.write(`${finding}\n`);
  for (const line of reading.unparsed) process.stderr.write(`test_file_unparsed: ${line}\n`);
  if (reading.files === 0 || reading.reads === 0)
    process.stderr.write(
      "source_shape_readers: no test file or no text read was found, so nothing can be judged; a green run reads both\n",
    );
  else if (reading.matches.length === 0)
    process.stderr.write(
      "source_shape_readers: no match across two tokens was found, which is a scan that lost its reader, not a class " +
        "that went away\n",
    );
  process.exitCode = EXIT_STATUS[status];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
