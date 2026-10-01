import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordTavernUiOperationEvidence } from "./record-tavern-ui-operation-evidence.mjs";
import { MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS } from "./lib/tavern-mounted-operation-vocabulary.mjs";

const profile = {
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: ["chat.rename", "draft.save", "draft.discard"],
  operationIds: ["chat.rename", "draft.save", "draft.discard"],
  navigationItemIds: ["chat"],
};

test("records only a fully-passed declared UI operation set as the mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-ui-evidence-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    // Every declared operation must have passed; `not_applicable` is a finding,
    // not evidence. The mapping is the proof the whole mounted surface worked,
    // so a skipped operation must never be silently dropped (design/28 §7).
    await writeFile(inputPath, JSON.stringify({ profile, operations: [
      { operationId: "chat.rename", outcome: "passed" },
      { operationId: "draft.save", outcome: "passed" },
      { operationId: "draft.discard", outcome: "not_applicable" },
    ]}));
    await assert.rejects(recordTavernUiOperationEvidence({ inputPath, outputPath }), /ui_operation_not_passed|ui_operation_incomplete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The all-passed case is the only shape that produces a mapping today.
test("produces the mapping when every declared operation passed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-ui-evidence-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    await writeFile(inputPath, JSON.stringify({ profile, operations: [
      { operationId: "chat.rename", outcome: "passed" },
      { operationId: "draft.save", outcome: "passed" },
      { operationId: "draft.discard", outcome: "passed" },
    ]}));
    const result = await recordTavernUiOperationEvidence({ inputPath, outputPath });
    assert.equal(result.evidence_kind, "automation_evidence");
    assert.deepEqual(Object.keys(result.operations), ["chat.rename", "draft.save", "draft.discard"]);
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

// The test above builds its own three-operation profile, so it accepts whatever
// vocabulary the recorder happens to carry. That is how the recorder came to
// reject the profile the Host actually mounts: `ac5baeb` added the voice
// settings surface to the profile and to the release gate, the recorder kept its
// older five-entry list, and every real config failed with
// `mounted_profile_operations_invalid`. These tests compare against the
// production declaration instead of a stub.

/** The operationIds the Host declares in composeTavernManagementProfile(). */
function hostMountedOperationIds() {
  const source = readFileSync(
    new URL("../host/src/composition/desktop-presentation-admission-owner.ts", import.meta.url),
    "utf8",
  );
  const at = source.indexOf("function composeTavernManagementProfile");
  assert.notEqual(at, -1, "composeTavernManagementProfile must exist in the Host composition owner");
  const body = source.slice(at, source.indexOf("\n}", at));
  const block = /operationIds:\s*\[([\s\S]*?)\]/.exec(body);
  assert.notEqual(block, null, "the mounted profile must declare operationIds");
  return [...block[1].matchAll(/"([a-z][a-z.\-]+)"/g)].map((m) => m[1]);
}

test("accepts the operation ids the Host actually mounts", async () => {
  const mounted = hostMountedOperationIds();
  assert.ok(mounted.length >= 8, `expected the mounted profile to declare its operations, got ${mounted.length}`);
  assert.deepEqual(
    [...MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS].sort(),
    [...mounted].sort(),
    "the shared vocabulary must equal the Host's mounted operationIds; a mismatch means the recorder or the gate will reject real evidence",
  );

  const root = await mkdtemp(join(tmpdir(), "tavern-ui-evidence-"));
  try {
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "mapping.json");
    await writeFile(inputPath, JSON.stringify({
      profile: {
        profileId: "gamebuddy.tavern-management.chat-list-title",
        releaseTier: "tavern_management",
        routeIds: mounted,
        operationIds: mounted,
        navigationItemIds: ["chat", "memory"],
      },
      operations: mounted.map((operationId) => ({ operationId, outcome: "passed" })),
    }));
    const result = await recordTavernUiOperationEvidence({ inputPath, outputPath });
    assert.deepEqual(Object.keys(result.operations).sort(), [...mounted].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
