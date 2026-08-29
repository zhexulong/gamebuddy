import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LIFECYCLE_PHASE_RESULT_SCHEMA,
  serializeLifecycleCleanupResult,
  serializeLifecyclePhaseResult,
  writeLifecycleCleanupResult,
  writeLifecyclePhaseResult,
} from "../src/write-lifecycle-result.mjs";

test("lifecycle cleanup result is bounded and content-free", () => {
  assert.equal(
    serializeLifecycleCleanupResult({ completed: true }),
    '{"schema":"gamebuddy-stardew-lifecycle-cleanup-result/v1","completed":true}',
  );
  assert.throws(() => serializeLifecycleCleanupResult({ completed: "yes" }), /completed_invalid/);
});

test("lifecycle phase result is bounded and content-free", () => {
  assert.deepEqual(JSON.parse(serializeLifecyclePhaseResult({ phase: "fixture_prepare", code: "failed" })), {
    schema: LIFECYCLE_PHASE_RESULT_SCHEMA,
    phase: "fixture_prepare",
    code: "failed",
  });
  assert.throws(() => serializeLifecyclePhaseResult({ phase: "private_path", code: "failed" }), /phase_result_invalid/);
  assert.throws(() => serializeLifecyclePhaseResult({ phase: "fixture_prepare", code: "raw_detail" }), /phase_result_invalid/);
});

test("lifecycle cleanup result requires a fresh absolute private file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "equip-lifecycle-result-"));
  try {
    const resultFile = path.join(root, "cleanup.json");
    await writeLifecycleCleanupResult(resultFile, { completed: true });
    assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), {
      schema: "gamebuddy-stardew-lifecycle-cleanup-result/v1",
      completed: true,
    });
    await assert.rejects(writeLifecycleCleanupResult(resultFile, { completed: true }), /EEXIST/);
    const phaseFile = path.join(root, "phase.json");
    await writeLifecyclePhaseResult(phaseFile, { phase: "live_child", code: "failed" });
    assert.deepEqual(JSON.parse(await readFile(phaseFile, "utf8")), {
      schema: LIFECYCLE_PHASE_RESULT_SCHEMA,
      phase: "live_child",
      code: "failed",
    });
    await assert.rejects(writeLifecycleCleanupResult("relative.json", { completed: true }), /path_not_absolute/);
    const occupied = path.join(root, "occupied");
    await writeFile(occupied, "not a directory");
    await assert.rejects(writeLifecycleCleanupResult(path.join(occupied, "result.json"), { completed: true }));
  } finally {
    for (const leaf of ["cleanup.json", "phase.json", "occupied"]) {
      await unlink(path.join(root, leaf)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await rmdir(root);
  }
});
