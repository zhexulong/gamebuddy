import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordTavernUiOperationEvidence } from "./record-tavern-ui-operation-evidence.mjs";

const profile = {
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: ["chat.rename", "draft.save", "draft.discard"],
  operationIds: ["chat.rename", "draft.save", "draft.discard"],
  navigationItemIds: ["chat"],
};

test("records only passed declared UI operations as content-free mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-ui-evidence-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    await writeFile(inputPath, JSON.stringify({ profile, operations: [
      { operationId: "chat.rename", outcome: "passed" },
      { operationId: "draft.save", outcome: "passed" },
      { operationId: "draft.discard", outcome: "not_applicable" },
    ]}));
    const result = await recordTavernUiOperationEvidence({ inputPath, outputPath });
    assert.equal(result.evidence_kind, "automation_evidence");
    assert.deepEqual(Object.keys(result.operations), ["chat.rename", "draft.save"]);
    assert.match(result.operations["chat.rename"][0], /^[a-f0-9]{48}$/);
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(written, result);
    assert.equal(Object.hasOwn(written, "title"), false);
    assert.equal(Object.hasOwn(written, "content"), false);
    assert.equal(Object.hasOwn(written, "operator_id"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects undeclared and duplicate UI operation outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-ui-evidence-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    await writeFile(inputPath, JSON.stringify({ profile, operations: [
      { operationId: "chat.rename", outcome: "passed" },
      { operationId: "chat.rename", outcome: "passed" },
    ]}));
    await assert.rejects(recordTavernUiOperationEvidence({ inputPath, outputPath }), /ui_operation_outcome_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
