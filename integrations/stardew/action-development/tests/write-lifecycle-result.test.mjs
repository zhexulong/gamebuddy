import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA,
  serializeStardewClosureBackendResult,
  writeStardewClosureBackendResult,
} from "../src/write-lifecycle-result.mjs";

test("completed lifecycle result is exact and content-free", () => {
  assert.equal(
    serializeStardewClosureBackendResult({ state: "completed" }),
    '{"schema":"gamebuddy-stardew-closure-backend-result/v1","state":"completed"}',
  );
});

test("failed lifecycle result carries exactly phase and bounded code", () => {
  assert.deepEqual(
    JSON.parse(serializeStardewClosureBackendResult({ state: "failed", phase: "fixture_prepare", code: "failed" })),
    { schema: STARDEW_CLOSURE_BACKEND_RESULT_SCHEMA, state: "failed", phase: "fixture_prepare", code: "failed" },
  );
});

test("serializer rejects completed with phase/code and failed with invalid phase/code", () => {
  assert.throws(
    () => serializeStardewClosureBackendResult({ state: "completed", phase: "fixture_prepare" }),
    /stardew_closure_backend_result_invalid/,
  );
  assert.throws(
    () => serializeStardewClosureBackendResult({ state: "completed", code: "failed" }),
    /stardew_closure_backend_result_invalid/,
  );
  assert.throws(
    () => serializeStardewClosureBackendResult({ state: "failed", phase: "private_path", code: "failed" }),
    /stardew_closure_backend_result_invalid/,
  );
  assert.throws(
    () => serializeStardewClosureBackendResult({ state: "failed", phase: "fixture_prepare", code: "raw_detail" }),
    /stardew_closure_backend_result_invalid/,
  );
  assert.throws(() => serializeStardewClosureBackendResult({ state: "unknown" }), /stardew_closure_backend_result_invalid/);
});

test("writer requires a fresh absolute private file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "equip-lifecycle-result-"));
  try {
    const resultFile = path.join(root, "result.json");
    await writeStardewClosureBackendResult(resultFile, { state: "completed" });
    assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), {
      schema: "gamebuddy-stardew-closure-backend-result/v1",
      state: "completed",
    });
    await assert.rejects(writeStardewClosureBackendResult(resultFile, { state: "completed" }), /EEXIST/);
    await assert.rejects(writeStardewClosureBackendResult("relative.json", { state: "completed" }), /path_not_absolute/);
    const occupied = path.join(root, "occupied");
    await writeFile(occupied, "not a directory");
    await assert.rejects(writeStardewClosureBackendResult(path.join(occupied, "result.json"), { state: "completed" }));
  } finally {
    for (const leaf of ["result.json", "occupied"]) {
      await unlink(path.join(root, leaf)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await rmdir(root);
  }
});