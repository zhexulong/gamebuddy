import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeMechanismReviewRegister } from "./lib/stardew-native-mechanism-review-register.mjs";
const report = {
  schemaVersion: 1, artifactKind: "native_interaction_mechanism_enumeration",
  target: { sha256: "a".repeat(64) }, source: { sourceManifestSha256: "b".repeat(64), files: [{ relativePath: "Fixture.cs", sha256: "d".repeat(64), byteLength: 1 }] },
  enumeration: { mechanisms: [
    { mechanismId: "host:root", sourceLocator: { relativePath: "Fixture.cs", startByte: 0, endByte: 1, sliceSha256: "a".repeat(64) } },
    { mechanismId: "content:match", sourceLocator: { relativePath: "Fixture.cs", startByte: 1, endByte: 2, sliceSha256: "b".repeat(64) } },
    { mechanismId: "syntax:incidental", sourceLocator: { relativePath: "Fixture.cs", startByte: 2, endByte: 3, sliceSha256: "c".repeat(64) } },
  ] },
};
function register(overrides = {}) { return {
  schemaVersion: 1, artifactKind: "native_interaction_mechanism_review_register",
  attestation: { targetAssemblySha256: "a".repeat(64), sourceManifestSha256: "b".repeat(64) },
  records: [
    { mechanismId: "host:root", disposition: "in_scope_root", reason: "Exact root declaration requires Stage-2 ownership review.", possiblyGameplayBearing: true },
    { mechanismId: "content:match", disposition: "unresolved_gap", reason: "Dynamic content receiver is not yet resolved.", possiblyGameplayBearing: true },
    { mechanismId: "syntax:incidental", disposition: "not_a_mechanism", reason: "Exact source review shows this syntax match is incidental.", sourceReasonLocator: { relativePath: "Fixture.cs", startByte: 2, endByte: 3, sliceSha256: "c".repeat(64) }, possiblyGameplayBearing: false },
  ],
  ...overrides,
}; }
test("requires exactly one non-semantic disposition for every exact discovered mechanism", () => {
  assert.deepEqual(validateNativeMechanismReviewRegister(register(), { mechanismReport: report }), { mechanismCount: 3, recordCount: 3, unresolvedCount: 1, inScopeMechanismIds: ["host:root"], dispositionByMechanismId: { "host:root": "in_scope_root", "content:match": "unresolved_gap", "syntax:incidental": "not_a_mechanism" } });
  const missing = register(); missing.records.pop();
  assert.throws(() => validateNativeMechanismReviewRegister(missing, { mechanismReport: report }), { code: "mechanism_review_register_unreviewed" });
  const duplicate = register(); duplicate.records.push({ ...duplicate.records[0] });
  assert.throws(() => validateNativeMechanismReviewRegister(duplicate, { mechanismReport: report }), { code: "mechanism_review_register_duplicate" });
});
test("prevents gap laundering and premature product vocabulary", () => {
  const laundering = register(); laundering.records[1].possiblyGameplayBearing = false;
  assert.throws(() => validateNativeMechanismReviewRegister(laundering, { mechanismReport: report }), { code: "mechanism_review_register_gap_must_block" });
  const premature = register({ primitiveId: "forbidden" });
  assert.throws(() => validateNativeMechanismReviewRegister(premature, { mechanismReport: report }), { code: "mechanism_review_register_forbidden_field" });
  const stale = register(); stale.attestation.targetAssemblySha256 = "c".repeat(64);
  assert.throws(() => validateNativeMechanismReviewRegister(stale, { mechanismReport: report }), { code: "mechanism_review_register_attestation_mismatch" });
});
