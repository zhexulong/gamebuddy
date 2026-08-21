// host/src/action-preflight-interpreter.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  createDomainActionPipeline,
  equipToolAction,
  tillSoilAction,
  waterCropAction,
  plantSeedAction,
  pickupForageAction,
  clearHoeDirtAction,
  type DomainActionNode,
} from "./action-ast.js";
import {
  interpretPreflight,
  snapshotToPreflightState,
  type PreflightSnapshot,
} from "./action-preflight-interpreter.js";
import type { Snapshot } from "./protocol.js";

test("Domain Action Preflight: evaluates handles, stamina, and tool slots with stateful simulation", () => {
  const snapshot: PreflightSnapshot = {
    currentLocation: "Farm",
    playerStamina: 100,
    inventorySlots: [{ slot: 0, label: "Hoe" }, { slot: 1, label: "Watering Can" }, { slot: 2, label: "Parsnip Seeds" }],
    verifiedHandles: ["soil:24,34", "soil:25,34"],
  };

  const validPlan = createDomainActionPipeline([
    equipToolAction(0, "Hoe"),
    tillSoilAction("soil:24,34"),
    equipToolAction(1, "Watering Can"),
    waterCropAction("soil:24,34"),
    plantSeedAction(2, "soil:24,34", "(O)472"),
  ]);

  const result = interpretPreflight(validPlan, snapshot);
  assert.equal(result.isValid, true);
  assert.equal(result.estimatedStaminaCost, 4); // 2 for till, 2 for water
  assert.equal(result.simulatedFinalStamina, 96);
  assert.deepEqual(result.missingHandles, []);
  assert.deepEqual(result.missingTools, []);

  // Unknown handle failure
  const invalidHandlePlan = createDomainActionPipeline([
    tillSoilAction("soil:99,99"),
  ]);
  const handleResult = interpretPreflight(invalidHandlePlan, snapshot);
  assert.equal(handleResult.isValid, false);
  assert.deepEqual(handleResult.missingHandles, ["soil:99,99"]);

  // Missing tool slot failure
  const invalidSlotPlan = createDomainActionPipeline([
    equipToolAction(5, "Iridium Pickaxe"),
  ]);
  const slotResult = interpretPreflight(invalidSlotPlan, snapshot);
  assert.equal(slotResult.isValid, false);
  assert.deepEqual(slotResult.missingTools, ["slot_5:Iridium Pickaxe"]);
});

test("Domain Action Preflight: adapts seamlessly from protocol.ts Snapshot with normalized handles", () => {
  const protocolSnap: Snapshot = {
    revision: 42,
    location: "Farm",
    tile: { x: 10, y: 15 },
    stamina: 80,
    health: 100,
    actionable: true,
    capabilities: ["action.till_soil"],
    currentTool: "Axe",
    toolSlots: [{ slot: 0, label: "Axe" }, { slot: 1, label: "Hoe" }],
    doorTargets: [{ sourceX: 10, sourceY: 10, targetLocation: "Coop", targetX: 3, targetY: 7 }],
    soilTiles: [{ x: 24, y: 34 }],
    forageTargets: [{ targetId: "forage:forage_01", x: 12, y: 14, qualifiedItemId: "(O)16", stack: 1 }],
    presentationLocale: "en-US",
  };

  const preflightState = snapshotToPreflightState(protocolSnap);
  assert.equal(preflightState.currentLocation, "Farm");
  assert.equal(preflightState.playerStamina, 80);
  assert.equal(preflightState.inventorySlots.length, 2);
  assert.equal(preflightState.verifiedHandles.includes("soil:24,34"), true);
  assert.equal(preflightState.verifiedHandles.includes("forage:forage_01"), true);
});

test("Domain Action Preflight: PBT Stamina Monotonicity & Fail-Closed Handle Guard", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 0, max: 200 }),
      (tillCount, initialStamina) => {
        const nodes = Array.from({ length: tillCount }, (_, i) => tillSoilAction(`soil:${i},0`));
        const plan = createDomainActionPipeline(nodes);
        const snapshot: PreflightSnapshot = {
          currentLocation: "Farm",
          playerStamina: initialStamina,
          inventorySlots: [{ slot: 0, label: "Hoe" }],
          verifiedHandles: Array.from({ length: tillCount }, (_, i) => `soil:${i},0`),
        };

        const result = interpretPreflight(plan, snapshot);
        assert.equal(result.estimatedStaminaCost, tillCount * 2);
        assert.equal(result.isValid, initialStamina >= tillCount * 2);
        if (result.isValid) {
          assert.equal(result.simulatedFinalStamina, initialStamina - tillCount * 2);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("Domain Action Preflight: PBT Pipeline Concatenation Cost Additivity", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 1, max: 10 }),
      (tillsA, tillsB) => {
        const nodesA = Array.from({ length: tillsA }, (_, i) => tillSoilAction(`soil:${i},0`));
        const nodesB = Array.from({ length: tillsB }, (_, i) => waterCropAction(`soil:${i},1`));
        const planA = createDomainActionPipeline(nodesA);
        const planB = createDomainActionPipeline(nodesB);
        const combinedPlan = createDomainActionPipeline([...nodesA, ...nodesB]);

        const allHandles = [
          ...Array.from({ length: tillsA }, (_, i) => `soil:${i},0`),
          ...Array.from({ length: tillsB }, (_, i) => `soil:${i},1`),
        ];
        const snapshot: PreflightSnapshot = {
          currentLocation: "Farm",
          playerStamina: 1000,
          inventorySlots: [{ slot: 0, label: "Hoe" }, { slot: 1, label: "Watering Can" }],
          verifiedHandles: allHandles,
        };

        const resA = interpretPreflight(planA, snapshot);
        const resB = interpretPreflight(planB, snapshot);
        const resCombined = interpretPreflight(combinedPlan, snapshot);

        // Law: Cost(A ++ B) === Cost(A) + Cost(B)
        assert.equal(resCombined.estimatedStaminaCost, resA.estimatedStaminaCost + resB.estimatedStaminaCost);
      },
    ),
    { numRuns: 100 },
  );
});

test("Domain Action Preflight: PBT Unknown Handle Soundness Invariant", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 100, max: 200 }),
      (knownCount, missingCoord) => {
        const knownHandles = Array.from({ length: knownCount }, (_, i) => `soil:${i},0`);
        const missingHandle = `soil:${missingCoord},999`;

        const plan = createDomainActionPipeline([
          ...knownHandles.map(tillSoilAction),
          tillSoilAction(missingHandle),
        ]);
        const snapshot: PreflightSnapshot = {
          currentLocation: "Farm",
          playerStamina: 500,
          inventorySlots: [{ slot: 0, label: "Hoe" }],
          verifiedHandles: knownHandles,
        };

        const res = interpretPreflight(plan, snapshot);
        assert.equal(res.isValid, false);
        assert.equal(res.missingHandles.includes(missingHandle), true);
      },
    ),
    { numRuns: 100 },
  );
});
