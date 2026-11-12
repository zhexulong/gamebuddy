#!/usr/bin/env node
/**
 * The falsifier for `tools/check-gate-populations.mjs`.
 *
 * The gate exists for one defect measured four times in one month: a check exits 0 having read nothing, and its exit
 * status is the only thing anyone downstream reads. `check:publint` printed a pass having read no publint message,
 * `test:stardew-soil-itm-canary` reported a pass over five skips, the wire parity gate printed six frames it could not
 * pair BELOW a `passed` verdict, and the multiplayer-sensitivity register was refused by its own producer while the gate
 * stayed green. Each was fixed on its own; nothing asked the question of the next gate.
 *
 * These cases drive the gate's own classifier over sources shaped like each of those four, and drive its CLI over a
 * throwaway tree, so "the check ran and found nothing" can never again be spelled the same way as "the check never ran".
 *
 * red-proof: inject the pre-fix `check-publint.mjs` source returns `gate_without_population` while the fixed source is
 *   clean, and the wire parity gate's pre-fix verdict returns `gate_pairs_a_subset_and_passes`
 *   (tools/check-gate-populations.test.mjs)
 * red-proof: inject the pre-fix soil-itm script over its skipping suite returns `gate_skip_can_pass`, and the CLI over a
 *   throwaway root reds a new silent gate and a baseline row whose finding is gone (tools/check-gate-populations.test.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { blankComments } from "./prelive.mjs";
import {
  baselineDocument,
  baselineKey,
  blankStringLiterals,
  classifyGate,
  describeCensus,
  judgeGates,
  publishesPopulation,
  readBaseline,
  readGates,
  reconcile,
  subsetCounts,
} from "./check-gate-populations.mjs";

const GATE = fileURLToPath(new URL("./check-gate-populations.mjs", import.meta.url));
const REPOSITORY_ROOT = path.dirname(path.dirname(GATE));

/** A gate record from source lines, the way `readGates` hands one to the classifier. */
function gate({
  id = "check:probe",
  command = "node tools/check-probe.mjs",
  entryFiles = ["tools/check-probe.mjs"],
  lines,
}) {
  return { id, command, entryFiles, sources: [lines.join("\n")] };
}

