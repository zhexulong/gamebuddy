#!/usr/bin/env node
/**
 * The falsifier for `tools/check-publint.mjs`.
 *
 * The gate exists for one defect: it printed "publint exited null but every failure maps to a known vendor baseline gap;
 * non-blocking here" and exited 0 having read no publint message at all, because `spawnSync("bun", …)` with
 * `shell: false` starts no shim. These cases drive the gate's own decision function and its real PATH search, so
 * "the tool never ran" can never again be read as "the tool reported nothing".
 *
 * Measured red (inject): restoring the pre-fix tolerance branch (`blocked.length === 0 && activeGaps.length > 0` with no
 * requirement on the parsed message count) -> the case "an unexplained non-zero exit is a failure, not a tolerated gap"
 * fails on `passed !== failed` (tools/check-publint.test.mjs)
 * Measured red (history): the default run on a machine with only npm's `bun` shims -> exit 0 printing
 * `publint exited null but every failure maps to a known vendor baseline gap`; the run now prints
 * `publint_not_measured:executable_unresolvable:bun …` and exits 2 (tools/check-publint.mjs)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessPublintRun,
  parsedPublintMessages,
  publintIdentity,
  resolveRunnerExecutable,
  runnerVersion,
} from "./check-publint.mjs";

const IDENTIFIED = "Running publint v0.3.25 for @cortexkit/pi-magic-context...\nLinting...\n";
const ACTIVE_GAP = Object.freeze([{ id: "missing-types-condition", detail: "missing types condition for exports: ." }]);

function withShims(names) {
  const directory = mkdtempSync(path.join(tmpdir(), "publint-shims-"));
  for (const name of names) writeFileSync(path.join(directory, name), "", "utf8");
  return directory;
}

function spawnResult({ status, stdout = "", stderr = "" }) {
  return { status, stdout, stderr };
}

function resolutionAt(directory, platform = "win32") {
  return resolveRunnerExecutable({ env: { PATH: directory }, platform });
}

test("a PATH holding only npm's shims resolves to nothing, and names each shim it refused", () => {
  const directory = withShims(["bun", "bun.cmd", "bun.ps1"]);
  try {
    const resolution = resolutionAt(directory);
    assert.equal(resolution.ok, false);
    assert.equal(resolution.executable, null);
    assert.deepEqual(
      resolution.found.map((entry) => path.basename(entry.path)),
      ["bun.cmd", "bun.ps1", "bun"],
    );
    for (const entry of resolution.found) assert.ok(entry.reason.length > 0, "each refusal says why it cannot be run");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a real executable later on PATH wins over the shims earlier on it", () => {
  const shims = withShims(["bun.cmd"]);
  const real = mkdtempSync(path.join(tmpdir(), "publint-real-"));
  writeFileSync(path.join(real, "bun.exe"), "", "utf8");
  try {
    const resolution = resolveRunnerExecutable({
      env: { PATH: `${shims}${path.delimiter}${real}` },
      platform: "win32",
    });
    assert.equal(resolution.ok, true);
    assert.equal(path.basename(resolution.executable), "bun.exe");
    assert.equal(resolution.found.length, 1, "the refused shim is still reported beside the usable file");
  } finally {
    rmSync(shims, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("the same search resolves the extensionless binary outside Windows", () => {
  // A Windows temp path carries a drive-letter colon, and `path.join` composes host-shaped paths, so this case states its
  // own file set: what it measures is the suffix list and the accept rule for a platform that has no `.exe` shims.
  // The win32 cases above run against real files.
  const executable = path.join("/usr/bin", "bun");
  const resolution = resolveRunnerExecutable({
    env: { PATH: "/usr/local/bin:/usr/bin" },
    platform: "linux",
    fileExists: (candidate) => candidate === executable,
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.executable, executable);
});

test("a name nothing on PATH carries is unresolvable rather than silently absent", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "publint-empty-"));
  try {
    mkdirSync(path.join(directory, "bin"));
    const resolution = resolveRunnerExecutable({
      name: "bun",
      env: { PATH: path.join(directory, "bin") },
      platform: "linux",
    });
    assert.equal(resolution.ok, false);
    assert.deepEqual(resolution.found, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unresolvable runner is not measured, and the marker says what was found instead", () => {
  const directory = withShims(["bun.cmd", "bun.ps1"]);
  try {
    const verdict = assessPublintRun({
      resolution: resolutionAt(directory),
      handshake: null,
      run: null,
      version: null,
      activeGaps: ACTIVE_GAP,
    });
    assert.equal(verdict.status, "not_measured");
    assert.equal(verdict.exitCode, 2);
    assert.match(
      verdict.lines[0],
      /^publint_not_measured:executable_unresolvable:bun - no file this process can spawn/u,
    );
    assert.ok(verdict.lines[0].includes("bun.cmd"), "the marker names the shim that was found");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a runner that does not answer --version is not measured", () => {
  const verdict = assessPublintRun({
    resolution: { ok: true, executable: "/usr/bin/bun", found: [] },
    handshake: spawnResult({ status: 1, stderr: "unknown option" }),
    run: null,
    version: null,
    activeGaps: ACTIVE_GAP,
  });
  assert.equal(verdict.status, "not_measured");
  assert.equal(verdict.exitCode, 2);
  assert.match(verdict.lines[0], /^publint_not_measured:runner_did_not_answer:\/usr\/bin\/bun --version exited 1/u);
});

test("a run that printed no publint identity line is not measured, whatever its exit status", () => {
  const verdict = assessPublintRun({
    resolution: { ok: true, executable: "/usr/bin/bun", found: [] },
    handshake: spawnResult({ status: 0, stdout: "1.4.4" }),
    run: spawnResult({ status: 0, stdout: "bun: no such package\n" }),
    version: "1.4.4",
    activeGaps: ACTIVE_GAP,
  });
  assert.equal(verdict.status, "not_measured");
  assert.equal(verdict.exitCode, 2);
  assert.match(verdict.lines[0], /^publint_not_measured:no_publint_output:/u);
});

test("a clean publint run passes and says which binary and version it measured", () => {
  const verdict = assessPublintRun({
    resolution: { ok: true, executable: "/usr/bin/bun", found: [] },
    handshake: spawnResult({ status: 0, stdout: "1.4.4" }),
    run: spawnResult({ status: 0, stdout: IDENTIFIED }),
    version: "1.4.4",
    activeGaps: ACTIVE_GAP,
  });
  assert.equal(verdict.status, "passed");
  assert.equal(verdict.exitCode, 0);
  assert.match(
    verdict.lines[0],
    /publint ran: \/usr\/bin\/bun \(bun 1\.4\.4, x publint --strict\), publint v0\.3\.25/u,
  );
});

test("an unexplained non-zero exit is a failure, not a tolerated gap", () => {
  const verdict = assessPublintRun({
    resolution: { ok: true, executable: "/usr/bin/bun", found: [] },
    handshake: spawnResult({ status: 0, stdout: "1.4.4" }),
    run: spawnResult({ status: 1, stdout: IDENTIFIED }),
    version: "1.4.4",
    activeGaps: ACTIVE_GAP,
  });
  assert.equal(verdict.status, "failed", "no parsed message means no gap could be matched");
  assert.equal(verdict.exitCode, 1);
  assert.ok(!verdict.lines.some((line) => line.includes("non-blocking")), "nothing may be excused unseen");
});

test("a message that maps to an active vendor gap is the only thing that can be tolerated", () => {
  const message = JSON.stringify({ code: "TYPES_NOT_EXPORTED", path: ["exports", "."] });
  const tolerated = assessPublintRun({
    resolution: { ok: true, executable: "/usr/bin/bun", found: [] },
    handshake: spawnResult({ status: 0, stdout: "1.4.4" }),
    run: spawnResult({ status: 1, stdout: `${IDENTIFIED}${message}\n` }),
    version: "1.4.4",
    activeGaps: ACTIVE_GAP,
  });
  assert.equal(tolerated.status, "passed");
  assert.equal(tolerated.exitCode, 0);
  assert.ok(
    tolerated.lines.some((line) => line.includes("every message it printed maps to a known vendor baseline gap")),
  );

  const blocking = assessPublintRun({
    resolution: { ok: true, executable: "/usr/bin/bun", found: [] },
    handshake: spawnResult({ status: 0, stdout: "1.4.4" }),
    run: spawnResult({
      status: 1,
      stdout: `${IDENTIFIED}${message}\n${JSON.stringify({ code: "FILE_MISSING", path: ["main"] })}\n`,
    }),
    version: "1.4.4",
    activeGaps: ACTIVE_GAP,
  });
  assert.equal(blocking.status, "failed");
  assert.equal(blocking.exitCode, 1);
  assert.ok(blocking.lines.at(-1).includes("FILE_MISSING"), "the blocking code is named");
});

test("the version and identity readers accept the real shapes and refuse anything else", () => {
  assert.equal(runnerVersion(spawnResult({ status: 0, stdout: "1.4.4\n" })), "1.4.4");
  assert.equal(runnerVersion(spawnResult({ status: 0, stdout: "no version here\n" })), null);
  assert.equal(
    runnerVersion(spawnResult({ status: 1, stdout: "1.4.4\n" })),
    null,
    "a failed handshake is not a version",
  );
  assert.equal(publintIdentity(spawnResult({ status: 0, stdout: IDENTIFIED })), "0.3.25");
  assert.equal(publintIdentity(spawnResult({ status: 0, stdout: "Linting...\n" })), null);
  assert.deepEqual(parsedPublintMessages(spawnResult({ status: 0, stdout: '{"code":"A"}\n{"code":"B"}\n' })), [
    { code: "A" },
    { code: "B" },
  ]);
  assert.deepEqual(parsedPublintMessages(spawnResult({ status: 0, stdout: '[{"code":"A"},{"code":"B"}]\n' })), [
    { code: "A" },
    { code: "B" },
  ]);
  assert.deepEqual(parsedPublintMessages(spawnResult({ status: 0, stdout: "All good!\n" })), []);
});
