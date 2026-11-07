/**
 * Falsifiers for tools/check-release-live-evidence.mjs.
 *
 * Every case plants one defect in a scratch `git init` repository - three commits whose dates are fixed
 * literals, so nothing here depends on the clock or on this checkout's history - and requires the gate to
 * name that defect. The scratch repository is also the only way to ask the four questions the gate exists
 * for without editing the committed evidence: a pin git has never seen, a pin on a side branch, a capture
 * date 60 days before its pin and one 60 days after it.
 *
 * red-proof: inject  a pin on a side branch that is not an ancestor of HEAD -> `evidence_pin_not_ancestor_of_head`
 *                    naming the surface and the commit
 *                    (tools/check-release-live-evidence.test.mjs)
 * red-proof: inject  capturedAt 60 days before the pinned commit -> `evidence_predates_pin`; 60 days after
 *                    it -> `evidence_pin_stale` (tools/check-release-live-evidence.test.mjs)
 * red-proof: inject  a declaration with no surface -> `status:"blocked"` and exit 1, with `examined 0`
 *                    (tools/check-release-live-evidence.test.mjs)
 * red-proof: fixture one measured surface beside one `not_measured` surface -> exit 0, and the summary line
 *                    names only the unmeasured one (tools/check-release-live-evidence.test.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditReleaseLiveEvidence,
  EVIDENCE_SCHEMA,
  EVIDENCE_SURFACES,
  MAX_EVIDENCE_DRIFT_DAYS,
  reportReading,
} from "./check-release-live-evidence.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "check-release-live-evidence.mjs");
const DAY_MS = 24 * 60 * 60 * 1000;
/** The pinned commit's own date in every scratch repository; the cases offset from it, never from now. */
const HEAD_DATE = "2026-02-01T00:00:00Z";

function gitAt(cwd, args, env = {}) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=GameBuddy Evidence Gate", "-c", "user.email=gate@gamebuddy.invalid", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

/**
 * A three-commit repository: `base` and `head` on the default branch, `side` on a branch that is never
 * merged. Each commit date is a literal, so a drift is a fact of the fixture rather than of today.
 */
function scratchRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "release-live-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  gitAt(root, ["init"]);
  const commit = (message, date) =>
    gitAt(root, ["commit", "--allow-empty", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  commit("base", "2026-01-01T00:00:00Z");
  commit("head", HEAD_DATE);
  const head = gitAt(root, ["rev-parse", "HEAD"]);
  const branch = gitAt(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  gitAt(root, ["checkout", "-b", "side"]);
  commit("side", "2026-02-15T00:00:00Z");
  const side = gitAt(root, ["rev-parse", "side"]);
  gitAt(root, ["checkout", branch]);
  return { root, head, side };
}

/** `HEAD_DATE` shifted by whole days, as an ISO instant the gate can compare against the pin. */
const daysFromHead = (days) => new Date(Date.parse(HEAD_DATE) + days * DAY_MS).toISOString();

function writeEvidence(root, file, document) {
  const directory = join(root, "tools", "fixtures", "live-evidence");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/** One surface's evidence, complete by default so each case can change exactly the field it is about. */
function evidence({ surface, pinnedSha, capturedAt = HEAD_DATE, verdict = "passed", reason, result }) {
  return {
    schema: EVIDENCE_SCHEMA,
    surface,
    capturedAt,
    pinnedSha,
    verdict,
    ...(reason === undefined ? {} : { reason }),
    readings: [{ id: `${surface}.journey`, result: result ?? verdict }],
  };
}

const TAVERN = Object.freeze([{ surface: "tavern", file: "tavern.json" }]);
const BOTH = Object.freeze([
  { surface: "memory", file: "memory.json" },
  { surface: "tavern", file: "tavern.json" },
]);
/**
 * The tree the release lane would read: the other surface measured, and the tavern document under test.
 * Every case below injects one defect, so a red run has one cause and the violation list can be asserted
 * whole instead of matched by pattern.
 */
function seed({ root, head, tavern }) {
  writeEvidence(root, "memory.json", evidence({ surface: "memory", pinnedSha: head }));
  writeEvidence(root, "tavern.json", tavern);
}

/** The gate as the release lane runs it: its own CLI, over the scratch repository. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

test("the committed evidence satisfies the declared shape, and leaves no finding", () => {
  const reading = auditReleaseLiveEvidence();
  assert.equal(reading.population, EVIDENCE_SURFACES.length);
  assert.deepEqual(reading.violations, []);
  for (const surface of reading.surfaces)
    assert.ok(EVIDENCE_SURFACES.some((entry) => entry.surface === surface.surface));
});

test("a measured surface whose pin is HEAD passes, so the gate can go green", (t) => {
  const { root, head } = scratchRepository(t);
  seed({ root, head, tavern: evidence({ surface: "tavern", pinnedSha: head }) });
  const run = runGate(root);
  assert.equal(run.status, 0, run.stderr);
  const reading = auditReleaseLiveEvidence({ root });
  assert.deepEqual(reading.violations, []);
  assert.equal(reading.status, "passed");
  assert.equal(reading.surfaces[1].readings, 1);
});

test("an unmeasured surface exits 0 and the summary names only it", (t) => {
  const { root, head } = scratchRepository(t);
  seed({
    root,
    head,
    tavern: evidence({
      surface: "tavern",
      pinnedSha: head,
      verdict: "not_measured",
      reason: "provider_credential_absent: no tavern-release-live-gate.json exists in this checkout",
    }),
  });
  const run = runGate(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /release_live_evidence examined 2 surface\(s\)/u);
  assert.match(
    run.stderr,
    /release_live_evidence not_measured: 1 of 2 surface\(s\)[^\n]*tavern \(provider_credential_absent\)/u,
  );
  assert.doesNotMatch(run.stderr, /not_measured: 1 of 2 surface\(s\)[^\n]*memory/u);
  assert.equal(JSON.parse(run.stdout).status, "not_measured");
});

test("a pin on a side branch is named as not an ancestor of HEAD", (t) => {
  const { root, head, side } = scratchRepository(t);
  seed({ root, head, tavern: evidence({ surface: "tavern", pinnedSha: side }) });
  const run = runGate(root);
  assert.equal(run.status, 1);
  assert.deepEqual(auditReleaseLiveEvidence({ root }).violations, [`evidence_pin_not_ancestor_of_head:tavern:${side}`]);
});

test("a pin git has never seen is reported apart from a side branch", (t) => {
  const { root, head } = scratchRepository(t);
  const absent = "0000000000000000000000000000000000000000";
  seed({ root, head, tavern: evidence({ surface: "tavern", pinnedSha: absent }) });
  const run = runGate(root);
  assert.equal(run.status, 1);
  assert.deepEqual(auditReleaseLiveEvidence({ root }).violations, [`evidence_pin_unknown:tavern:${absent}`]);
});

test("evidence captured before its pin is named as predating it", (t) => {
  const { root, head } = scratchRepository(t);
  seed({
    root,
    head,
    tavern: evidence({ surface: "tavern", pinnedSha: head, capturedAt: daysFromHead(-(MAX_EVIDENCE_DRIFT_DAYS * 2)) }),
  });
  const run = runGate(root);
  assert.equal(run.status, 1);
  assert.deepEqual(auditReleaseLiveEvidence({ root }).violations, [`evidence_predates_pin:tavern:60d before ${head}`]);
});

test("evidence captured long after its pin is named as a stale pin", (t) => {
  const { root, head } = scratchRepository(t);
  seed({
    root,
    head,
    tavern: evidence({ surface: "tavern", pinnedSha: head, capturedAt: daysFromHead(MAX_EVIDENCE_DRIFT_DAYS * 2) }),
  });
  const run = runGate(root);
  assert.equal(run.status, 1);
  assert.deepEqual(auditReleaseLiveEvidence({ root }).violations, [`evidence_pin_stale:tavern:60d after ${head}`]);
});

test("a declaration with no surface is blocked rather than passed", () => {
  const reading = auditReleaseLiveEvidence({ surfaces: [] });
  assert.equal(reading.population, 0);
  assert.equal(reading.status, "blocked");
  const lines = [];
  assert.equal(reportReading(reading, { write: (line) => lines.push(line) }), 1);
  assert.match(lines.join(""), /examined 0/u);
});

test("evidence absent from every surface fails instead of reading as unmeasured", (t) => {
  const { root } = scratchRepository(t);
  const run = spawnSync(process.execPath, [GATE, "--root", root, "--evidence-root", join(root, "absent")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(String(run.stdout), /evidence_missing:tavern:tavern\.json/u);
});

test("a failed verdict cannot pass the release lane", (t) => {
  const { root, head } = scratchRepository(t);
  seed({ root, head, tavern: evidence({ surface: "tavern", pinnedSha: head, verdict: "failed" }) });
  const run = runGate(root);
  assert.equal(run.status, 1);
  assert.deepEqual(auditReleaseLiveEvidence({ root }).violations, ["evidence_verdict_failed:tavern"]);
});

test("a passed verdict cannot carry a reading that was not measured", (t) => {
  const { root, head } = scratchRepository(t);
  seed({
    root,
    head,
    tavern: evidence({ surface: "tavern", pinnedSha: head, verdict: "passed", result: "not_measured" }),
  });
  const run = runGate(root);
  assert.equal(run.status, 1);
  assert.deepEqual(auditReleaseLiveEvidence({ root }).violations, [
    "evidence_verdict_contradicted:tavern:tavern.journey:not_measured",
  ]);
});

test("a file copied from the other surface is named rather than read as this one's", (t) => {
  const { root, head } = scratchRepository(t);
  writeEvidence(root, "memory.json", evidence({ surface: "tavern", pinnedSha: head }));
  const reading = auditReleaseLiveEvidence({ root, surfaces: BOTH });
  assert.ok(reading.violations.includes("evidence_surface_mismatch:memory:tavern"));
  assert.ok(reading.violations.includes("evidence_missing:tavern:tavern.json"));
  assert.equal(reading.status, "failed");
});

test("an unmeasured surface that states no cause is named", (t) => {
  const { root, head } = scratchRepository(t);
  writeEvidence(root, "tavern.json", evidence({ surface: "tavern", pinnedSha: head, verdict: "not_measured" }));
  const reading = auditReleaseLiveEvidence({ root, surfaces: TAVERN });
  assert.ok(reading.violations.includes("evidence_reason_unstated:tavern"));
});

test("a duplicated reading id is named", (t) => {
  const { root, head } = scratchRepository(t);
  const document = evidence({ surface: "tavern", pinnedSha: head });
  document.readings = [
    { id: "tavern.journey", result: "passed" },
    { id: "tavern.journey", result: "passed" },
  ];
  writeEvidence(root, "tavern.json", document);
  const reading = auditReleaseLiveEvidence({ root, surfaces: TAVERN });
  assert.ok(reading.violations.includes("evidence_reading_duplicated:tavern:tavern.journey"));
});

test("evidence with no readings cannot claim a measured verdict", (t) => {
  const { root, head } = scratchRepository(t);
  const document = evidence({ surface: "tavern", pinnedSha: head });
  document.readings = [];
  writeEvidence(root, "tavern.json", document);
  const reading = auditReleaseLiveEvidence({ root, surfaces: TAVERN });
  assert.ok(reading.violations.includes("evidence_readings_empty:tavern"));
});

test("an unknown schema is named instead of read as this contract", (t) => {
  const { root, head } = scratchRepository(t);
  const document = { ...evidence({ surface: "tavern", pinnedSha: head }), schema: "something_else/v1" };
  writeEvidence(root, "tavern.json", document);
  const reading = auditReleaseLiveEvidence({ root, surfaces: TAVERN });
  assert.ok(reading.violations.includes("evidence_schema_unknown:tavern:something_else/v1"));
});
