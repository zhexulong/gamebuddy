import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  fileURLToPath(new URL("../host/scripts/build-desktop-launcher-test-generation.mjs", import.meta.url)),
);

/**
 * Run the fixture-generation script against a fixture directory and capture the
 * failure. The script always fails before the publisher step for the cases here,
 * so no Guardian build or network access happens.
 *
 * @param {string} fixtureRoot
 * @returns {Promise<{code: number, stderr: string}>}
 */
function runGeneration(fixtureRoot) {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, join(tmpdir(), `gen-out-${Date.now()}`), fixtureRoot],
      { cwd: resolve(SCRIPT, "../..") },
      (error, _stdout, stderr) => {
        resolvePromise({ code: error?.code ?? 0, stderr: String(stderr) });
      },
    );
    child.on("error", () => resolvePromise({ code: -1, stderr: "spawn_failed" }));
  });
}

test("a framework-dependent fixture is refused by name, not as an opaque timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-apphost-"));
  try {
    await writeFile(join(root, "node.exe"), "stub");
    // A sibling node.dll is exactly what an apphost publish emits when the AOT
    // toolchain (MSVC link.exe) is unavailable. Accepting it produced a
    // generation whose single runtime file could not start, so the child never
    // connected to the bootstrap pipe and the supervisor reported a bare
    // host_runtime_unavailable after ~74s. The cause must be the message.
    await writeFile(join(root, "node.dll"), "stub");
    const { code, stderr } = await runGeneration(root);
    assert.notEqual(code, 0, "a non-self-contained fixture must fail the generation");
    assert.match(stderr, /desktop_launcher_test_fixture_not_self_contained/);
    assert.match(stderr, /node\.dll is present beside node\.exe/);
    assert.match(stderr, /MSVC/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fixture directory without node.exe is refused by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-empty-"));
  try {
    const { code, stderr } = await runGeneration(root);
    assert.notEqual(code, 0);
    assert.match(stderr, /desktop_launcher_test_fixture_node_missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
