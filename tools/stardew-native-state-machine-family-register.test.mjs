import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeStateMachineFamilyRegister } from "./lib/stardew-native-state-machine-family-register.mjs";
const text = `void Input() { Owner(); Dynamic(); } void Owner() { state = 1; }`,
  bytes = Buffer.from(text),
  h = createHash("sha256").update(bytes).digest("hex");
const anchor = (part) => {
  const startByte = bytes.indexOf(Buffer.from(part)),
    endByte = startByte + Buffer.byteLength(part);
  return {
    relativePath: "Game.cs",
    startByte,
    endByte,
    sliceSha256: createHash("sha256").update(bytes.subarray(startByte, endByte)).digest("hex"),
    sourceFileSha256: h,
  };
};
const sourceFiles = { "Game.cs": { text, sha256: h } };
const complete = () => ({
  schemaVersion: 1,
  artifactKind: "native_state_machine_family_register",
  families: [
    {
      familyId: "source-family:tool-lifecycle",
      familyKind: "input_lifecycle",
      coverageState: "partial_with_blocking_gaps",
      steps: [
        { sequence: 0, kind: "ingress", ownerSyntax: "Input", anchor: anchor("void Input() { Owner(); Dynamic(); }") },
        { sequence: 1, kind: "source_owner", ownerSyntax: "Owner", anchor: anchor("void Owner() { state = 1; }") },
        {
          sequence: 2,
          kind: "unresolved_gap",
          ownerSyntax: "Dynamic",
          anchor: anchor("Dynamic();"),
          gapId: "gap:dynamic",
          possiblyGameplayBearing: true,
        },
      ],
    },
  ],
});
test("accepts a source-attested family slice while retaining a blocking dynamic edge", () => {
  const result = validateNativeStateMachineFamilyRegister(complete(), { sourceFiles });
  assert.equal(result.familyCount, 1);
  assert.equal(result.blockingGapCount, 1);
});
test("fails closed for omitted partial-family gap, stale anchor, and missing owner", () => {
  const missing = complete();
  missing.families[0].steps.pop();
  assert.throws(() => validateNativeStateMachineFamilyRegister(missing, { sourceFiles }), {
    code: "state_machine_family_gap_missing",
  });
  const stale = complete();
  stale.families[0].steps[0].anchor.sliceSha256 = "0".repeat(64);
  assert.throws(() => validateNativeStateMachineFamilyRegister(stale, { sourceFiles }), {
    code: "state_machine_family_anchor_stale",
  });
  const owner = complete();
  owner.families[0].steps[1].ownerSyntax = "Absent";
  assert.throws(() => validateNativeStateMachineFamilyRegister(owner, { sourceFiles }), {
    code: "state_machine_family_owner_unproven",
  });
});
test("forbids action/primitive vocabulary", () => {
  const value = complete();
  value.families[0].primitiveId = "no";
  assert.throws(() => validateNativeStateMachineFamilyRegister(value, { sourceFiles }), {
    code: "state_machine_family_forbidden_field",
  });
});
test("fails closed for non-neutral identities and a gap hidden in an exact slice", () => {
  const family = complete();
  family.families[0].familyId = "tool-lifecycle";
  assert.throws(() => validateNativeStateMachineFamilyRegister(family, { sourceFiles }), {
    code: "state_machine_family_id_invalid",
  });
  const gap = complete();
  gap.families[0].steps.at(-1).gapId = "unfinished";
  assert.throws(() => validateNativeStateMachineFamilyRegister(gap, { sourceFiles }), {
    code: "state_machine_family_gap_invalid",
  });
  const slice = complete();
  slice.families[0].coverageState = "exact_source_slice_only";
  assert.throws(() => validateNativeStateMachineFamilyRegister(slice, { sourceFiles }), {
    code: "state_machine_family_slice_gap_invalid",
  });
});
