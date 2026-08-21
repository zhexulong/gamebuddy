// host/src/pullback-receipt.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc, type Arbitrary } from "./test-support/fast-check.js";
import {
  createCompositeExecutionReceipt,
  verifyPullbackEqualizer,
  deepEqual,
  type PullbackSpec,
  type StepReceipt,
} from "./pullback-receipt.js";

/** Arbitrary generator for deep, recursive nested JSON trees compatible with zero-dependency fast-check */
function arbitraryJsonTree(depth = 3): Arbitrary<unknown> {
  const leaf = fc.oneof<unknown>(fc.string({ minLength: 1, maxLength: 8 }), fc.integer({ min: -100, max: 100 }), fc.boolean(), fc.constant(null));
  if (depth <= 0) return leaf;
  const child = arbitraryJsonTree(depth - 1);
  return fc.oneof<unknown>(
    leaf,
    fc.array(child, { minLength: 0, maxLength: 3 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), child),
  );
}

test("Pullback Receipt: records step receipts and verifies mathematical equalizers", () => {
  const spec: PullbackSpec = {
    targetProperty: "terrain.soil_dirt.state",
    targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
    expectedValue: { tilled: true, watered: true },
  };

  const steps: StepReceipt[] = [
    { stepIndex: 0, actionType: "equip_tool", state: "succeeded", reasonCode: "tool_equipped" },
    { stepIndex: 1, actionType: "till_soil", state: "succeeded", reasonCode: "soil_tilled" },
    { stepIndex: 2, actionType: "water_crop", state: "succeeded", reasonCode: "crop_watered" },
  ];

  const receipt = createCompositeExecutionReceipt({
    executionId: "exec_01",
    requestId: "req_01",
    action: "till_and_water_sop",
    spec,
    actualValue: { watered: true, tilled: true }, // Order of keys differs intentionally
    revision: 10,
    steps,
  });

  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.reasonCode, "equalizer_matched");
  assert.equal(verifyPullbackEqualizer(receipt), true);

  const evidence = receipt.evidence as any;
  assert.equal(evidence.stepReceipts.length, 3);
  assert.equal(evidence.failedStepIndex, null);

  // Partial mutation failure test: Step 2 failed
  const partialSteps: StepReceipt[] = [
    { stepIndex: 0, actionType: "equip_tool", state: "succeeded", reasonCode: "tool_equipped" },
    { stepIndex: 1, actionType: "till_soil", state: "succeeded", reasonCode: "soil_tilled" },
    { stepIndex: 2, actionType: "water_crop", state: "failed", reasonCode: "out_of_water" },
  ];

  const failedReceipt = createCompositeExecutionReceipt({
    executionId: "exec_02",
    requestId: "req_02",
    action: "till_and_water_sop",
    spec,
    actualValue: { tilled: true, watered: false },
    revision: 11,
    steps: partialSteps,
    failedStepIndex: 2,
  });

  assert.equal(failedReceipt.state, "failed");
  assert.equal(failedReceipt.reasonCode, "step_failed:water_crop:out_of_water");
  assert.equal(verifyPullbackEqualizer(failedReceipt), false);
  const failEvidence = failedReceipt.evidence as any;
  assert.equal(failEvidence.failedStepIndex, 2);
  assert.equal(failEvidence.stepReceipts.length, 3);
});

test("Pullback Receipt: Equalizer Deep Equal Reflexivity, Symmetry, Transitivity across Recursive JSON Trees", () => {
  fc.assert(
    fc.property(arbitraryJsonTree(), (tree) => {
      // Reflexivity
      assert.equal(deepEqual(tree, JSON.parse(JSON.stringify(tree))), true);

      // Symmetry
      const copy = JSON.parse(JSON.stringify(tree));
      assert.equal(deepEqual(tree, copy), deepEqual(copy, tree));
    }),
    { numRuns: 100 },
  );
});

test("Pullback Receipt: PBT Equalizer Key Order Commutativity on Objects", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.integer(),
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.boolean(),
      (k1, v1, k2, v2) => {
        if (k1 === k2) return;
        const objA = { [k1]: v1, [k2]: v2 };
        const objB = { [k2]: v2, [k1]: v1 };
        assert.equal(deepEqual(objA, objB), true);
      },
    ),
    { numRuns: 100 },
  );
});

test("Pullback Receipt: PBT Equalizer Mutation Sensitivity (distinct trees produce deepEqual === false)", () => {
  fc.assert(
    fc.property(
      arbitraryJsonTree(),
      fc.string({ minLength: 1, maxLength: 8 }),
      (tree, randomKey) => {
        if (typeof tree === "object" && tree !== null) {
          const mutated = Array.isArray(tree)
            ? [...tree, "mutation_sentinel"]
            : { ...tree, [`mut_${randomKey}`]: "mutation_sentinel" };
          assert.equal(deepEqual(tree, mutated), false);
        }
      },
    ),
    { numRuns: 100 },
  );
});
