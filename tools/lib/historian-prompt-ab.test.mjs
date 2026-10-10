// The A/B record for the historian voice change: two real folds, one table of obligations.
//
// `checkHistorianRubric` is the instrument; the fixture holds what each arm actually produced. The point of
// running it here rather than in prose is that the comparison is reproducible and the instrument is the same
// one a future prompt edit is measured with.
//
// What this is NOT: a single-session automated A/B. The two arms were recorded days apart, because building
// a generation with the other prompt revision needs the runtime tree and that build is currently blocked by
// another lane's `windows_bootstrap_guardian_dotnet_sdk_drift`. Each arm still comes from a real provider fold
// of the same fixture, and a re-run through `run-memory-live-loop.mjs` (with `--require-historian-rubric`)
// produces the same two fields per arm.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkHistorianRubric } from "./historian-rubric.mjs";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/historian-prompt-ab/voice-change.json", import.meta.url)),
    "utf8",
  ),
);
const arm = (variant) => fixture.arms.find((entry) => entry.variant === variant);

/**
 * A compartment as `readCompartments` hands it to the rubric.
 *
 * The recorded excerpts are PROSE only - the titles those folds produced were not captured - so a
 * placeholder title is supplied and the comparison is asserted on the prose obligations. The title
 * obligation is exercised by the synthetic cases in `historian-rubric.test.mjs`.
 */
const asCompartment = (entry) => ({
  sequence: 0,
  title: "(title not part of the recorded excerpt)",
  tiers: [entry.text, "", "", ""],
});

test("the legacy arm violated two obligations the voice change exists to fix", () => {
  const legacy = arm("legacy-third-person");
  assert.ok(legacy, "the legacy arm must be recorded");
  const result = checkHistorianRubric([asCompartment(legacy)]);
  assert.deepEqual(
    result.violations.map((violation) => violation.obligation),
    ["no-role-labels", "no-transcript-references"],
  );
});

test("the companion-voice arm violates no prose obligation", () => {
  const voiced = arm("companion-voice");
  assert.ok(voiced, "the voiced arm must be recorded");
  const result = checkHistorianRubric([asCompartment(voiced)]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.compartmentsChecked, 1);
});

test("every recorded arm names when and where it came from", () => {
  // An arm without provenance cannot be re-derived, and would turn this file into an assertion about
  // nothing. The schema check is deliberately about the fields a reader needs, not about exact wording.
  for (const entry of fixture.arms) {
    assert.match(entry.recorded, /\d{4}-\d{2}-\d{2}/u);
    assert.match(entry.recorded, /fold/u);
  }
});
