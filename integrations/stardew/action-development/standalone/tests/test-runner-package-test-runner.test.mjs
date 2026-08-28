import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPackageTestInvocation, MAX_TEST_MODULES } from "../src/test-runner/package-test-runner.mjs";

async function withFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardew-action-test-runner-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function frozenModules(...modules) {
  return Object.freeze(modules);
}

async function writeTest(root, modulePath = "tests/valid.test.mjs") {
  const target = path.join(root, ...modulePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "throw new Error('fixture must not be imported or run by the builder');\n");
  return target;
}

test("builds an immutable direct Node invocation from explicit nested regular test files", async () => withFixture(async (root) => {
  const first = await writeTest(root, "tests/first.test.mjs");
  const second = await writeTest(root, "tests/nested/second.test.mjs");
  const modules = frozenModules("tests/first.test.mjs", "tests/nested/second.test.mjs");

  const invocation = await buildPackageTestInvocation({ packageRoot: root, testModules: modules });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ["--test", "--test-concurrency=1", first, second]);
  assert.equal(invocation.cwd, root);
  assert.equal(invocation.policy.shell, false);
  assert.equal(invocation.policy.selection, "explicit-relative-test-modules");
  assert.equal(invocation.policy.authority, "package-local-preparation");
  assert.ok(Object.isFrozen(invocation));
  assert.ok(Object.isFrozen(invocation.args));
  assert.ok(Object.isFrozen(invocation.policy));
}));

test("rejects missing and non-regular selected files", async () => withFixture(async (root) => {
  await assert.rejects(
    buildPackageTestInvocation({ packageRoot: root, testModules: frozenModules("tests/missing.test.mjs") }),
    /test_module_missing/,
  );

  await mkdir(path.join(root, "tests", "directory.test.mjs"), { recursive: true });
  await assert.rejects(
    buildPackageTestInvocation({ packageRoot: root, testModules: frozenModules("tests/directory.test.mjs") }),
    /test_module_not_regular_file/,
  );
}));

test("rejects a selected symlink instead of resolving it", async (t) => withFixture(async (root) => {
  const outside = path.join(path.dirname(root), "stardew-action-test-runner-outside.test.mjs");
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(outside, "// outside fixture\n");
  try {
    try {
      await symlink(outside, path.join(root, "tests", "linked.test.mjs"), "file");
    } catch (error) {
      if (process.platform === "win32") {
        t.skip(`file symlink unavailable on Windows: ${error?.code ?? "unknown"}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      buildPackageTestInvocation({ packageRoot: root, testModules: frozenModules("tests/linked.test.mjs") }),
      /path_link_or_reparse|test_module_outside_package/,
    );
  } finally {
    await rm(outside, { force: true });
  }
}));

test("rejects unsafe, escaping, non-test, and duplicate relative module paths", async () => withFixture(async (root) => {
  const invalidPaths = [
    "/tmp/absolute.test.mjs",
    "C:/absolute.test.mjs",
    "tests\\backslash.test.mjs",
    "tests/../escape.test.mjs",
    "outside/escape.test.mjs",
    "tests/not-a-test.js",
    "tests/./normalized.test.mjs",
    "tests//empty-segment.test.mjs",
  ];
  for (const modulePath of invalidPaths) {
    await assert.rejects(
      buildPackageTestInvocation({ packageRoot: root, testModules: frozenModules(modulePath) }),
      /invalid_test_module_path/,
      modulePath,
    );
  }

  await assert.rejects(
    buildPackageTestInvocation({ packageRoot: root, testModules: frozenModules("tests/Case.test.mjs", "tests/case.test.mjs") }),
    /duplicate_test_module/,
  );

  const tooMany = Object.freeze(Array.from({ length: MAX_TEST_MODULES + 1 }, (_, index) => `tests/test-${index}.test.mjs`));
  await assert.rejects(
    buildPackageTestInvocation({ packageRoot: root, testModules: tooMany }),
    /invalid_test_module_count/,
  );
}));

test("rejects mutable and proxy input containers", async () => withFixture(async (root) => {
  const valid = await writeTest(root);
  assert.equal(path.basename(valid), "valid.test.mjs");

  await assert.rejects(
    buildPackageTestInvocation({ packageRoot: root, testModules: ["tests/valid.test.mjs"] }),
    /test_modules_not_frozen/,
  );
  await assert.rejects(
    buildPackageTestInvocation({ packageRoot: root, testModules: new Proxy(frozenModules("tests/valid.test.mjs"), {}) }),
    /test_modules_not_frozen/,
  );
  await assert.rejects(
    buildPackageTestInvocation(new Proxy({ packageRoot: root, testModules: frozenModules("tests/valid.test.mjs") }, {})),
    /invalid_options/,
  );
}));
