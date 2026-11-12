// red-proof: history  the raw-text signature match as it shipped at 1c38ab9d in
//   `host/src/containment/runtime/contained-game-runtime.internal.test.ts` replayed -> `source_shape_read_from_raw_text:
//   ...:205:5` and `:209:3`, status `failed` (tools/check-source-shape-readers.test.mjs)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditSourceShapeReaders, patternTokens, statusOf } from "./check-source-shape-readers.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-source-shape-readers.mjs");

/** The revision the failing assertion shipped at: its raw-text signature match went red on a reformat, not on a change. */
const PRE_FIX_REVISION = "1c38ab9d";
const PRE_FIX_TEST = "host/src/containment/runtime/contained-game-runtime.internal.test.ts";

/** One throwaway root holding the given test files, keyed by their path inside it. */
function rootWith(files) {
  const root = mkdtempSync(join(tmpdir(), "source-shape-readers-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents, "utf8");
  }
  return root;
}

/** The reading for one fixture, with the root removed again. */
function readingFor(files) {
  const root = rootWith(files);
  try {
    return auditSourceShapeReaders({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The gate CLI over a fixture root: what an operator sees, including the exit status. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root, "--json"], { encoding: "utf8" });
  return { status: result.status, report: JSON.parse(String(result.stdout).trim()), stderr: String(result.stderr) };
}

const RAW_READ = 'const source = readFileSync("product.ts", "utf8");';
const SHAPE_READ = [
  'import { readSourceShape } from "./test-support/source-shape.test-support.js";',
  'const { shape } = readSourceShape("product.ts");',
];

/**
 * The defect itself: the committed bytes are matched against a pattern that separates three tokens with spaces, so the
 * assertion measures where the formatter put the line breaks. The finding has to name the file, the line, how many
 * tokens the pattern spans and the pattern, because "one assertion measures layout" is a number a reader cannot act on.
 */
test("a raw read matched across three tokens is named with its file, its line, its token count and its pattern", () => {
  const reading = readingFor({
    "host/src/assertion.test.ts": [
      'import { readFileSync } from "node:fs";',
      RAW_READ,
      "assert.match(source, /launchRole\\(role, launchOperation: RoleLaunchOperation\\)/);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, [
    "source_shape_read_from_raw_text:host/src/assertion.test.ts:3:3:/launchRole\\(role, launchOperation: RoleLaunchOperation\\)/",
  ]);
  assert.equal(reading.throughShape, 0);
  assert.equal(reading.notShape.length, 1);
  assert.equal(statusOf(reading), "failed");
});

/** The sanctioned shape: the same pattern, over the value the helper normalised. Nothing about the claim changed. */
test("the same pattern over the normalised shape is not a finding", () => {
  const reading = readingFor({
    "host/src/shape.test.ts": [
      ...SHAPE_READ,
      "assert.match(shape, /launchRole\\(role, launchOperation: RoleLaunchOperation\\)/);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.matches.length, 1, "the match is still in the population: it is examined, not excused");
  assert.equal(reading.throughShape, 1);
  assert.equal(statusOf(reading), "passed");
});

/** Selecting the member directly is the same choice as destructuring it, and the gate reads both. */
test("shape selected from the pair without destructuring is read the same way", () => {
  const reading = readingFor({
    "host/src/direct.test.ts": [
      'import { readSourceShape } from "./test-support/source-shape.test-support.js";',
      'const text = readSourceShape("product.ts");',
      "assert.match(text.shape, /launchRole\\(role, launchOperation\\)/);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.throughShape, 1);
});

/** A read a member call produced - `.split(/\r?\n/u)` - is still that read's text, not a new value. */
test("a read whose member calls produced the matched value keeps the read's fidelity", () => {
  const reading = readingFor({
    "host/src/chain.test.ts": [
      'import { readFileSync } from "node:fs";',
      'const lines = readFileSync("product.ts", "utf8").split(/\\r?\\n/u);',
      "assert.ok(lines.includes('const authorization: InternalAuthorization'));",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, [
    "source_shape_read_from_raw_text:host/src/chain.test.ts:3:3:'const authorization: InternalAuthorization'",
  ]);
});

/**
 * The false-GREEN direction, which is worse than the red one: after a rewrap this assertion passes without ever having
 * matched, so a product change it was written to prevent arrives silently. A negative match is a layout claim too.
 */
test("negative and membership matches across tokens over raw text are findings", () => {
  const reading = readingFor({
    "host/src/negative.test.ts": [
      'import { readFileSync } from "node:fs";',
      RAW_READ,
      "assert.doesNotMatch(source, /encodePrivateFacts or privateFrame/);",
      "assert.equal(source.includes('kind: \"enter\" as const'), false);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, [
    "source_shape_read_from_raw_text:host/src/negative.test.ts:3:3:/encodePrivateFacts or privateFrame/",
    "source_shape_read_from_raw_text:host/src/negative.test.ts:4:4:'kind: \"enter\" as const'",
  ]);
});

/** A pattern that already tolerates whitespace survives a rewrap, so it is not in the population. */
test("a pattern that tolerates any whitespace between its tokens is not a finding", () => {
  const reading = readingFor({
    "host/src/tolerant.test.ts": [
      'import { readFileSync } from "node:fs";',
      RAW_READ,
      "assert.match(source, /launchRole\\(\\s*role,\\s*launchOperation/);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.deepEqual(
    reading.matches,
    [],
    "no literal whitespace separates the pattern's tokens, so it is one token wide and outside the population",
  );
});

/**
 * The boundary the supervisor set, encoded rather than exempted: seeking a single marker whose POSITION carries meaning
 * may read the committed bytes. `indexOf("\\n}")` locates a brace in column 0; there is no token inside it to reflow.
 */
test("a single-token seek in raw text is not a finding", () => {
  const reading = readingFor({
    "host/src/markers.test.ts": [
      'import { readFileSync } from "node:fs";',
      RAW_READ,
      'const declared = source.indexOf("Read-BoundedUtf8Frame");',
      'const closeBrace = source.indexOf("\\n}", declared);',
      "assert.ok(declared < closeBrace);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.matches.length, 0, "a one-token seek is outside the population by construction");
});

/**
 * The stated gap: a value the gate cannot follow through an unknown call leaves the population. It is asserted here so
 * the boundary is a decision a reader can see, not a silent hole - and a new helper would be added to the recognised
 * pair rather than left here.
 */
test("a value passed through a call the gate cannot resolve is outside the population", () => {
  const reading = readingFor({
    "host/src/opaque.test.ts": [
      'import { readFileSync } from "node:fs";',
      RAW_READ,
      "const decorated = decorate(source);",
      "assert.match(decorated, /launchRole\\(role, launchOperation\\)/);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.matches.length, 0);
});

/** A scan that lost its reader must not agree with itself: no match at all is `blocked`, never `passed`. */
test("a tree whose test files read no text is blocked rather than green", () => {
  const reading = readingFor({ "host/src/quiet.test.ts": "assert.equal(1, 1);" });
  assert.equal(reading.files, 1);
  assert.equal(reading.reads, 0);
  assert.equal(statusOf(reading), "blocked");
});

/** The CLI's three answers: a violation fails, an unmeasured tree blocks, a routed population passes. */
test("the gate exits 0 passed, 1 failed and 2 blocked on a throwaway root", () => {
  const passing = rootWith({
    "host/src/pass.test.ts": [...SHAPE_READ, "assert.match(shape, /launchRole\\(role, launchOperation\\)/);"].join(
      "\n",
    ),
  });
  const failing = rootWith({
    "host/src/fail.test.ts": ['import { readFileSync } from "node:fs";', RAW_READ, "assert.match(source, /a b/);"].join(
      "\n",
    ),
  });
  const blocked = rootWith({ "host/src/empty.test.ts": "assert.equal(1, 1);" });
  try {
    const passed = runGate(passing);
    assert.equal(passed.status, 0, String(passed.stderr));
    assert.equal(passed.report.status, "passed");
    assert.equal(passed.report.examined, 1);

    const failed = runGate(failing);
    assert.equal(failed.status, 1);
    assert.equal(failed.report.status, "failed");
    assert.deepEqual(failed.report.findings, ["source_shape_read_from_raw_text:host/src/fail.test.ts:3:2:/a b/"]);
    assert.match(failed.stderr, /source_shape_read_from_raw_text:host\/src\/fail\.test\.ts:3:2/u);

    const unmeasured = runGate(blocked);
    assert.equal(unmeasured.status, 2, "a scan that measured nothing exits 2");
    assert.equal(unmeasured.report.status, "blocked");
    assert.match(unmeasured.stderr, /no text read was found/u);
  } finally {
    for (const root of [passing, failing, blocked]) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Red on real history rather than on an invented sample: the assertion that failed on 2026-11-12 is replayed from the
 * revision it shipped at, and the gate names it. The product was never wrong - the formatter folded a signature.
 */
test("the shipped raw-text signature match is named when the revision it shipped at is read", () => {
  const shipped = execFileSync("git", ["show", `${PRE_FIX_REVISION}:${PRE_FIX_TEST}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  const reading = readingFor({ [PRE_FIX_TEST]: shipped });
  assert.deepEqual(reading.findings, [
    "source_shape_read_from_raw_text:" +
      "host/src/containment/runtime/contained-game-runtime.internal.test.ts:205:5:" +
      "/launchRole\\(role, launchOperation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer\\)/",
    "source_shape_read_from_raw_text:" +
      "host/src/containment/runtime/contained-game-runtime.internal.test.ts:209:3:" +
      "/const authorization: InternalAuthorization/",
  ]);
  assert.equal(statusOf(reading), "failed");
});

/** The token count is the whole rule, so it is pinned on its own: literal whitespace separates, `\s` does not. */
test("a pattern's token count separates on the whitespace it matches literally", () => {
  assert.equal(patternTokens("/launchRole\\(role\\)/u"), 1);
  assert.equal(patternTokens("/launchRole\\(role, launchOperation\\)/u"), 2);
  assert.equal(
    patternTokens("/a\\s+ b/u"),
    2,
    "the escape is not a separator; the literal space between it and `b` is",
  );
  assert.equal(patternTokens("/a\\s+b/u"), 1);
  assert.equal(patternTokens('/kind: "enter" as const/u'), 4);
  assert.equal(patternTokens("if \\(x\\) \\{ return \\$null \\}"), 4, "a string pattern is counted the same way");
  assert.equal(patternTokens("/\\) \\{/u"), 0, "punctuation alone is not a token");
});
