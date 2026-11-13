#!/usr/bin/env node
/**
 * The falsifiers for `tools/audit-gate-red-proofs.mjs` - the gate that asks whether every other gate has
 * been seen red. Each test here injects the defect the audit exists to name and requires the audit to
 * name it, because a coverage gate that cannot go red is the illusion it was written to remove.
 *
 * The tree is synthetic on purpose: the question is whether the READING reacts to a marker appearing and
 * disappearing, so the fixture must be the only thing that changes.
 *
 * The marker keyword is assembled from two strings rather than written out: this file is owned by the
 * audit under test, and a literal marker here would be read as one of the audit's own proofs.
 *
 * red-proof: inject  the anchor test removed from `readRedProofMarkers`, so a marker inside a string literal counts ->
 *                    `× a marker on a code line is not a marker, so a gate cannot satisfy itself` (with five more),
 *                    exit 1; the unmodified audit passes all ten cases, exit 0 (tools/audit-gate-red-proofs.test.mjs)
 *
 * red-proof: inject  this suite's gate-file scan re-spelled as `/^check-.*\.mjs$/` in a copy whose population is widened
 *                    to `audit-*` and whose index drop is silenced -> the re-spelled scan passed while asking `isGateFile`
 *                    named the planted untracked gate file it never looked at (tools/audit-gate-red-proofs.test.mjs)
 *
 * red-proof: inject  the untracked term made a suffix that disappears at zero, as this audit had it before -> "a zero
 *                    complement is a reading that has to be printed, not an absence a reader fills in", actual
 *                    `... unreadable=0 ` with no term at all (tools/audit-gate-red-proofs.test.mjs)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditGateRedProofs,
  describeDropped,
  describeGateCensus,
  describePopulationLine,
  evaluate,
  readRedProofMarkers,
} from "./audit-gate-red-proofs.mjs";
import { POPULATION_FIELDS } from "./lib/assert-non-vacuous.mjs";
import { isGateFile } from "./lib/gate-population.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const KEYWORD = ["red", "proof"].join("-");
const marker = (kind, claim, pointer) => `\n * ${KEYWORD}: ${kind}  ${claim} (${pointer})\n`;

/** The fixture tree is a git repository with its files staged: the population is the index, not the directory. */
const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

function makeTree(files, packageExtra = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-red-proofs-"));
  const write = (path, contents) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents, "utf8");
  };
  write(
    "package.json",
    JSON.stringify({
      scripts: {
        "check:a": "node tools/check-a.mjs",
        "check:aggregate": "pnpm check:a",
        build: "node tools/check-a.mjs",
      },
      ...packageExtra,
    }),
  );
  write("tools/check-a.test.mjs", "// the falsifier suite\n");
  for (const [path, contents] of Object.entries(files)) write(path, contents);
  git(root, "init", "-q");
  git(root, "add", "-A");
  return root;
}

const gateSource = (comment) => `#!/usr/bin/env node\n${comment}\nprocess.exit(0);\n`;
const statusOf = (reading, gate) => reading.records.find((record) => record.id === gate)?.status;
const codesFor = (findings, gate) => findings.filter((finding) => finding.gate === gate).map((finding) => finding.code);
const evaluateAgainst = (root, gates) => evaluate({ reading: auditGateRedProofs({ root }), baseline: { gates } });

