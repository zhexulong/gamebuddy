import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeTransitionFamilyUniverse } from "./lib/stardew-native-transition-family-universe.mjs";
const text = "void Input() { Owner(); Dynamic(); } void Owner() { state = 1; }";
const bytes = Buffer.from(text);
const fileSha = createHash("sha256").update(bytes).digest("hex");
const anchor = (needle) => {
  const startByte = bytes.indexOf(Buffer.from(needle));
  const endByte = startByte + Buffer.byteLength(needle);
  return {
    relativePath: "Game.cs",
    startByte,
    endByte,
    sliceSha256: createHash("sha256").update(bytes.subarray(startByte, endByte)).digest("hex"),
    sourceFileSha256: fileSha,
  };
};
const sourceFiles = { "Game.cs": { text, sha256: fileSha } };
const complete = () => ({
  schemaVersion: 1,
  artifactKind: "native_transition_family_universe",
  families: [
    {
      familyId: "source-family:input-router",
      familyKind: "input_lifecycle",
      regions: [
        {
          regionId: "region:input-router",
          ownerAnchor: anchor("void Input() { Owner(); Dynamic(); }"),
          exits: [
            { exitId: "exit:owner-handoff", exitKind: "direct_handoff", anchor: anchor("Owner();") },
            { exitId: "exit:dynamic-handoff", exitKind: "polymorphic_handoff", anchor: anchor("Dynamic();") },
          ],
        },
      ],
      gaps: [{ gapId: "gap:dynamic-handler", anchor: anchor("Dynamic();"), possiblyGameplayBearing: true }],
    },
  ],
});
test("accepts a source-attested partial transition family without inferring a transition identity", () => {
  const result = validateNativeTransitionFamilyUniverse(complete(), { sourceFiles });
  assert.equal(result.familyCount, 1);
  assert.equal(result.closureState, "partial_with_blocking_gaps");
  assert.equal(result.analysisBoundary.transitionIdentity, "not_derived");
});
test("fails closed for unanchored owner, missing exits, or a removed gameplay gap", () => {
  const stale = complete();
  stale.families[0].regions[0].ownerAnchor.sliceSha256 = "0".repeat(64);
  assert.throws(() => validateNativeTransitionFamilyUniverse(stale, { sourceFiles }), {
    code: "transition_family_universe_anchor_stale",
  });
  const exits = complete();
  exits.families[0].regions[0].exits = [];
  assert.throws(() => validateNativeTransitionFamilyUniverse(exits, { sourceFiles }), {
    code: "transition_family_universe_exits_missing",
  });
  const gap = complete();
  gap.families[0].gaps = [];
  assert.throws(() => validateNativeTransitionFamilyUniverse(gap, { sourceFiles }), {
    code: "transition_family_universe_gaps_missing",
  });
});
test("forbids product vocabulary and non-neutral family identities", () => {
  const product = complete();
  product.families[0].actionId = "no";
  assert.throws(() => validateNativeTransitionFamilyUniverse(product, { sourceFiles }), {
    code: "transition_family_universe_forbidden_field",
  });
  const id = complete();
  id.families[0].familyId = "input-router";
  assert.throws(() => validateNativeTransitionFamilyUniverse(id, { sourceFiles }), {
    code: "transition_family_universe_id_invalid",
  });
});
test("schema v2 requires exact target, source, and content attestations", () => {
  const v2 = complete();
  v2.schemaVersion = 2;
  v2.attestation = {
    targetAssemblySha256: "a".repeat(64),
    sourceManifestSha256: "b".repeat(64),
    contentManifestSha256: "c".repeat(64),
  };
  assert.equal(validateNativeTransitionFamilyUniverse(v2, { sourceFiles }).familyCount, 1);
  delete v2.attestation.contentManifestSha256;
  assert.throws(() => validateNativeTransitionFamilyUniverse(v2, { sourceFiles }), {
    code: "transition_family_universe_attestation_invalid",
  });
});