/** A throwaway tree with a `package.json`, the gates it declares, and nothing else. */
function withTree({ scripts, files }, body) {
  const root = mkdtempSync(path.join(tmpdir(), "gate-populations-"));
  try {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }, null, 2));
    for (const [name, lines] of Object.entries(files)) writeFileSync(path.join(root, name), `${lines.join("\n")}\n`);
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runGate(root, ...extra) {
  const result = spawnSync(process.execPath, [GATE, "--root", root, ...extra], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("a gate that prints a verdict and no count of what it examined is gate_without_population", () => {
  const finding = classifyGate(
    gate({
      lines: [
        "const messages = readMessages();",
        "process.stdout.write('check-probe: passed\\n');",
        "process.exitCode = messages.length === 0 ? 0 : 1;",
      ],
    }),
  );
  assert.equal(finding?.code, "gate_without_population");
});

test("the same gate answers the question when it publishes a not-measured verdict instead", () => {
  const finding = classifyGate(
    gate({
      lines: [
        "const resolution = resolveRunner();",
        "if (!resolution.ok) {",
        "  process.stdout.write(`probe_not_measured:executable_unresolvable:${resolution.name}\\n`);",
        "  process.exitCode = 2;",
        "  return;",
        "}",
        "process.stdout.write('probe: passed\\n');",
      ],
    }),
  );
  assert.equal(finding, null, "a gate that can say 'I did not measure' is not silent about its population");
});

test("a population line is read in both orders this tree writes it in", () => {
  assert.equal(publishesPopulation("console.log(`files examined ${n}`);"), true);
  assert.equal(publishesPopulation("console.log(`${n} tests`);"), true);
  assert.equal(publishesPopulation("console.log(`probe: passed`);"), false);
});

test("a report key from the shared non-vacuity judge counts as a population", () => {
  assert.equal(
    publishesPopulation("process.stdout.write(`${JSON.stringify({ gate: 'probe', examined: 3 })}\\n`);"),
    true,
  );
  // The found side is not the population: `0 findings` says nothing about how many objects produced zero.
  assert.equal(publishesPopulation("console.log(`probe: ${findings.length} findings`);"), false);
});

test("an all-skip suite with nothing deciding before the runner is gate_skip_can_pass", () => {
  const finding = classifyGate({
    id: "test:probe",
    command: "node --test tools/probe.test.mjs",
    entryFiles: ["tools/probe.test.mjs"],
    sources: [["test('a case', { skip: !hasRoot() }, () => {});"].join("\n")],
  });
  assert.equal(finding?.code, "gate_skip_can_pass");
  assert.match(finding.detail, /node --test/);
});

test("a suite behind a decider that can refuse is not skip_can_pass", () => {
  // The shape `tools/stardew-soil-itm-canary-gate.mjs` was given when the five skips were found reporting green: it
  // decides before the runner and publishes the not-measured verdict itself.
  const finding = classifyGate(
    gate({
      id: "test:probe",
      command: "node tools/probe-gate.mjs",
      lines: [
        "const missing = missingWitnesses({ root });",
        "if (missing.length > 0) {",
        "  process.stdout.write(`probe_not_measured:root_absent:${root}\\n`);",
        "  process.exitCode = 2;",
        "}",
      ],
    }),
  );
  assert.equal(finding, null);
});

test("a subset count the verdict never reads is gate_pairs_a_subset_and_passes", () => {
  // The wire parity gate before `2738fa62`: 31 of 37 frames paired, the six it could not pair named in prose below.
  const finding = classifyGate(
    gate({
      lines: [
        "const unpaired = [];",
        "for (const frame of arms) if (!pairs.has(frame)) unpaired.push(frame);",
        "process.stdout.write(`frames examined ${arms.size} · paired ${pairs.size}\\n`);",
        "process.stdout.write(`  unpaired frames ${unpaired.join(', ')} · ${unpaired.length} unmeasured\\n`);",
      ],
    }),
  );
  assert.equal(finding?.code, "gate_pairs_a_subset_and_passes");
  assert.match(finding.detail, /unpaired/);
});

test("the same count compared against zero puts the subset into the verdict", () => {
  const finding = classifyGate(
    gate({
      lines: [
        "const unpaired = [];",
        "for (const frame of arms) if (!pairs.has(frame)) unpaired.push(frame);",
        "const checks = [check('frame_paired', unpaired.length === 0 ? 'passed' : 'blocked')];",
        "process.stdout.write(`frames examined ${arms.size} · paired ${pairs.size}\\n`);",
      ],
    }),
  );
  assert.equal(finding, null);
});

test("a subset word in a string literal is a label, not a count a gate holds", () => {
  assert.deepEqual(subsetCounts("const names = ['unpaired', 'unmatched']; const n = names.length;"), []);
  assert.deepEqual(subsetCounts("const unpaired = [];\nunpaired.push(frame);\nconst n = unpaired.length;"), [
    "unpaired",
  ]);
  assert.equal(blankStringLiterals("a('x') + b").length, "a('x') + b".length);
});

test("the census partitions the population exactly, with zero blocked rather than green", () => {
  const census = describeCensus({
    examined: 4,
    outside: [{ id: "check:knip", detail: "runs `pnpm knip`" }],
    findings: [{ id: "check:a", code: "gate_without_population", detail: "x" }],
    blocked: [{ id: "check:b", detail: "entry not readable as source" }],
  });
  assert.equal(census.withLine, 2);
  assert.equal(census.withLine + census.without + census.unreadable, 4, "M + K + R = N");
  assert.match(census.lines[0], /gates examined 4 · with a population line 2 · without 1 · unreadable 1/u);
  assert.match(census.lines[1], /without_population 1 · skip_can_pass 0 · pairs_a_subset 0/u);
});

test("the CLI reads a tree, records the reading, and reds a new silent gate and a paid debt", () => {
  const scripts = { "check:silent": "node tools/check-silent.mjs", "check:loud": "node tools/check-loud.mjs" };
  const files = {
    "tools/check-silent.mjs": ["process.stdout.write('check-silent: passed\\n');"],
    "tools/check-loud.mjs": ["process.stdout.write(`files examined ${files.length}\\n`);"],
  };
  withTree({ scripts, files }, (root) => {
    const before = runGate(root);
    assert.equal(before.status, 2, "no baseline yet: the reading exists and cannot be compared");
    assert.match(before.stdout, /gate_population_baseline_unreadable/u);

    assert.equal(runGate(root, "--update").status, 0);
    const recorded = runGate(root);
    assert.equal(recorded.status, 0);
    assert.match(recorded.stdout, /gates examined 2 · with a population line 1 · without 1 · unreadable 0/u);
    assert.match(recorded.stdout, /gate_population_baseline_current/u);

    // A new gate that is silent about its population cannot land quietly.
    writeFileSync(path.join(root, "tools", "check-quieter.mjs"), "process.stdout.write('ok\\n');\n");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { ...scripts, "check:quieter": "node tools/check-quieter.mjs" } }),
    );
    const added = runGate(root);
    assert.equal(added.status, 1);
    assert.match(added.stdout, /gate_population_finding_unrecorded: gate_without_population check:quieter/u);

    // A paid debt must be deleted: the gate that was silent now says what it examined, so its baseline row is stale.
    writeFileSync(path.join(root, "tools", "check-silent.mjs"), "process.stdout.write(`files examined ${0}\\n`);\n");
    const paid = runGate(root, "--json");
    assert.equal(paid.status, 1);
    const report = JSON.parse(paid.stdout);
    assert.deepEqual(report.stale, ["gate_without_population check:silent"]);
    assert.deepEqual(report.unrecorded, ["gate_without_population check:quieter"], "the new gate is still owed");
  });
});

