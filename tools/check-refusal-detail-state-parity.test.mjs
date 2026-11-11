// red-proof: history  the shipped tree of `15a3c57c`, whose Mod `MayCarryRefusalDetail` permits `PartiallySucceeded`
//   while the Host's `BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES` does not -> `refusal_detail_state_set_drift:partially_succeeded:host`,
//   exit 1 (tools/check-refusal-detail-state-parity.test.mjs)
// Tests for the refusal-detail state parity gate.
//
// Every case mutates the REAL sources in memory (or in a throwaway root), so a passing suite proves the gate is
// decisive: the first case replays the shipped tree of `15a3c57c`, whose Mod method permits `PartiallySucceeded` while
// the Host set does not, and requires the gate to name exactly `refusal_detail_state_set_drift:partially_succeeded:host`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkRefusalDetailStateParity,
  EXIT,
  extractHostStates,
  extractHostVocabulary,
  extractModStates,
  formatRefusalDetailStates,
  HOST_PATH,
  MOD_PATH,
  wireTokenOf,
} from "./check-refusal-detail-state-parity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const MOD_SOURCE = sourceOf(MOD_PATH);
const HOST_SOURCE = sourceOf(HOST_PATH);

/**
 * A copy of the Host source with the refusal-detail declaration's own text mutated, so a case cannot accidentally edit
 * an earlier list that happens to name the same tokens.
 */
const hostWithDeclaration = (mutate) => {
  const at = HOST_SOURCE.indexOf("BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES:");
  return HOST_SOURCE.slice(0, at) + mutate(HOST_SOURCE.slice(at));
};

/** The Host set as the commit before the fix spelled it: the state the Mod permits, deleted from the array. */
const hostWithoutPartiallySucceeded = () =>
  hostWithDeclaration((region) => region.replace('  "partially_succeeded",\n', ""));
/** The Host set widened by a state the Mod's method does not permit. */
const hostWithSucceeded = () =>
  hostWithDeclaration((region) => region.replace("new Set([\n", 'new Set([\n  "succeeded",\n'));
/** The Mod's method with one permitted state removed - the other direction of the same drift. */
const modWithoutPartiallySucceeded = () => MOD_SOURCE.replace(" or BodyProgramNodeState.PartiallySucceeded;", ";");
/** The Mod's method naming a state the Host's vocabulary has no token for. */
const modWithUnwireableState = () =>
  MOD_SOURCE.replace("or BodyProgramNodeState.PartiallySucceeded;", "or BodyProgramNodeState.PartlySucceeded;");

const violationsOf = (report) => report.violations.map((violation) => violation.code);

test("the shipped tree agrees, and says what it examined", () => {
  const report = checkRefusalDetailStateParity({ root });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.mod, ["cancelled", "failed", "partially_succeeded", "rejected"]);
  assert.deepEqual(report.host, ["cancelled", "failed", "partially_succeeded", "rejected"]);
  assert.equal(report.examined, 4, "the union of the two sets");
  assert.equal(report.agree, 4, "their intersection");
  assert.equal(report.missing, 0);
  assert.deepEqual(violationsOf(report), []);
  assert.deepEqual(
    report.checks.map((entry) => [entry.id, entry.status]),
    [
      ["declaration_readable", "passed"],
      ["wire_vocabulary", "passed"],
      ["state_set_agreement", "passed"],
    ],
  );
});

