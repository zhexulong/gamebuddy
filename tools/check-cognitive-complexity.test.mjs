/**
 * The falsifier suite for `tools/check-cognitive-complexity.mjs`.
 *
 * Every case drives the gate's OWN functions (`measureCSharp`, `evaluate`) or its OWN command line over a
 * throwaway root, so no case pins a second hand-written copy of the metric. The expected numbers are derived
 * from SonarSource's published S3776 rules and written next to the source that produces them, which is the point:
 * a change in the walker has to disagree with arithmetic written by hand.
 *
 * red-proof: inject  a third `if` nested two levels deep into a fixture method -> `function_over_bound` naming
 *   `cs:Fixture.Type.Run(int)` with the value the hand-computed nesting predicts (this file)
 * red-proof: inject  a second partial file declaring the same class -> `class_complexity_over_bound:
 *   Fixture.Big:2:240`, one class with `parts 2` and no per-file finding (this file)
 * red-proof: inject  a recorded member and then delete it from the source -> `stale_complexity_baseline:<member>`
 *   (this file)
 * red-proof: inject  a size record whose `parts`/`methods` predate the tree -> `class_size_record_stale` naming both
 *   disagreeing fields, while 30 more lines on the same shape stays `class_size_grew` (this file)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BIOME_COMPLEXITY_SATURATION,
  BIOME_SATURATION_READING,
  CLASS_BOUND,
  CLASS_LINE_CEILING,
  CLASS_METHOD_CEILING,
  CS_FUNCTION_BOUND,
  evaluate,
  formatComplexity,
  measureCSharp,
} from "./check-cognitive-complexity.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const GATE = join(TOOLS, "check-cognitive-complexity.mjs");
const BOUNDS = { ts: 30, cs: CS_FUNCTION_BOUND };

/** One member's complexity, in the unit the gate prints. */
async function complexityOf(body) {
  const measured = await measureCSharp(
    "Fixture.cs",
    `namespace Fixture\n{\n  public class Type\n  {\n    public void Run(int a, int b)\n    {\n${body}\n    }\n  }\n}\n`,
  );
  const member = measured.members.find((entry) => entry.id.startsWith("cs:Fixture.Type.Run("));
  assert.ok(
    member,
    `the fixture declared one measured member, found ${JSON.stringify(measured.members.map((m) => m.id))}`,
  );
  return member.value;
}

test("S3776: sequential branches add 1 each and never nest", async () => {
  assert.equal(await complexityOf("if (a > 0) { a++; }\nif (a < 0) { a--; }\nif (a == 0) { a = 1; }"), 3);
});

test("S3776: a nested branch adds 1 plus the nesting depth", async () => {
  // outer if = 1, inner if = 1 + 1, innermost = 1 + 2
  assert.equal(await complexityOf("if (a > 0) { if (a < 0) { if (b > 0) { a++; } } }"), 1 + (1 + 1) + (1 + 2));
});

test("S3776: loops increment and open a nesting level", async () => {
  assert.equal(await complexityOf("for (var i = 0; i < b; i++) { if (a > 0) { a++; } }"), 1 + (1 + 1));
  assert.equal(await complexityOf("foreach (var x in a) { while (b > 0) { b--; } }"), 1 + 0 + (1 + 1));
});

test("S3776: else if and else add 1 without a nesting increment", async () => {
  assert.equal(await complexityOf("if (a > 0) { a++; } else if (a < 0) { a--; } else { a = 0; }"), 3);
});

test("S3776: a switch costs 1 plus 1 per section", async () => {
  const body = "switch (a) { case 1: a++; break; case 2: a--; break; default: break; }";
  assert.equal(await complexityOf(body), 1 + 3);
});

test("S3776: catch increments without nesting its body", async () => {
  // the try's own if = 1, the catch = 1, its if = 1: no level is opened, so nothing gains a nesting increment
  assert.equal(await complexityOf("try { if (a > 0) { a++; } } catch (System.Exception) { if (b > 0) { b--; } }"), 3);
});

test("S3776: logical operators cost one per RUN of the same operator", async () => {
  assert.equal(await complexityOf("var x = a > 0 && a < 2 && b > 0;"), 1);
  assert.equal(await complexityOf("var x = a > 0 && a < 2 || b > 0;"), 2);
  assert.equal(await complexityOf("var x = (a > 0 || a < 2) && (b > 0 || b < 2);"), 3);
});

test("S3776: a nested function restarts nesting but stays with its member", async () => {
  // for = 1 + nesting 0; if at depth 1 = 1 + 1; the lambda body is scored at depth 0, so its if is 1
  const body = "for (var i = 0; i < b; i++) { if (a > 0) { System.Action f = () => { if (b > 0) { a++; } }; f(); } }";
  assert.equal(await complexityOf(body), 1 + (1 + 1) + 1);
});

