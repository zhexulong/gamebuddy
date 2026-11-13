// red-proof: inject  a hand-rolled `this.Remember(receipt); this.AddTrace(receipt);` terminal into the converted
//   `busactions` family -> `terminal_commit_bypasses_seam:integrations/stardew/
//   farmhandexecutioncontroller.busactions.cs:<line>:busactions`; the same tree with the real exemption list reads
//   `sites examined 886 · through the seam 886 · exempt 6 · families 47` and exit 0
//   (re-measured 2026-11-13; the birth reading of the same gate was `916 · 916 · 93 · 45` - 87 of those 93 exempt
//   sites were converted between `0844cb59` and `1d871a20`, and the four entries the debt record still holds are
//   the four members that still store and publish by hand)
//   (tools/check-terminal-commit-single-entry.test.mjs)
// red-proof: inject  an exemption for a member that calls the seam -> `stale_terminal_seam_exemption:<file>:<line>`
// Tests for the terminal-commit single-entry gate.
//
// Two kinds of assertion, both against real sources rather than fixtures invented for the test:
//  - the POPULATION is scanned from the workspace, so a passing case proves the scan still finds the ~900 sites the
//    product actually settles through (a scan that finds nothing would otherwise agree with itself);
//  - the MUTATIONS re-inject the exact shape the gate exists for - a receipt stored and published by hand - into the
//    family this change converted, so a green run cannot mean "the pattern stopped matching".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyTree,
  collectSourceFiles,
  familyOf,
  memberAt,
  runGate,
  scanSource,
  scanTree,
} from "./check-terminal-commit-single-entry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUS_ACTIONS = "integrations/stardew/farmhandexecutioncontroller.busactions.cs";
const LIFECYCLE_ACTIONS = "integrations/stardew/farmhandexecutioncontroller.lifecycleactions.cs";
const RESOURCE_TOOL_ACTIONS = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
const SEAM_HOST = "integrations/stardew/farmhandexecutioncontroller.cs";

const sourceOf = (relativePath) => ({
  path: relativePath,
  text: readFileSync(path.join(root, relativePath), "utf8"),
});

const realSources = () =>
  collectSourceFiles(root).map((absolute) => ({
    path: path.relative(root, absolute).split(path.sep).join("/"),
    text: readFileSync(absolute, "utf8"),
  }));

/** The family this change converted: every terminal commit in it reaches the ledger through the seam. */
test("the converted bus family reaches the ledger through the seam", () => {
  const scanned = scanSource(BUS_ACTIONS, sourceOf(BUS_ACTIONS).text);

  // Its last hand-rolled store-and-publish was `RequestLocalRideBus`'s non-terminal `Running` marker, converted by
  // `1d871a20`; that commit also deleted the exemption which recorded it. Nothing in this family publishes a receipt
  // by hand any more, which is the stronger statement the old pin ("one member still owes one") could not make.
  assert.deepEqual(
    scanned.bypasses.map((site) => site.member),
    [],
  );
  assert.deepEqual([...new Set(scanned.seamCalls.map((site) => site.member))].sort(), [
    "InvalidateBusRide",
    "RequestLocalRideBus",
    "UpdateBusRide",
  ]);
});

/** The mutation the gate exists for: one hand-rolled terminal put back where the seam now is. */
test("a hand-rolled terminal in the converted family is named with file, line and family", () => {
  const original = sourceOf(BUS_ACTIONS).text;
  const injected = original.replace(
    '        this.RememberTerminal(\n            ride.RequestId,\n            ride.ExecutionId,\n            ExecutionState.Uncertain,\n            "bus_departure_invalidated",',
    '        LocalExecutionReceipt handRolled = new(ride.RequestId, ride.ExecutionId, ExecutionState.Uncertain, "bus_departure_invalidated", this.revision, "reason=none");\n        this.Remember(handRolled);\n        this.AddTrace(handRolled);\n        this.RememberTerminal(\n            ride.RequestId,\n            ride.ExecutionId,\n            ExecutionState.Uncertain,\n            "bus_departure_invalidated",',
  );
  assert.notEqual(injected, original, "the mutation must land, or the test proves nothing");

  const scanned = scanSource(BUS_ACTIONS, injected);
  const verdict = classifyTree(
    { declarations: [], seamCalls: scanned.seamCalls, seamSites: scanned.seamSites, bypasses: scanned.bypasses },
    [],
  );

  const codes = verdict.findings.map((finding) => finding.code);
  assert.ok(
    codes.some(
      (code) => code.startsWith(`terminal_commit_bypasses_seam:${BUS_ACTIONS}:`) && code.endsWith(":busactions"),
    ),
    `expected the injected bypass to be named, got ${JSON.stringify(codes)}`,
  );
  assert.ok(
    verdict.findings.some((finding) => finding.detail.includes("InvalidateBusRide")),
    "the failure must name the drifting member so the next reader knows what to fix",
  );
});

