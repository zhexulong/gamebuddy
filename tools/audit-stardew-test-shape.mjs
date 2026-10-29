// Which tests in GameBuddy.Stardew.Integration.Tests pin repository source text?
//
// THE DEFINITION (one sentence, repeated in the project README and the commit):
//   A source-shape pin is a test whose body reads a repository file
//   (File.ReadAllText/ReadAllLines/ReadAllBytes) and asserts on its text
//   (Should().Contain/NotContain) instead of constructing and calling product code.
//
// A test that reaches the file through a helper declared in the same file counts too -
// the read and the assertion are the same act whether they are written inline or one
// call away. A test whose assertion is hidden inside a custom helper the reader cannot
// see through (`AssertLinesContain(...)`, `AssertRunner(...)`) is AMBIGUOUS: the
// sentence cannot decide it, so the file is reported and left alone.
//
// The population is derived from file content on every run, never from a list, so a new
// file is classified the moment it exists.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRAIT = '[Trait("kind", "source-shape")]';
export const MIXED_MARKER = "// MIXED SHAPE AND BEHAVIOUR:";
export const SHAPE_FILE_SUFFIX = "SourceShapeTests.cs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_DIRECTORY = path.join(ROOT, "integrations", "stardew", "tests", "GameBuddy.Stardew.Integration.Tests");

const READS_REPOSITORY_FILE = /\bFile\.(?:ReadAllText|ReadAllLines|ReadAllBytes)\s*\(/;
const ASSERTS_ON_TEXT = /\.Should\(\)\.(?:Contain|NotContain)\(/;

/** Blank out comments, keeping every index, so a slice of the result is the same slice of the source. */
export function stripComments(source) {
  const characters = [...source];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (character === '"' || character === "'") {
      const quote = character;
      index++;
      while (index < characters.length && characters[index] !== quote) {
        if (characters[index] === "\\") index++;
        index++;
      }
      continue;
    }
    if (character === "/" && characters[index + 1] === "/") {
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index++;
      }
      continue;
    }
    if (character === "/" && characters[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? characters.length : close + 2;
      for (; index < end; index++)
        if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
      index--;
    }
  }
  return characters.join("");
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    // Skip string and character literals: `'}'` and `"{"` are text, not braces.
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      index++;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") index++;
        index++;
      }
      continue;
    }
    if (text[index] === "{") depth++;
    else if (text[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const NOT_A_METHOD = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "return",
  "new",
  "nameof",
  "typeof",
  "when",
  "lock",
  "fixed",
]);

/** `name -> body` for every method declared in one file. The first declaration of a name wins. */
export function methodBodies(stripped) {
  const bodies = new Map();
  for (const match of stripped.matchAll(/([A-Za-z_]\w*)\s*(?:<[^;{}<>]*>)?\s*\(/g)) {
    const name = match[1];
    if (NOT_A_METHOD.has(name)) continue;
    let index = match.index + match[0].length - 1;
    let parens = 0;
    for (; index < stripped.length; index++) {
      if (stripped[index] === "(") parens++;
      else if (stripped[index] === ")") {
        parens--;
        if (parens === 0) break;
      }
    }
    if (parens !== 0) continue;
    const rest = stripped.slice(index + 1);
    const arrow = rest.search(/=>/);
    const brace = rest.indexOf("{");
    const semicolon = rest.indexOf(";");
    let body;
    if (arrow !== -1 && (brace === -1 || arrow < brace) && (semicolon === -1 || arrow < semicolon)) {
      body = rest.slice(arrow + 2, semicolon === -1 ? rest.length : semicolon + 1);
    } else if (brace !== -1 && (semicolon === -1 || brace < semicolon)) {
      const open = index + 1 + brace;
      const close = matchingBrace(stripped, open);
      if (close === -1) continue;
      body = stripped.slice(open, close + 1);
    } else continue;
    if (!bodies.has(name)) bodies.set(name, body);
  }
  return bodies;
}

/** Every `[Fact]`/`[Theory]` method in one file: its name and the body declared under that name. */
export function testMethods(stripped, bodies) {
  const starts = [...stripped.matchAll(/\[(?:Fact|Theory)\]/g)].map((match) => match.index);
  return starts.map((start, position) => {
    const slice = stripped.slice(start, starts[position + 1] ?? stripped.length);
    const signature = slice.match(
      /\b(?:public|internal)\s+(?:static\s+|async\s+|override\s+)*[\w<>\[\],\.\?\s]+?\s([A-Za-z_]\w*)\s*\(/,
    );
    const name = signature?.[1] ?? `#${position + 1}`;
    return { name, body: bodies.get(name) ?? slice };
  });
}

/** Names in this file whose body reaches a repository-file read, following same-file calls. */
function sourceReadingHelpers(bodies) {
  const reading = new Set();
  for (const [name, body] of bodies) if (READS_REPOSITORY_FILE.test(body)) reading.add(name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (reading.has(name)) continue;
      for (const call of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        if (!reading.has(call[1])) continue;
        reading.add(name);
        grew = true;
        break;
      }
    }
  }
  return reading;
}

const calledNames = (text) => [...text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]);

