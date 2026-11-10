// Falsifiers for the receipt transition-field provenance gate.
//
// Every case drives the real gate implementation: either over the committed sources (the two fabricated deltas
// re-injected at the exact lines they shipped on) or over a synthetic Mod root, so a passing suite says the gate
// reads its population rather than recognising its own output.
//
// red-proof: inject  `before = "none"` and `chunk_removed=true` re-injected into the committed sources -> one
//                    `fabricated_delta` naming each exact line; a satisfied allowance -> `stale_allowance_entry`;
//                    a builder with no transition field -> `gate_measured_nothing` blocked
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkStardewReceiptTransitionProvenance,
  extractBindingLiterals,
  extractTransitionFields,
  LITERAL_TRANSITION_ALLOWANCES,
  MOD_ROOT,
  receiptBuilderFiles,
  stripComments,
} from "./audit-stardew-receipt-transition-fields.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const TILL = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
const PICKUP = "integrations/stardew/farmhandexecutioncontroller.cs";
const WEARABLE = "integrations/stardew/farmhandexecutioncontroller.actorstateactions.cs";

const lineOfMatch = (source, needle) => source.slice(0, source.indexOf(needle)).split("\n").length;

const findings = (report, code) => report.violations.filter((violation) => violation.code === code);

test("the population is every receipt builder partial, not a hand-written list", () => {
  const files = receiptBuilderFiles();
  assert.ok(files.length > 40, `expected the execution-controller partials, got ${files.length}`);
  for (const file of files)
    assert.match(file, /^integrations\/stardew\/farmhandexecutioncontroller[a-z0-9.]*\.cs$/u, file);
  assert.ok(files.includes(PICKUP), "the base execution controller is in the population");
  assert.ok(files.includes(TILL), "and so is every sibling partial");
});

test("the committed sources carry no fabricated delta", () => {
  const report = checkStardewReceiptTransitionProvenance();
  assert.deepEqual(report.violations, [], JSON.stringify(report.violations, null, 2));
  assert.equal(report.status, "passed");
  assert.ok(report.population > 400, `expected the whole receipt surface, examined ${report.population}`);
  assert.equal(report.computed + report.literal, report.population);
  assert.equal(report.allowances.stale, 0, "no allowance outlived its literal");
});

test("every allowance states a reason and an expiring file|field|value", () => {
  const seen = new Set();
  for (const entry of LITERAL_TRANSITION_ALLOWANCES) {
    assert.match(entry.file, /^integrations\/stardew\/farmhandexecutioncontroller[a-z0-9.]*\.cs$/u, entry.file);
    assert.match(
      entry.field,
      /^(?:before|after|removed|delta|[a-z0-9]+(?:_[a-z0-9]+)*_(?:before|after|removed|delta))$/u,
    );
    assert.ok(entry.value.length > 0, `${entry.field} carries the literal it excuses`);
    assert.ok(entry.reason.length > 40, `${entry.file}:${entry.field} needs a reason a reviewer can weigh`);
    const key = `${entry.file}|${entry.field}|${entry.value}`;
    assert.ok(!seen.has(key), `duplicate allowance ${key}`);
    seen.add(key);
  }
});

// ---------------------------------------------------------------------------
// Red proof: the two fabricated deltas, re-injected at the lines they shipped on.
// ---------------------------------------------------------------------------

test('red: `before = "none"` in till_soil is reported at its own line', () => {
  const original = sourceOf(TILL);
  const anchor = "string before = DescribeSoilFeature(dirtBefore);";
  assert.ok(original.includes(anchor), "the fix this proof reverts must still be the one in place");
  const mutated = original.replace(anchor, 'string before = "none";');
  assert.notEqual(mutated, original);
  const report = checkStardewReceiptTransitionProvenance({ overrides: { [TILL]: mutated } });

  const fabricated = findings(report, "fabricated_delta");
  assert.equal(fabricated.length, 1, JSON.stringify(report.violations, null, 2));
  assert.equal(fabricated[0].file, TILL);
  assert.equal(fabricated[0].field, "before");
  assert.equal(fabricated[0].line, lineOfMatch(mutated, 'string before = "none";'));
  assert.match(mutated.split("\n")[fabricated[0].line - 1], /^\s*string before = "none";/u);
  assert.ok(
    fabricated[0].detail.startsWith(`fabricated_delta:${TILL}:${fabricated[0].line}:before`),
    fabricated[0].detail,
  );
  assert.match(fabricated[0].detail, /bound to the literal `none`/u);
  assert.equal(report.status, "blocked");
});

