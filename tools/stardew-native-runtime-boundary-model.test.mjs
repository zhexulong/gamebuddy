import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeBoundaryModelDigest,
  validateNativeRuntimeBoundaryModel,
  validateToolContentRuntimeRecord,
} from "./lib/stardew-native-runtime-boundary-model.mjs";

const hash = (letter) => letter.repeat(64);
function model(boundary = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "native_runtime_boundary_model",
    attestation: { targetAssemblySha256: hash("a"), contentManifestSha256: hash("b") },
    boundaries: [
      {
        boundaryId: "boundary:tool-data",
        disposition: "runtime_modeled",
        kind: "runtime_content_snapshot",
        runtimeRecordSha256: hash("c"),
        ...boundary,
      },
    ],
  };
}

test("accepts only version-locked runtime boundary records", () => {
  const value = model();
  const result = validateNativeRuntimeBoundaryModel(value, {
    targetAssemblySha256: hash("a"),
    contentManifestSha256: hash("b"),
  });
  assert.equal(result.boundaryCount, 1);
  assert.equal(result.modelSha256, runtimeBoundaryModelDigest(value));
});

test("rejects forged attestations, incomplete runtime proof, and product vocabulary", () => {
  assert.throws(
    () => validateNativeRuntimeBoundaryModel(model(), { targetAssemblySha256: hash("d") }),
    /target assembly/,
  );
  assert.throws(() => validateNativeRuntimeBoundaryModel(model({ runtimeRecordSha256: undefined })), /runtime record/);
  const invalid = model();
  invalid.boundaries[0].primitiveId = "bad";
  assert.throws(() => validateNativeRuntimeBoundaryModel(invalid), /forbidden/);
});

test("validates a complete redacted tool content record by its canonical digest", () => {
  const record = {
    state: "loaded",
    digest: "",
    entries: [{ itemId: "Axe", className: "Axe", upgradeLevel: 0, instantUse: false, attachmentSlots: -1 }],
  };
  record.digest = "3dfb54875d8527470218d7b1ddcd5cc553d38231f63f9043ba4d24bc05cbe4b1";
  assert.equal(
    validateToolContentRuntimeRecord(record, { targetAssemblySha256: hash("a"), contentManifestSha256: hash("b") })
      .toolCount,
    1,
  );
  record.entries[0].className = "Hoe";
  assert.throws(
    () =>
      validateToolContentRuntimeRecord(record, { targetAssemblySha256: hash("a"), contentManifestSha256: hash("b") }),
    /digest/,
  );
});

test("requires approval material for an explicit scope boundary", () => {
  const value = model({
    disposition: "approved_scope_boundary",
    kind: "approved_scope_exclusion",
    runtimeRecordSha256: undefined,
    scopeReason: "topology does not expose this route",
    approvalRecordSha256: hash("d"),
  });
  assert.equal(validateNativeRuntimeBoundaryModel(value).boundaryCount, 1);
  delete value.boundaries[0].approvalRecordSha256;
  assert.throws(() => validateNativeRuntimeBoundaryModel(value), /approval/);
});
