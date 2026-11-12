// One falsifier per check: each check must be able to report its own finding when the wiring it guards is
// broken, and must stay silent on the real checkout's good wiring.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditGateRedProofs, describeGateCensus } from "../audit-gate-red-proofs.mjs";
import { indexedGatePopulation } from "./indexed-sources.mjs";
import {
  checkExperimentalRunners,
  checkGateFalsifiers,
  checkGateRegistry,
  checkLiveRunPreflight,
  checkRunnerResolution,
  checkScenarioAcceptance,
  describeGateFalsifierCensus,
  gateFalsifierCensus,
  gateRedProofLedger,
  harnessGateNames,
  readModFixtureSources,
} from "./harness-conformance.mjs";
import { preflightLiveRun } from "./live-run-preflight.mjs";

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(toolsDir, "..");

test("preflight check reports a preflight that misses a bad tree", () => {
  const blindPreflight = () => ({ ok: true, checks: [], firstFailure: null });
  const findings = checkLiveRunPreflight({ preflight: blindPreflight });
  assert.ok(
    findings.some((entry) => entry.code === "preflight_missed_a_bad_tree"),
    `expected a missed-tree finding, got ${JSON.stringify(findings)}`,
  );

  assert.deepEqual(checkLiveRunPreflight({ preflight: preflightLiveRun }), []);
});

test("scenario check reports a fixture-library mapping the Mod never learned, and no run plan can rescue it", () => {
  const modSources = [
    { file: "ModEntry.Fixtures.cs", source: 'FixtureScenario is not ("native_till_soil_v1")' },
    {
      file: "ModEntry.Fixtures.MultiDay.cs",
      source: 'fixture.FixtureScenario == "native_multi_day_play_session_v1"',
    },
  ];

  // The fixture library's own mapping is the authority: a name the Mod's switch does not name is the
  // finding on its own, with no run-plan record in sight.
  const noPlan = checkScenarioAcceptance({
    modSources,
    fixture: { actions: () => ["till_soil"], scenario: () => "native_absent_v1" },
    publishedScenarios: new Map(),
    actionIds: ["till_soil"],
  });
  assert.deepEqual(
    noPlan.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );

  // The exact defect the old fallback masked: the fixture library named `native_respond_level_up_v1` (a
  // world the Mod's switch has never had) while the run plan recorded `native_multi_day_play_session_v1`
  // (accepted). The plan is a second authority for the same fact, and its disagreement is a finding, not
  // a rescue - the fixture library's own mapping must itself be accepted.
  const maskedByPlan = checkScenarioAcceptance({
    modSources,
    fixture: { actions: () => ["respond_level_up"], scenario: () => "native_respond_level_up_v1" },
    publishedScenarios: new Map([["respond_level_up", "native_multi_day_play_session_v1"]]),
    actionIds: ["respond_level_up"],
  });
  assert.deepEqual(
    maskedByPlan.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );
  assert.match(maskedByPlan[0].detail, /second authority for the same fact that disagrees/u);

  // A run plan that records an unknown world too is still the same finding.
  const planAlsoUnknown = checkScenarioAcceptance({
    modSources,
    fixture: { actions: () => ["till_soil"], scenario: () => "native_absent_v1" },
    publishedScenarios: new Map([["till_soil", "native_absent_plan_v1"]]),
    actionIds: ["till_soil"],
  });
  assert.deepEqual(
    planAlsoUnknown.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );

  // The real checkout's own wiring is conformant.
  assert.deepEqual(checkScenarioAcceptance({ modSources: readModFixtureSources(repoRoot) }), []);
});

test("runner check reports a runner that is not on disk", () => {
  const findings = checkRunnerResolution({
    actionIds: ["till_soil"],
    resolve: () => "run-stardew-native-local-player-does-not-exist.mjs",
    toolsDir,
  });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["runner_not_found"],
  );

  assert.deepEqual(checkRunnerResolution({ toolsDir }), []);
});