test("S3776: a property accessor is measured on its own, and its value joins the class", async () => {
  const measured = await measureCSharp(
    "Fixture.cs",
    "namespace Fixture\n{\n  public class Type\n  {\n    public int P\n    {\n      get { if (true) { return 1; } return 0; }\n      set { if (value > 0) { } }\n    }\n  }\n}\n",
  );
  assert.deepEqual(
    measured.members.map((member) => [member.id, member.value]),
    [
      ["cs:Fixture.Type.P.get()", 1],
      ["cs:Fixture.Type.P.set()", 1],
    ],
  );
  assert.equal(measured.types[0].value, 2);
});

test("anti-partial: two partial declarations of one class are one type with two parts", async () => {
  const first = await measureCSharp(
    "Against.cs",
    "namespace Fixture\n{\n  public partial class Big\n  {\n    public void Alpha() { if (true) { } }\n  }\n}\n",
  );
  const second = await measureCSharp(
    "For.cs",
    "namespace Fixture\n{\n  public partial class Big\n  {\n    public void Beta() { if (true) { } }\n  }\n}\n",
  );
  const merged = new Map();
  for (const type of [...first.types, ...second.types]) {
    const known = merged.get(type.id);
    if (known === undefined) {
      merged.set(type.id, { ...type, files: new Set(type.files) });
      continue;
    }
    known.value += type.value;
    known.parts += type.parts;
    known.lines += type.lines;
    known.methods += type.methods;
    for (const file of type.files) known.files.add(file);
  }
  const [type] = [...merged.values()];
  assert.equal(merged.size, 1, "one class name is one type, whatever the file count");
  assert.equal(type.id, "cs:Fixture.Big");
  assert.equal(type.parts, 2);
  assert.equal(type.files.size, 2);
  assert.equal(type.value, 2, "the class complexity is the sum of its parts");
  assert.equal(type.methods, 2);
});

