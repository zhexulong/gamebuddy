/*
 * red-proof: inject  the real entry point is copied into a scratch directory and given a `package.json`
 * with a `run:silent` script whose file states no claim: `node eval.mjs` there exits 1 and prints
 * `eval_undocumented: run:silent`; two `run:` scripts naming one documented file exits 1 and prints
 * `eval_duplicate_claim: run:alpha and run:beta`, while the well-formed map over the same reader exits 0.
 * The violations are written by this file and read back out of the listing the reader produced, not out of
 * a return value the reader and the test both already agree on (tools/eval.test.mjs).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claimOf, deriveInstruments } from "./eval.mjs";

const documented = `/**\n * The claim this instrument settles, in one sentence.\n *\n * More prose that is not part of the claim.\n */\nconsole.log("x");\n`;
const undocumented = `import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\n`;

/** The entry point as it sits on disk: the same bytes, so what runs here is the reader, not a copy of its rules. */
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "eval.mjs");

/**
 * The real entry point, run over a fabricated `package.json`.
 *
 * The listing derives its root from its own location - `tools/eval.mjs` means the directory above `tools/` - so
 * the only way to hand it a script map is to hand it a directory: the entry is copied to `tools/eval.mjs` there
 * byte for byte, the manifest is written beside it, and the process is spawned. What the test asserts is the exit
 * code and the line the reader printed, which no stub inside this file can produce on its behalf.
 */
function runInstrumentListing(scripts, files = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "eval-instruments-"));
  try {
    mkdirSync(join(scratch, "tools"), { recursive: true });
    copyFileSync(ENTRY, join(scratch, "tools", "eval.mjs"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ scripts }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(scratch, name)), { recursive: true });
      writeFileSync(join(scratch, name), text);
    }
    const result = spawnSync(process.execPath, [join(scratch, "tools", "eval.mjs")], { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("a claim is read from the header, not from any comment in the file", () => {
  const cited = `import { x } from "y";\n\n/* A comment that cites a reference later in the file. */\nconsole.log(x);\n`;
  assert.equal(
    claimOf(cited),
    null,
    "a `//` or `/* */` line after the first statement is not a header, and must not become the claim",
  );
  assert.equal(
    claimOf(`#!/usr/bin/env node\n// The claim, stated on the line after the shebang.\nconsole.log(1);\n`),
    "The claim, stated on the line after the shebang.",
    "a shebang is not a statement, so the comment after it is still the header",
  );
});

test("the claim is the first sentence of the header, not the whole comment", () => {
  assert.equal(
    claimOf(documented),
    "The claim this instrument settles, in one sentence.",
    "the listing shows one sentence per instrument; a whole paragraph is unreadable in a list",
  );
  assert.equal(claimOf(undocumented), null, "a file with no leading comment states no claim");
});

test("a file with no header comment is reported, never paraphrased", () => {
  const { instruments, undocumented: gaps } = deriveInstruments({
    scripts: { "run:silent": "node tools/silent.mjs" },
    root: "/nonexistent-root",
  });
  assert.deepEqual(instruments, [], "a file that cannot be read is not an instrument we can name");
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].why, /could not be read/u);
});

test("two instruments claiming one sentence are reported as one finding", () => {
  /* Both names resolve to the same readable file, so both read the same claim. */
  const { duplicate } = deriveInstruments({
    scripts: { "run:alpha": "node tools/eval.mjs", "run:beta": "node tools/eval.mjs" },
    root: process.cwd(),
  });
  assert.equal(duplicate.length, 1, "the same claim under two names is a copy, and must be named");
  assert.equal(duplicate[0].first, "run:alpha");
  assert.equal(duplicate[0].second, "run:beta");
});

test("the kind decides the listing, and an unknown prefix is not an instrument", () => {
  const { instruments } = deriveInstruments({
    scripts: {
      "run:mine": "node tools/eval.mjs",
      "test:perf-mine": "node tools/perf/budget.test.mjs",
      "test:unrelated": "node --test tools/eval.test.mjs",
      "check:mine": "node tools/eval.mjs",
    },
    root: process.cwd(),
  });
  const names = instruments.map((entry) => entry.name);
  assert.deepEqual(names.sort(), ["run:mine", "test:perf-mine"], "only the instrument prefixes are listed");
  assert.equal(
    instruments.find((entry) => entry.name === "test:perf-mine").kind,
    "scale",
    "a perf budget is a scale instrument, not an effect one",
  );
});

test("a clean script map exits zero and lists the instrument with its claim", () => {
  const { status, output } = runInstrumentListing(
    { "run:documented": "node tools/documented.mjs" },
    { "tools/documented.mjs": documented },
  );
  assert.equal(status, 0, "a listing with nothing to report must not red the `pnpm eval` entry point for every reader");
  assert.match(output, /eval_instruments total=1 undocumented=0 duplicate_claims=0/u);
  assert.match(output, /The claim this instrument settles, in one sentence\./u);
});

test("a `run:` script whose file states no claim fails the entry point and names it", () => {
  const { status, output } = runInstrumentListing(
    { "run:silent": "node tools/silent.mjs" },
    { "tools/silent.mjs": undocumented },
  );
  assert.equal(status, 1, "an instrument nobody can describe is a defect in the instrument, so the listing is red");
  assert.match(
    output,
    /eval_undocumented: run:silent - the entry file carries no header comment stating its claim \(tools\/silent\.mjs\)/u,
    "the finding names the script and the file, so the reader knows which instrument to document",
  );
});

test("two `run:` scripts claiming one sentence fail the entry point and name both", () => {
  const { status, output } = runInstrumentListing(
    { "run:alpha": "node tools/documented.mjs", "run:beta": "node tools/documented.mjs" },
    { "tools/documented.mjs": documented },
  );
  assert.equal(status, 1, "one claim under two names is a copy, and nothing keeps the two in step");
  assert.match(
    output,
    /eval_duplicate_claim: run:alpha and run:beta both claim "The claim this instrument settles, in one sentence\."/u,
    "the finding names both names and the sentence they share",
  );
});