// The property is "importing it starts nothing", so the falsifier is a runner that starts something on import - with
// `import.meta.main` written in it, which is all the source-text form this check replaced ever looked for.
test("runner check imports the runner and reports one that starts on import", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-runner-"));
  try {
    const stubTools = join(root, "tools");
    mkdirSync(stubTools, { recursive: true });
    const stub = "run-stub-smoke.mjs";
    writeFileSync(
      join(stubTools, stub),
      '// import.meta.main is named in this comment and nowhere else\nprocess.stdout.write("session started\\n");\n',
    );
    const findings = checkRunnerResolution({ actionIds: ["till_soil"], resolve: () => stub, toolsDir: stubTools });
    assert.deepEqual(
      findings.map((entry) => entry.code),
      ["runner_import_failed"],
    );
    assert.match(findings[0].detail, /import printed: session started/u);

    // The three failures the probe can see are told apart, because each sends the reader somewhere else: a
    // missing test artifact is a build step, a missing package is an install step, and a runner that starts
    // a session on import is a defect in the runner. Reporting all three as "missing cli" is what sent a
    // CI reader to the wrong file on 2026-10-25.
    const stubs = {
      artifact:
        "throw new Error('live_run_artifact_stale:artifact_missing - rebuild with: cd host && pnpm build:test');\n",
      package: "await import('no-such-package-anywhere');\n",
    };
    for (const [expected, source] of [
      ["runner_artifact_not_built", stubs.artifact],
      ["runner_missing_cli", stubs.package],
    ]) {
      writeFileSync(join(stubTools, stub), source);
      const codes = checkRunnerResolution({ actionIds: ["till_soil"], resolve: () => stub, toolsDir: stubTools }).map(
        (entry) => entry.code,
      );
      assert.deepEqual(codes, [expected]);
    }

    // The control: a runner whose CLI really is gated imports silently and passes.
    writeFileSync(join(stubTools, stub), 'if (import.meta.main) process.stdout.write("session started\\n");\n');
    assert.deepEqual(checkRunnerResolution({ actionIds: ["till_soil"], resolve: () => stub, toolsDir: stubTools }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(checkRunnerResolution({ toolsDir }), []);
});

test("experimental runner check reports a descriptor runner that is not on disk", () => {
  const findings = checkExperimentalRunners({
    runners: { absent_action: "run-stardew-native-local-player-absent.mjs" },
    toolsDir,
  });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["experimental_runner_missing"],
  );

  assert.deepEqual(checkExperimentalRunners({ toolsDir }), []);
});

test("gate check reports a gate that neither self-reports nor is declared", () => {
  const findings = checkGateFalsifiers({ gateNames: ["check-a-gate-nobody-classified.mjs"], toolsDir });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["gate_without_falsifier"],
  );

  assert.deepEqual(checkGateFalsifiers({ gateNames: harnessGateNames(toolsDir), toolsDir }), []);
});

// Three findings are about the population rather than one gate's own run, and each NAMES its member: a gate no ledger
// covers, a report that cannot show whether it measured anything, and a recorded debt that is already paid.
test("gates no ledger covers, and reports that cannot show what they measured, are named one by one", () => {
  const declared = {
    gateNames: ["check-declared.mjs"],
    withoutFalsifier: [{ gate: "check-declared.mjs", reason: "its falsifier is its own test" }],
    toolsDir,
  };
  assert.deepEqual(
    checkGateFalsifiers(declared),
    [],
    "the control: a declared gate with nothing else reported is clean",
  );
  assert.deepEqual(
    checkGateFalsifiers({
      ...declared,
      undeclared: [{ gate: "test:nobody", detail: "no `red-proof:` marker in tools/x.test.mjs" }],
    }).map((entry) => [entry.code, entry.detail]),
    [["gate_undeclared", "test:nobody: no `red-proof:` marker in tools/x.test.mjs"]],
  );
  const invisible = checkGateFalsifiers({ ...declared, zeroPopulation: ["check-silent.mjs"] });
  assert.deepEqual(
    invisible.map((entry) => entry.code),
    ["gate_report_without_population"],
  );
  assert.match(
    invisible[0].detail,
    /check-silent\.mjs: prints a self-verification report and names no population\/fields\/cases\/examined field/u,
  );
  assert.deepEqual(
    checkGateFalsifiers({
      ...declared,
      staleDeclarations: [{ gate: "test:paid", detail: "this gate is proven now" }],
    }).map((entry) => entry.code),
    ["gate_declaration_stale"],
  );
  // An `external` label is only as good as the runner behind it. A command no script and no workflow invokes names a
  // rule nothing in this repository checks, so the label fails here instead of counting as a gate that owes nothing.
  const uninvoked = checkGateFalsifiers({
    ...declared,
    externalWithoutRunner: [{ gate: "check:knip", command: "pnpm knip:invented" }],
  });
  assert.deepEqual(
    uninvoked.map((entry) => entry.code),
    ["external_runner_not_invoked"],
  );
  assert.match(uninvoked[0].detail, /check:knip: claims `external pnpm knip:invented`, which no package\.json/u);
});

