import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonWithoutDuplicateKeys } from "../src/json-text.mjs";
import {
  BLOCKED_MISSING_TARGET_ASSEMBLIES,
  FAILED_CONTRACT_OUTPUT_MISSING,
  FAILED_TARGET_ASSEMBLY,
  FAILED_TARGET_CLOSURE_PARTIAL,
  REPORT_SCHEMA,
  TARGET_ASSEMBLIES_AVAILABLE,
  validateReport,
} from "../static-verifier/schema.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticVerifierDirectory = path.join(path.dirname(directory), "static-verifier");
const CLI = path.join(staticVerifierDirectory, "verify-static.mjs");

function runCli(options, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: staticVerifierDirectory,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("every committed producer fixture maps closure state to the exact process exit code", async () => {
  const cases = [
    ["input.pass.v1.json", 0, "passed", TARGET_ASSEMBLIES_AVAILABLE],
    ["input.blocked.v1.json", 2, "blocked", BLOCKED_MISSING_TARGET_ASSEMBLIES],
    ["input.partial.v1.json", 1, "failed", FAILED_TARGET_CLOSURE_PARTIAL],
    ["input.malformed.v1.json", 1, "failed", FAILED_TARGET_ASSEMBLY],
    ["input.contract-missing.v1.json", 1, "failed", FAILED_CONTRACT_OUTPUT_MISSING],
  ];
  for (const [fixture, exitCode, state, reasonCode] of cases) {
    const result = await runCli({}, fixture);
    assert.equal(result.code, exitCode, `${fixture} exit code`);
    assert.equal(result.stderr, "", `${fixture} stderr`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, REPORT_SCHEMA);
    assert.equal(report.state, state, fixture);
    assert.equal(report.reasonCode, reasonCode, fixture);
    assert.equal(validateReport(report), report, fixture);
  }
});

test("spawns the verifier command with shell disabled", async () => {
  const calls = [];
  const originalSpawn = spawn;
  const baseRun = (options, ...args) => {
    calls.push(options);
    return new Promise((resolve, reject) => {
      const child = originalSpawn(process.execPath, [CLI, ...args], options);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  };
  const result = await baseRun(
    { cwd: staticVerifierDirectory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    "input.pass.v1.json",
  );
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shell, false);
  assert.equal(calls[0].cwd, staticVerifierDirectory);
  assert.equal(JSON.parse(result.stdout).state, "passed");
});

test("accepts only package-owned input arguments and rejects escapes and absolute paths", async () => {
  for (const args of [
    [],
    ["input.pass.v1.json", "input.blocked.v1.json"],
    ["C:/outside/input.pass.v1.json"],
    ["/outside/input.pass.v1.json"],
    ["../portfolio.json"],
    [path.join("..", "portfolio.json")],
    ["fixtures\\input.pass.v1.json"],
    ["fixtures/input.pass.v1.txt"],
    ["fixtures/not-present.v1.json"],
  ]) {
    const result = await runCli({}, ...args);
    assert.equal(result.code, 3, `args ${JSON.stringify(args)}`);
    assert.equal(result.stdout, "", `args ${JSON.stringify(args)}`);
    assert.match(result.stderr, /stardew_static_verifier_usage_|stardew_static_verifier_input_unreadable/);
  }
});

test("rejects malformed JSON and non-package-owned input content before verification", async () => {
  const malformed = await runCli({}, "input.malformed-json.v1.json");
  assert.equal(malformed.code, 3);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /stardew_static_verifier_input_duplicate_key/);

  const rootScope = await runCli({}, "input.root-scope.v1.json");
  assert.equal(rootScope.code, 3);
  assert.equal(rootScope.stdout, "");
  assert.match(rootScope.stderr, /stardew_static_verifier_schema_input_scope/);
});

test("writes one deterministic JSON report to stdout and nothing to stderr", async () => {
  const result = await runCli({}, "input.pass.v1.json");
  assert.equal(result.stderr, "");
  const report = parseJsonWithoutDuplicateKeys(result.stdout, "cli_report");
  assert.equal(report.state, "passed");
  assert.equal(report.summary.passDenominator, 1);
});