test("red: `chunk_removed=true` in the pickup receipt is reported at its own line", () => {
  const original = sourceOf(PICKUP);
  const anchor = "chunk_removed={chunkRemoved}{chunkReason}";
  assert.ok(original.includes(anchor), "the fix this proof reverts must still be the one in place");
  const mutated = original.replace(anchor, "chunk_removed=true");
  assert.notEqual(mutated, original);
  const report = checkStardewReceiptTransitionProvenance({ overrides: { [PICKUP]: mutated } });

  const fabricated = findings(report, "fabricated_delta");
  assert.equal(fabricated.length, 1, JSON.stringify(report.violations, null, 2));
  assert.equal(fabricated[0].file, PICKUP);
  assert.equal(fabricated[0].field, "chunk_removed");
  // The line is the evidence string's, not the comment that spells the old literal: the gate reads code.
  assert.match(mutated.split("\n")[fabricated[0].line - 1], /chunk_removed=true;inventory_before=/u);
  assert.match(fabricated[0].detail, /written as the literal `true`/u);
});

test("red: an allowance whose literal is gone is stale, and is not counted as a fabricated delta", () => {
  const original = sourceOf(WEARABLE);
  assert.ok(original.includes("destination_before=none"), "the allowance this proof expires must still exist");
  // `removedItemId` is itself read, so this mutation replaces one restated constant with a measured one.
  const mutated = original.replace("destination_before=none", "destination_before={removedItemId}");
  assert.notEqual(mutated, original);
  const report = checkStardewReceiptTransitionProvenance({ overrides: { [WEARABLE]: mutated } });

  const stale = findings(report, "stale_allowance_entry");
  assert.equal(stale.length, 1, JSON.stringify(report.violations, null, 2));
  assert.equal(stale[0].file, WEARABLE);
  assert.equal(stale[0].field, "destination_before");
  assert.match(stale[0].detail, /^stale_allowance_entry:/u);
  assert.match(stale[0].detail, /expired: delete the entry/u);
  assert.deepEqual(findings(report, "fabricated_delta"), []);
});

// ---------------------------------------------------------------------------
// The shapes the next instance would arrive in.
// ---------------------------------------------------------------------------

