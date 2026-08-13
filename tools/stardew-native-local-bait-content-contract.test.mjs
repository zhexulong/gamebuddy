import assert from "node:assert/strict";
import test from "node:test";
import { BAIT_CONTRACT, validateBaitProbe } from "./stardew-native-local-bait-content-contract.mjs";

test("bait content contract accepts only the pinned target-version object datum", () => {
  const probe = { objectsContent: { state: "loaded", digest: BAIT_CONTRACT.expectedObjectsDigest, entries: [{ itemId: "685", name: "Bait", category: -21, type: "Basic", unknownFields: [] }] } };
  assert.equal(validateBaitProbe(probe), null);
});
test("bait content contract fails closed for hash-derived digest or semantic drift", () => {
  const valid = { state: "loaded", digest: BAIT_CONTRACT.expectedObjectsDigest, entries: [{ itemId: "685", name: "Bait", category: -21, type: "Basic", unknownFields: [] }] };
  assert.equal(validateBaitProbe({ objectsContent: { ...valid, digest: "changed" } }), "objects_content_probe_invalid");
  assert.equal(validateBaitProbe({ objectsContent: { ...valid, entries: [{ ...valid.entries[0], category: -20 }] } }), "bait_content_contract_mismatch");
});
