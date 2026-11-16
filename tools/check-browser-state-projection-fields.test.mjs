/**
 * The falsifiers for `check-browser-state-projection-fields.mjs`.
 *
 * Each case mutates a COPY of the two files the gate reads and asks the gate for its verdict. The claims:
 *
 *   1. THE TREE PASSES, with the population printed: the `game` projection's own field set, from the contract.
 *   2. THE LITERAL IS RED - and named twice, because it is two defects: a field no input can change
 *      (`published_field_is_a_constant`) and a count the producer wrote for itself
 *      (`published_field_reports_a_zero_it_did_not_measure`). The second is what a "fixed" field that answers
 *      `{count: 0}` when its source is absent still is.
 *   3. AN EXEMPTION EXPIRES: a declared-unpublished field that starts being derived is
 *      `stale_constant_field_reason`, so the list cannot become a place facts go to be forgotten.
 *   4. BOTH DIRECTIONS OF THE CONTRACT are policed: a contract field the producer never writes, and a producer field the
 *      contract does not declare.
 *
 * red-proof: inject  the capability summary's producer rewritten to a literal in a copy of the tree ->
 *   `published_field_is_a_constant` and `published_field_reports_a_zero_it_did_not_measure` naming the field
 *   (tools/check-browser-state-projection-fields.test.mjs)
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditBrowserStateProjection,
  CONTRACT_PATH,
  isConstantExpression,
  numericLiterals,
  PRODUCER_PATH,
  UNPUBLISHED_PROJECTION_FIELDS,
} from "./check-browser-state-projection-fields.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureTree(t) {
  const root = mkdtempSync(join(tmpdir(), "browser-projection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [CONTRACT_PATH, PRODUCER_PATH]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, file), join(root, file));
  }
  return root;
}

function rewrite(root, path, replace) {
  const target = join(root, path);
  const before = readFileSync(target, "utf8");
  const after = replace(before);
  assert.notEqual(after, before, `the fixture injection changed nothing in ${path}, so the case proves nothing`);
  writeFileSync(target, after);
}

const codes = (reading) => reading.violations.map((violation) => violation.code);

test("the tree passes: every field of the game projection follows a live fact or states why it cannot", () => {
  const reading = auditBrowserStateProjection({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", `the real tree is red: ${codes(reading).join(", ")}`);
  assert.ok(reading.examined > 0, "the contract's `game` projection was not read, which is a blocked reading");
  // The population is the contract's, so a field added there is judged without an edit here. Printed, not assumed.
  assert.ok(
    reading.examined >= 12,
    `examined ${String(reading.examined)} field(s) of the game projection: ${String(reading.derived)} derived`,
  );
  assert.equal(
    reading.constant,
    Object.keys(UNPUBLISHED_PROJECTION_FIELDS).length,
    `every constant field is declared and every declaration is a constant field: ${codes(reading).join(", ")}`,
  );
});

test("the literal is red twice: a field no input can change, and a zero nobody measured", (t) => {
  const root = fixtureTree(t);
  rewrite(root, PRODUCER_PATH, (source) =>
    source.replace(
      "capabilitySummary: projectCapabilitySummary(capability),",
      "capabilitySummary: Object.freeze({ available: false, count: 0 }),",
    ),
  );
  const reading = auditBrowserStateProjection({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading).sort(), [
    `published_field_is_a_constant:capabilitySummary:${PRODUCER_PATH}`,
    `published_field_reports_a_zero_it_did_not_measure:capabilitySummary:${PRODUCER_PATH}`,
  ]);
});

test("a derived field that answers 0 when its source is absent is still red", (t) => {
  const root = fixtureTree(t);
  // The half-fix: the shape is derived, so the constant rule is silent - and the projection still says "0 capabilities"
  // for a layer that could not read the count at all.
  rewrite(root, PRODUCER_PATH, (source) =>
    source.replace(
      "capabilitySummary: projectCapabilitySummary(capability),",
      'capabilitySummary: capability === undefined ? Object.freeze({ status: "not_measured", count: 0 }) : Object.freeze({ status: "published", count: capability.count }),',
    ),
  );
  const reading = auditBrowserStateProjection({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), [
    `published_field_reports_a_zero_it_did_not_measure:capabilitySummary:${PRODUCER_PATH}`,
  ]);
  assert.match(reading.violations[0].detail, /writes the number\(s\) 0/u, "the finding names the number");
});

test("an exemption for a field that now follows a live fact has expired", (t) => {
  const root = fixtureTree(t);
  rewrite(root, PRODUCER_PATH, (source) =>
    source.replace("role: null,", 'role: attachment.status === "none" ? null : "companion",'),
  );
  const reading = auditBrowserStateProjection({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["stale_constant_field_reason:role"]);
});

test("a declared reason with nothing written in it is a declaration without a decision", () => {
  const reading = auditBrowserStateProjection({
    root: REPOSITORY_ROOT,
    declarations: {
      ...UNPUBLISHED_PROJECTION_FIELDS,
      role: { reason: "   ", owedBy: "host/src/stardew-role-lifecycle-facade.ts" },
    },
  });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["constant_field_without_a_reason:role"]);
});

test("a declared constant is excused whatever its literal value, and only a constant one", (t) => {
  // The declaration is about "no input can change this", not about the particular word: a selected save the surface
  // cannot publish is excused as `null` or as a label, and what makes it wrong is being derived while the reason stays.
  const root = fixtureTree(t);
  rewrite(root, PRODUCER_PATH, (source) => source.replace("selectedSave: null,", 'selectedSave: "Spring Year 2",'));
  assert.equal(auditBrowserStateProjection({ root }).status, "passed");
});

test("both directions of the contract are policed", (t) => {
  const missing = fixtureTree(t);
  rewrite(missing, PRODUCER_PATH, (source) => source.replace(/\n\s*selectedSave: null,/u, ""));
  assert.deepEqual(codes(auditBrowserStateProjection({ root: missing })), [
    `projection_field_unproduced:selectedSave:${PRODUCER_PATH}`,
  ]);

  const foreign = fixtureTree(t);
  rewrite(foreign, PRODUCER_PATH, (source) =>
    source.replace(/\n(\s*)selectedSave: null,/u, '\n$1selectedSave: null,\n$1invented: "x",'),
  );
  assert.ok(
    codes(auditBrowserStateProjection({ root: foreign })).includes(
      `projection_field_not_in_contract:invented:${PRODUCER_PATH}`,
    ),
    "a producer field the contract does not declare is a value no consumer can read",
  );
});

test("a contract with no game projection is blocked, never green", (t) => {
  const root = fixtureTree(t);
  rewrite(root, CONTRACT_PATH, (source) =>
    source.replace("export const GameBrowserStateV1Schema", "export const SomethingElseSchema"),
  );
  const reading = auditBrowserStateProjection({ root });
  assert.equal(reading.status, "blocked");
  assert.equal(reading.examined, 0);
});

test("a literal is decided by shape, and a number is found outside strings only", () => {
  for (const literal of ["null", "false", "0", '"x"', "Object.freeze({ a: null, b: 0 })", "[]", "[null, 0]"])
    assert.equal(isConstantExpression(literal), true, `${literal} is a literal`);
  for (const derived of ["attachment.status", 'a?.b ?? "unavailable"', "Object.freeze({ x: a })", "f(1)"])
    assert.equal(isConstantExpression(derived), false, `${derived} follows an input`);

  assert.deepEqual(numericLiterals('Object.freeze({ status: "not_measured", count: 0 })'), ["0"]);
  assert.deepEqual(numericLiterals('Object.freeze({ status: "published", count: capability.count })'), []);
  // Digits inside a string are words, not numbers: `not_measured` must never read as a measurement.
  assert.deepEqual(numericLiterals('Object.freeze({ status: "v2", reason: "no_reader_2" })'), []);
});
