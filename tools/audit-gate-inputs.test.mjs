/**
 * The falsifiers for `tools/audit-gate-inputs.mjs`, one per way a gate's population can be read wrongly.
 *
 * red-proof: self-check  this file drives its own gate over throwaway trees -> a hand-listed gate that prints its verdict
 *            from its findings alone and is not recorded is `gate_input_hand_listed_and_green_with_zero:` with exit 1,
 *            a recorded one exits 0, a row the tree outgrew is `gate_input_baseline_stale:`, and a tree with no gate
 *            exits 2 rather than passing (tools/audit-gate-inputs.mjs).
 *
 * Each case builds a throwaway tree with a real `package.json` and real gate files, so the tool's ONE derivation
 * (`tools/lib/gate-population.mjs`) is what puts them in the population - a hand-written list of gates in this test
 * would prove nothing about the reading.
 *
 * The four claims, in the order a reader needs them:
 *
 *   1. each source is recognised from code, not from a label: a scan, a module-level table, one fixed input, a program
 *      this repository does not carry, a language this reading has no grammar for;
 *   2. each zero-read verdict is recognised from code, and the pass condition (`findings.length === 0`) is NOT a zero
 *      population guard - that boundary is the difference between a gate and a gate nobody can trust;
 *   3. the pair that cannot tell "nothing to check" from "all good" is the worst class, its baseline row names the
 *      population the gate hand-lists, and the ratchet turns in both directions;
 *   4. the CLI: a new member of that class exits 1 and names it, a recorded one exits 0, a stale row exits 1, and a tree
 *      with no gate in it exits 2 rather than passing;
 *   5. the reader is not always called by the name it was imported under, and it is not always a reader: `read =`
 *      `readFile` (injected or aliased), `await import(url)` (loaded, not opened), and a command whose program this
 *      repository does not carry (`depcruise`) - each of which was measured as reading NOTHING before this case
 *      existed, and each of which the real tree uses today (`tools/generate-sbom.mjs`, `tools/check-dist-runtime-
 *      exports.mjs`, `check:host-module-graph`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PATH,
  baselineDocument,
  buildReport,
  classifyReading,
  compareWithBaseline,
  readGateInputs,
  statusOf,
  worstClass,
  zeroReadFlags,
  zeroReadVerdict,
} from "./audit-gate-inputs.mjs";

const TOOL = fileURLToPath(new URL("./audit-gate-inputs.mjs", import.meta.url));

/** A throwaway tree from `path -> text`. Removed when the case ends, so no case can read another's state. */
function fixtureTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "gate-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The reading over a fixture tree, keyed by gate id, so a case asserts a fact rather than an index. */
async function readingOf(root) {
  const reading = await readGateInputs({ root });
  return { reading, byId: new Map(reading.gates.map((gate) => [gate.id, gate])) };
}

const scripts = (names) => JSON.stringify({ scripts: Object.fromEntries(names) });

/** Every shape at once: one shape per gate file, named by a `check:` script so the census sees each one. */
const MIXED = {
  "package.json": scripts([
    ["check:scan", "node tools/check-scan.mjs"],
    ["check:table", "node tools/check-table.mjs"],
    ["check:single", "node tools/check-single.mjs"],
    ["check:guarded", "node tools/check-guarded.mjs"],
    ["check:silent", "node tools/check-silent.mjs"],
    ["check:python", "node tools/check-python.py"],
    ["check:outside", "pnpm knip --production"],
  ]),
  "host/src/a.ts": "export const a = 1;\n",
  "host/src/b.ts": "export const b = 2;\n",
  // A scan, and a `findings.length === 0` pass condition: the pass check must not be read as a zero-population guard.
  "tools/check-scan.mjs": `import { readdirSync } from "node:fs";
// A gate whose own prose says not_measured is not a gate that reports it.
const findings = [];
const files = readdirSync("host/src");
if (findings.length === 0) process.stdout.write(\`scan examined \${files.length}\\n\`);
process.stdout.write(\`\${JSON.stringify({ gate: "scan", status: "passed", examined: files.length })}\\n\`);
`,
  // Two paths written down module-level: the population is this file's own list, and the shared judge blocks a zero
  // reading of it. The fixtures are parsed, never executed, so the judge call needs no import here.
  "tools/check-table.mjs": `import { readFileSync } from "node:fs";
const FILES = ["host/src/a.ts", "host/src/b.ts"];
const found = FILES.map((file) => readFileSync(file, "utf8"));
const judged = assertNonVacuous({ gate: "table", status: "passed", examined: found.length });
process.stdout.write(\`\${JSON.stringify({ gate: "table", status: judged.status, examined: found.length })}\\n\`);
`,
  // One fixed input: a declaration the gate points at, not a set it enumerates. The path is written with a slash
  // because a fixture tree is not a repository, so the index supplies no file-extension vocabulary for a bare name.
  "tools/check-single.mjs": `import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync("./package.json", "utf8"));
process.stdout.write(\`\${JSON.stringify({ gate: "single", status: "passed", examined: Object.keys(manifest).length })}\\n\`);
`,
  // Hand-listed AND blocked: the pair split, so the ratchet can tell the two apart.
  "tools/check-guarded.mjs": `import { readFileSync } from "node:fs";
const FILES = ["host/src/a.ts", "host/src/b.ts"];
const found = FILES.map((file) => readFileSync(file, "utf8"));
if (found.length === 0) {
  process.stderr.write("nothing to read\\n");
  process.exitCode = 2;
}
process.stdout.write(\`\${JSON.stringify({ gate: "guarded", status: found.length === 0 ? "blocked" : "passed", examined: found.length })}\\n\`);
`,
  // The worst class: hand-listed, and a run over nothing prints what a run over two prints.
  "tools/check-silent.mjs": `import { readFileSync } from "node:fs";
const FILES = ["host/src/a.ts", "host/src/b.ts"];
const found = FILES.map((file) => readFileSync(file, "utf8"));
process.stdout.write(\`\${JSON.stringify({ gate: "silent", status: "passed", findings: [] })}\\n\`);
`,
  "tools/check-python.py": "print('a gate this reading has no grammar for')\n",
};