/**
 * Classify one file.
 *
 * - `pinCount`: tests that read repository source and assert `Contain`/`NotContain` on it.
 * - `ambiguous`: tests that read repository source but whose assertion lives in a custom
 *   helper (a same-file method holding the `Should().Contain`), so the sentence cannot say
 *   whether they are pins. The caller reports these and leaves the file alone.
 */
export function classifySource(source, fileName) {
  const stripped = stripComments(source);
  const bodies = methodBodies(stripped);
  const tests = testMethods(stripped, bodies);
  const reading = sourceReadingHelpers(bodies);

  const rows = tests.map((test) => {
    const reads = READS_REPOSITORY_FILE.test(test.body) || calledNames(test.body).some((name) => reading.has(name));
    if (!reads) return { name: test.name, kind: "behaviour" };
    if (ASSERTS_ON_TEXT.test(test.body)) return { name: test.name, kind: "pin" };
    const assertsInHelper = calledNames(test.body).some((name) => ASSERTS_ON_TEXT.test(bodies.get(name) ?? ""));
    return { name: test.name, kind: assertsInHelper ? "ambiguous" : "behaviour" };
  });

  const pinCount = rows.filter((row) => row.kind === "pin").length;
  const ambiguous = rows.filter((row) => row.kind === "ambiguous").map((row) => row.name);
  const kind =
    rows.length === 0
      ? "no-tests"
      : ambiguous.length > 0
        ? "ambiguous"
        : pinCount === 0
          ? "behaviour-only"
          : pinCount === rows.length
            ? "shape-only"
            : "mixed";
  return {
    file: fileName,
    kind,
    pinCount,
    testCount: rows.length,
    trait: source.includes(TRAIT),
    ambiguous,
    classComments: classComments(source),
    className: className(source),
  };
}

function className(source) {
  const match = source.match(
    /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal)\s+(?:sealed\s+|static\s+|partial\s+|abstract\s+)*class\s+(\w+)/m,
  );
  return match?.[1] ?? null;
}

/** The comment lines directly above the first class declaration. */
function classComments(source) {
  const lines = source.split(/\r?\n/);
  const declaration = lines.findIndex((line) =>
    /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal)\s+(?:sealed\s+|static\s+|partial\s+|abstract\s+)*class\s+\w+/.test(line),
  );
  if (declaration === -1) return [];
  const comments = [];
  for (let index = declaration - 1; index >= 0; index--) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("[")) {
      comments.unshift(trimmed);
      continue;
    }
    break;
  }
  return comments;
}

const WHY = 80;

