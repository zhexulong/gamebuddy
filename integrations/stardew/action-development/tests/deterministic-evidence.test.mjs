import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPassedEvidence } from "@gamebuddy/game-action-devkit";
import { runDeterministicScenarioWithEvidence } from "../src/deterministic-evidence.mjs";

const identity = Object.freeze({
  gameId: "stardew",
  actionId: "equip_tool",
  runId: "evidence-run-1",
  stage: "deterministic-check",
  profileIdentity: "stardew-local-example",
  claimScope: "equip-tool-static-contract",
});

async function withEvidenceRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardew-deterministic-evidence-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("records deterministic fake success as explicitly non-live passing evidence", async () => {
  await withEvidenceRoot(async (evidenceRoot) => {
    const { bundle } = await runDeterministicScenarioWithEvidence({ identity, evidenceRoot });
    assert.equal(bundle.status, "complete");
    assert.equal(bundle.verdict, "passed");
    assert.equal(bundle.metadata.evidenceKind, "deterministic_fake_backend");
    assert.deepEqual(await readPassedEvidence({ root: evidenceRoot, identity: { gameId: identity.gameId, actionId: identity.actionId, runId: identity.runId } }), {
      schema: "gamebuddy-action-evidence/v1",
      identity: { gameId: "stardew", actionId: "equip_tool", runId: "evidence-run-1" },
      status: "complete",
      verdict: "passed",
      metadata: bundle.metadata,
    });
  });
});

test("records fake failure only as incomplete evidence that cannot pass queries", async () => {
  await withEvidenceRoot(async (evidenceRoot) => {
    await assert.rejects(runDeterministicScenarioWithEvidence({ identity, evidenceRoot, mode: "crash" }), /child_failed/);
    await assert.rejects(readPassedEvidence({ root: evidenceRoot, identity: { gameId: identity.gameId, actionId: identity.actionId, runId: identity.runId } }), /bundle_not_passing/);
  });
});