test("each source is read from code, not from a label", async (t) => {
  const { byId } = await readingOf(fixtureTree(t, MIXED));

  // A directory scan: the population is derived at run time.
  assert.equal(byId.get("check:scan").source, "authority");
  assert.match(byId.get("check:scan").because, /^directory_scan:tools\/check-scan\.mjs:readdirSync$/u);
  assert.deepEqual(byId.get("check:scan").reads, ["host/src"]);

  // A module-level table of paths: the gate wrote the members down.
  assert.equal(byId.get("check:table").source, "hand-listed");
  assert.deepEqual(byId.get("check:table").reads, ["host/src/a.ts", "host/src/b.ts"]);

  // One fixed input is a declaration the gate points at, not a population it enumerates.
  assert.equal(byId.get("check:single").source, "authority");
  assert.equal(byId.get("check:single").because, "fixed_input:./package.json");

  // The deciding code is not in this repository: named, counted, and never green.
  assert.equal(byId.get("check:outside").source, "external");
  assert.equal(byId.get("check:outside").because, "command_names_no_file_in_this_repository");
  assert.equal(byId.get("check:outside").zeroRead, "unseen");

  // A language this reading has no grammar for is `unreadable`, not a pass.
  assert.equal(byId.get("check:python").source, "unreadable");
  assert.match(byId.get("check:python").because, /^entry_language_not_parsed_here:\.py$/u);
  assert.equal(byId.get("check:python").zeroRead, "unseen");
});

test("each zero-read verdict is read from code, and the pass condition is not a guard", async (t) => {
  const { byId } = await readingOf(fixtureTree(t, MIXED));

  // `if (findings.length === 0) process.stdout.write(...)` is how every gate says "I found nothing": the comparison
  // this reading looks for is one whose branch EXITS or BLOCKS, which is why the scan gate stays green-with-zero.
  assert.equal(byId.get("check:scan").zeroRead, "green-with-zero");

  // A zero comparison whose branch blocks the run is the fix, so this one is not a member of the worst class even
  // though it hand-lists the same two paths as the gate below it.
  assert.equal(byId.get("check:guarded").source, "hand-listed");
  assert.equal(byId.get("check:guarded").zeroRead, "blocked");

  // The same pair, guarded by the SHARED judge instead of a branch of its own: still not a member.
  assert.equal(byId.get("check:table").source, "hand-listed");
  assert.equal(byId.get("check:table").zeroRead, "blocked");

  assert.equal(byId.get("check:silent").source, "hand-listed");
  assert.equal(byId.get("check:silent").zeroRead, "green-with-zero");
});