/** The seam's own body is not a bypass: it is the one place the pair belongs. */
test("the seam's own store-and-publish body counts as through the seam", () => {
  const scanned = scanSource(SEAM_HOST, sourceOf(SEAM_HOST).text);
  assert.equal(scanned.seamSites.length, 1, "the seam body must be found exactly once");
  assert.equal(scanned.seamSites[0].member, "RememberTerminal");
});

/**
 * The debt record's own entries. Each ratchet case below VARIES a real entry - one more site, one fewer, a member that
 * was converted, a member that never existed - so the fixture can only be as true as the ratchet it drives: an entry
 * whose member has meanwhile been converted is refused by `debtEntry` instead of quietly pinning a tree that moved.
 */
const debtRecord = JSON.parse(readFileSync(path.join(root, "tools/terminal-commit-seam-exemptions.json"), "utf8"));
const debtSites = debtRecord.exemptions.reduce((total, entry) => total + entry.sites, 0);
const debtEntry = (file, member) => {
  const entry = debtRecord.exemptions.find((candidate) => candidate.file === file && candidate.member === member);
  assert.ok(entry, `${file}:${member} is no longer debt: this fixture must name a member that still owes a site`);
  return entry;
};

/** An exemption that outlives its site must go red, in both directions. */
test("an exemption for a member that now calls the seam is stale", () => {
  const verdict = classifyTree(scanTree([sourceOf(BUS_ACTIONS)]), [
    { file: BUS_ACTIONS, member: "UpdateBusRide", line: 190, sites: 1, family: "busactions", reason: "converted" },
  ]);

  assert.equal(verdict.exempt, 0, "a member that reaches the seam through `RememberTerminal` exempts nothing");
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    [`stale_terminal_seam_exemption:${BUS_ACTIONS}:190`],
  );
});

test("an exemption whose member disappeared entirely is stale", () => {
  const verdict = classifyTree(scanTree([sourceOf(BUS_ACTIONS)]), [
    { file: BUS_ACTIONS, member: "RetireBusRide", line: 7, sites: 1, family: "busactions", kind: "x", reason: "gone" },
  ]);

  assert.equal(verdict.exempt, 0);
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    [`stale_terminal_seam_exemption:${BUS_ACTIONS}:7`],
  );
});

/** The ratchet compares SITE COUNTS, so a partial conversion inside one member cannot hide. */
test("a member that owes fewer sites than its exemption records is stale", () => {
  const entry = debtEntry(LIFECYCLE_ACTIONS, "UpdateActiveDayAdvance");
  const verdict = classifyTree(scanTree([sourceOf(LIFECYCLE_ACTIONS)]), [{ ...entry, sites: entry.sites + 1 }]);

  assert.equal(verdict.exempt, entry.sites, "the site it still owes is covered; the phantom one is the debt");
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    [`stale_terminal_seam_exemption:${entry.file}:${entry.line}`],
  );
});

/** And the other direction: an exemption covers its count exactly, and the surplus is a bypass, not an exemption. */
test("an exemption covers exactly its recorded sites, and the surplus is a bypass", () => {
  const entry = debtEntry(RESOURCE_TOOL_ACTIONS, "CompleteToolApproach");
  assert.ok(entry.sites > 1, `the surplus case needs a member that owes more than one site, got ${entry.sites}`);

  const covered = classifyTree(scanTree([sourceOf(RESOURCE_TOOL_ACTIONS)]), [entry]);
  assert.deepEqual(covered.findings, []);
  assert.equal(covered.exempt, entry.sites);

  const short = classifyTree(scanTree([sourceOf(RESOURCE_TOOL_ACTIONS)]), [{ ...entry, sites: entry.sites - 1 }]);
  assert.equal(short.exempt, entry.sites - 1);
  assert.equal(short.findings.length, 1, `expected the one surplus site, got ${JSON.stringify(short.findings)}`);
  assert.ok(
    short.findings[0].code.startsWith(`terminal_commit_bypasses_seam:${RESOURCE_TOOL_ACTIONS}:`) &&
      short.findings[0].code.endsWith(":resourcetoolactions") &&
      short.findings[0].detail.includes("CompleteToolApproach"),
    `the failure must name the surplus site and its member, got ${JSON.stringify(short.findings[0])}`,
  );
});