// A check whose population is empty agrees with itself: no gate enumerated must be a finding, not a silent pass.
test("gate check blocks on an empty population instead of agreeing with itself", () => {
  const findings = checkGateFalsifiers({ gateNames: [], toolsDir });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["gate_population_empty"],
  );
  assert.match(findings[0].detail, /no tools\/check-\*\.mjs gate was enumerated/u);
});

// The population is ONE derivation (`tools/lib/gate-population.mjs`), read by this suite and by the red-proof audit. The
// numbers that used to disagree by 3x - 106 gate files here, 330 gates there - are asserted equal, so a second scan
// cannot reappear without this failing.
test("the census counts each gate in exactly one bucket and names the ones nobody declared", () => {
  const population = [
    { id: "check:a", entryFiles: ["tools/check-a.mjs"] },
    { id: "check:b", entryFiles: ["tools/check-b.mjs"] },
    { id: "tools/check-c.mjs", entryFiles: ["tools/check-c.mjs"] },
    { id: "check:d", entryFiles: ["tools/check-d.mjs"] },
    // A script gate whose entry is the gate's own falsifier suite: this suite has no default run to read.
    { id: "test:a", entryFiles: ["tools/check-a.test.mjs"] },
    { id: "test:host", entryFiles: ["host/src/x.test.ts"] },
  ];
  const ledger = {
    withRedProof: 2,
    recorded: 1,
    undeclared: [{ gate: "test:host", detail: "no marker" }],
    // The sixth member: `check:d` is judged, unlisted, and carries a claim nobody can read - which is a bucket of its
    // own, not a subset of the debt. Without it the line's four buckets would add up to five of six.
    unreadable: ["check:d"],
    stale: [],
    external: [
      {
        gate: "test:a",
        commands: [{ command: "pnpm --dir pkg run test", howItFails: "a failing case exits 1" }],
        inheritedFrom: [],
      },
    ],
    externalWithoutRunner: [],
    zeroPopulationPass: ["check-c.mjs"],
  };
  const census = gateFalsifierCensus({
    population,
    withFalsifier: ["check-a.mjs"],
    withoutFalsifier: [{ gate: "check-b.mjs", reason: "its falsifier is its own test" }],
    ledger,
  });
  assert.deepEqual(census, {
    examined: 6,
    judged: 4,
    withReport: 1,
    without: 1,
    unlisted: ["tools/check-c.mjs", "check:d"],
    excluded: ["test:a", "test:host"],
    excludedUndeclared: ["test:host"],
    withRedProof: 2,
    recorded: 1,
    undeclared: ["test:host"],
    unreadable: ["check:d"],
    external: [
      {
        gate: "test:a",
        commands: [{ command: "pnpm --dir pkg run test", howItFails: "a failing case exits 1" }],
        inheritedFrom: [],
      },
    ],
    zeroPopulationPass: ["check-c.mjs"],
    untrackedNotCounted: [],
  });
  assert.deepEqual(describeGateFalsifierCensus(census), [
    "gates examined 6 · with a red proof 2 · external 1 · declared without 1 · unreadable 1 · undeclared 1 · " +
      "zero-population-pass 1 · unlisted 2 (tools/check-c.mjs, check:d)",
    "judged here 4 (with a self-report 1 · declared without a report 1) · excluded 2 (a package.json gate script " +
      "whose entry is not a tools/check-*.mjs gate file, so this suite has no default run to read): 1 proven, external " +
      "or recorded in the red-proof ledger, 1 undeclared and named below",
    "external 1 (rule lives in another program; run the command to watch it fail): test:a = `pnpm --dir pkg run test`",
  ]);
});

// The line is a partition or it is not printed at all. Measured 2026-11-13: the real line read `341 + 7 + 7 = 355` of
// 357 while the sentence under it said "357 of 357 are accounted for", because the two gates whose claim cannot be read
// were in no bucket the line printed. Printing that bucket fixes one instance; the sum read back OFF the line is what
// makes the next forgotten bucket impossible, so both failures are asserted here rather than the one count.
test("a census line whose buckets do not add up to its population is never printed", () => {
  const reading = { examined: 357, withRedProof: 341, external: 7, recorded: 7, undeclared: 0, zeroPopulationPass: 0 };
  assert.match(describeGateCensus({ ...reading, unreadable: 2 }), / · unreadable 2 · /u);
  // The pre-fix line: the same reading with the bucket missing from it.
  assert.throws(
    () => describeGateCensus({ ...reading, unreadable: undefined }),
    /census_does_not_reconcile:unreadable_not_printed:357/u,
  );
  // A bucket that is printed but leaves gates in none of them: the sum is not the population, so the line is not a
  // partition and a reader adding it up would be told something the tool never measured.
  assert.throws(
    () => describeGateCensus({ ...reading, unreadable: 2, undeclared: 2 }),
    /census_does_not_reconcile:359:357/u,
  );
});