test("a comment cannot make a gate report not_measured", async (t) => {
  // Comments are blanked before the flags are read, and the fixture's scan gate says `not_measured` in prose while its
  // code never does. It is `green-with-zero` - not `unmeasured` - which is the end-to-end proof that a gate's
  // documentation stays out of its verdict.
  const { byId } = await readingOf(fixtureTree(t, MIXED));
  assert.match(MIXED["tools/check-scan.mjs"], /not_measured/u);
  assert.equal(byId.get("check:scan").zeroRead, "green-with-zero");
  // The same word in code IS a report.
  assert.equal(zeroReadFlags(`status = "not_measured";`).notMeasured, true);
  assert.equal(
    zeroReadVerdict({ source: "authority", flags: zeroReadFlags(`status = "not_measured";`) }),
    "unmeasured",
  );
});

test("the shared judge and an allowEmpty reason are the other two verdicts", () => {
  assert.equal(
    zeroReadVerdict({ source: "authority", flags: zeroReadFlags(`const judged = assertNonVacuous(report);`) }),
    "blocked",
  );
  assert.equal(
    zeroReadVerdict({ source: "authority", flags: zeroReadFlags(`allowEmpty: "the mount is not here"`) }),
    "unmeasured",
  );
  // `unseen` outranks every flag: code this reading cannot see cannot be claimed to guard anything.
  assert.equal(
    zeroReadVerdict({ source: "external", flags: zeroReadFlags(`if (examined === 0) process.exit(2);`) }),
    "unseen",
  );
  assert.equal(zeroReadVerdict({ source: "unreadable", flags: zeroReadFlags("") }), "unseen");
});

test("classifyReading answers unknown only when nothing readable is there", () => {
  const empty = { reads: [], scans: [], spawns: [], tables: [] };
  assert.deepEqual(classifyReading(empty), {
    source: "unknown",
    because: "no_file_read_reachable",
    reads: [],
  });
  // A path from a name the file does not declare is an authority's, not the file's: `read(SOURCES.surface)`.
  const imported = {
    reads: [{ file: "tools/x.mjs", call: "readFileSync", literals: [], fromImport: ["SOURCES"] }],
    scans: [],
    spawns: [],
    tables: [],
  };
  assert.equal(classifyReading(imported).source, "authority");
  assert.match(classifyReading(imported).because, /^path_from_a_name_this_reading_does_not_declare:/u);
  // `git` is the index: a derived population even though it is a program.
  const index = {
    reads: [],
    scans: [],
    spawns: [{ file: "tools/x.mjs", call: "execFileSync", program: "git" }],
    tables: [],
  };
  assert.equal(classifyReading(index).source, "authority");
  assert.match(classifyReading(index).because, /^index_read:/u);
});

test("the worst class is the pair, and its baseline row names the population", async (t) => {
  const { reading, byId } = await readingOf(fixtureTree(t, MIXED));
  const members = worstClass(reading.gates);

  assert.deepEqual(
    members.map((gate) => gate.id),
    ["check:silent"],
  );
  // The baseline row carries the population the gate hand-lists, not just its name: a reader can check the claim.
  assert.equal(baselineDocument(members).members[0], "check:silent :: host/src/a.ts, host/src/b.ts");
  assert.equal(byId.get("check:guarded").zeroRead, "blocked", "a blocked gate is not in the worst class");
});

test("the ratchet turns both ways", () => {
  const member = { id: "check:a", reads: ["x/y.ts"] };
  const baseline = baselineDocument([member]);

  assert.deepEqual(compareWithBaseline({ members: [member], baseline }), { unrecorded: [], stale: [] });

  const arrived = compareWithBaseline({ members: [member, { id: "check:b", reads: ["x/z.ts"] }], baseline });
  assert.deepEqual(
    arrived.unrecorded.map((gate) => gate.id),
    ["check:b"],
  );

  const paid = compareWithBaseline({ members: [], baseline });
  assert.deepEqual(paid.stale, ["check:a"]);

  // The identity is the gate, never its paths: a row whose population changed is the same member, so it cannot read
  // as stale when a path moves inside the gate.
  const moved = compareWithBaseline({ members: [{ id: "check:a", reads: ["x/other.ts"] }], baseline });
  assert.deepEqual(moved, { unrecorded: [], stale: [] });
});

test("a reading over no gate is blocked, not passed", () => {
  assert.equal(statusOf({ examined: 0, baselineMissing: false, unrecorded: [], stale: [] }), "blocked");
  assert.equal(statusOf({ examined: 3, baselineMissing: true, unrecorded: [], stale: [] }), "blocked");
  assert.equal(statusOf({ examined: 3, baselineMissing: false, unrecorded: [], stale: [] }), "passed");
  assert.equal(statusOf({ examined: 3, baselineMissing: false, unrecorded: [{ id: "check:a" }], stale: [] }), "failed");
});