/** The population is derived from the tree, never listed: it must be large, and it must name real families. */
test("the workspace population is derived and non-trivial", () => {
  const scanned = scanTree(realSources());

  assert.ok(scanned.seamCalls.length > 800, `expected the seam to be called widely, got ${scanned.seamCalls.length}`);
  assert.ok(scanned.bypasses.length > 0, "the debt this gate records must still be visible");
  assert.ok(scanned.families.includes("busactions"), "a family name must come from the partial's own file name");
  assert.ok(scanned.families.includes("controller"), "the main partial must be its own family");
});

/** The verdict line the task requires, produced from the real tree. */
test("the real tree passes and prints the population it examined", () => {
  const result = runGate(root);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^sites examined \d+ · through the seam \d+ · exempt \d+ · families \d+$/mu);
  const verdict = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(verdict.status, "passed");

  // Every number in the report is CROSS-CHECKED against a scan this test performs itself, rather than pinned to
  // today's tree: a count that only matched because the tree stopped growing is a check that has stopped working.
  const scanned = scanTree(realSources());
  const sites = scanned.bypasses.length + scanned.seamCalls.length + scanned.seamSites.length;
  assert.equal(verdict.examined, sites, "the report must count the sites the scan found");
  assert.equal(verdict.seamCalls, scanned.seamCalls.length);
  assert.equal(
    verdict.exempt,
    debtSites,
    "every exempt site is one the debt record still names; 93 -> 6 was 87 conversions, not 87 dropped entries",
  );
  assert.equal(
    verdict.families,
    new Set([...scanned.bypasses, ...scanned.seamCalls, ...scanned.seamSites].map((site) => site.family)).size,
  );
  assert.equal(verdict.examined, verdict.throughSeam, "every site in the tree reaches the ledger through the seam");
});

/** Zero population is blocked, never green. */
test("an empty source tree is blocked with the reason, not passed", () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "terminal-seam-"));
  try {
    mkdirSync(path.join(empty, "integrations", "stardew"), { recursive: true });
    const result = runGate(empty);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no_source_examined/u);
    // THE REPORT IS PRINTED ON A BLOCKED RUN TOO, and every check says blocked rather than passed: the conformance
    // mechanism reads this line, and a gate that measured nothing must not be able to look like one that found nothing.
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.status, "blocked");
    assert.equal(report.examined, 0);
    assert.ok(report.checks.length > 0, "a blocked report with no checks is a report nothing can read");
    for (const check of report.checks)
      assert.equal(check.status, "blocked", `${check.id} read ${check.status} on a run that measured nothing`);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

/** A tree of sources with no terminal commit at all is blocked too: nothing was measured. */
test("a tree with sources but no commit site is blocked", () => {
  const quiet = mkdtempSync(path.join(os.tmpdir(), "terminal-seam-quiet-"));
  try {
    const directory = path.join(quiet, "integrations", "stardew");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "Quiet.cs"), "namespace GameBuddy.Stardew;\ninternal static class Quiet { }\n");
    const result = runGate(quiet);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no_terminal_commit_found/u);
  } finally {
    rmSync(quiet, { recursive: true, force: true });
  }
});

/** Identities the gate reports with must come from the file itself, not from a table. */
test("family and member are read from the source, so a line shift cannot rename a site", () => {
  assert.equal(familyOf(BUS_ACTIONS), "busactions");
  assert.equal(familyOf(SEAM_HOST), "controller");
  assert.equal(familyOf("integrations/stardew/BridgeSession.cs"), "BridgeSession");

  const lines = ["internal class X", "{", "    private void Alpha(", "        int a)", "    {", "    }", "}"];
  assert.equal(memberAt(lines, 4), "Alpha");
});