// The real tree, read the way both tools read it. What this pins is the SHAPE, not today's debt: every gate is in one
// bucket, the judged half is exactly the gate files, and the audit's own population is the same number - so the next
// scan added to either tool fails here instead of shipping a second answer.
test("the real tree is one population, and the gates no ledger covers are named one by one", () => {
  const population = indexedGatePopulation({ root: repoRoot });
  const ledger = gateRedProofLedger({ root: repoRoot });
  const census = gateFalsifierCensus({
    population: population.gates,
    ledger,
    untrackedNotCounted: population.untrackedNotCounted,
  });
  const audit = auditGateRedProofs({ root: repoRoot });
  assert.equal(census.examined, audit.population.total);
  assert.deepEqual(
    census.untrackedNotCounted,
    audit.population.untrackedNotCounted,
    "both tools publish the same complement from the same reading",
  );
  assert.equal(census.judged + census.excluded.length, census.examined);
  assert.equal(census.withReport + census.without + census.unlisted.length, census.judged);
  // Building the line is the partition assertion: the buckets the reading produces must add up to the population it
  // prints, or `describeGateCensus` throws instead of printing a line a reader cannot reconcile.
  assert.ok(
    describeGateFalsifierCensus(census)[0].startsWith(`gates examined ${census.examined} ·`),
    "the census line names the population it partitions",
  );
  // Both halves are populated on the real tree, so neither number can be a green zero.
  assert.ok(census.withReport > 0 && census.without > 0, "a registry half measured nothing");
  // The registry still classifies every gate file it enumerates; that is the invariant, not today's count.
  assert.deepEqual(census.unlisted, []);
  assert.deepEqual(
    census.undeclared,
    ledger.undeclared.map((entry) => entry.gate),
    "the census must name the same undeclared gates the findings name",
  );
});

