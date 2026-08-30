import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDeterministicScenario } from "../src/deterministic-scenario.mjs";

const identity = Object.freeze({
  gameId: "stardew",
  actionId: "equip_tool",
  runId: "fake-run-1",
  stage: "deterministic-check",
  profileIdentity: "stardew-local-example",
  claimScope: "equip-tool-static-contract",
});

test("runs a deterministic fake child through private result transport", async () => {
  const outcome = await runDeterministicScenario({ identity });
  assert.equal(outcome.result.verdict, "passed");
  assert.equal(outcome.result.receipt.executionId, "fake-execution");
});

for (const [mode, pattern, timeoutMs] of [
  ["crash", /child_failed/, 10_000],
  ["missing", /result_invalid/, 10_000],
  ["wrong-identity", /result_invalid/, 10_000],
  ["invalid", /result_invalid/, 10_000],
  ["hang", /child_failed/, 100],
]) {
  test(`fails closed when fake child ${mode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stardew-deterministic-result-"));
    try {
      await assert.rejects(runDeterministicScenario({ identity, mode, timeoutMs, privateResultRoot: root }), pattern);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