test("the Host half `15a3c57c` left out is named, on the Host side", () => {
  const report = checkRefusalDetailStateParity({
    root,
    overrides: { [HOST_PATH]: hostWithoutPartiallySucceeded() },
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(violationsOf(report), ["refusal_detail_state_set_drift:partially_succeeded:host"]);
  assert.equal(report.examined, 4, "the union still names the state one side dropped");
  assert.equal(report.agree, 3);
  assert.equal(report.missing, 1);
  assert.match(report.violations[0].detail, /refused and the bridge closes/u);
});

test("a Host token the Mod's method does not permit is named on the Mod side", () => {
  const report = checkRefusalDetailStateParity({ root, overrides: { [HOST_PATH]: hostWithSucceeded() } });
  assert.deepEqual(violationsOf(report), ["refusal_detail_state_set_drift:succeeded:mod"]);
  assert.equal(report.examined, 5);
  assert.equal(report.missing, 1);
});

test("a state the Mod's method stops naming is named on the Mod side", () => {
  const report = checkRefusalDetailStateParity({
    root,
    overrides: { [MOD_PATH]: modWithoutPartiallySucceeded() },
  });
  assert.deepEqual(violationsOf(report), ["refusal_detail_state_set_drift:partially_succeeded:mod"]);
});

test("a Mod state the Host has no token for is named before any set can agree", () => {
  const report = checkRefusalDetailStateParity({ root, overrides: { [MOD_PATH]: modWithUnwireableState() } });
  assert.ok(violationsOf(report).includes("refusal_detail_state_unknown_token:partly_succeeded:mod"));
  assert.equal(report.status, "failed");
  assert.equal(report.checks.find((entry) => entry.id === "wire_vocabulary")?.status, "failed");
});

test("a declaration that cannot be read is blocked, not agreed", () => {
  const report = checkRefusalDetailStateParity({
    root,
    overrides: { [HOST_PATH]: HOST_SOURCE.replace("BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES", "RENAMED_SET") },
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.examined, 0);
  assert.equal(report.checks.find((entry) => entry.id === "declaration_readable")?.status, "blocked");
  for (const line of formatRefusalDetailStates(report)) assert.ok(!line.startsWith("refusal_detail_state_set_drift"));
});

test("each side is read from its own declaration, not from a copy of it", () => {
  assert.deepEqual(extractModStates(MOD_SOURCE), ["Cancelled", "Failed", "PartiallySucceeded", "Rejected"]);
  assert.deepEqual(extractHostStates(HOST_SOURCE), ["cancelled", "failed", "partially_succeeded", "rejected"]);
  const vocabulary = extractHostVocabulary(HOST_SOURCE);
  assert.ok(vocabulary.includes("partially_succeeded"), "the Host's own state table carries the token");
  assert.equal(extractModStates("no declaration here"), null);
  assert.equal(extractHostStates("no declaration here"), null);
  // The C# member is mapped, not looked up: one spelling for the whole fact, so a new state needs no table entry.
  assert.equal(wireTokenOf("PartiallySucceeded"), "partially_succeeded");
  assert.equal(wireTokenOf("RecoveryRequired"), "recovery_required");
});

/** A throwaway checkout holding only the two files the gate reads, one of them mutated. */
function throwawayRoot({ host = HOST_SOURCE, mod = MOD_SOURCE } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "refusal-detail-parity-"));
  for (const [relativePath, contents] of [
    [HOST_PATH, host],
    [MOD_PATH, mod],
  ]) {
    mkdirSync(path.dirname(path.join(dir, relativePath)), { recursive: true });
    writeFileSync(path.join(dir, relativePath), contents, "utf8");
  }
  return dir;
}

function runGate(arguments_) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "tools", "check-refusal-detail-state-parity.mjs"), ...arguments_],
    {
      encoding: "utf8",
    },
  );
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("the CLI prints its population and exits 0 on the shipped tree", () => {
  const run = runGate([]);
  assert.equal(run.status, EXIT.agree, run.stderr);
  assert.match(run.stdout, /refusal_detail_states examined 4 · agree 4 · missing 0/u);
});

test("the CLI exits 1 and names the drifting member on the pre-fix Host set", () => {
  const dir = throwawayRoot({ host: hostWithoutPartiallySucceeded() });
  try {
    const run = runGate(["--root", dir]);
    assert.equal(run.status, EXIT.drift, run.stderr);
    assert.match(run.stdout, /refusal_detail_state_set_drift:partially_succeeded:host/u);
    assert.match(run.stdout, /refusal_detail_states examined 4 · agree 3 · missing 1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI exits 2 on an empty population, so a gate that measured nothing is never green", () => {
  const dir = throwawayRoot({
    host: hostWithDeclaration((region) => region.replace(/new Set\(\[[\s\S]*?\]\)/u, "new Set([])")),
  });
  try {
    const run = runGate(["--root", dir]);
    assert.equal(run.status, EXIT.blocked, run.stderr);
    assert.match(run.stdout, /"status":"blocked"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