// The population is the index (`tools/lib/indexed-sources.mjs`), so a lane's new gate file is nobody's yet: it must not
// fail the census, and it must not disappear either - the drop is published. Staging the same file is what makes it a
// gate, and an undeclared one then blocks exactly as it did before.
test("the census judges the index: an untracked gate is published, and the same gate staged is unlisted", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-index-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const declared = [{ gate: "check-declared.mjs", reason: "its falsifier is its own test" }];
  const read = () => {
    const population = indexedGatePopulation({ root });
    return {
      census: gateFalsifierCensus({
        population: population.gates,
        withFalsifier: [],
        withoutFalsifier: declared,
        ledger: {
          withRedProof: 0,
          recorded: 0,
          // The red-proof reading is not what this case is about, but the census line has to partition the population
          // it prints: the synthetic tree holds no marker at all, so every gate in it is one nobody declared.
          undeclared: population.gates.map((gate) => ({ gate: gate.id, detail: "no marker in the synthetic tree" })),
          unreadable: [],
          stale: [],
          external: [],
          externalWithoutRunner: [],
          zeroPopulationPass: [],
        },
        untrackedNotCounted: population.untrackedNotCounted,
      }),
      findings: checkGateFalsifiers({
        gateNames: harnessGateNames(join(root, "tools")),
        withFalsifier: [],
        withoutFalsifier: declared,
        toolsDir: join(root, "tools"),
      }),
    };
  };
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, "tools", "check-declared.mjs"), "// a gate its own registry names\n");
    git("init", "-q");
    git("add", "-A");
    writeFileSync(join(root, "tools", "check-planted.mjs"), "// a lane's new gate, in no commit\n");

    const untracked = read();
    assert.deepEqual(untracked.census.untrackedNotCounted, ["tools/check-planted.mjs"]);
    assert.deepEqual(untracked.census.unlisted, [], "an untracked gate is not declared debt");
    assert.deepEqual(untracked.findings, [], "an untracked gate must not fail the census");
    assert.match(
      describeGateFalsifierCensus(untracked.census)[0],
      / · untracked_not_counted 1: tools\/check-planted\.mjs$/u,
    );

    git("add", "tools/check-planted.mjs");
    const staged = read();
    assert.deepEqual(staged.census.untrackedNotCounted, []);
    assert.deepEqual(staged.census.unlisted, ["tools/check-planted.mjs"]);
    assert.deepEqual(
      staged.findings.map((entry) => entry.code),
      ["gate_without_falsifier"],
    );
    assert.match(describeGateFalsifierCensus(staged.census)[0], / · unlisted 1 \(tools\/check-planted\.mjs\)$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The registry itself drifts: an entry exempting a gate that is not there exempts nothing, and would otherwise keep
// claiming a reading it no longer makes.
test("a declaration naming a gate that is not in tools/ is stale", () => {
  const findings = checkGateRegistry({
    gateNames: ["reported.mjs"],
    withFalsifier: ["reported.mjs", "check-deleted.mjs"],
    withoutFalsifier: [{ gate: "check-moved.mjs", reason: "requires a live-run artifact" }],
  });
  assert.deepEqual(
    findings.map((entry) => entry.detail),
    [
      "check-deleted.mjs: declared to print a report, but no such gate is in tools/",
      "check-moved.mjs: declared without a report, but no such gate is in tools/",
    ],
  );
  assert.deepEqual(
    checkGateRegistry({ gateNames: harnessGateNames(toolsDir) }),
    [],
    "every entry in the real registry names a gate the harness enumerates",
  );
});

// The report is what the gate PRINTS, so the falsifier deletes the print while keeping the words the source-text form
// looked for: a comment naming `checks` and `mode:` satisfies a regex and proves nothing about the run. The stub lives
// in its own directory so it is never picked up as a real gate by `harnessGateNames`.
test("gate check reads the report a gate prints, not the words in its source", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-gates-"));
  try {
    const stubTools = join(root, "tools");
    mkdirSync(stubTools, { recursive: true });
    const stub = "check-stub-gate.mjs";
    writeFileSync(
      join(stubTools, stub),
      '// this gate prints checks and mode: in a comment, and a human line on stdout\nprocess.stdout.write("all good\\n");\n',
    );
    const findings = checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools });
    assert.deepEqual(
      findings.map((entry) => entry.code),
      ["falsifier_signature_missing"],
    );
    assert.match(findings[0].detail, /the default run printed no self-verification report \(exit 0\)/u);

    // The control: the same file, printing a report, passes - so the finding above is about the artifact.
    writeFileSync(
      join(stubTools, stub),
      'const checks = [{ id: "one_rule", status: "passed" }];\nprocess.stdout.write(`${JSON.stringify({ gate: "stub/v1", status: "passed", checks })}\\n`);\n',
    );
    assert.deepEqual(checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `0 findings` means nothing without `examined N`, and this suite used to accept any non-empty `checks` list: a gate
// that printed `{"status":"passed","population":0}` beside its rules was read as a gate that passed. The rule is the
// one `tools/lib/assert-non-vacuous.mjs` owns, so the three answers it can give are the three asserted here.
//
// red-proof: inject  a stub gate printing `population: 0` beside a passing `checks` list -> `gate_measured_nothing`
//                    names the stub; the same stub with `population: 3`, and with a stated `allowEmpty` reason, pass
test("a gate's report that examined nothing is blocked, and one that says why is not", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-vacuous-"));
  try {
    const stubTools = join(root, "tools");
    mkdirSync(stubTools, { recursive: true });
    const stub = "check-stub-vacuous.mjs";
    const printing = (fields) =>
      `const checks = [{ id: "one_rule", status: "passed" }];\n` +
      `process.stdout.write(\`\${JSON.stringify({ gate: "stub/vacuous", status: "passed", checks, ${fields} })}\\n\`);\n`;

    writeFileSync(join(stubTools, stub), printing("population: 0"));
    const findings = checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools });
    assert.deepEqual(
      findings.map((entry) => entry.code),
      ["gate_measured_nothing"],
    );
    assert.match(findings[0].detail, /^check-stub-vacuous\.mjs: gate_measured_nothing:stub\/vacuous:population/u);

    // The control: the same report with objects in it is a measurement, so the finding above is about the population.
    writeFileSync(join(stubTools, stub), printing("population: 3"));
    assert.deepEqual(checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools }), []);

    // A zero whose reason the gate states is `not_measured`, never `passed` and never a finding of this kind: the gate
    // already handles its own empty population, and the suite does not overrule the reason.
    writeFileSync(
      join(stubTools, stub),
      printing('population: 0, allowEmpty: "this gate judges a diff, and the diff is empty"'),
    );
    assert.deepEqual(checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