function syntheticBuilder(source) {
  const root = mkdtempSync(path.join(tmpdir(), "receipt-provenance-"));
  mkdirSync(path.join(root, MOD_ROOT), { recursive: true });
  writeFileSync(path.join(root, MOD_ROOT, "farmhandexecutioncontroller.synthetic.cs"), source, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const evidence = (fields) =>
  `private LocalExecutionReceipt Mint(ExecutionState state) => new("e", "r", state, "reason", 1, $"${fields}");`;

test("red: a new completion receipt claiming `health_after` as a literal is caught and named", () => {
  const { root, cleanup } = syntheticBuilder(
    evidence("location=Farm;target=3,4;health_before={healthBefore};health_after=100"),
  );
  try {
    const report = checkStardewReceiptTransitionProvenance({ root });
    assert.equal(report.status, "blocked");
    assert.equal(findings(report, "fabricated_delta").length, 1);
    assert.equal(findings(report, "fabricated_delta")[0].field, "health_after");
    assert.equal(findings(report, "fabricated_delta")[0].value, "100");
  } finally {
    cleanup();
  }
});

test("red: a field bound to a boolean literal is caught even though the evidence interpolates it", () => {
  const { root, cleanup } = syntheticBuilder(
    [
      evidence("hoedirt_present_after={presentAfter};removed={removed}"),
      "private void Bind()",
      "{",
      "    bool presentAfter = true;",
      "}",
    ].join("\n"),
  );
  try {
    const report = checkStardewReceiptTransitionProvenance({ root });
    assert.equal(report.status, "blocked");
    const fabricated = findings(report, "fabricated_delta");
    assert.equal(fabricated.length, 1, JSON.stringify(report.violations, null, 2));
    assert.equal(fabricated[0].field, "hoedirt_present_after");
    assert.match(fabricated[0].detail, /bound to the literal `true`/u);
  } finally {
    cleanup();
  }
});

test("a numeric binding is the documented boundary: a sentinel is not read as a fabricated delta", () => {
  // `int points = -1;` is how the Mod says "this path never ran"; a fabricated zero is the same characters. The gate
  // refuses to guess, and says so in its header rather than passing silently.
  const { root, cleanup } = syntheticBuilder(
    [
      evidence("points_before={pointsBefore};points_after={pointsAfter}"),
      "private void Bind()",
      "{",
      "    int pointsBefore = -1;",
      "}",
    ].join("\n"),
  );
  try {
    assert.deepEqual(checkStardewReceiptTransitionProvenance({ root }).violations, []);
  } finally {
    cleanup();
  }
});

test("a comment spelling a transition pair is a sentence about the defect, not a field", () => {
  assert.equal(stripComments("// the receipt said before=none;after=HoeDirt\nint x;").includes("before"), false);
  const { root, cleanup } = syntheticBuilder(
    [
      '// the receipt reported $"before=none;after=HoeDirt" and that is the sentence under test',
      evidence("before={before};after={after}"),
    ].join("\n"),
  );
  try {
    const report = checkStardewReceiptTransitionProvenance({ root });
    assert.equal(report.population, 2, "only the two live fields are read");
    assert.deepEqual(report.violations, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Zero population: not measured is blocked, never passed.
// ---------------------------------------------------------------------------

test("red: a root with no receipt builder is blocked rather than green", () => {
  const root = mkdtempSync(path.join(tmpdir(), "receipt-provenance-empty-"));
  try {
    mkdirSync(path.join(root, MOD_ROOT), { recursive: true });
    const report = checkStardewReceiptTransitionProvenance({ root });
    assert.equal(report.status, "blocked");
    assert.equal(report.population, 0);
    assert.equal(findings(report, "gate_measured_nothing")[0].field, "<population>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("red: a receipt builder with no transition field is blocked rather than green", () => {
  const { root, cleanup } = syntheticBuilder(evidence("slot=1;item=(O)78"));
  try {
    const report = checkStardewReceiptTransitionProvenance({ root });
    assert.equal(report.status, "blocked");
    assert.equal(report.population, 0);
    assert.equal(findings(report, "gate_measured_nothing").length, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The readers themselves.
// ---------------------------------------------------------------------------

test("extractTransitionFields names the members of the population and nothing else", () => {
  const fields = extractTransitionFields(
    `private LocalExecutionReceipt Mint() => new(ExecutionState.Succeeded, "reason", 1, $"before={before};after=HoeDirt;stamina_delta={delta};held_object_empty=true;before_watered=false");`,
  );
  assert.deepEqual(
    fields.map((field) => field.key),
    ["before", "after", "stamina_delta"],
  );
});

test("extractBindingLiterals reads string and boolean literals, and skips computed bindings", () => {
  const bindings = extractBindingLiterals(
    [
      'string before = "none";',
      "bool present = false;",
      "int count = 0;",
      "bool present2 = location.GetHoeDirtAtTile(tile) is not null;",
      "string? removed = occupantBefore.QualifiedItemId;",
    ].join("\n"),
  );
  assert.deepEqual([...bindings.keys()].sort(), ["before", "present"]);
  assert.deepEqual(bindings.get("before"), [{ line: 1, value: "none" }]);
  assert.deepEqual(bindings.get("present"), [{ line: 2, value: "false" }]);
});
