/**
 * The ratchet's predicate, planted against.
 *
 * `check-test-typecheck-ratchet.mjs` is only worth wiring if the comparison it makes really
 * names the error that grew: a gate whose failure output is "the count changed" is a gate
 * nobody repairs. These tests run the exact functions the CLI runs, over synthetic tsc output,
 * so the planted cases are deterministic and do not depend on how red the real test project
 * happens to be today.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { countsByCode, parseErrors, ratchet } from "./check-test-typecheck-ratchet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(HERE, "test-typecheck-baseline.json"), "utf8"));

const line = (file, lineNumber, code, message) => `${file}(${lineNumber},1): error ${code}: ${message}`;

test("baseline.1: the recorded baseline is internally consistent and names the revision it came from", () => {
  const sum = Object.values(BASELINE.codes).reduce((total, count) => total + count, 0);
  assert.equal(sum, BASELINE.total, "the per-code counts must add up to the recorded total");
  assert.match(BASELINE.revision, /^[0-9a-f]{7,}$/u, "the baseline names the revision it was recorded from");
});

test("ratchet.1: a new error of a code the baseline never had is the finding, with file:line", (t) => {
  // The defect this gate exists for: a real TS2304 in a production file, invisible because the
  // test project was already red. The baseline below is the shape of the real one - errors of
  // other codes, no TS2304 at all.
  const baseline = { codes: { TS2322: 35, TS2532: 25 }, total: 60 };
  const errors = parseErrors(
    [
      line("src/game-tools.test.ts", 100, "TS2322", "Type 'a' is not assignable to type 'b'."),
      line("src/stardew-game-integration-adapter.ts", 412, "TS2304", "Cannot find name 'sessionId'."),
    ].join("\n"),
  );
  const result = ratchet({ baseline, errors });
  assert.deepEqual(result.grew, ["TS2304"], "the code that grew is the new code");
  assert.deepEqual(
    result.reported.map((error) => `${error.file}:${error.line} ${error.code}: ${error.message}`),
    ["src/stardew-game-integration-adapter.ts:412 TS2304: Cannot find name 'sessionId'."],
    "the failure names the new error's file and line, so the 181st error is not left to be diffed by hand",
  );
  t.diagnostic(`ratchet.1: planted TS2304 -> ${result.reported[0].file}:${result.reported[0].line}`);
});

test("ratchet.2: one more error of a code the baseline already carries grows that code", (t) => {
  const baseline = { codes: { TS2322: 35 }, total: 35 };
  const grown = ratchet({
    baseline,
    errors: Array.from({ length: 36 }, () => ({ file: "src/x.test.ts", line: 1, column: 1, code: "TS2322", message: "m" })),
  });
  assert.deepEqual(grown.grew, ["TS2322"], "the code grew past its recorded count");
  assert.equal(grown.reported.length, 36, "every current error of the grown code is reported");
  t.diagnostic("ratchet.2: 35 -> 36 is a finding");
});

test("ratchet.3: errors that disappear are never a finding", () => {
  const baseline = { codes: { TS2322: 35, TS2307: 2 }, total: 37 };
  const result = ratchet({ baseline, errors: [{ file: "src/x.test.ts", line: 1, column: 1, code: "TS2322", message: "m" }] });
  assert.deepEqual(result.grew, [], "a ratchet only turns one way");
  assert.deepEqual(ratchet({ baseline, errors: [] }).grew, [], "a project that got greener is green");
});

test("ratchet.4: an empty baseline is not a disarmed gate", () => {
  // The disarmament this catches: deleting the baseline file's contents so nothing can grow.
  // With an empty baseline the very next run fails on every code the project carries.
  const result = ratchet({
    baseline: { codes: {}, total: 0 },
    errors: [{ file: "src/x.test.ts", line: 3, column: 4, code: "TS2322", message: "m" }],
  });
  assert.deepEqual(result.grew, ["TS2322"]);
  assert.equal(result.reported[0].line, 3, "the unnamed baseline reports the site it found");
});

test("ratchet.5: a tsc line that is not an error diagnostic is not an error", () => {
  const errors = parseErrors(
    [
      "src/action-registry.ts(765,1): error TS1109: Expression expected.",
      "src/x.ts(1,1): warning TS9999: a warning is not an error",
      "Found 2 errors in the same file, starting at: src/x.ts:1",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    errors.map((error) => `${error.file}:${error.line}:${error.column} ${error.code}`),
    ["src/action-registry.ts:765:1 TS1109"],
  );
  assert.deepEqual(countsByCode(errors), { TS1109: 1 }, "the counts are read off the parsed errors");
});