export function auditStardewTestShape({ directory = PROJECT_DIRECTORY } = {}) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .sort();
  const rows = files.map((name) => classifySource(readFileSync(path.join(directory, name), "utf8"), name));
  const findings = [];

  for (const row of rows) {
    if (row.kind === "no-tests" || row.kind === "ambiguous") continue;
    if (row.kind === "behaviour-only") {
      if (row.trait)
        findings.push({
          file: row.file,
          rule: "trait_misdescribes",
          detail: `none of its ${row.testCount} tests pins source text, so ${TRAIT} would misdescribe what they do`,
        });
      continue;
    }
    if (row.kind === "shape-only") {
      if (!row.trait)
        findings.push({
          file: row.file,
          rule: "trait_missing",
          detail: `all ${row.testCount} of its tests pin source text, so the class must carry ${TRAIT}`,
        });
      if (!row.file.endsWith(SHAPE_FILE_SUFFIX))
        findings.push({
          file: row.file,
          rule: "name_not_shape",
          detail: `all ${row.testCount} of its tests pin source text, so the file must be named *${SHAPE_FILE_SUFFIX}`,
        });
      continue;
    }
    if (row.trait)
      findings.push({
        file: row.file,
        rule: "trait_misdescribes",
        detail: `${row.testCount - row.pinCount} of its ${row.testCount} tests exercise behaviour, so ${TRAIT} would misdescribe them`,
      });
    const marker = row.classComments.find((comment) => comment.startsWith(MIXED_MARKER));
    if (marker === undefined)
      findings.push({
        file: row.file,
        rule: "mixed_unstated",
        detail: `mixes ${row.pinCount} source-shape pins with ${row.testCount - row.pinCount} behaviour tests, so a "${MIXED_MARKER} ..." line must say so above the class`,
      });
    else if (marker.slice(MIXED_MARKER.length).trim().length < WHY)
      findings.push({
        file: row.file,
        rule: "mixed_why_missing",
        detail: `"${MIXED_MARKER}" needs ${WHY}+ characters saying why this file holds both kinds`,
      });
  }

  const count = (kind) => rows.filter((row) => row.kind === kind).length;
  return {
    fileCount: rows.length,
    shapeOnly: count("shape-only"),
    mixed: count("mixed"),
    behaviourOnly: count("behaviour-only"),
    ambiguous: count("ambiguous"),
    noTests: count("no-tests"),
    pins: rows.reduce((total, row) => total + row.pinCount, 0),
    tests: rows.reduce((total, row) => total + row.testCount, 0),
    rows,
    findings: findings.sort((left, right) => `${left.file}${left.rule}`.localeCompare(`${right.file}${right.rule}`)),
  };
}

function main() {
  const report = auditStardewTestShape();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.length === 0 ? 0 : 1;
  }
  if (process.argv.includes("--list")) {
    for (const kind of ["shape-only", "mixed", "behaviour-only", "ambiguous"]) {
      console.log(`--- ${kind}`);
      for (const row of report.rows.filter((candidate) => candidate.kind === kind)) {
        const why = row.ambiguous.length > 0 ? ` (${row.ambiguous.join(", ")})` : "";
        console.log(`  ${row.file} ${row.pinCount}/${row.testCount}${why}`);
      }
    }
    return report.findings.length === 0 ? 0 : 1;
  }
  console.log(
    `integration test files: ${report.fileCount} - ${report.tests} tests, ${report.pins} of them source-shape pins`,
  );
  console.log(
    `shape-only ${report.shapeOnly} | mixed ${report.mixed} | behaviour-only ${report.behaviourOnly} | ambiguous ${report.ambiguous} | no tests ${report.noTests}`,
  );
  if (report.findings.length === 0) {
    console.log("shape: ok (every class states which kind it holds)");
    return 0;
  }
  console.log(`shape: ${report.findings.length} finding(s)`);
  for (const finding of report.findings) console.log(`  [${finding.rule}] ${finding.file}: ${finding.detail}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
