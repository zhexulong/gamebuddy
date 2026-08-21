import test from "node:test";
import assert from "node:assert/strict";
import { fc, type Arbitrary } from "./test-support/fast-check.js";
import {
  createDomainActionPipeline,
  equipToolAction,
  tillSoilAction,
  waterCropAction,
  plantSeedAction,
  fertilizeTileAction,
  harvestCropAction,
  pickupForageAction,
  useItemAction,
  clearHoeDirtAction,
  contributeBundleAction,
  skipEventAction,
  serializeDomainActionPipeline,
  deserializeDomainActionPipeline,
  type DomainActionNode,
  type DomainActionPipeline,
} from "./action-ast.js";

/** Arbitrary generator for individual DomainActionNode items */
export function arbitraryDomainActionNode(): Arbitrary<DomainActionNode> {
  return fc.oneof<DomainActionNode>(
    fc.record({
      type: fc.constant("equip_tool" as const),
      slot: fc.integer({ min: 0, max: 11 }),
      toolName: fc.constantFrom("Hoe", "Watering Can", "Axe", "Pickaxe", "Shears", "Milk Pail"),
    }),
    fc.record({
      type: fc.constant("till_soil" as const),
      targetHandle: fc.record({ x: fc.integer({ min: 0, max: 100 }), y: fc.integer({ min: 0, max: 100 }) })
        .map(({ x, y }) => `soil:${x},${y}`),
    }),
    fc.record({
      type: fc.constant("water_crop" as const),
      targetHandle: fc.record({ x: fc.integer({ min: 0, max: 100 }), y: fc.integer({ min: 0, max: 100 }) })
        .map(({ x, y }) => `soil:${x},${y}`),
    }),
    fc.record({
      type: fc.constant("plant_seed" as const),
      slot: fc.integer({ min: 0, max: 35 }),
      targetHandle: fc.record({ x: fc.integer({ min: 0, max: 100 }), y: fc.integer({ min: 0, max: 100 }) })
        .map(({ x, y }) => `soil:${x},${y}`),
      qualifiedItemId: fc.constantFrom("(O)472", "(O)474", "(O)475"),
    }),
    fc.record({
      type: fc.constant("fertilize_tile" as const),
      slot: fc.integer({ min: 0, max: 35 }),
      targetHandle: fc.record({ x: fc.integer({ min: 0, max: 100 }), y: fc.integer({ min: 0, max: 100 }) })
        .map(({ x, y }) => `soil:${x},${y}`),
      qualifiedItemId: fc.constantFrom("(O)368", "(O)369"),
    }),
    fc.record({
      type: fc.constant("harvest_crop" as const),
      targetHandle: fc.constantFrom("crop:24,34:crop_parsnip", "crop:25,34:crop_potato", "crop:26,34:crop_cauliflower"),
      qualifiedItemId: fc.oneof(fc.constantFrom("(O)24", "(O)192", "(O)190"), fc.constant(undefined)),
    }),
    fc.record({
      type: fc.constant("pickup_forage" as const),
      targetHandle: fc.constantFrom("forage:12,14:forage_daffodil", "forage:15,18:forage_dandelion", "forage:20,22:forage_leek"),
      qualifiedItemId: fc.oneof(fc.constantFrom("(O)16", "(O)18", "(O)20"), fc.constant(undefined)),
    }),
    fc.record({
      type: fc.constant("use_item" as const),
      slot: fc.integer({ min: 0, max: 35 }),
      qualifiedItemId: fc.constantFrom("(O)16", "(O)18", "(O)20"),
    }),
    fc.record({
      type: fc.constant("clear_hoedirt" as const),
      slot: fc.integer({ min: 0, max: 11 }),
      targetHandle: fc.record({ x: fc.integer({ min: 0, max: 100 }), y: fc.integer({ min: 0, max: 100 }) })
        .map(({ x, y }) => `soil:${x},${y}`),
    }),
    fc.record({
      type: fc.constant("contribute_bundle" as const),
      bundleId: fc.constantFrom("Pantry_SpringCrops", "Boiler_Blacksmiths"),
      bundleSlot: fc.integer({ min: 0, max: 5 }),
      inventorySlot: fc.integer({ min: 0, max: 35 }),
    }),
    fc.record({
      type: fc.constant("skip_event" as const),
      eventId: fc.oneof(fc.constantFrom("event_01", "event_02", "event_03"), fc.constant(undefined)),
    }),
  );
}

/** Arbitrary generator for bounded composite DomainActionPipeline instances */
export function arbitraryDomainActionPipeline(maxLength = 8): Arbitrary<DomainActionPipeline> {
  return fc.array(arbitraryDomainActionNode(), { minLength: 1, maxLength }).map(createDomainActionPipeline);
}

test("Domain Action AST: constructs pure declarative pipelines", () => {
  const pipeline = createDomainActionPipeline([
    equipToolAction(1, "Hoe"),
    tillSoilAction("soil:24,34"),
    equipToolAction(2, "Watering Can"),
    waterCropAction("soil:24,34"),
    plantSeedAction(0, "soil:24,34", "(O)472"),
  ]);

  assert.equal(pipeline.nodes.length, 5);
  assert.equal(pipeline.nodes[0].type, "equip_tool");
  assert.equal(pipeline.nodes[1].type, "till_soil");
  assert.equal(pipeline.nodes[3].type, "water_crop");
});

test("Domain Action AST: PBT Wire Serialization Roundtrip Identity", () => {
  fc.assert(
    fc.property(arbitraryDomainActionPipeline(), (pipeline) => {
      const serialized = serializeDomainActionPipeline(pipeline, "test_pipe_01");
      assert.equal(serialized.pipelineId, "test_pipe_01");
      assert.equal(Array.isArray(serialized.steps), true);
      assert.equal(serialized.steps.length, pipeline.nodes.length);

      // Verify each step has standard wire shape { stepIndex, actionType, args }
      serialized.steps.forEach((step, idx) => {
        assert.equal(step.stepIndex, idx);
        assert.equal(typeof step.actionType, "string");
        assert.equal(typeof step.args, "object");
      });

      const deserialized = deserializeDomainActionPipeline(serialized);
      assert.deepEqual(deserialized, pipeline);

      const reserialized = serializeDomainActionPipeline(deserialized, "test_pipe_01");
      assert.deepEqual(reserialized, serialized);
    }),
    { numRuns: 100 },
  );
});

test("Domain Action AST: PBT Deserialization fails closed on non-consecutive or corrupt step indices", () => {
  fc.assert(
    fc.property(
      arbitraryDomainActionPipeline(),
      fc.integer({ min: 1, max: 10 }),
      (pipeline, corruptOffset) => {
        const serialized = serializeDomainActionPipeline(pipeline, "corrupt_test");
        const corruptSteps = serialized.steps.map((s, idx) => ({
          ...s,
          stepIndex: idx === 0 ? idx + corruptOffset : idx,
        }));
        assert.throws(
          () => deserializeDomainActionPipeline({ pipelineId: "corrupt_test", steps: corruptSteps }),
          /invalid_step_index_sequence/,
        );
      },
    ),
    { numRuns: 100 },
  );
});
