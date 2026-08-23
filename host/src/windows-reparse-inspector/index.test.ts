import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoWindowsReparse,
  createBuildWindowsReparseInspector,
  createPublishedWindowsReparseInspector,
  inspectWindowsReparse,
} from "./index.js";
import { createTestWindowsReparseInspector } from "./index.test-support.js";

async function fixture(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-reparse-test-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("inspectWindowsReparse returns regular for regular files and directories", async () => {
  const item = await fixture();
  try {
    const filePath = join(item.root, "file.txt");
    const dirPath = join(item.root, "subdir");
    await writeFile(filePath, "test", "utf8");
    await mkdir(dirPath);

    const capability = await createBuildWindowsReparseInspector();
    assert.equal(await inspectWindowsReparse(capability, filePath), "regular");
    assert.equal(await inspectWindowsReparse(capability, dirPath), "regular");
    await assertNoWindowsReparse(capability, filePath);
    await assertNoWindowsReparse(capability, dirPath);
  } finally {
    await item.dispose();
  }
});

test("inspectWindowsReparse returns reparse for symbolic links", async (t) => {
  const item = await fixture();
  try {
    const targetPath = join(item.root, "target.txt");
    const linkPath = join(item.root, "link.txt");
    await writeFile(targetPath, "target content", "utf8");
    try {
      await symlink(targetPath, linkPath, "file");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        t.skip("symbolic links are not permitted in this environment");
        return;
      }
      throw error;
    }

    const capability = await createBuildWindowsReparseInspector();
    assert.equal(await inspectWindowsReparse(capability, linkPath), "reparse");
    await assert.rejects(
      assertNoWindowsReparse(capability, linkPath),
      /windows_reparse_inspection_unavailable/,
    );
  } finally {
    await item.dispose();
  }
});

test("inspectWindowsReparse rejects missing paths, invalid capabilities, and relative paths", async () => {
  const item = await fixture();
  try {
    const capability = await createBuildWindowsReparseInspector();
    await assert.rejects(
      inspectWindowsReparse(capability, join(item.root, "non-existent.txt")),
      /windows_reparse_inspection_unavailable/,
    );
    await assert.rejects(
      inspectWindowsReparse(undefined, join(item.root, "file.txt")),
      /windows_reparse_inspection_unavailable/,
    );
    await assert.rejects(
      inspectWindowsReparse(capability, "relative/path.txt"),
      /windows_reparse_inspection_unavailable/,
    );
  } finally {
    await item.dispose();
  }
});

test("createPublishedWindowsReparseInspector creates capability with absolute path and rejects relative path", async () => {
  const item = await fixture();
  try {
    const capability = await createPublishedWindowsReparseInspector(item.root);
    assert.ok(capability);
    await assert.rejects(
      createPublishedWindowsReparseInspector("relative/path"),
      /windows_reparse_inspection_unavailable/,
    );
  } finally {
    await item.dispose();
  }
});

test("createTestWindowsReparseInspector supports custom inspection behavior", async () => {
  const reparseCapability = createTestWindowsReparseInspector(() => "reparse");
  assert.equal(await inspectWindowsReparse(reparseCapability, "/mock/path"), "reparse");
  await assert.rejects(
    assertNoWindowsReparse(reparseCapability, "/mock/path"),
    /windows_reparse_inspection_unavailable/,
  );

  const errorCapability = createTestWindowsReparseInspector(() => {
    throw new Error("fail");
  });
  await assert.rejects(
    inspectWindowsReparse(errorCapability, "/mock/path"),
    /windows_reparse_inspection_unavailable/,
  );
});

test("public policy entry does not expose test-only capability minting", async () => {
  const source = await readFile(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "src", "windows-reparse-inspector", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /__testOnly|test-support/);
});
