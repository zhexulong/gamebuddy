// Tests for tools/check-production-pack-load.mjs.
//
// The borrowed packed-install pattern (from magic-context-airp's
// `smoke-tui-pack-install.ts`) exists to catch artifacts that are complete on
// disk yet fail to LOAD because a transitive module is missing from the
// published file set. The gate loads the import.meta.main-guarded bootstrap
// entry through the generation's OWN bundled runtime, so these tests stage
// fixture generations and pin:
//
//   neutral  — a complete generation passes;
//   negative — a missing bootstrap entry, a missing runtime, and a broken
//              transitive module all fail closed.
//
// The gate resolves current.json / generations relative to an injectable
// distRoot (test seam); real host/dist is never touched.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProductionPackLoad } from "./check-production-pack-load.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const realDistRoot = resolve(scriptDir, "..", "host", "dist");

let distRoot;
let nodeBin;

before(async () => {
  nodeBin = process.execPath; // system node stands in for the bundled runtime path
  distRoot = await mkdtemp(join(tmpdir(), "gb-pack-load-"));
});

after(async () => {
  await rm(distRoot, { recursive: true, force: true });
});

/** Stage a generation directory and write current.json pointing at it. */
async function stageGeneration(name, { bootstrapEntry = "", wireModule = "", runtime = true, entries = true } = {}) {
  const root = join(distRoot, "generations", name);
  if (entries) {
    await mkdir(join(root, "bootstrap", "entry"), { recursive: true });
    await mkdir(join(root, "bootstrap", "wire"), { recursive: true });
    await writeFile(join(root, "main.js"), "export const x = 1;\n", "utf8");
    await writeFile(join(root, "stardew-attachment.js"), "export const y = 2;\n", "utf8");
    await writeFile(join(root, "farmhand-companion-preview.js"), "export const z = 3;\n", "utf8");
  }
  if (bootstrapEntry) {
    await writeFile(join(root, "bootstrap", "entry", "desktop-host-entry.internal.js"), bootstrapEntry, "utf8");
  }
  if (wireModule) {
    await writeFile(join(root, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js"), wireModule, "utf8");
  }
  if (runtime) {
    await mkdir(join(root, "runtime"), { recursive: true });
    copyFileSync(nodeBin, join(root, "runtime", "node.exe"));
  }
  await writeFile(join(distRoot, "current.json"), JSON.stringify({ generation: name }), "utf8");
}

describe("check-production-pack-load", () => {
  test("blocked when current.json is missing", () => {
    const report = checkProductionPackLoad({ distRoot });
    assert.equal(report.verdict, "blocked");
    assert.ok(report.failures.some((f) => f.startsWith("pointer_missing")));
  });

  test("blocked when current.json is unreadable", async () => {
    await writeFile(join(distRoot, "current.json"), "{ nope", "utf8");
    const report = checkProductionPackLoad({ distRoot });
    assert.equal(report.verdict, "blocked");
    assert.ok(report.failures.some((f) => f.startsWith("pointer_unreadable")));
  });

  test("neutral: complete generation passes", async () => {
    await stageGeneration("g-ok", {
      wireModule: "export function runDesktopHostBootstrap() {}\n",
      bootstrapEntry:
        'import { runDesktopHostBootstrap } from "../wire/desktop-runtime-bootstrap.internal.js";\nif (import.meta.main) void runDesktopHostBootstrap();\n',
    });

    const report = checkProductionPackLoad({ distRoot });
    assert.equal(report.verdict, "passed");
    assert.equal(report.bootstrapImport.ok, true);
  });

  test("negative: bootstrap entry missing", async () => {
    await stageGeneration("g-noboot", { bootstrapEntry: "" });

    const report = checkProductionPackLoad({ distRoot });
    assert.equal(report.verdict, "blocked");
    assert.ok(report.failures.some((f) => f.startsWith("bootstrap_entry_missing")));
  });

  test("negative: bundled runtime missing", async () => {
    // Full entry set present; only the bundled runtime is absent, which must
    // fail the gate at the runtime check (not earlier at the entry check).
    await stageGeneration("g-noruntime", {
      runtime: false,
      wireModule: "export function runDesktopHostBootstrap() {}\n",
      bootstrapEntry:
        'import { runDesktopHostBootstrap } from "../wire/desktop-runtime-bootstrap.internal.js";\nif (import.meta.main) void runDesktopHostBootstrap();\n',
    });

    const report = checkProductionPackLoad({ distRoot });
    assert.equal(report.verdict, "blocked");
    assert.ok(report.failures.some((f) => f.startsWith("bundled_runtime_missing")));
  });

  test("negative: transitive module broken in the loaded closure", async () => {
    await stageGeneration("g-broken", {
      // The wire module demands a module that does not exist in the fixture
      // set — the exact packed-install bug class (missing transitive module).
      wireModule:
        'import { runDesktopHostBootstrap } from "./missing-module.internal.js";\nexport { runDesktopHostBootstrap };\n',
      bootstrapEntry:
        'import { runDesktopHostBootstrap } from "../wire/desktop-runtime-bootstrap.internal.js";\nif (import.meta.main) void runDesktopHostBootstrap();\n',
    });

    const report = checkProductionPackLoad({ distRoot });
    assert.equal(report.verdict, "blocked");
    assert.ok(report.failures.some((f) => f.startsWith("bootstrap_import_failed")));
    assert.equal(report.bootstrapImport.ok, false);
  });
});