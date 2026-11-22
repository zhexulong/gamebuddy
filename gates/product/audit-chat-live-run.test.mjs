import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditChatLiveRunFile, parseAuditCliArgs } from "./audit-chat-live-run.mjs";

const CLI_PATH = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-run-audit");

/** @param {string} name */
function fixturePath(name) {
  return join(FIXTURE_DIR, name);
}

/** @param {(dir: string) => Promise<void>} fn */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gamebuddy-chat-run-audit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** @param {string[]} args */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// ============================================================================
// Argument parsing
// ============================================================================

test("parseAuditCliArgs accepts both flag forms and rejects an unknown argument", () => {
  assert.deepEqual(parseAuditCliArgs(["--audit", "a.json", "--report", "r.json", "--json"]), {
    auditPath: "a.json",
    reportPath: "r.json",
    format: "json",
    help: false,
  });
  assert.deepEqual(parseAuditCliArgs(["--audit=a.json", "--format=text"]), {
    auditPath: "a.json",
    reportPath: undefined,
    format: "text",
    help: false,
  });
  assert.deepEqual(parseAuditCliArgs(["-a", "a.json", "-r", "r.json"]), {
    auditPath: "a.json",
    reportPath: "r.json",
    format: "text",
    help: false,
  });
  assert.throws(() => parseAuditCliArgs(["--audit", "a.json", "--verbose"]), /unknown_argument:--verbose/);
  assert.throws(() => parseAuditCliArgs(["--audit", "a.json", "--format=yaml"]), /unknown_format:yaml/);
});

// ============================================================================
// Exit codes
// ============================================================================

test("CLI exits 0 on the clean fixture and prints the Phase 7 synthesis report", () => {
  const result = runCli(["--audit", fixturePath("clean-success.json")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Execution Audit Summary/);
  assert.match(result.stdout, /## Seam Attribution & Deterministic Gates/);
  assert.match(result.stdout, /passed \(no integrity failure\)/);
});

test("CLI exits 1 when the hollow-success fixture is audited", () => {
  const result = runCli(["--audit", fixturePath("hollow-success.json")]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /INTEGRITY FAILED/);
  assert.match(result.stdout, /hollow_success/);
});

test("CLI exits 1 for every integrity-failing fixture", () => {
  for (const name of [
    "hollow-success.json",
    "hollow-failure.json",
    "unobserved-cancellation.json",
    "recovery-mismatch.json",
    "provider-boundary-unsettled.json",
    "invalid-stream-frame.json",
    "feedback-starvation.json",
    "settlement-contention.json",
    "probe-isolation-breach.json",
  ]) {
    const result = runCli(["--audit", fixturePath(name)]);
    assert.equal(result.status, 1, `${name} should exit 1: ${result.stderr}`);
  }
});

test("CLI exits 1 and names the breach when a memory probe recorded an isolation breach", () => {
  const result = runCli(["--audit", fixturePath("probe-isolation-breach.json")]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /INTEGRITY FAILED/);
  assert.match(result.stdout, /isolation_breach \[memory_isolation, high\] x1/);
});

test("CLI exits 0 for every reported-only probe outcome", () => {
  // needle.miss / distractor.confused / supersede.fail / isolation.clean /
  // probe.observability_gap are measurements: a run that only misses must still
  // produce a report and exit 0 (probe design §6.1/§7).
  const result = runCli(["--audit", fixturePath("probe-reported-only.json")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed \(no integrity failure\)/);
  assert.match(result.stdout, /- Memory probe: 5 event\(s\)/);
});

test("CLI exits 0 for non-integrity waste findings so a report can still be produced", () => {
  for (const name of [
    "idle-stall.json",
    "micro-stepping.json",
    "stream-gap-churn.json",
    "memory-conflict-storm.json",
    "provider-unobserved.json",
  ]) {
    const result = runCli(["--audit", fixturePath(name)]);
    assert.equal(result.status, 0, `${name} should exit 0: ${result.stderr}`);
  }
});

test("CLI exits 2 on the malformed fixture and lists every validation reason", () => {
  const result = runCli(["--audit", fixturePath("malformed.json")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BLOCKED: audit_validation_failed/);
  assert.match(result.stderr, /at_not_monotonic/);
  assert.match(result.stderr, /code_unknown/);
  assert.match(result.stderr, /kind_unknown/);
  assert.match(result.stderr, /meta_too_many_keys/);
});

test("CLI exits 2 without --audit", () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--audit <path> is required/);
});

test("CLI exits 2 on an unknown argument, an invalid format, an unreadable path and invalid JSON", async () => {
  const unknown = runCli(["--audit", fixturePath("clean-success.json"), "--verbose"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown_argument:--verbose/);

  const badFormat = runCli(["--audit", fixturePath("clean-success.json"), "--format=yaml"]);
  assert.equal(badFormat.status, 2);
  assert.match(badFormat.stderr, /unknown_format:yaml/);

  const missing = runCli(["--audit", fixturePath("does-not-exist.json")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /BLOCKED: audit_load_error/);

  await withTempDir(async (dir) => {
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ not json", "utf8");
    const result = runCli(["--audit", broken]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BLOCKED: audit_parse_error/);
  });
});

test("CLI --json prints the machine report and --report writes it to disk", async () => {
  await withTempDir(async (dir) => {
    const reportPath = join(dir, "report.json");
    const result = runCli(["--audit", fixturePath("clean-success.json"), "--report", reportPath, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const printed = JSON.parse(result.stdout);
    assert.equal(printed.schema, "chat_run_audit_report/v1");
    assert.equal(printed.verdict, "passed");
    assert.equal(printed.summary.turnCount, 2);

    const written = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(reportPath, "utf8")));
    assert.equal(written.schema, "chat_run_audit_report/v1");
    assert.equal(written.runId, printed.runId);
    assert.equal(written.integrity.passed, true);
  });
});

test("CLI --help exits 0 and documents the exit codes", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Exit codes: 0 no integrity failure, 1 integrity failed, 2 usage\/validation error/);
});

// ============================================================================
// Library entry point
// ============================================================================

test("auditChatLiveRunFile never reports a validation failure as a report", async () => {
  const outcome = await auditChatLiveRunFile(fixturePath("malformed.json"));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "audit_validation_failed");
  assert.ok(outcome.errors.length > 0);
});

test("auditChatLiveRunFile builds a report for a valid trace and labels the artifact", async () => {
  const outcome = await auditChatLiveRunFile(fixturePath("idle-stall.json"));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.report.artifact.label, fixturePath("idle-stall.json"));
  assert.equal(outcome.report.verdict, "passed");
  assert.ok(outcome.report.waste.maxFrameGapMs > 30000);
});