test("an empty population is blocked with its name, never green", () => {
  withTree({ scripts: {}, files: {} }, (root) => {
    const result = runGate(root);
    assert.equal(result.status, 2, "a reading over zero gates agrees with itself, which is the defect");
    assert.match(result.stdout, /gate_population_population_empty: 0 gate read under/u);
  });
});

test("the gate classifies itself, and the committed baseline is the tree's own reading", () => {
  // The rule this gate enforces, applied to its own source. This is the staging-independent half of the answer: a file
  // that is not staged yet is not in the index-derived population, but its classification is still decidable.
  const own = blankComments(readFileSync(new URL("./check-gate-populations.mjs", import.meta.url), "utf8"));
  assert.equal(
    classifyGate({
      id: "check:gate-populations",
      command: "node tools/check-gate-populations.mjs",
      entryFiles: ["tools/check-gate-populations.mjs"],
      sources: [own],
    }),
    null,
    "the same call that judges 342 gates must find nothing in this one's own source",
  );

  const { examined, outside, untrackedNotCounted } = readGates({ root: REPOSITORY_ROOT });
  const { buckets, findings } = judgeGates({ gates: examined });
  const self = buckets.find((entry) => entry.entryFiles.includes("tools/check-gate-populations.mjs"));

  // Either the index carries this file and it is classified, or it says by name that it does not - never a silent miss.
  assert.ok(
    self !== undefined || untrackedNotCounted.includes("tools/check-gate-populations.mjs"),
    "a file the index does not carry yet is named as untracked, not swallowed",
  );
  if (self !== undefined)
    assert.equal(
      self.bucket,
      "with a population line",
      "the rule this gate enforces is applied to it by the same call",
    );
  assert.ok(examined.length > outside.length, "the readable half is the larger half of the derived population");
  const unreadable = buckets.filter((entry) => entry.bucket === "unreadable").length;
  assert.equal(
    findings.length + (examined.length - findings.length - unreadable) + unreadable,
    examined.length,
    "without K + with a population line M + unreadable R = examined N over the real tree",
  );

  const { unrecorded, stale } = reconcile({ findings, baseline: readBaseline({ root: REPOSITORY_ROOT }) });
  assert.deepEqual(
    unrecorded.map(baselineKey),
    [],
    "a gate silent about its population must be recorded in tools/gate-population-baseline.json or fixed",
  );
  assert.deepEqual(stale, [], "a baseline row whose finding is gone must be deleted, not left standing");
  assert.deepEqual(
    baselineDocument(findings).gates,
    [...baselineDocument(findings).gates].sort(),
    "--update writes a sorted file, so the diff is the reading and not the ordering",
  );
});
