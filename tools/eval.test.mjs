/*
 * red-proof: inject  `deriveInstruments` is fed three hand-built script maps in this file. The first
 * is a well-formed instrument and yields one entry; the second drops the header comment and yields
 * `eval_undocumented`; the third gives two scripts the same claim and yields `eval_duplicate_claim`.
 * Running the real entry point over a scratch copy of `package.json` with a `run:` script whose file
 * carries no comment exits 1 and names it - the same violation, produced by the real reader rather
 * than by a stub, so the listing cannot pass by describing scripts it never read.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { claimOf, deriveInstruments } from "./eval.mjs";

const documented = `/**\n * The claim this instrument settles, in one sentence.\n *\n * More prose that is not part of the claim.\n */\nconsole.log("x");\n`;
const undocumented = `import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\n`;

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
