// The historian rubric's predicates, and the two things they must never do.
//
// They must catch the defects the prompt obligations exist to prevent (role labels, transcript
// references, internal markers, missing tiers), and they must NOT be a heuristic that passes everything:
// an obligation nothing can fail reads as coverage while measuring nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkHistorianRubric, identifyHistorianPrompt } from "./historian-rubric.mjs";

const compartment = (overrides) => ({
  sequence: 0,
  title: "We passed a quiet morning together",
  tiers: ["We walked the road and talked about the lanterns.", "A quiet morning.", "", ""],
  ...overrides,
});

test("a compartment written in the companion's voice breaks no obligation", () => {
  const result = checkHistorianRubric([compartment({})]);
  assert.equal(result.compartmentsChecked, 1);
  assert.deepEqual(result.violations, []);
});

test("the legacy third-person log voice fails, per compartment", () => {
  const result = checkHistorianRubric([
    compartment({ sequence: 3, title: "The player argued about shutters (msgs 4-6)" }),
    compartment({ sequence: 4, tiers: ["The assistant disagreed with the user.", "", "", ""] }),
  ]);
  assert.deepEqual(
    result.violations.map((violation) => `${violation.obligation}@${violation.where}`),
    ["no-role-labels@sequence 3", "no-transcript-references@sequence 3", "no-role-labels@sequence 4"],
  );
});

test("internal markers and missing content fail too", () => {
  const result = checkHistorianRubric([
    compartment({ sequence: 7, tiers: ["<thinking> plan </thinking>", "", "", ""] }),
    compartment({ sequence: 8, title: "   ", tiers: ["", "condensed", "", ""] }),
  ]);
  assert.deepEqual(
    result.violations.map((violation) => `${violation.obligation}@${violation.where}`),
    ["no-internal-markers@sequence 7", "title-present@sequence 8", "p1-present@sequence 8"],
  );
});

test("an empty run is reported as checked-zero, never as a pass", () => {
  const result = checkHistorianRubric([]);
  assert.equal(result.compartmentsChecked, 0);
  assert.deepEqual(result.violations, []);
  assert.ok(result.checkedObligations.length > 0);
  // Nothing to judge is not a green verdict: the count of zero is a fact about the input, not about the
  // narrative, and a caller reading only `violations` would see an empty list and call it clean.
  assert.equal(result.passed, false);
  assert.equal(checkHistorianRubric([compartment({})]).passed, true);
});

test("the prompt variant is read from the bundle the generation actually carries", () => {
  const root = mkdtempSync(join(tmpdir(), "rubric-variant-"));
  const dist = join(root, "generations", "g-test", "node_modules", "@cortexkit", "pi-magic-context", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "const prompt = `# Historian — Ongoing Interaction Memory Domain`;\n");
  assert.equal(identifyHistorianPrompt(root).variant, "legacy-third-person");

  writeFileSync(
    join(dist, "index.js"),
    'const prompt = `# Historian — Ongoing Interaction Memory Domain`;\nconst voice = `write "I" for the companion and "you" for the player`;\n',
  );
  const voiced = identifyHistorianPrompt(root);
  assert.equal(voiced.variant, "companion-voice");
  assert.equal(voiced.carrier, "index.js");

  rmSync(root, { recursive: true, force: true });
  // Nothing to read is "unknown", never a guess between the variants.
  assert.equal(identifyHistorianPrompt(root).variant, "unknown");
});
