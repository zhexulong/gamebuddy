import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertStardewDecompileRoot,
  resolveStardewDecompileRoot,
  STARDEW_DECOMPILE_ROOT_ENV,
  STARDEW_DECOMPILE_ROOT_RELATIVE_PATH,
  STARDEW_DECOMPILER_VERSION,
  StardewDecompileRootMissingError,
} from "./stardew-decompile-root.mjs";

/**
 * The guard exists so that "I could not look" can never read as "there is nothing". These
 * tests pin the two halves of that contract: a usable tree resolves, and every unusable tree
 * (absent, a file, empty) throws with the exact path it looked for and the restore recipe.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANONICAL_ROOT = path.join(REPO_ROOT, ...STARDEW_DECOMPILE_ROOT_RELATIVE_PATH.split("/"));

function withTempRepo(build) {
  const dir = mkdtempSync(path.join(tmpdir(), "stardew-decompile-root-"));
  try {
    build(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

test("resolves the committed decompiled tree when it is present", () => {
  assert.equal(resolveStardewDecompileRoot({ repositoryRoot: REPO_ROOT, env: {} }), CANONICAL_ROOT);
});

test("fails closed, naming the path and the restore recipe, when the root is absent", () => {
  const repo = withTempRepo(() => {});
  try {
    assert.throws(
      () => resolveStardewDecompileRoot({ repositoryRoot: repo, env: {} }),
      (error) => {
        assert.ok(error instanceof StardewDecompileRootMissingError);
        assert.equal(error.code, "stardew_decompile_root_missing");
        assert.equal(error.root, path.join(repo, ...STARDEW_DECOMPILE_ROOT_RELATIVE_PATH.split("/")));
        assert.ok(error.message.includes(error.root), "the message names the exact path it looked for");
        assert.ok(error.message.includes(STARDEW_DECOMPILER_VERSION), "the message names the pinned decompiler");
        assert.match(error.message, /gitignored/);
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fails closed when the root exists but holds no decompiled source", () => {
  const repo = withTempRepo((dir) =>
    mkdirSync(path.join(dir, ...STARDEW_DECOMPILE_ROOT_RELATIVE_PATH.split("/")), { recursive: true }),
  );
  try {
    assert.throws(() => resolveStardewDecompileRoot({ repositoryRoot: repo, env: {} }), {
      code: "stardew_decompile_root_missing",
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fails closed when the root path is a file rather than a directory", () => {
  const repo = withTempRepo((dir) => writeFileSync(path.join(dir, "not-a-tree"), "", "utf8"));
  try {
    assert.throws(
      () => assertStardewDecompileRoot(path.join(repo, "not-a-tree")),
      { code: "stardew_decompile_root_missing" },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an explicit root wins over the environment and is verified the same way", () => {
  const repo = withTempRepo((dir) => {
    const nested = path.join(dir, "custom", "StardewValley");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "Game1.cs"), "namespace StardewValley { internal class Game1 {} }\n", "utf8");
  });
  try {
    const explicit = resolveStardewDecompileRoot({ repositoryRoot: repo, root: "custom", env: {} });
    assert.equal(explicit, path.join(repo, "custom"));
    assert.equal(
      resolveStardewDecompileRoot({ repositoryRoot: repo, env: { [STARDEW_DECOMPILE_ROOT_ENV]: "custom" } }),
      explicit,
    );
    assert.throws(
      () =>
        resolveStardewDecompileRoot({
          repositoryRoot: repo,
          root: "missing",
          env: { [STARDEW_DECOMPILE_ROOT_ENV]: "custom" },
        }),
      { code: "stardew_decompile_root_missing" },
      "an explicit root must still be verified, not trusted",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("assertStardewDecompileRoot returns the usable root unchanged", () => {
  assert.equal(assertStardewDecompileRoot(CANONICAL_ROOT), CANONICAL_ROOT);
  assert.throws(() => assertStardewDecompileRoot(""), { code: "stardew_decompile_root_missing" });
});