test("ratchet: an unrecorded member over its bound is named with file and value", () => {
  const verdict = evaluate({
    members: [
      { id: "cs:Fixture.Type.Run(int)", language: "cs", name: "Fixture.Type.Run", file: "A.cs", line: 7, value: 31 },
    ],
    types: [],
    baseline: { members: [], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  assert.equal(verdict.findings.length, 1);
  assert.match(verdict.findings[0].detail, /^cs:Fixture\.Type\.Run\(int\) @ A\.cs:7 = 31 \(bound 30 cs\)$/u);
});

test("ratchet: a recorded member that holds still is green, and one that grows is named", () => {
  const member = {
    id: "cs:Fixture.Type.Run(int)",
    language: "cs",
    name: "Fixture.Type.Run",
    file: "A.cs",
    line: 7,
    value: 40,
  };
  const green = evaluate({
    members: [member],
    types: [],
    baseline: { members: [{ id: member.id, value: 40 }], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  assert.deepEqual(green.findings, []);
  const grown = evaluate({
    members: [{ ...member, value: 41 }],
    types: [],
    baseline: { members: [{ id: member.id, value: 40 }], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  assert.deepEqual(
    grown.findings.map((finding) => [finding.code, finding.detail]),
    [["function_grew", `${member.id} 40 -> 41`]],
  );
});

test("ratchet: a recorded member the tree no longer has is stale, in either language", () => {
  const verdict = evaluate({
    members: [],
    types: [],
    baseline: {
      members: [
        { id: "cs:Fixture.Gone.Run()", value: 50 },
        { id: "ts:host/src/gone.ts#run", value: 50 },
      ],
      classes: [],
      sizes: [],
    },
    bounds: BOUNDS,
  });
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    ["stale_complexity_baseline", "stale_complexity_baseline"],
  );
  assert.ok(verdict.findings.some((finding) => finding.detail === "cs:Fixture.Gone.Run()"));
});

test("ratchet: a class over its complexity bound names the class, its parts and the sum", () => {
  const type = {
    id: "cs:Fixture.Big",
    name: "Fixture.Big",
    parts: 46,
    files: new Set(),
    file: "A.cs",
    line: 3,
    value: CLASS_BOUND + 1,
    lines: 10,
    methods: 2,
  };
  const verdict = evaluate({
    members: [],
    types: [type],
    // The size record is the shape `--update` writes: `parts` and `methods` beside the lines, so it agrees with
    // the tree here and only the complexity binding is being read.
    baseline: {
      members: [],
      classes: [],
      sizes: [{ id: type.id, parts: type.parts, lines: type.lines, methods: type.methods }],
    },
    bounds: BOUNDS,
  });
  assert.deepEqual(
    verdict.findings.map((finding) => [finding.code, finding.detail]),
    [["class_complexity_over_bound", `Fixture.Big:46:${CLASS_BOUND + 1}`]],
  );
});

test("ratchet: class size names the ceiling, the value and the part count", () => {
  const lines = {
    id: "cs:Fixture.Long",
    name: "Fixture.Long",
    parts: 3,
    files: new Set(),
    file: "A.cs",
    line: 3,
    value: 0,
    lines: CLASS_LINE_CEILING + 1,
    methods: 1,
  };
  const methods = {
    id: "cs:Fixture.Wide",
    name: "Fixture.Wide",
    parts: 1,
    files: new Set(),
    file: "B.cs",
    line: 3,
    value: 0,
    lines: 10,
    methods: CLASS_METHOD_CEILING + 1,
  };
  const verdict = evaluate({
    members: [],
    types: [lines, methods],
    baseline: { members: [], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  assert.deepEqual(verdict.findings.map((finding) => finding.code).sort(), [
    "class_lines_over_ceiling",
    "class_methods_over_ceiling",
  ]);
  assert.ok(
    verdict.findings.some(
      (finding) => finding.detail === `Fixture.Long:${CLASS_LINE_CEILING + 1}:${CLASS_LINE_CEILING}:3`,
    ),
  );
  assert.ok(
    verdict.findings.some(
      (finding) => finding.detail === `Fixture.Wide:${CLASS_METHOD_CEILING + 1}:${CLASS_METHOD_CEILING}`,
    ),
  );
});

test("ratchet: a class size whose structure held still may only shrink in lines, and a gone type is stale", () => {
  const type = {
    id: "cs:Fixture.Long",
    name: "Fixture.Long",
    parts: 2,
    files: new Set(),
    file: "A.cs",
    line: 3,
    value: 0,
    lines: 1200,
    methods: 20,
  };
  const record = { id: type.id, parts: 2, lines: 1200, methods: 20 };
  const baseline = { members: [], classes: [], sizes: [record] };
  const shrunk = evaluate({ members: [], types: [{ ...type, lines: 1100 }], baseline, bounds: BOUNDS });
  assert.deepEqual(shrunk.findings, []);
  const grown = evaluate({ members: [], types: [{ ...type, lines: 1230 }], baseline, bounds: BOUNDS });
  assert.deepEqual(
    grown.findings.map((finding) => [finding.code, finding.detail]),
    [["class_size_grew", `${type.id} 1200 lines/20 methods -> 1230 lines/20 methods`]],
  );
  const gone = evaluate({ members: [], types: [], baseline, bounds: BOUNDS });
  assert.deepEqual(
    gone.findings.map((finding) => [finding.code, finding.detail]),
    [["stale_class_ceiling", type.id]],
  );
});

/**
 * The incident, replayed as one reading: a `ModEntry`-shaped record against a tree measured after the class changed
 * shape. `parts` and `methods` only move when the class's structure does, so their disagreement is what tells a stale
 * record (`class_size_record_stale`) from a class that grew (`class_size_grew`).
 */
const MOD_ENTRY_SHAPE = {
  id: "cs:ModEntry",
  name: "ModEntry",
  parts: 58,
  files: new Set(),
  file: "ModEntry.cs",
  line: 10,
  value: 0,
  lines: 15426,
  methods: 335,
};

/** One size record for `MOD_ENTRY_SHAPE`, with the fields the caller wants stale or current. */
const recordedSize = (fields) => ({
  members: [],
  classes: [],
  sizes: [{ id: MOD_ENTRY_SHAPE.id, name: "ModEntry", parts: 58, lines: 15426, methods: 335, ...fields }],
  revision: "21bd3a46",
});

test("ratchet: a size record whose partials or methods disagree with the tree is stale, not grown", () => {
  // The incident itself: the record's METHODS had been corrected (335), its PARTIALS had not (56 against 58), and
  // the line count came from before the class changed shape. `class_size_grew` called a 76-line shrink growth here.
  const stalePartials = evaluate({
    members: [],
    types: [{ ...MOD_ENTRY_SHAPE, lines: 15363 }],
    baseline: recordedSize({ parts: 56, lines: 15356 }),
    bounds: BOUNDS,
  });
  assert.deepEqual(
    stalePartials.findings.map((finding) => finding.code),
    ["class_size_record_stale"],
    "a record taken at another shape of the class is stale, and must not be read as growth",
  );
  const [finding] = stalePartials.findings;
  assert.match(finding.detail, /^cs:ModEntry parts 56 -> 58 /u, "the disagreeing field is named, with both numbers");
  assert.match(finding.detail, /record taken at 21bd3a46/u, "the revision is the reader's only cheap check");
  assert.match(finding.detail, /--update/u, "the instruction is to re-record, not to shrink the class");

  // The other direction: the record predates the 68 initialisers being inlined, so the tree has MORE methods than it
  // says. Today that reads as growth; it is the same untrustworthy record seen from the other side.
  const staleMethods = evaluate({
    members: [],
    types: [MOD_ENTRY_SHAPE],
    baseline: recordedSize({ parts: 55, methods: 267, lines: 15502 }),
    bounds: BOUNDS,
  });
  assert.deepEqual(
    staleMethods.findings.map((item) => item.code),
    ["class_size_record_stale"],
  );
  assert.match(staleMethods.findings[0].detail, /parts 55 -> 58, methods 267 -> 335 /u);

  // A record LARGER than the tree in every field used to pass in silence: nothing had grown, so nothing was said,
  // while the numbers compared against were from a class that no longer exists. Stale says so - it buys no silence.
  const recordAheadOfTheTree = evaluate({
    members: [],
    types: [MOD_ENTRY_SHAPE],
    baseline: recordedSize({ parts: 60, methods: 400, lines: 16000 }),
    bounds: BOUNDS,
  });
  assert.deepEqual(
    recordAheadOfTheTree.findings.map((item) => [item.code, /parts 60 -> 58/u.test(item.detail)]),
    [["class_size_record_stale", true]],
  );
});

test("ratchet: the same shape with 30 more lines is growth, so the assertion keeps its teeth", () => {
  const verdict = evaluate({
    members: [],
    types: [{ ...MOD_ENTRY_SHAPE, lines: MOD_ENTRY_SHAPE.lines + 30 }],
    baseline: recordedSize({}),
    bounds: BOUNDS,
  });
  assert.deepEqual(
    verdict.findings.map((finding) => [finding.code, finding.detail]),
    [["class_size_grew", "cs:ModEntry 15426 lines/335 methods -> 15456 lines/335 methods"]],
  );
});

test("identity: two members that resolve to one name are a collision, not one shadowing the other", () => {
  const member = {
    id: "cs:Fixture.Type.Run(int)",
    language: "cs",
    name: "Fixture.Type.Run",
    file: "A.cs",
    line: 7,
    value: 1,
  };
  const verdict = evaluate({
    members: [member, { ...member, line: 20 }],
    types: [],
    baseline: { members: [], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    ["complexity_identity_collision"],
  );
});

// ----------------------------------------------------------------------------------------------------------
// Biome's ceiling: 255 is a floor, not a measurement
// ----------------------------------------------------------------------------------------------------------

/** A ts member reading at Biome's ceiling, as the producer reports any function at or above 255. */
const SATURATED_MEMBER = {
  id: "ts:host/src/x.ts#run",
  language: "ts",
  name: "host/src/x.ts#run",
  file: "host/src/x.ts",
  line: 5,
  value: BIOME_COMPLEXITY_SATURATION,
  saturated: true,
};

test("reading: a function at Biome's ceiling is named as a floor, never as a count", () => {
  const verdict = evaluate({
    members: [SATURATED_MEMBER],
    types: [],
    baseline: { members: [], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  const [finding] = verdict.findings;
  assert.equal(finding.code, "function_over_bound");
  assert.equal(
    finding.detail,
    `ts:host/src/x.ts#run @ host/src/x.ts:5 = ${BIOME_SATURATION_READING} (bound 30 ts, saturated)`,
  );
  assert.doesNotMatch(finding.detail, /= 255\b/u, "nothing prints the ceiling as a measurement");
  assert.equal(formatComplexity(verdict.counts.ts.worst), `>=255 (biome saturates at 255)`);
  assert.equal(verdict.counts.ts.saturating, 1, "the report carries the population standing on the floor");
  assert.equal(formatComplexity({ value: 83 }), "83", "a reading under the ceiling is still a number");
});

test("ratchet: a recorded function that grows into Biome's ceiling is red, and its new reading is a floor", () => {
  const verdict = evaluate({
    members: [SATURATED_MEMBER],
    types: [],
    baseline: { members: [{ id: SATURATED_MEMBER.id, value: 52 }], classes: [], sizes: [] },
    bounds: BOUNDS,
  });
  assert.deepEqual(
    verdict.findings.map((finding) => [finding.code, finding.detail]),
    [["function_grew", `${SATURATED_MEMBER.id} 52 -> ${BIOME_SATURATION_READING}`]],
  );
});

// ----------------------------------------------------------------------------------------------------------
// The command line, over throwaway roots
// ----------------------------------------------------------------------------------------------------------

/** A throwaway root with the two producers' own inputs; the caller adds what each case is about. */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "gb-cognitive-"));
  mkdirSync(join(root, "host", "src"), { recursive: true });
  mkdirSync(join(root, "integrations", "stardew"), { recursive: true });
  return root;
}

function writeBiomeConfig(root, maxAllowedComplexity = 1) {
  writeFileSync(
    join(root, "biome.json"),
    `${JSON.stringify(
      {
        files: { includes: ["host/src/**"] },
        linter: {
          enabled: true,
          rules: {
            complexity: { noExcessiveCognitiveComplexity: { level: "error", options: { maxAllowedComplexity } } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** One TypeScript function with `branches` sequential `if`s, so its complexity is `branches`. */
function writeTypeScriptSource(root, branches) {
  const body = Array.from({ length: branches }, (_, index) => `  if (value > ${index}) {\n    value -= 1;\n  }`).join(
    "\n",
  );
  writeFileSync(
    join(root, "host", "src", "fixture.ts"),
    `export function run(value: number): number {\n${body}\n  return value;\n}\n`,
  );
}

/**
 * One ANONYMOUS function: a lambda passed straight to `.map`, so nothing names it and its identity has to come from
 * its owner and ordinal. `branches` is its own complexity; `padLines` are comment lines inserted above the whole
 * function, which move every line below them and must move no identity.
 */
function writeAnonymousLambdaSource(root, branches, padLines = 0) {
  const pad = Array.from({ length: padLines }, (_, index) => `// padding ${index}`).join("\n");
  const body = Array.from({ length: branches }, (_, index) => `    if (input > ${index}) { total -= 1; }`).join("\n");
  writeFileSync(
    join(root, "host", "src", "fixture.ts"),
    `${pad}${padLines === 0 ? "" : "\n"}export function run(value: number): number {\n` +
      `  return [value].map((input) => {\n    let total = input;\n${body}\n    return total;\n  })[0];\n}\n`,
  );
}

/** One C# member with `branches` sequential `if`s, so its complexity is `branches`. */
const csharpMember = (branches) =>
  Array.from({ length: branches }, (_, index) => `      if (a > ${index}) { a -= 1; }`).join("\n");

/** A partial of `Fixture.Big` carrying `members` methods, each of complexity `branches`. */
const csharpPartial = (name, members, branches) =>
  `namespace Fixture\n{\n  public partial class Big\n  {\n${Array.from(
    { length: members },
    (_, index) => `    public void ${name}${index}(int a)\n    {\n${csharpMember(branches)}\n    }`,
  ).join("\n")}\n  }\n}\n`;

const EMPTY_CSHARP = "namespace Fixture\n{\n  public class Empty\n  {\n  }\n}\n";

function run(root, args = []) {
  return spawnSync(process.execPath, [GATE, ...args, "--root", root], { encoding: "utf8", cwd: TOOLS });
}

test("cli: an empty population is blocked rather than green", () => {
  const root = fixtureRoot();
  try {
    writeBiomeConfig(root);
    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /complexity blocked: ts_population_empty:host\/src/u);
    assert.match(result.stdout, /"status":"blocked"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a missing biome.json is named, because the number has one owner", () => {
  const root = fixtureRoot();
  try {
    writeTypeScriptSource(root, 2);
    writeFileSync(join(root, "integrations", "stardew", "Empty.cs"), EMPTY_CSHARP);
    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ts_biome_config_missing:biome\.json/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: without a baseline an over-bound function is red, and --update records it", () => {
  const root = fixtureRoot();
  try {
    writeBiomeConfig(root, 1);
    writeTypeScriptSource(root, 2);
    writeFileSync(join(root, "integrations", "stardew", "Empty.cs"), EMPTY_CSHARP);
    const red = run(root);
    assert.equal(red.status, 1);
    assert.match(red.stderr, /function_over_bound: ts:host\/src\/fixture\.ts#run/u);
    assert.match(red.stdout, /functions examined/u);
    assert.match(red.stdout, /merged from partials/u);
    assert.match(red.stdout, /types examined/u);
    assert.match(red.stdout, /never summed or compared/u);

    const recorded = run(root, ["--update"]);
    assert.equal(recorded.status, 0);
    const baseline = JSON.parse(readFileSync(join(root, "tools", "cognitive-complexity-baseline.json"), "utf8"));
    assert.deepEqual(
      baseline.members.map((entry) => entry.id),
      ["ts:host/src/fixture.ts#run"],
    );
    const green = run(root);
    assert.equal(green.status, 0);
    assert.match(green.stdout, /"status":"passed"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a recorded function that grows is red, and one that disappears leaves the baseline", () => {
  const root = fixtureRoot();
  try {
    writeBiomeConfig(root, 1);
    writeTypeScriptSource(root, 2);
    writeFileSync(join(root, "integrations", "stardew", "Empty.cs"), EMPTY_CSHARP);
    assert.equal(run(root, ["--update"]).status, 0);
    writeTypeScriptSource(root, 5);
    const grown = run(root);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /function_grew: ts:host\/src\/fixture\.ts#run 2 -> 5/u);
    writeTypeScriptSource(root, 0);
    const gone = run(root);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /stale_complexity_baseline: ts:host\/src\/fixture\.ts#run/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: the class ceiling adds up the partials, not the files", () => {
  const root = fixtureRoot();
  try {
    writeBiomeConfig(root);
    writeTypeScriptSource(root, 0);
    // 6 methods of complexity 20 per partial: no member reaches the function bound of 30, and neither part reaches
    // the class bound of 200 on its own (6 x 20 = 120), while the class sums 240.
    writeFileSync(join(root, "integrations", "stardew", "Against.cs"), csharpPartial("Alpha", 6, 20));
    writeFileSync(join(root, "integrations", "stardew", "For.cs"), csharpPartial("Beta", 6, 20));
    const result = run(root);
    assert.match(result.stdout, /classes examined 1 · merged from partials 2 · over the class bound 200: 1/u);
    assert.match(result.stdout, /worst Fixture\.Big @ integrations\/stardew\/Against\.cs:3 parts 2 = 240/u);
    assert.match(result.stderr, /class_complexity_over_bound: Fixture\.Big:2:240/u);
    // Neither part is over any bound of its own: the finding belongs to the class, not to a file.
    assert.doesNotMatch(result.stderr, /function_over_bound/u);
    // The baseline can say the size out loud instead of being red on day one.
    assert.equal(run(root, ["--update"]).status, 0);
    const baseline = JSON.parse(readFileSync(join(root, "tools", "cognitive-complexity-baseline.json"), "utf8"));
    assert.deepEqual(
      baseline.classes.map((entry) => [entry.id, entry.parts, entry.value]),
      [["cs:Fixture.Big", 2, 240]],
    );
    assert.deepEqual(
      baseline.sizes.map((entry) => [entry.id, entry.parts, entry.files, entry.methods]),
      [],
      "a type under both ceilings is not recorded: the baseline holds the debt, not a census",
    );
    const green = run(root);
    assert.equal(green.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a class over the line ceiling is red and recorded", () => {
  const root = fixtureRoot();
  try {
    writeBiomeConfig(root);
    writeTypeScriptSource(root, 0);
    const padding = Array.from({ length: CLASS_LINE_CEILING }, (_, index) => `    // line ${index}`).join("\n");
    writeFileSync(
      join(root, "integrations", "stardew", "Long.cs"),
      `namespace Fixture\n{\n  public class Long\n  {\n${padding}\n  }\n}\n`,
    );
    const result = run(root);
    assert.match(
      result.stderr,
      new RegExp(`class_lines_over_ceiling: Fixture\\.Long:${CLASS_LINE_CEILING + 3}:${CLASS_LINE_CEILING}:1`, "u"),
    );
    assert.match(result.stdout, new RegExp(`largest Fixture\\.Long @ ${CLASS_LINE_CEILING + 3} lines`, "u"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a class that changed shape is a stale size record, while one that only got longer grew", () => {
  const root = fixtureRoot();
  const baselinePath = join(root, "tools", "cognitive-complexity-baseline.json");
  const padding = (count) => Array.from({ length: count }, (_, index) => `    // line ${index}`).join("\n");
  const writeLong = (lines) =>
    writeFileSync(
      join(root, "integrations", "stardew", "Long.cs"),
      `namespace Fixture\n{\n  public class Long\n  {\n${padding(lines)}\n  }\n}\n`,
    );
  try {
    writeBiomeConfig(root);
    writeTypeScriptSource(root, 0);
    writeLong(CLASS_LINE_CEILING);
    assert.equal(run(root, ["--update"]).status, 0);
    const recorded = JSON.parse(readFileSync(baselinePath, "utf8")).sizes[0];
    assert.deepEqual([recorded.parts, recorded.lines, recorded.methods], [1, CLASS_LINE_CEILING + 3, 0]);

    // 30 more lines, no structural change: the class grew, and the finding says so.
    writeLong(CLASS_LINE_CEILING + 30);
    const grown = run(root);
    assert.equal(grown.status, 1);
    assert.match(
      grown.stderr,
      new RegExp(
        `class_size_grew: cs:Fixture\\.Long ${CLASS_LINE_CEILING + 3} lines/0 methods -> ${CLASS_LINE_CEILING + 33} lines/0 methods`,
        "u",
      ),
    );

    // A SECOND partial: the class changed shape, so the recorded line count describes a class that no longer
    // exists in that form. The finding is `class_size_record_stale` naming both disagreeing fields, and it is
    // still a failure - stale is not a way to pass - with `--update` as the remedy rather than a smaller class.
    assert.equal(run(root, ["--update"]).status, 0);
    writeFileSync(
      join(root, "integrations", "stardew", "Long.Second.cs"),
      "namespace Fixture\n{\n  public partial class Long\n  {\n    public void Alpha(int a)\n    {\n      if (a > 0) { a -= 1; }\n    }\n  }\n}\n",
    );
    const stale = run(root);
    assert.equal(stale.status, 1, "a record nobody can trust is still a failing reading");
    assert.match(stale.stderr, /class_size_record_stale: cs:Fixture\.Long parts 1 -> 2, methods 0 -> 1/u);
    assert.doesNotMatch(stale.stderr, /class_size_grew/u);
    assert.match(stale.stderr, /--update/u);
    assert.match(stale.stdout, /"status":"failed"/u);
    assert.match(stale.stdout, /class_size_ceiling/u);

    // Re-recording is the whole remedy: the arithmetic goes in the entry, the gate goes green again.
    assert.equal(run(root, ["--update"]).status, 0);
    const green = run(root);
    assert.equal(green.status, 0);
    assert.doesNotMatch(green.stderr, /class_size_record_stale|class_size_grew/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: biome's ceiling is printed as a floor in the reading line, the finding and the json report", () => {
  const root = fixtureRoot();
  try {
    writeBiomeConfig(root, 1);
    // 300 sequential `if`s: biome's score is a byte, so it reports 255 for this and for any larger function.
    writeTypeScriptSource(root, BIOME_COMPLEXITY_SATURATION + 45);
    writeFileSync(join(root, "integrations", "stardew", "Empty.cs"), EMPTY_CSHARP);
    const red = run(root);
    assert.equal(red.status, 1);
    assert.match(red.stdout, /saturating 1 of 1 \(>=255 \(biome saturates at 255\)\)/u);
    assert.match(
      red.stdout,
      /worst host\/src\/fixture\.ts#run @ host\/src\/fixture\.ts:1 = >=255 \(biome saturates at 255\)/u,
    );
    assert.match(
      red.stderr,
      /function_over_bound: ts:host\/src\/fixture\.ts#run @ host\/src\/fixture\.ts:1 = >=255 \(biome saturates at 255\) \(bound 1 ts, saturated\)/u,
    );
    const report = JSON.parse(red.stdout.split("\n").find((line) => line.startsWith('{"gate"')));
    assert.deepEqual(report.worst.ts, {
      name: "host/src/fixture.ts#run",
      file: "host/src/fixture.ts",
      line: 1,
      complexity: ">=255 (biome saturates at 255)",
      saturated: true,
    });
    assert.match(report.checks[0].detail, /saturating 1 of 1 at >=255 \(biome saturates at 255\)/u);

    // The floor is recorded as one, with its flag, and then the entry is green while nothing is claimed about size.
    assert.equal(run(root, ["--update"]).status, 0);
    const baseline = JSON.parse(readFileSync(join(root, "tools", "cognitive-complexity-baseline.json"), "utf8"));
    assert.deepEqual(
      baseline.members.map((entry) => [entry.value, entry.saturated]),
      [[BIOME_COMPLEXITY_SATURATION, true]],
    );
    const green = run(root);
    assert.equal(green.status, 0);
    assert.match(green.stdout, /saturating 1 of 1/u);

    // THE LIMITATION, PINNED RATHER THAN HIDDEN: 300 and 500 branches read the same 255, so growth inside the
    // ceiling cannot be seen by any reading this gate can take. What it does guarantee is that the number is never
    // printed as exact - the reading below is still `>=255`, not `255, unchanged`.
    writeTypeScriptSource(root, BIOME_COMPLEXITY_SATURATION + 245);
    const grownInsideTheCeiling = run(root);
    assert.equal(grownInsideTheCeiling.status, 0);
    assert.match(grownInsideTheCeiling.stdout, /= >=255 \(biome saturates at 255\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: an anonymous member's identity is where it is, not which line it is on", () => {
  const root = fixtureRoot();
  const baselinePath = join(root, "tools", "cognitive-complexity-baseline.json");
  try {
    writeBiomeConfig(root, 1);
    writeAnonymousLambdaSource(root, 2);
    writeFileSync(join(root, "integrations", "stardew", "Empty.cs"), EMPTY_CSHARP);
    const red = run(root);
    assert.equal(red.status, 1);
    // Biome scores a lambda nested in a call at nesting 1, so each `if` costs 2 there and two of them read 4. The
    // number is not what this case is about: the IDENTITY is.
    assert.match(
      red.stderr,
      /function_over_bound: ts:host\/src\/fixture\.ts#run#lambda1 @ host\/src\/fixture\.ts:2 = 4 \(bound 1 ts\)/u,
      "the identity is the named owner plus the ordinal, and the line rides beside it",
    );
    assert.equal(run(root, ["--update"]).status, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(baselinePath, "utf8")).members.map((entry) => entry.id),
      ["ts:host/src/fixture.ts#run#lambda1"],
    );

    // The incident this identity exists for: 25 lines inserted above an unchanged lambda. The recorded identity
    // must hold, so the run stays green instead of reporting one new offender plus one stale entry.
    writeAnonymousLambdaSource(root, 2, 25);
    const shifted = run(root);
    assert.equal(shifted.status, 0);
    assert.doesNotMatch(shifted.stderr, /stale_complexity_baseline/u);
    assert.doesNotMatch(shifted.stderr, /function_over_bound/u);
    // Both readings from the same tree: the line moved and the identity did not, which is what makes the identity
    // - not the position - the key.
    assert.equal(run(root, ["--update"]).status, 0);
    const recorded = JSON.parse(readFileSync(baselinePath, "utf8")).members[0];
    assert.equal(recorded.id, "ts:host/src/fixture.ts#run#lambda1");
    assert.ok(recorded.line > 2, `the line moved to ${recorded.line} and the identity held`);

    // The identity also names the lambda in a failure, with the line as the reader's hint rather than as the key.
    writeAnonymousLambdaSource(root, 3, 25);
    const grown = run(root);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /function_grew: ts:host\/src\/fixture\.ts#run#lambda1 4 -> 6/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: --update keeps the reason recorded for an entry", () => {
  const root = fixtureRoot();
  const baselinePath = join(root, "tools", "cognitive-complexity-baseline.json");
  try {
    writeBiomeConfig(root, 1);
    writeTypeScriptSource(root, 2);
    writeFileSync(join(root, "integrations", "stardew", "Empty.cs"), EMPTY_CSHARP);
    assert.equal(run(root, ["--update"]).status, 0);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    baseline.members[0].reason = "bought by a correctness fix in fixture commit";
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    assert.equal(run(root, ["--update"]).status, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(baselinePath, "utf8")).members.map((entry) => entry.reason),
      ["bought by a correctness fix in fixture commit"],
      "re-recording a value does not erase why it was bought",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: --update keeps a reason on the row it explains, not on the same id in another section", () => {
  const root = fixtureRoot();
  const baselinePath = join(root, "tools", "cognitive-complexity-baseline.json");
  try {
    writeBiomeConfig(root);
    writeTypeScriptSource(root, 0);
    const padding = Array.from({ length: CLASS_LINE_CEILING }, (_, index) => `    // line ${index}`).join("\n");
    const methods = Array.from(
      { length: 11 },
      (_, index) => `    public void Run${index}(int a)\n    {\n${csharpMember(20)}\n    }`,
    ).join("\n");
    writeFileSync(
      join(root, "integrations", "stardew", "Big.cs"),
      `namespace Fixture\n{\n  public class Big\n  {\n${padding}\n${methods}\n  }\n}\n`,
    );
    assert.equal(run(root, ["--update"]).status, 0);
    const first = JSON.parse(readFileSync(baselinePath, "utf8"));
    // One type, two rows: 220 complexity over the class bound and over the line ceiling at once.
    assert.deepEqual(
      first.classes.map((entry) => entry.id),
      ["cs:Fixture.Big"],
    );
    assert.deepEqual(
      first.sizes.map((entry) => entry.id),
      ["cs:Fixture.Big"],
    );
    first.sizes[0].reason = "bought by a fixture commit";
    writeFileSync(baselinePath, `${JSON.stringify(first, null, 2)}\n`);
    assert.equal(run(root, ["--update"]).status, 0);
    const again = JSON.parse(readFileSync(baselinePath, "utf8"));
    assert.deepEqual(
      again.sizes.map((entry) => entry.reason),
      ["bought by a fixture commit"],
    );
    assert.deepEqual(
      again.classes.map((entry) => entry.reason),
      [undefined],
      "a line-shaped reason is not a class one",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
