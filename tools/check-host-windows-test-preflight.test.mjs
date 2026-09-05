import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkHostWindowsTestPreflight,
  inspectPosixFixtureParents,
  inspectWindowsNegativeDefaults,
} from "./check-host-windows-test-preflight.mjs";

const scriptPath = "host/scripts/run-test-suite.test.mjs";

test("detects only direct POSIX mkdtemp parents", () => {
  const source = [
    "mkdtemp('/tmp/direct-');",
    "mkdtemp(join('/tmp', 'joined-'));",
    "mkdtemp(resolve('/tmp', 'resolved-'));",
    "mkdtemp(`/tmp/template-`);",
    "const parent = '/tmp'; mkdtemp(join(parent, 'alias-'));",
    "const expected = '/tmp'; assert.equal(actual, expected);",
    "const dynamic = `/tmp/${suffix}`; mkdtemp(join(dynamic, 'dynamic-'));",
    "mkdtemp(join(dynamicParent, 'dynamic-'));",
    "// mkdtemp('/tmp/comment-')",
  ].join("\n");
  assert.deepEqual(
    inspectPosixFixtureParents("host/src/example.test.ts", source).map((violation) => violation.line),
    [1, 2, 3, 4, 5],
  );
});

test("requires an explicit non-undefined Bun override only for registered Windows negative assertions", () => {
  const source = [
    "assert.throws(() => testDependencyInvocations({ platform: 'win32' }), /failure/);",
    "assert.throws(() => testDependencyInvocations({ platform: 'win32', bunExecutable: undefined }), /failure/);",
    "assert.throws(() => testDependencyInvocations({ platform: 'win32', bunExecutable: '' }), /failure/);",
    "testDependencyInvocations({ platform: 'win32' });",
  ].join("\n");
  assert.deepEqual(
    inspectWindowsNegativeDefaults(scriptPath, source).map((violation) => violation.line),
    [1, 2],
  );
});

test("produces the frozen deterministic report for regular test sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-windows-preflight-"));
  try {
    await mkdir(join(root, "host/scripts"), { recursive: true });
    await mkdir(join(root, "host/src"), { recursive: true });
    await writeFile(
      join(root, scriptPath),
      "assert.throws(() => testDependencyInvocations({ platform: 'win32' }), /failure/);\n",
    );
    await writeFile(join(root, "host/src/example.test.ts"), "mkdtemp(join('/tmp', 'fixture-'));\n");
    await writeFile(join(root, "host/src/ignored.ts"), "mkdtemp('/tmp/ignored-');\n");
    const report = await checkHostWindowsTestPreflight({ root });
    assert.deepEqual(report, {
      gate: "host_windows_test_preflight/v1",
      verdict: "blocked",
      inspectedFiles: [scriptPath, "host/src/example.test.ts"],
      violations: [
        { path: scriptPath, line: 1, code: "negative_env_default_not_overridden" },
        { path: "host/src/example.test.ts", line: 1, code: "posix_fixture_parent_on_windows" },
      ],
    });
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