test("a declared red proof is proven; deleting it names the gate, its aggregate, and the stale baseline entry", () => {
  const proof = marker(
    "inject",
    "a lane set that omits an action its run needs -> fixture_lane_missing_required_action",
    "tools/check-a.test.mjs",
  );
  const root = makeTree({ "tools/check-a.mjs": gateSource(proof) });
  try {
    // Recorded as a gap yesterday, closed today - so the entry is stale and the ratchet must say so.
    const proven = evaluateAgainst(root, ["check:a", "check:aggregate"]);
    const reading = auditGateRedProofs({ root });
    assert.equal(statusOf(reading, "check:a"), "proven");
    assert.equal(statusOf(reading, "check:aggregate"), "proven");
    assert.deepEqual(codesFor(proven.findings, "check:a"), ["baseline_entry_stale"]);
    assert.equal(reading.proven.find((record) => record.id === "check:a").proofs[0].kind, "inject");

    // The injection: the marker disappears, nothing else changes. The aggregate cannot stay green behind it.
    writeFileSync(join(root, "tools/check-a.mjs"), gateSource("// no proof here"), "utf8");
    const cleared = evaluateAgainst(root, []);
    const unproven = auditGateRedProofs({ root });
    assert.equal(statusOf(unproven, "check:a"), "unproven");
    assert.equal(statusOf(unproven, "check:aggregate"), "unproven_via_members");
    assert.deepEqual(codesFor(cleared.findings, "check:a"), ["no_red_proof"]);
    assert.deepEqual(codesFor(cleared.findings, "check:aggregate"), ["no_red_proof"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded gap holds the ratchet, and recording it as proven again fails it", () => {
  const root = makeTree({ "tools/check-a.mjs": gateSource("// no proof here") });
  try {
    const held = evaluateAgainst(root, ["check:a", "check:aggregate"]);
    assert.deepEqual(held.findings, []);
    assert.equal(held.held, 2);
    // The baseline only tightens: an entry that is proven now cannot keep excusing the gate.
    writeFileSync(
      join(root, "tools/check-a.mjs"),
      gateSource(marker("inject", "an omission -> the finding", "tools/check-a.test.mjs")),
      "utf8",
    );
    const stale = evaluateAgainst(root, ["check:a", "check:aggregate"]);
    assert.deepEqual(codesFor(stale.findings, "check:a"), ["baseline_entry_stale"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a baseline entry whose gate no longer exists is stale, so the file cannot outlive its gates", () => {
  const root = makeTree({ "tools/check-a.mjs": gateSource("// no proof here") });
  try {
    const findings = evaluateAgainst(root, ["check:a", "check:deleted-long-ago"]).findings;
    assert.deepEqual(codesFor(findings, "check:deleted-long-ago"), ["baseline_entry_stale"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker on a code line is not a marker, so a gate cannot satisfy itself", () => {
  const root = makeTree({
    "tools/check-a.mjs": gateSource(`const pattern = "${KEYWORD}: inject  something long enough to look real";`),
  });
  try {
    const reading = auditGateRedProofs({ root });
    assert.equal(readRedProofMarkers({ root, file: "tools/check-a.mjs" }).length, 0);
    assert.equal(statusOf(reading, "check:a"), "unproven");
    assert.deepEqual(codesFor(evaluateAgainst(root, []).findings, "check:a"), ["no_red_proof"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a proof that names a file which is not on disk is a dead claim the baseline cannot hold", () => {
  const root = makeTree({
    "tools/check-a.mjs": gateSource(marker("inject", "an omission -> the finding", "tools/check-a-vanished.test.mjs")),
  });
  try {
    const reading = auditGateRedProofs({ root });
    assert.equal(statusOf(reading, "check:a"), "pointer_missing");
    // Recorded as a gap AND unreadable: the recording does not excuse a claim nobody can check.
    const findings = evaluateAgainst(root, ["check:a"]).findings;
    assert.deepEqual(codesFor(findings, "check:a"), ["red_proof_pointer_missing"]);
    assert.match(findings[0].detail, /tools\/check-a-vanished\.test\.mjs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker whose kind is not one the ledger reads is reported, not skipped and not recorded", () => {
  const root = makeTree({
    "tools/check-a.mjs": gateSource(`\n * ${KEYWORD}: vibes  it felt red when I ran it by hand\n`),
  });
  try {
    const reading = auditGateRedProofs({ root });
    assert.equal(statusOf(reading, "check:a"), "malformed");
    assert.deepEqual(codesFor(evaluateAgainst(root, ["check:a"]).findings, "check:a"), ["red_proof_kind_unknown"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a proof's pointer is executed when a runner names the file or the project directory it sits in", () => {
  const files = {
    "integrations/stardew/tests/Project/InjectedTests.cs": "// the injected fact\n",
    "integrations/stardew/tests/Elsewhere/Unrun.cs": "// a project no command runs\n",
  };
  // The declaration lives in `gateRedProofs`, which is where a gate whose command runs a project keeps its proof:
  // `dotnet test <project>` names no file of its own.
  const tree = (pointer) =>
    makeTree(files, {
      scripts: { "check:a": "dotnet test integrations/stardew/tests/Project" },
      gateRedProofs: {
        "check:a": `inject a failing fact compiled beside the real sources -> \`Failed: 1, Passed: 1\` and exit 1 (${pointer})`,
      },
    });

  // `dotnet test <project directory>` compiles every file beneath it, so the fact's own file is run.
  const executed = tree("integrations/stardew/tests/Project/InjectedTests.cs");
  try {
    const reading = auditGateRedProofs({ root: executed });
    assert.equal(statusOf(reading, "check:a"), "proven");
    assert.deepEqual(reading.unexecutedProofs, []);
  } finally {
    rmSync(executed, { recursive: true, force: true });
  }

  // The injection: the same marker naming a project nothing runs. Proven still, but the census must say the
  // proof points at a file no command reaches - which is the reading this derivation exists for.
  const orphaned = tree("integrations/stardew/tests/Elsewhere/Unrun.cs");
  try {
    const reading = auditGateRedProofs({ root: orphaned });
    assert.equal(statusOf(reading, "check:a"), "proven");
    assert.deepEqual(
      reading.unexecutedProofs.map((entry) => entry.pointer),
      ["integrations/stardew/tests/Elsewhere/Unrun.cs"],
    );
  } finally {
    rmSync(orphaned, { recursive: true, force: true });
  }
});

test("the population is the declared gate scripts plus the gate files no script names", () => {
  const root = makeTree({
    "tools/check-a.mjs": gateSource(
      marker("inject", "a lane set that omits a required action", "tools/check-a.test.mjs"),
    ),
    "tools/check-orphan.mjs": gateSource("// reachable by no script\n"),
  });
  try {
    const reading = auditGateRedProofs({ root });
    const ids = reading.records.map((record) => record.id);
    // Derived from package.json's `audit:`/`check:`/`test:` namespace: `build` is not a gate.
    assert.deepEqual(
      ids.filter((id) => id.includes(":")),
      ["check:a", "check:aggregate"],
    );
    // The directory half is the gates a script never names, and it is mandatory: a gate nobody types
    // is exactly the one that stops working without a symptom.
    assert.ok(ids.includes("tools/check-orphan.mjs"), `orphan gate missing from ${ids.join(", ")}`);
    assert.equal(reading.population.unclaimedByScript, 1);
    assert.equal(statusOf(reading, "tools/check-orphan.mjs"), "unproven");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The population is the index, so a gate file no commit carries is nobody's yet: it must not fail the census, and it
// must not disappear either. Staging the same file makes it a gate like any other, and its unreadable marker then fails
// the run - the leniency is about which gate is judged, never about how a marker is parsed.
test("a gate file the index does not carry is inert and published; staged, it is judged", () => {
  const root = makeTree({ "tools/check-a.mjs": gateSource("// no proof here") });
  try {
    writeFileSync(
      join(root, "tools/check-planted.mjs"),
      gateSource(`\n * ${KEYWORD}: vibes  it felt red when I ran it by hand\n`),
      "utf8",
    );
    const untracked = auditGateRedProofs({ root });
    assert.deepEqual(untracked.population.untrackedNotCounted, ["tools/check-planted.mjs"]);
    assert.equal(untracked.population.total, 2, "the untracked gate is not in the population");
    assert.equal(statusOf(untracked, "tools/check-planted.mjs"), undefined);
    assert.deepEqual(evaluateAgainst(root, ["check:a", "check:aggregate"]).findings, []);

    git(root, "add", "tools/check-planted.mjs");
    const staged = auditGateRedProofs({ root });
    assert.deepEqual(staged.population.untrackedNotCounted, [], "a staged gate file is in the index");
    assert.equal(staged.population.total, 3);
    assert.equal(statusOf(staged, "tools/check-planted.mjs"), "malformed");
    assert.deepEqual(
      codesFor(evaluateAgainst(root, ["check:a", "check:aggregate"]).findings, "tools/check-planted.mjs"),
      ["red_proof_kind_unknown"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the census counts the gates that cannot see a zero population, and the ones that print no report at all", () => {
  const report = (fields) =>
    `#!/usr/bin/env node\nprocess.stdout.write('{"gate":"stub/v1","status":"passed","checks":[],${fields}}\\n');\n`;
  const root = makeTree({
    "tools/check-a.mjs": gateSource("// no proof here"),
    // A report that names no field the shared judge reads: a zero in it is invisible.
    "tools/check-invisible.mjs": report("'\"count\":0'"),
    // A report that does name one: the judge can see it, so it is not part of the count.
    "tools/check-visible.mjs": report("'\"population\":3'"),
    // A gate that prints no report is not judged on a population at all, and is not counted as reporting.
    "tools/check-silent.mjs": gateSource("// a human sentence on stdout, no report"),
  });
  try {
    const census = auditGateRedProofs({ root }).zeroPopulationPass;
    assert.deepEqual(census.reporting.sort(), ["tools/check-invisible.mjs", "tools/check-visible.mjs"]);
    assert.deepEqual(census.invisible, ["tools/check-invisible.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// One list, two readers: the static census looks for the SAME field names `assertNonVacuous` reads at runtime. Two
// spellings of that list disagree the first time a member is added to one of them, and the disagreement is silent - the
// census would report a gate as blind while the judge reads its population perfectly well.
test("the static census reads exactly the field names the shared judge reads", () => {
  for (const field of POPULATION_FIELDS) {
    const root = makeTree({
      "tools/check-a.mjs": gateSource("// no proof here"),
      ["tools/check-field.mjs"]: `#!/usr/bin/env node\nprocess.stdout.write('{"gate":"stub/v1","status":"passed","checks":[],"${field}":2}\\n');\n`,
    });
    try {
      assert.deepEqual(
        auditGateRedProofs({ root }).zeroPopulationPass.invisible,
        [],
        `a report carrying \`${field}\` must be readable by the census`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an external label leaves the debt set, and a command nothing invokes fails the run", () => {
  // A project runner: `pnpm knip` names no file here, so the declaration lives beside the command that defines it.
  const declared = (command, howItFails) => ({ "check:knip": `external ${command} — ${howItFails}` });
  const invoked = makeTree(
    {},
    { scripts: { "check:knip": "pnpm knip" }, gateRedProofs: declared("pnpm knip", "an unused export exits 1") },
  );
  try {
    const reading = auditGateRedProofs({ root: invoked });
    assert.equal(statusOf(reading, "check:knip"), "external");
    assert.deepEqual(
      reading.external.map((record) => record.external[0].command),
      ["pnpm knip"],
      "the record keeps the command a reader would run",
    );
    assert.deepEqual(
      reading.gaps.map((gap) => gap.gate),
      [],
      "an external gate owes no in-repo proof",
    );
    // The ratchet tightens here too: the entry recorded while it was unproven is now stale.
    assert.deepEqual(codesFor(evaluateAgainst(invoked, ["check:knip"]).findings, "check:knip"), [
      "baseline_entry_stale",
    ]);
  } finally {
    rmSync(invoked, { recursive: true, force: true });
  }

  // The same label with a command no script and no workflow runs: a silencer, named as one.
  const uninvoked = makeTree(
    {},
    { scripts: { "check:knip": "pnpm knip" }, gateRedProofs: declared("pnpm knip:invented", "a typo exits 1") },
  );
  try {
    const reading = auditGateRedProofs({ root: uninvoked });
    assert.equal(statusOf(reading, "check:knip"), "external", "the label is read; the runner is what fails");
    assert.deepEqual(reading.externalWithoutRunner, [{ gate: "check:knip", command: "pnpm knip:invented" }]);
    assert.deepEqual(codesFor(evaluateAgainst(uninvoked, []).findings, "check:knip"), ["external_runner_not_invoked"]);
  } finally {
    rmSync(uninvoked, { recursive: true, force: true });
  }
});

test("an external label with no failure clause is unreadable, not a pass", () => {
  const root = makeTree(
    {},
    { scripts: { "check:knip": "pnpm knip" }, gateRedProofs: { "check:knip": "external pnpm knip --all" } },
  );
  try {
    const reading = auditGateRedProofs({ root });
    assert.equal(statusOf(reading, "check:knip"), "malformed");
    assert.deepEqual(codesFor(evaluateAgainst(root, []).findings, "check:knip"), ["red_proof_kind_unknown"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aggregate whose members are proven or external is external, and one with an unproven member is not", () => {
  const external = { "check:knip": "external pnpm knip — an unused export exits 1" };
  const root = makeTree(
    {
      "tools/check-a.mjs": gateSource(
        marker("inject", "a lane set that omits a required action", "tools/check-a.test.mjs"),
      ),
    },
    {
      scripts: {
        "check:a": "node tools/check-a.mjs",
        "check:aggregate": "pnpm check:a && pnpm check:knip",
        "check:knip": "pnpm knip",
      },
      gateRedProofs: external,
    },
  );
  try {
    const reading = auditGateRedProofs({ root });
    assert.equal(statusOf(reading, "check:a"), "proven");
    assert.equal(statusOf(reading, "check:knip"), "external");
    assert.equal(statusOf(reading, "check:aggregate"), "external");
    // The arithmetic the census prints: every gate is proven, external, or still owes a proof.
    assert.equal(
      reading.proven.length + reading.external.length + reading.gaps.length,
      reading.population.total,
      "proven + external + owing must be the population",
    );

    // An unproven member takes the aggregate back out of the external set.
    writeFileSync(join(root, "tools/check-a.mjs"), gateSource("// no proof here"), "utf8");
    assert.equal(statusOf(auditGateRedProofs({ root }), "check:aggregate"), "unproven_via_members");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree: every gate file reaches a record or the published complement, and this audit shows its own red proof", () => {
  const reading = auditGateRedProofs({ root: REPOSITORY_ROOT });
  const claimed = new Set(reading.records.flatMap((record) => record.entryFiles));
  // The rule for "this file is a gate" is the one `tools/lib/gate-population.mjs` owns, asked rather than re-spelled:
  // this filter used to carry its own copy, `check-*`-only, and in a tree whose population is widened to `audit-*` as
  // well it read 121 of 139 gate files and said nothing about the other 18.
  const onDisk = readdirSync(join(REPOSITORY_ROOT, "tools"))
    .filter(isGateFile)
    .map((name) => `tools/${name}`);
  // A gate file is either judged or published as one the index does not carry - never silently absent from both.
  const untrackedNotCounted = new Set(reading.population.untrackedNotCounted);
  assert.deepEqual(
    onDisk.filter(
      (file) => !claimed.has(file) && statusOf(reading, file) === undefined && !untrackedNotCounted.has(file),
    ),
    [],
  );
  const self = reading.records.find((record) => record.id === "audit:gate-red-proofs");
  assert.ok(self !== undefined, "the audit must derive itself from package.json like any other gate");
  assert.equal(self.status, "proven", "the audit's own red proof must be declared, not assumed");
  assert.ok(
    JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")).scripts["audit:gate-red-proofs"],
    "audit:gate-red-proofs must be a declared script",
  );
  // The census the summary line prints, read from the same run: a population of zero would agree with itself, so the
  // real tree must produce a non-empty reporting set and a count that is a subset of it.
  assert.ok(
    reading.zeroPopulationPass.reporting.length > 0,
    "no gate file prints a report, so the census measured nothing",
  );
  assert.deepEqual(
    reading.zeroPopulationPass.invisible.filter((file) => !reading.zeroPopulationPass.reporting.includes(file)),
    [],
  );
});

// Two lines print a population and both must say what the index removed from it. The first is the one an operator quotes,
// so its complement is a field printed at zero rather than a suffix that disappears; the census line's partition stays a
// partition, and the untracked term names gates that were removed from `examined` before it was computed, so it can never
// be one of its buckets.
test("both population lines name the complement the index removed, and it never enters the census partition", () => {
  const population = {
    total: 4,
    scripts: 3,
    gateFiles: 2,
    unclaimedByScript: 1,
    untrackedNotCounted: ["tools/check-planted.mjs", "tools/check-other.mjs"],
  };
  const fields = { proven: 1, held: 1, unproven: 1, unassessed: 1, unreadable: 0 };
  const first = describePopulationLine({ population, ...fields });
  assert.match(first, /population=4 /u);
  assert.match(
    first,
    / untracked_not_counted 2: tools\/check-other\.mjs, tools\/check-planted\.mjs$/u,
    "the summary line must name the files it is not counting",
  );
  assert.match(
    describePopulationLine({ population: { ...population, untrackedNotCounted: [] }, ...fields }),
    / untracked_not_counted 0$/u,
    "a zero complement is a reading that has to be printed, not an absence a reader fills in",
  );

  const census = describeGateCensus({
    examined: 4,
    withRedProof: 1,
    external: 1,
    recorded: 1,
    unreadable: 0,
    undeclared: 1,
    zeroPopulationPass: 0,
    untrackedNotCounted: population.untrackedNotCounted,
  });
  const partitionSum = ["with a red proof", "external", "declared without", "unreadable", "undeclared"]
    .map((label) => Number(new RegExp(`(?:^|· )${label} (\\d+)(?: ·|$)`, "u").exec(census)[1]))
    .reduce((total, count) => total + count, 0);
  assert.equal(partitionSum, 4, "the five buckets partition `examined`, complement and all");
  assert.match(
    census,
    / · untracked_not_counted 2: tools\/check-other\.mjs, tools\/check-planted\.mjs$/u,
    "the census line names the complement too",
  );
  // The sum is the assertion: a line whose five buckets do not add up is a throw, never a reading.
  assert.throws(
    () =>
      describeGateCensus({
        examined: 5,
        withRedProof: 1,
        external: 1,
        recorded: 1,
        unreadable: 0,
        undeclared: 1,
        zeroPopulationPass: 0,
      }),
    /census_does_not_reconcile:4:5/u,
  );
});

// The defect this test exists for: a derivation that reads a member and then leaves it out without a word. Measured
// 2026-11-13: `tools/run-tool-test-corpus.mjs` dropped 42 `test:`/`suite:` scripts while printing `notTaken 0`, and the
// red-proof census dropped five `suite:` scripts and three gate-shaped files under `tools/` subdirectories while printing
// a population that did not mention them. A filter may exclude a member; it may not exclude silently. So the census prints
// every member it left out, by name and with the rule that left it out, and a run with nothing dropped prints that zero
// beside the size of what it read.
test("every member the derivation leaves out is named with its reason, and a zero is counted beside the population", () => {
  const proof = marker("inject", "an omission -> the finding", "tools/check-a.test.mjs");
  const scripts = { "check:a": "node tools/check-a.mjs", "suite:library": "node --test tools/check-a.test.mjs" };
  const root = makeTree(
    { "tools/check-a.mjs": gateSource(proof), "tools/nested/check-sub.mjs": gateSource("// no proof here") },
    { scripts },
  );
  const clean = makeTree({ "tools/check-a.mjs": gateSource(proof) });
  try {
    const reading = auditGateRedProofs({ root });
    assert.deepEqual(
      reading.population.dropped.map((entry) => entry.member),
      ["suite:library", "tools/nested/check-sub.mjs"],
      "both excluded members must be named, not counted out of the population in silence",
    );
    assert.equal(reading.population.examined, 3, "two scripts and the one gate-shaped file no script claims");
    assert.equal(reading.population.total, 1);
    const [summary, ...members] = describeDropped(reading.population);
    assert.equal(summary, "gate_red_proofs dropped 2 of 3");
    assert.match(members[0], /^dropped:suite:library - .*`suite:` script/u);
    assert.match(members[1], /^dropped:tools\/nested\/check-sub\.mjs - .*outside the gate directory/u);

    // A tree that drops nothing still prints the zero, beside the number of members it read (`check:a` and the
    // aggregate `check:aggregate`, which names no file of its own).
    assert.deepEqual(describeDropped(auditGateRedProofs({ root: clean }).population), [
      "gate_red_proofs dropped 0 of 2",
    ]);

    // A member that left the population and is named by neither list is a reading that does not reconcile, not a line.
    assert.throws(
      () => describeDropped({ ...reading.population, examined: 4 }),
      /population_does_not_reconcile:1\+2\+0:4/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});