test("the report names the class, the counts, and its own rule outcomes", async (t) => {
  const { reading } = await readingOf(fixtureTree(t, MIXED));
  const members = worstClass(reading.gates);
  const report = buildReport({
    reading,
    members,
    baseline: null,
    unrecorded: compareWithBaseline({ members, baseline: null }).unrecorded,
    stale: [],
  });
  assert.equal(report.gate, "gate_inputs/v1");
  assert.equal(report.examined, reading.examined);
  assert.equal(report.worstClass, members.length);
  assert.equal(report.status, "blocked", "no baseline means the class cannot be told from a new member");
  assert.equal(report.sources.unreadable, 1);
  assert.equal(report.zeroRead.unseen, 2);
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["every_gate_classified", "baseline_current"],
  );
});

test("the CLI: a new member is red and names itself, a recorded one is green, a stale row is red", async (t) => {
  const root = fixtureTree(t, MIXED);
  const run = () => spawnSync(process.execPath, [TOOL, "--root", root], { encoding: "utf8" });

  // No baseline: blocked, because a member cannot be told from a new one.
  assert.equal(run().status, 2);

  // Recorded: green, and the census line carries `examined N`.
  mkdirSync(join(root, dirname(BASELINE_PATH)), { recursive: true });
  writeFileSync(
    join(root, BASELINE_PATH),
    `${JSON.stringify(baselineDocument([{ id: "check:silent", reads: ["host/src/a.ts", "host/src/b.ts"] }]), null, 2)}\n`,
  );
  const recorded = run();
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /gate_inputs examined 7 · /u);
  assert.equal(JSON.parse(recorded.stdout.trim().split("\n").at(-1)).status, "passed");

  // A member nobody recorded: red, and the finding names the gate and the population it hand-lists.
  writeFileSync(
    join(root, "tools/check-arrived.mjs"),
    `import { readFileSync } from "node:fs";\nconst FILES = ["host/src/a.ts", "host/src/b.ts"];\nconst found = FILES.map((file) => readFileSync(file, "utf8"));\nprocess.stdout.write(JSON.stringify({ gate: "arrived", status: "passed", examined: found.length }) + "\\n");\n`,
  );
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  manifest.scripts["check:arrived"] = "node tools/check-arrived.mjs";
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  const arrived = run();
  assert.equal(arrived.status, 1, arrived.stderr);
  assert.match(
    arrived.stderr,
    /gate_input_hand_listed_and_green_with_zero: check:arrived — host\/src\/a\.ts, host\/src\/b\.ts/u,
  );

  // A row the tree has outgrown: red too, because the record may only shrink.
  const paid = baselineDocument([
    { id: "check:silent", reads: ["host/src/a.ts", "host/src/b.ts"] },
    { id: "check:ghost", reads: ["gone/x.ts"] },
  ]);
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(paid, null, 2)}\n`);
  const stale = run();
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /gate_input_baseline_stale: check:ghost/u);
});

test("the CLI over a tree with no gate in it exits 2 instead of passing", (t) => {
  const root = fixtureTree(t, { "package.json": scripts([]) });
  const run = spawnSync(process.execPath, [TOOL, "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no gate was read, so nothing can be judged/u);
});

test("the two gates the red-proof ledger calls unassessed are external here, never green", async () => {
  // `report:clones` runs jscpd and `test:voice-protocol` runs a suite in the vendored `pi-koe` package: neither runs a
  // file this repository owns, which is the whole of what `unassessed` meant. This reading must reach the same
  // conclusion and must NOT report them as gates that measured nothing - that would be the silent green it exists for.
  const reading = await readGateInputs();
  assert.ok(reading.examined > 300, `the real census read ${reading.examined} gates`);
  for (const id of ["report:clones", "test:voice-protocol"]) {
    const gate = reading.gates.find((entry) => entry.id === id);
    assert.ok(gate !== undefined, `${id} is in the population`);
    assert.equal(gate.source, "external", `${id} is external`);
    assert.equal(gate.zeroRead, "unseen", `${id} is unseen rather than green-with-zero`);
  }
});

test("a reader the gate binds to another name is read through the name it calls", async (t) => {
  const root = fixtureTree(t, {
    "package.json": scripts([
      ["check:injected", "node tools/check-injected.mjs"],
      ["check:aliased-import", "node tools/check-aliased-import.mjs"],
      ["check:loaded", "node tools/check-loaded.mjs"],
      ["check:builtin", "node tools/check-builtin.mjs"],
    ]),
    "host/src/a.ts": "export const a = 1;\n",
    // A reader injected as a destructured parameter default: the call site says `read`, the reader is `readFile`.
    "tools/check-injected.mjs": `import { readFile } from "node:fs/promises";
async function load(path, { read = readFile } = {}) {
  return read(path, "utf8");
}
const source = await load("host/src/a.ts");
process.stdout.write(JSON.stringify({ gate: "injected", examined: source.length }) + "\\n");
`,
    // The same, imported under another name.
    "tools/check-aliased-import.mjs": `import { readFileSync as slurp } from "node:fs";
const source = slurp("host/src/a.ts", "utf8");
process.stdout.write(JSON.stringify({ gate: "aliased-import", examined: source.length }) + "\\n");
`,
    // A module LOADED rather than opened: what `host/src/a.ts` exports is the population.
    "tools/check-loaded.mjs": `import { pathToFileURL } from "node:url";
const loaded = await import(pathToFileURL("host/src/a.ts").href);
process.stdout.write(JSON.stringify({ gate: "loaded", examined: Object.keys(loaded).length }) + "\\n");
`,
    // A built-in loaded by name reaches no file here, so this gate still reads nothing.
    "tools/check-builtin.mjs": `const { readFile } = await import("node:fs/promises");
process.stdout.write(JSON.stringify({ gate: "builtin", examined: typeof readFile }) + "\\n");
`,
  });
  const { byId } = await readingOf(root);

  // Namespace ignored: the reader is the reader, and the verdict is `green-with-zero` about a population this reading
  // now names, not about an empty set of nothing.
  assert.equal(byId.get("check:injected").source, "authority");
  assert.equal(
    byId.get("check:injected").because,
    "path_not_written_in_this_reading:tools/check-injected.mjs:readFile (as read)",
  );
  assert.equal(byId.get("check:injected").zeroRead, "green-with-zero");

  assert.equal(byId.get("check:aliased-import").source, "authority");
  assert.deepEqual(byId.get("check:aliased-import").reads, ["host/src/a.ts"]);

  // A load is a read: this gate reports a population of one file's exports, and before this case it reported nothing.
  assert.equal(byId.get("check:loaded").source, "authority");
  assert.equal(byId.get("check:loaded").because, "module_load:tools/check-loaded.mjs:import");

  assert.equal(byId.get("check:builtin").source, "unknown");
  assert.equal(byId.get("check:builtin").because, "no_file_read_reachable");
});

test("a scan whose root is a parameter names the parameter instead of naming nothing", async (t) => {
  const root = fixtureTree(t, {
    "package.json": scripts([["check:walker", "node tools/check-walker.mjs"]]),
    "host/src/a.ts": "export const a = 1;\n",
    // The shape 21 gates in this tree use: an exported walker whose directory arrives as an argument.
    "tools/check-walker.mjs": `import { readdirSync } from "node:fs";
export function listSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) files.push(entry.name);
  };
  walk(root);
  return files;
}
const files = listSources("host/src");
process.stdout.write(JSON.stringify({ gate: "walker", examined: files.length }) + "\\n");
`,
  });
  const { byId } = await readingOf(root);
  const gate = byId.get("check:walker");

  assert.equal(gate.source, "authority");
  assert.equal(gate.zeroRead, "green-with-zero");
  // The reading says where it stopped rather than printing an empty path list that reads like a gate over nothing.
  assert.match(
    gate.because,
    /^directory_scan:tools\/check-walker\.mjs:readdirSync \(root is directory, a parameter of walk\)$/u,
  );
  assert.deepEqual(gate.reads, []);
});

test("a command decided by a program this repository does not carry is external, not unknown", async (t) => {
  const root = fixtureTree(t, {
    "package.json": scripts([
      ["check:cruise", "depcruise --config .dependency-cruiser.cjs host/src/main.ts"],
      ["check:chained", "cd host && node --test src/a.test.mjs"],
    ]),
    "host/src/main.ts": "export const main = 1;\n",
    "host/src/a.test.mjs": "process.stdout.write('a test that reads no file\\n');\n",
  });
  const { byId } = await readingOf(root);

  // The named files are arguments to `depcruise`: its verdict is the published program's, so the reading says so
  // instead of calling a gate over four files a gate that reads nothing.
  assert.equal(byId.get("check:cruise").source, "external");
  assert.equal(byId.get("check:cruise").because, "runs_a_program_this_repository_does_not_carry:depcruise");
  assert.equal(byId.get("check:cruise").zeroRead, "unseen");

  // `cd host && node --test …` is `node` running this repository's own file: the chain is a shell detail, not a program.
  assert.equal(byId.get("check:chained").source, "unknown");
  assert.equal(byId.get("check:chained").because, "no_file_read_reachable");
});
