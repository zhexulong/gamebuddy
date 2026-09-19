# Category-Theoretic Domain Action & Evidence Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Superseded by `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`. Do not execute this plan: its generic AST, SOP dispatcher, Host preflight, pullback/equalizer runtime, and parallel dynamic action registry are retired. Preserve only laws that `design/91` folds into the unique production action pipeline.

**Historical goal:** Refactor GameBuddy action execution, state verification, snapshot querying, and dynamic action synthesis using Category Theory and Algebraic Modeling over **Mod-authorized domain morphisms and opaque observation handles** (Pure Declarative ASTs, Fail-Closed Pipeline Composition, Pullback/Equalizer state receipts with step-boundary preservation, and Diagnostic Feedback).

**Architecture & Execution Model:**
1. **Native Instant Domain Morphisms (C# SMAPI Mod):** Instant atomic domain operations (`equip_tool`, `till_soil`, `water_crop`, `plant_seed`, `fertilize_tile`, `harvest_crop`, `pickup_forage`, `use_item`, `clear_hoedirt`, `contribute_bundle`, `skip_event`) executed sequentially on the game thread within SMAPI `UpdateTicked` via a fail-closed step pipeline backed by dedicated semantic coordinators and registered via [`SopCompositeActionHandler : IFarmhandActionHandler`](file:///E:/projects/ai-game-companion/integrations/stardew/src/Core/Handlers/SopCompositeActionHandler.cs) into [`FarmhandActionRouter.cs`](file:///E:/projects/ai-game-companion/integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs) with action ID `sop_composite_pipeline`.
2. **Multi-Tick Movement & Transitions:** Asynchronous multi-tick operations (`traverse_route`, `move_to_tile`, `use_facility:mine_ladder`, `travel`) remain discrete, outer RPC operations to preserve SMAPI frame ticking without blocking the main game thread.
3. **Dynamic Domain SOPs (Host Declarative AST):** Pure data ASTs constructed in the Host ([`action-ast.ts`](file:///E:/projects/ai-game-companion/host/src/action-ast.ts)), preflighted locally via a pure interpreter ([`action-preflight-interpreter.ts`](file:///E:/projects/ai-game-companion/host/src/action-preflight-interpreter.ts)), serialized over the Named Pipe Bridge as standard `ExecutionRequest` payloads using a unified wire schema, and verified upon receipt via Pullback/Equalizer deep structural equality ([`pullback-receipt.ts`](file:///E:/projects/ai-game-companion/host/src/pullback-receipt.ts)) with explicit step boundaries and diagnostic-only feedback.

**Tech Stack:** TypeScript 5.9 (Host), C# 10 / .NET 6 (`GameBuddy.Stardew.Core`), xUnit, FluentAssertions, `FsCheck.Xunit` (C# PBT), Node.js Test Runner, `fast-check` (Host PBT).

**Spec:** [`design/85_CATEGORY_THEORETIC_ACTION_AND_EVIDENCE_ARCHITECTURE_SPEC.md`](file:///E:/projects/ai-game-companion/design/85_CATEGORY_THEORETIC_ACTION_AND_EVIDENCE_ARCHITECTURE_SPEC.md)

---

## Global Constraints & Architectural Invariants

- **Zero Heavy FP Libraries & YAGNI Pruning:** Implement pure functional primitives directly in native TypeScript (discriminated unions, pure functions) and C# (`readonly record struct Result<TValue, TError>` with `CA1715`/`CA1000` compliance). Do not pull in `fp-ts`, `LanguageExt`, or heavy monadic libraries. Follow [`AGENTS.md`](file:///E:/projects/ai-game-companion/AGENTS.md).
- **Preserve Existing C# Mod Architecture:** Do not overwrite or break [`FarmhandActionRouter.cs`](file:///E:/projects/ai-game-companion/integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs) or [`IFarmhandActionHandler.cs`](file:///E:/projects/ai-game-companion/integrations/stardew/src/Core/Abstractions/IFarmhandActionHandler.cs). Implement `SopCompositeActionHandler` implementing `IFarmhandActionHandler` with action ID `sop_composite_pipeline`.
- **Authoritative Identification Reuse:** Reuse existing target ID generators (`ExecutionManager.BuildForageTargetId`, `ExecutionManager.BuildCropTargetId`) rather than duplicating SHA256 logic in step runners.
- **SMAPI Main-Thread Affinity & Exception Safety:** All native Stardew game state mutations execute synchronously within SMAPI `UpdateTicked` on the main game thread. Any native runtime exception is caught fail-closed inside the step pipeline runner, recorded in the step ledger, and prevented from crashing SMAPI.
- **Dynamic SOP $\neq$ Authority Escalation:** Registering an SOP in the Host is strictly client-side macro templating. The Mod maintains strict default-deny authority over every node in the pipeline at execution time (verifying node type whitelist, action policy, handle freshness, scope, revision, and deadline).
- **Prohibition of Generic Ingress Dispatchers:** `GameLocation.checkAction` and `Tool.DoFunction` are strictly prohibited as generic execution dispatchers. All native executions must route to target-version proven **Semantic Coordinators** (e.g. `PortfolioCropActionCoordinator`, `PortfolioForageActionCoordinator`).
- **Step-Boundary & Partial Mutation Preservation:** Non-rollback mutations (e.g. tilling soil) must never be masked. Every step produces a durable step receipt, and the aggregate composite receipt explicitly identifies the exact failed step index and all completed precursor steps.
- **Diagnostic Feedback Only (Zero Auto-Retry):** Equalizer mismatches or step failures immediately halt execution (fail-closed) and emit structured diagnostic deltas to the Agent. The engine **never** auto-modifies or auto-re-executes mutations.
- **Unified Cross-Language Wire Schema:** `SopStepWireDescriptor` ({ stepIndex, actionType, args }) is shared identically between TypeScript and C# JSON serialization.
- **Deep Structural Equality for Equalizers:** Pullback verification uses order-independent deep structural comparison, not fragile string comparison.
- **TDD + Algebraic PBT:** Every task enforces Red-Green-Refactor with `fast-check` (Host) and `FsCheck.Xunit` (C#) verifying all algebraic laws:
  1. AST Wire Roundtrip Invariant (`deserialize(serialize(ast)) === ast`)
  2. Preflight Stamina Monotonicity, Additivity ($\text{Cost}(P_1 \oplus P_2) = \text{Cost}(P_1) + \text{Cost}(P_2)$), and Handle Soundness Invariant
  3. Execution Pipeline Short-Circuit, Exception Safety & Step-Boundary Preservation Invariants
  4. Equalizer Deep Structural Equality (Reflexivity, Symmetry, Transitivity, Mutation Sensitivity over Arbitrary Depth)
  5. Registry Idempotency & Malformed JSON Fail-Closed Fuzzing Invariant

---

### Task 1: Domain Action AST, Cross-Language Wire Serialization, and Roundtrip PBT in Host

**Files:**
- Create: `host/src/action-ast.ts`
- Test: `host/src/action-ast.test.ts`

**Interfaces:**
- Consumes: Domain snapshot types from [`host/src/protocol.ts`](file:///E:/projects/ai-game-companion/host/src/protocol.ts).
- Produces: `DomainActionNode`, `DomainActionPipeline`, `SopStepWireDescriptor`, `SopPipelineWirePayload`, `equipToolAction`, `equipToolSlotAction`, `tillSoilAction`, `waterCropAction`, `plantSeedAction`, `fertilizeTileAction`, `harvestCropAction`, `pickupForageAction`, `collectForageAction`, `useItemAction`, `clearHoeDirtAction`, `contributeBundleAction`, `skipEventAction`, `serializeDomainActionPipeline`, `deserializeDomainActionPipeline`, `createDomainActionPipeline`.

- [ ] **Step 1: Write failing unit and PBT tests for AST creation, wire serialization, and roundtrip identity**

```typescript
// host/src/action-ast.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/action-ast.test.js`  
Expected: FAIL with "Cannot find module './action-ast.js'".

- [ ] **Step 3: Write minimal implementation in `host/src/action-ast.ts`**

```typescript
// host/src/action-ast.ts

export type DomainActionNode =
  | { readonly type: "equip_tool" | "equip_tool_slot"; readonly slot: number; readonly toolName: string }
  | { readonly type: "till_soil"; readonly targetHandle: string }
  | { readonly type: "water_crop"; readonly targetHandle: string }
  | { readonly type: "plant_seed"; readonly slot: number; readonly targetHandle: string; readonly qualifiedItemId: string }
  | { readonly type: "fertilize_tile"; readonly slot: number; readonly targetHandle: string; readonly qualifiedItemId: string }
  | { readonly type: "harvest_crop"; readonly targetHandle: string; readonly qualifiedItemId?: string }
  | { readonly type: "pickup_forage" | "collect_forage"; readonly targetHandle: string; readonly qualifiedItemId?: string }
  | { readonly type: "use_item"; readonly slot: number; readonly qualifiedItemId: string }
  | { readonly type: "clear_hoedirt"; readonly slot: number; readonly targetHandle: string }
  | { readonly type: "contribute_bundle"; readonly bundleId: string; readonly bundleSlot: number; readonly inventorySlot: number }
  | { readonly type: "skip_event"; readonly eventId?: string };

export interface DomainActionPipeline {
  readonly nodes: readonly DomainActionNode[];
}

export interface SopStepWireDescriptor {
  readonly stepIndex: number;
  readonly actionType: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SopPipelineWirePayload {
  readonly pipelineId: string;
  readonly steps: readonly SopStepWireDescriptor[];
  readonly expectedPullback?: {
    readonly targetProperty: string;
    readonly targetLocation: { readonly location: string; readonly tile: { readonly x: number; readonly y: number } };
    readonly expectedValue: unknown;
  };
}

export function createDomainActionPipeline(nodes: readonly DomainActionNode[]): DomainActionPipeline {
  return Object.freeze({ nodes: Object.freeze([...nodes]) });
}

export function equipToolAction(slot: number, toolName: string): DomainActionNode {
  return { type: "equip_tool", slot, toolName };
}

export function equipToolSlotAction(slot: number, toolName: string): DomainActionNode {
  return { type: "equip_tool", slot, toolName };
}

export function tillSoilAction(targetHandle: string): DomainActionNode {
  return { type: "till_soil", targetHandle };
}

export function waterCropAction(targetHandle: string): DomainActionNode {
  return { type: "water_crop", targetHandle };
}

export function plantSeedAction(slot: number, targetHandle: string, qualifiedItemId: string): DomainActionNode {
  return { type: "plant_seed", slot, targetHandle, qualifiedItemId };
}

export function fertilizeTileAction(slot: number, targetHandle: string, qualifiedItemId: string): DomainActionNode {
  return { type: "fertilize_tile", slot, targetHandle, qualifiedItemId };
}

export function harvestCropAction(targetHandle: string, qualifiedItemId?: string): DomainActionNode {
  return { type: "harvest_crop", targetHandle, qualifiedItemId };
}

export function pickupForageAction(targetHandle: string, qualifiedItemId?: string): DomainActionNode {
  return { type: "pickup_forage", targetHandle, qualifiedItemId };
}

export function collectForageAction(targetHandle: string, qualifiedItemId?: string): DomainActionNode {
  return { type: "pickup_forage", targetHandle, qualifiedItemId };
}

export function useItemAction(slot: number, qualifiedItemId: string): DomainActionNode {
  return { type: "use_item", slot, qualifiedItemId };
}

export function clearHoeDirtAction(slot: number, targetHandle: string): DomainActionNode {
  return { type: "clear_hoedirt", slot, targetHandle };
}

export function contributeBundleAction(bundleId: string, bundleSlot: number, inventorySlot: number): DomainActionNode {
  return { type: "contribute_bundle", bundleId, bundleSlot, inventorySlot };
}

export function skipEventAction(eventId?: string): DomainActionNode {
  return { type: "skip_event", eventId };
}

export function serializeDomainActionPipeline(pipeline: DomainActionPipeline, pipelineId = "sop_pipeline"): SopPipelineWirePayload {
  const steps: SopStepWireDescriptor[] = pipeline.nodes.map((node, index) => {
    const { type, ...args } = node;
    return {
      stepIndex: index,
      actionType: type,
      args: Object.freeze(args as Record<string, unknown>),
    };
  });

  return Object.freeze({
    pipelineId,
    steps: Object.freeze(steps),
  });
}

export function deserializeDomainActionPipeline(payload: SopPipelineWirePayload): DomainActionPipeline {
  if (!payload || !Array.isArray(payload.steps)) {
    throw new Error("invalid_sop_payload: steps array required");
  }

  payload.steps.forEach((step, idx) => {
    if (step.stepIndex !== idx) {
      throw new Error(`invalid_step_index_sequence: expected ${idx} but got ${step.stepIndex}`);
    }
  });

  const nodes: DomainActionNode[] = payload.steps.map((step) => {
    return {
      type: step.actionType,
      ...step.args,
    } as DomainActionNode;
  });

  return createDomainActionPipeline(nodes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/action-ast.test.js`  
Expected: PASS.

---

### Task 2: Host Preflight Interpreter & Algebraic PBT (Monotonicity, Additivity, Soundness)

**Files:**
- Create: `host/src/action-preflight-interpreter.ts`
- Test: `host/src/action-preflight-interpreter.test.ts`

**Interfaces:**
- Consumes: `DomainActionPipeline`, `DomainActionNode` from `host/src/action-ast.ts`, `Snapshot` from `host/src/protocol.ts`.
- Produces: `interpretPreflight`, `PreflightResult`, `PreflightSnapshot`, `snapshotToPreflightState`.

- [ ] **Step 1: Write failing unit and algebraic PBT tests (Monotonicity, Concatenation Additivity, Handle Soundness, Stateful Tool Simulation)**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/action-preflight-interpreter.test.js`  
Expected: FAIL with "Cannot find module './action-preflight-interpreter.js'".

- [ ] **Step 3: Write minimal implementation in `host/src/action-preflight-interpreter.ts`**

```typescript
// host/src/action-preflight-interpreter.ts
import type { DomainActionPipeline, DomainActionNode } from "./action-ast.js";
import type { Snapshot } from "./protocol.js";

export interface PreflightSnapshot {
  readonly currentLocation: string;
  readonly playerStamina: number;
  readonly inventorySlots: readonly { readonly slot: number; readonly label: string }[];
  readonly verifiedHandles: readonly string[];
}

export interface PreflightResult {
  readonly isValid: boolean;
  readonly estimatedStaminaCost: number;
  readonly simulatedFinalStamina: number;
  readonly missingTools: readonly string[];
  readonly missingHandles: readonly string[];
}

export function snapshotToPreflightState(snapshot: Snapshot): PreflightSnapshot {
  const verifiedHandles: string[] = [];
  if (snapshot.doorTargets) {
    for (const dt of snapshot.doorTargets) {
      verifiedHandles.push(`door:${dt.targetLocation}:${dt.targetX},${dt.targetY}`);
    }
  }
  if (snapshot.soilTiles) {
    for (const st of snapshot.soilTiles) {
      verifiedHandles.push(`soil:${st.x},${st.y}`);
    }
  }
  if (snapshot.forageTargets) {
    for (const ft of snapshot.forageTargets) {
      verifiedHandles.push(ft.targetId);
    }
  }

  return {
    currentLocation: snapshot.location,
    playerStamina: snapshot.stamina,
    inventorySlots: Object.freeze(snapshot.toolSlots ?? []),
    verifiedHandles: Object.freeze(verifiedHandles),
  };
}

export function interpretPreflight(
  plan: DomainActionPipeline,
  initialState: PreflightSnapshot,
): PreflightResult {
  let staminaCost = 0;
  const missingTools: string[] = [];
  const missingHandles: string[] = [];

  for (const node of plan.nodes) {
    switch (node.type) {
      case "equip_tool":
      case "equip_tool_slot": {
        const slotMatch = initialState.inventorySlots.find(
          (s) => s.slot === node.slot && s.label === node.toolName,
        );
        if (!slotMatch) {
          const missingKey = `slot_${node.slot}:${node.toolName}`;
          if (!missingTools.includes(missingKey)) {
            missingTools.push(missingKey);
          }
        }
        break;
      }
      case "till_soil":
      case "water_crop":
      case "harvest_crop":
      case "pickup_forage":
      case "collect_forage":
      case "clear_hoedirt": {
        if (!initialState.verifiedHandles.includes(node.targetHandle)) {
          if (!missingHandles.includes(node.targetHandle)) {
            missingHandles.push(node.targetHandle);
          }
        }
        if (node.type === "till_soil" || node.type === "water_crop" || node.type === "clear_hoedirt") {
          staminaCost += 2;
        }
        break;
      }
      case "plant_seed":
      case "fertilize_tile": {
        if (!initialState.verifiedHandles.includes(node.targetHandle)) {
          if (!missingHandles.includes(node.targetHandle)) {
            missingHandles.push(node.targetHandle);
          }
        }
        break;
      }
      case "use_item":
      case "contribute_bundle":
      case "skip_event":
        break;
    }
  }

  const isValid =
    missingTools.length === 0 &&
    missingHandles.length === 0 &&
    initialState.playerStamina >= staminaCost;

  return {
    isValid,
    estimatedStaminaCost: staminaCost,
    simulatedFinalStamina: Math.max(0, initialState.playerStamina - staminaCost),
    missingTools: Object.freeze(missingTools),
    missingHandles: Object.freeze(missingHandles),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/action-preflight-interpreter.test.js`  
Expected: PASS.

---

### Task 3: C# SMAPI Game-Thread Pipeline Step Runner & Durable Step Receipt Ledger

**Files:**
- Create: `integrations/stardew/src/Core/Algebra/Result.cs`
- Create: `integrations/stardew/src/Core/Algebra/SopStepPipeline.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopStepPipelinePropertyTests.cs`

**Interfaces:**
- Consumes: `LocalExecutionReceipt` from `GameBuddy.Stardew.Core.Models`.
- Produces: `Result<TValue, TError>`, `SopStepWireDescriptor`, `SopPipelineWirePayload`, `SopStepReceipt`, `SopPipelineResult`, `ISopStepRunner`, `SopStepPipelineRunner`.

- [ ] **Step 1: Write failing FsCheck.Xunit PBT tests for Step Boundaries, Short-Circuiting, Exception Containment, and JSON Deserialization Fuzzing**

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopStepPipelinePropertyTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using FluentAssertions;
using Xunit;
using GameBuddy.Stardew.Core.Algebra;

public sealed class SopStepPipelinePropertyTests
{
    private sealed class MockStepRunner : ISopStepRunner
    {
        private readonly Func<int, string, Result<string, string>> _evaluator;
        public List<int> ExecutedSteps { get; } = new();

        public MockStepRunner(Func<int, string, Result<string, string>> evaluator) => _evaluator = evaluator;

        public Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args)
        {
            this.ExecutedSteps.Add(stepIndex);
            return this._evaluator(stepIndex, actionType);
        }

        public object? SampleStateProperty(string location, int tileX, int tileY, string propertyPath)
        {
            return true;
        }
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_ShortCircuitsAtFirstFailure_AndPreservesExactStepReceipts(PositiveInt totalSteps, PositiveInt failAt)
    {
        int n = (totalSteps.Get % 10) + 1;
        int failIdx = (failAt.Get % n);

        var runner = new MockStepRunner((idx, _) => idx == failIdx ? Result.Fail<string, string>("mock_failure") : Result.Ok<string, string>("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        bool isCorrectSuccessState = result.IsSuccess == false;
        bool isCorrectFailedIndex = result.FailedStepIndex == failIdx;
        bool isCorrectExecutionCount = runner.ExecutedSteps.Count == failIdx + 1;
        bool isCorrectReceiptsCount = result.StepReceipts.Count == failIdx + 1;

        return (isCorrectSuccessState && isCorrectFailedIndex && isCorrectExecutionCount && isCorrectReceiptsCount).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_SucceedsAll_WhenNoStepFails(PositiveInt totalSteps)
    {
        int n = (totalSteps.Get % 10) + 1;
        var runner = new MockStepRunner((_, _) => Result.Ok<string, string>("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        return (result.IsSuccess && result.FailedStepIndex == null && result.StepReceipts.Count == n).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_ContainsNativeExceptions_FailClosed(PositiveInt totalSteps, PositiveInt throwAt)
    {
        int n = (totalSteps.Get % 10) + 1;
        int throwIdx = (throwAt.Get % n);

        var runner = new MockStepRunner((idx, _) =>
        {
            if (idx == throwIdx) throw new InvalidOperationException("Native engine crash simulation");
            return Result.Ok<string, string>("step_succeeded");
        });

        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        bool failedCorrectly = !result.IsSuccess && result.FailedStepIndex == throwIdx;
        bool exceptionRecorded = result.ReasonCode.Contains("exception_invalidoperationexception");
        bool stoppedAtThrow = runner.ExecutedSteps.Count == throwIdx + 1;

        return (failedCorrectly && exceptionRecorded && stoppedAtThrow).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_FailsClosed_OnCorruptedStepIndexSequence(PositiveInt totalSteps, PositiveInt badIndexOffset)
    {
        int n = (totalSteps.Get % 10) + 1;
        var runner = new MockStepRunner((_, _) => Result.Ok<string, string>("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            int index = (i == 0) ? i + (badIndexOffset.Get % 5 + 1) : i;
            steps.Add(new SopStepWireDescriptor(index, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        return (!result.IsSuccess && result.ReasonCode == "invalid_step_index_sequence").ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_ShortCircuits_OnExpiredDeadline(PositiveInt totalSteps)
    {
        int n = (totalSteps.Get % 10) + 1;
        var runner = new MockStepRunner((_, _) => Result.Ok<string, string>("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        long expiredDeadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1000;
        var result = pipeline.Execute(steps, expiredDeadline);

        bool failedWithTimeout = !result.IsSuccess && result.ReasonCode == "timed_out";
        bool executedZeroSteps = runner.ExecutedSteps.Count == 0;
        return (failedWithTimeout && executedZeroSteps).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_Enforces_MaxPipelineSteps_Limit(PositiveInt extraSteps)
    {
        int total = SopStepPipelineRunner.MaxPipelineSteps + (extraSteps.Get % 20 + 1);
        var runner = new MockStepRunner((_, _) => Result.Ok<string, string>("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < total; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        return (!result.IsSuccess && result.ReasonCode == "pipeline_too_long" && runner.ExecutedSteps.Count == 0).ToProperty();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~SopStepPipelinePropertyTests"`  
Expected: FAIL with compilation errors.

- [ ] **Step 3: Write minimal implementation in `Result.cs` and `SopStepPipeline.cs`**

```csharp
// integrations/stardew/src/Core/Algebra/Result.cs
namespace GameBuddy.Stardew.Core.Algebra;

using System;

public readonly record struct Result<TValue, TError>
{
    public bool IsSuccess { get; }
    public TValue Value { get; }
    public TError Error { get; }

    internal Result(bool isSuccess, TValue value, TError error)
    {
        this.IsSuccess = isSuccess;
        this.Value = value;
        this.Error = error;
    }
}

public static class Result
{
    public static Result<TValue, TError> Ok<TValue, TError>(TValue value) => new(true, value, default!);
    public static Result<TValue, TError> Fail<TValue, TError>(TError error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return new(false, default!, error);
    }
}
```

```csharp
// integrations/stardew/src/Core/Algebra/SopStepPipeline.cs
namespace GameBuddy.Stardew.Core.Algebra;

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed record SopStepWireDescriptor(
    [property: JsonPropertyName("stepIndex")] int StepIndex,
    [property: JsonPropertyName("actionType")] string ActionType,
    [property: JsonPropertyName("args")] IReadOnlyDictionary<string, JsonElement> Args
);

public sealed record SopTileDescriptor(
    [property: JsonPropertyName("x")] int X,
    [property: JsonPropertyName("y")] int Y
);

public sealed record SopLocationDescriptor(
    [property: JsonPropertyName("location")] string Location,
    [property: JsonPropertyName("tile")] SopTileDescriptor Tile
);

public sealed record SopExpectedPullbackDescriptor(
    [property: JsonPropertyName("targetProperty")] string TargetProperty,
    [property: JsonPropertyName("targetLocation")] SopLocationDescriptor TargetLocation,
    [property: JsonPropertyName("expectedValue")] JsonElement ExpectedValue
);

public sealed record SopPipelineWirePayload(
    [property: JsonPropertyName("pipelineId")] string PipelineId,
    [property: JsonPropertyName("steps")] IReadOnlyList<SopStepWireDescriptor> Steps,
    [property: JsonPropertyName("expectedPullback")] SopExpectedPullbackDescriptor? ExpectedPullback
);

public sealed record SopStepReceipt(
    [property: JsonPropertyName("stepIndex")] int StepIndex,
    [property: JsonPropertyName("actionType")] string ActionType,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("reasonCode")] string ReasonCode
);

public sealed record SopPipelineResult(
    [property: JsonPropertyName("isSuccess")] bool IsSuccess,
    [property: JsonPropertyName("failedStepIndex")] int? FailedStepIndex,
    [property: JsonPropertyName("stepReceipts")] IReadOnlyList<SopStepReceipt> StepReceipts,
    [property: JsonPropertyName("reasonCode")] string ReasonCode
);

public interface ISopStepRunner
{
    Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args);
    object? SampleStateProperty(string location, int tileX, int tileY, string propertyPath);
}

public sealed class SopStepPipelineRunner
{
    public const int MaxPipelineSteps = 16;
    private readonly ISopStepRunner _runner;

    public SopStepPipelineRunner(ISopStepRunner runner)
    {
        _runner = runner ?? throw new ArgumentNullException(nameof(runner));
    }

    public SopPipelineResult Execute(IReadOnlyList<SopStepWireDescriptor> steps, long? requestedDeadlineMs = null)
    {
        if (steps == null || steps.Count == 0)
        {
            return new SopPipelineResult(false, null, Array.Empty<SopStepReceipt>(), "empty_sop_pipeline");
        }

        if (steps.Count > MaxPipelineSteps)
        {
            return new SopPipelineResult(false, null, Array.Empty<SopStepReceipt>(), "pipeline_too_long");
        }

        var receipts = new List<SopStepReceipt>();

        for (int i = 0; i < steps.Count; i++)
        {
            var step = steps[i];
            if (step.StepIndex != i)
            {
                return new SopPipelineResult(false, step.StepIndex, receipts, "invalid_step_index_sequence");
            }

            if (requestedDeadlineMs.HasValue && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > requestedDeadlineMs.Value)
            {
                receipts.Add(new SopStepReceipt(step.StepIndex, step.ActionType, "failed", "timed_out"));
                return new SopPipelineResult(false, step.StepIndex, receipts, "timed_out");
            }

            Result<string, string> stepResult;
            try
            {
                stepResult = _runner.ExecuteStep(step.StepIndex, step.ActionType, step.Args);
            }
            catch (Exception ex)
            {
                stepResult = Result.Fail<string, string>($"exception_{ex.GetType().Name.ToLowerInvariant()}");
            }

            string state = stepResult.IsSuccess ? "succeeded" : "failed";
            string reason = stepResult.IsSuccess ? stepResult.Value : $"step_failed:{step.ActionType}:{stepResult.Error}";
            receipts.Add(new SopStepReceipt(step.StepIndex, step.ActionType, state, reason));

            if (!stepResult.IsSuccess)
            {
                return new SopPipelineResult(false, step.StepIndex, receipts, reason);
            }
        }

        return new SopPipelineResult(true, null, receipts, "pipeline_succeeded");
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~SopStepPipelinePropertyTests"`  
Expected: PASS.

---

### Task 4: Pullback / Equalizer Deep Structural Verification & State Receipt Generator

**Files:**
- Create: `host/src/pullback-receipt.ts`
- Test: `host/src/pullback-receipt.test.ts`
- Create: `integrations/stardew/src/Core/Algebra/PullbackEvidence.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/PullbackReceiptPropertyTests.cs`

**Interfaces:**
- Consumes: `ExecutionReceipt` from `host/src/protocol.ts`.
- Produces: `PullbackSpec`, `PullbackEvidence`, `StepReceipt`, `createCompositeExecutionReceipt`, `verifyPullbackEqualizer`, `deepEqual`.

- [ ] **Step 1: Write failing TS and C# unit/PBT tests for Step Boundaries & Equalizer Laws across Deep Nested Trees**

```typescript
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
  const leaf = fc.oneof(fc.string({ minLength: 1, maxLength: 8 }), fc.integer({ min: -100, max: 100 }), fc.boolean(), fc.constant(null));
  if (depth <= 0) return leaf;
  const child = arbitraryJsonTree(depth - 1);
  return fc.oneof(
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
```

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/PullbackReceiptPropertyTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using FluentAssertions;
using Xunit;
using GameBuddy.Stardew.Core.Algebra;

public sealed class PullbackReceiptPropertyTests
{
    [Property(MaxTest = 100)]
    public Property PullbackReceipt_EqualizerMatches_OnlyWhenExpectedEqualsActual(int expected, int actual)
    {
        var evidence = new CompositeExecutionReceiptPayload(
            "sop_composite_pipeline",
            "mine.currentFloor",
            new SopLocationDescriptor("UndergroundMine11", new SopTileDescriptor(10, 12)),
            expected,
            actual,
            expected == actual,
            Array.Empty<SopStepReceipt>(),
            null
        );

        return (evidence.EqualizerMatched == (expected == actual)).ToProperty();
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/pullback-receipt.test.js && dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~PullbackReceiptPropertyTests"`  
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation in `host/src/pullback-receipt.ts` & `PullbackEvidence.cs`**

```typescript
// host/src/pullback-receipt.ts
import type { ExecutionReceipt } from "./protocol.js";

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recordB, key)) return false;
    if (!deepEqual(recordA[key], recordB[key])) return false;
  }
  return true;
}

export interface PullbackSpec {
  readonly targetProperty: string;
  readonly targetLocation: {
    readonly location: string;
    readonly tile: { readonly x: number; readonly y: number };
  };
  readonly expectedValue: unknown;
}

export interface StepReceipt {
  readonly stepIndex: number;
  readonly actionType: string;
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly reasonCode: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PullbackEvidence extends PullbackSpec {
  readonly actualValue: unknown;
  readonly equalizerMatched?: boolean;
  readonly stepReceipts?: readonly StepReceipt[];
  readonly failedStepIndex?: number | null;
}

export function createCompositeExecutionReceipt(params: {
  executionId: string;
  requestId: string;
  action: string;
  spec: PullbackSpec;
  actualValue: unknown;
  revision: number;
  steps: readonly StepReceipt[];
  failedStepIndex?: number | null;
}): ExecutionReceipt {
  const failedStep = typeof params.failedStepIndex === "number" ? params.steps[params.failedStepIndex] : null;
  const equalizerMatched = !failedStep && deepEqual(params.spec.expectedValue, params.actualValue);

  const reasonCode = failedStep
    ? (failedStep.reasonCode.startsWith("step_failed:") ? failedStep.reasonCode : `step_failed:${failedStep.actionType}:${failedStep.reasonCode}`)
    : equalizerMatched
      ? "equalizer_matched"
      : "equalizer_mismatch";

  return Object.freeze({
    executionId: params.executionId,
    requestId: params.requestId,
    state: equalizerMatched ? "succeeded" : "failed",
    reasonCode,
    revision: params.revision,
    evidence: Object.freeze({
      action: params.action,
      targetProperty: params.spec.targetProperty,
      targetLocation: params.spec.targetLocation,
      expectedValue: params.spec.expectedValue,
      actualValue: params.actualValue,
      equalizerMatched,
      stepReceipts: params.steps,
      failedStepIndex: params.failedStepIndex ?? null,
    } as Record<string, unknown>),
  });
}

export function verifyPullbackEqualizer(receipt: ExecutionReceipt): boolean {
  if (!receipt.evidence || typeof receipt.evidence !== "object") return false;
  const evidence = receipt.evidence as Record<string, unknown>;
  return (
    evidence.equalizerMatched === true &&
    deepEqual(evidence.expectedValue, evidence.actualValue)
  );
}
```

```csharp
// integrations/stardew/src/Core/Algebra/PullbackEvidence.cs
namespace GameBuddy.Stardew.Core.Algebra;

using System.Collections.Generic;
using System.Text.Json.Serialization;

public sealed record CompositeExecutionReceiptPayload(
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("targetProperty")] string? TargetProperty,
    [property: JsonPropertyName("targetLocation")] SopLocationDescriptor? TargetLocation,
    [property: JsonPropertyName("expectedValue")] object? ExpectedValue,
    [property: JsonPropertyName("actualValue")] object? ActualValue,
    [property: JsonPropertyName("equalizerMatched")] bool EqualizerMatched,
    [property: JsonPropertyName("stepReceipts")] IReadOnlyList<SopStepReceipt> StepReceipts,
    [property: JsonPropertyName("failedStepIndex")] int? FailedStepIndex
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/pullback-receipt.test.js && dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~PullbackReceiptPropertyTests"`  
Expected: PASS.

---

### Task 5: Protocol Registration, Mod Composite SOP Action Handler (`SopCompositeActionHandler`) & Live SMAPI Step Runner

**Files:**
- Modify: `host/src/protocol.ts` (register `sop_composite_pipeline` action and typed pipeline payload validator)
- Modify: `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` (register `sop_composite_pipeline` catalog definition)
- Modify: `integrations/stardew/ExecutionManager.cs` (make `BuildForageTargetId` and `BuildCropTargetId` internal static for direct step runner reuse)
- Modify: `integrations/stardew/BridgeSession.cs` (register `sop_composite_pipeline` argument shape, validation, and fingerprint)
- Modify: `integrations/stardew/ModEntry.cs` (register `SopCompositeActionHandler` into `FarmhandActionRouter` at startup)
- Create: `integrations/stardew/src/Core/Handlers/SopCompositeActionHandler.cs`
- Create: `integrations/stardew/Handlers/SmapiLiveStepRunner.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopCompositeActionHandlerTests.cs`

**Interfaces:**
- Consumes: `IFarmhandActionHandler`, `FarmhandActionRouter`, `IExecutionLedger`, `BridgeExecutionRequest`, `SopStepPipelineRunner`, `CompositeExecutionReceiptPayload`, `ExecutionManager`.
- Produces: `SopCompositeActionHandler` implementing `IFarmhandActionHandler` registered into `FarmhandActionRouter`, `SmapiLiveStepRunner` implementing `ISopStepRunner`.

- [ ] **Step 1: Write failing unit and fuzzing tests for `SopCompositeActionHandler`**

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopCompositeActionHandlerTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using Xunit;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Handlers;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Routing;

public sealed class SopCompositeActionHandlerTests
{
    private sealed class InMemoryLedger : IExecutionLedger
    {
        public long CurrentRevision => 10;
        public bool IsBodyBusy => false;
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt)
        {
            receipt = default!;
            return false;
        }
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence)
            => new(executionId, requestId, state, reasonCode, this.CurrentRevision, evidence);
        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    private sealed class DummyStepRunner : ISopStepRunner
    {
        public List<string> Executed { get; } = new();
        public bool FailOnStep1 { get; set; }

        public Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args)
        {
            this.Executed.Add($"{stepIndex}:{actionType}");
            if (this.FailOnStep1 && stepIndex == 1)
            {
                return Result.Fail<string, string>("simulated_step_failure");
            }
            return Result.Ok<string, string>("step_succeeded");
        }

        public object? SampleStateProperty(string location, int tileX, int tileY, string propertyPath)
        {
            if (propertyPath == "terrain.soil_dirt.state.watered") return true;
            return null;
        }
    }

    [Fact]
    public void Handler_RegistersInRouter_AndExecutesCompositePipelineSuccessfully()
    {
        var dummyRunner = new DummyStepRunner();
        var handler = new SopCompositeActionHandler(dummyRunner);
        var router = new FarmhandActionRouter();
        router.Register(handler);

        var pipelinePayload = new SopPipelineWirePayload(
            "test_pipeline_01",
            new[]
            {
                new SopStepWireDescriptor(0, "equip_tool", new Dictionary<string, JsonElement>()),
                new SopStepWireDescriptor(1, "till_soil", new Dictionary<string, JsonElement>())
            },
            new SopExpectedPullbackDescriptor("terrain.soil_dirt.state.watered", new SopLocationDescriptor("Farm", new SopTileDescriptor(24, 34)), JsonSerializer.SerializeToElement(true))
        );

        var payloadElement = JsonSerializer.SerializeToElement(pipelinePayload);
        var args = new BridgeExecutionArgs
        {
            AdditionalProperties = new Dictionary<string, JsonElement> { ["pipelinePayload"] = payloadElement }
        };
        var request = new BridgeExecutionRequest("req_sop_1", "idem_1", "sop_composite_pipeline", args, 10, 5000);
        var ledger = new InMemoryLedger();

        bool routed = router.TryRoute(request, ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("pipeline_succeeded");
        dummyRunner.Executed.Should().Equal("0:equip_tool", "1:till_soil");
        receipt.Evidence.Should().NotBeNullOrEmpty();
        receipt.Evidence.Should().Contain("\"actualValue\":true");
    }

    [Fact]
    public void Handler_ShortCircuitsOnFailure_AndPreservesPartialEvidence()
    {
        var dummyRunner = new DummyStepRunner { FailOnStep1 = true };
        var handler = new SopCompositeActionHandler(dummyRunner);
        var router = new FarmhandActionRouter();
        router.Register(handler);

        var pipelinePayload = new SopPipelineWirePayload(
            "test_pipeline_02",
            new[]
            {
                new SopStepWireDescriptor(0, "equip_tool", new Dictionary<string, JsonElement>()),
                new SopStepWireDescriptor(1, "till_soil", new Dictionary<string, JsonElement>()),
                new SopStepWireDescriptor(2, "water_crop", new Dictionary<string, JsonElement>())
            },
            null
        );

        var payloadElement = JsonSerializer.SerializeToElement(pipelinePayload);
        var args = new BridgeExecutionArgs
        {
            AdditionalProperties = new Dictionary<string, JsonElement> { ["pipelinePayload"] = payloadElement }
        };
        var request = new BridgeExecutionRequest("req_sop_2", "idem_2", "sop_composite_pipeline", args, 10, 5000);
        var ledger = new InMemoryLedger();

        bool routed = router.TryRoute(request, ledger, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue();
        receipt.State.Should().Be(ExecutionState.Failed);
        receipt.ReasonCode.Should().Be("step_failed:till_soil:simulated_step_failure");
        dummyRunner.Executed.Should().Equal("0:equip_tool", "1:till_soil");
    }

    [Fact]
    public void Handler_FailsClosed_OnMissingOrMalformedPayload()
    {
        var dummyRunner = new DummyStepRunner();
        var handler = new SopCompositeActionHandler(dummyRunner);
        var args = new BridgeExecutionArgs();
        var request = new BridgeExecutionRequest("req_sop_err", "idem_err", "sop_composite_pipeline", args, 10, 5000);
        var ledger = new InMemoryLedger();

        var receipt = handler.Execute(request, ledger);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("missing_sop_pipeline_payload");
        dummyRunner.Executed.Should().BeEmpty();
    }

    [Fact]
    public void Handler_Rejects_PipelineExceedingMaxSteps()
    {
        var dummyRunner = new DummyStepRunner();
        var handler = new SopCompositeActionHandler(dummyRunner);
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i <= SopStepPipelineRunner.MaxPipelineSteps; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, "equip_tool", new Dictionary<string, JsonElement>()));
        }

        var pipelinePayload = new SopPipelineWirePayload("oversized_pipe", steps, null);
        var payloadElement = JsonSerializer.SerializeToElement(pipelinePayload);
        var args = new BridgeExecutionArgs
        {
            AdditionalProperties = new Dictionary<string, JsonElement> { ["pipelinePayload"] = payloadElement }
        };
        var request = new BridgeExecutionRequest("req_sop_oversized", "idem_oversized", "sop_composite_pipeline", args, 10, 5000);
        var ledger = new InMemoryLedger();

        var receipt = handler.Execute(request, ledger);

        receipt.State.Should().Be(ExecutionState.Failed);
        receipt.ReasonCode.Should().Be("pipeline_too_long");
        dummyRunner.Executed.Should().BeEmpty();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~SopCompositeActionHandlerTests"`  
Expected: FAIL with compilation errors.

- [ ] **Step 3: Implement `SopCompositeActionHandler.cs`, `SmapiLiveStepRunner.cs`, `BridgeSession.cs`, and `ModEntry.cs` Registrations**

```csharp
// integrations/stardew/src/Core/Handlers/SopCompositeActionHandler.cs
namespace GameBuddy.Stardew.Core.Handlers;

using System;
using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Models;

public sealed class SopCompositeActionHandler : IFarmhandActionHandler
{
    private readonly SopStepPipelineRunner _pipelineRunner;
    private readonly ISopStepRunner _stepRunner;

    public SopCompositeActionHandler(ISopStepRunner stepRunner)
    {
        _stepRunner = stepRunner ?? throw new ArgumentNullException(nameof(stepRunner));
        _pipelineRunner = new SopStepPipelineRunner(stepRunner);
    }

    public IReadOnlyCollection<string> SupportedActions { get; } = new[] { "sop_composite_pipeline" };

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        SopPipelineWirePayload? wirePayload = null;

        if (request.Args.AdditionalProperties != null &&
            request.Args.AdditionalProperties.TryGetValue("pipelinePayload", out JsonElement payloadElement))
        {
            try
            {
                wirePayload = JsonSerializer.Deserialize<SopPipelineWirePayload>(
                    payloadElement.GetRawText(),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                );
            }
            catch (Exception ex)
            {
                return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, $"invalid_sop_payload:exception_{ex.GetType().Name.ToLowerInvariant()}", null);
            }
        }

        if (wirePayload == null)
        {
            return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "missing_sop_pipeline_payload", null);
        }

        if (wirePayload.Steps == null || wirePayload.Steps.Count == 0)
        {
            return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "empty_sop_pipeline", null);
        }

        var result = _pipelineRunner.Execute(wirePayload.Steps, request.DeadlineMs);
        var state = result.IsSuccess ? ExecutionState.Succeeded : ExecutionState.Failed;

        object? actualValue = null;
        if (wirePayload.ExpectedPullback != null)
        {
            actualValue = _stepRunner.SampleStateProperty(
                wirePayload.ExpectedPullback.TargetLocation.Location,
                wirePayload.ExpectedPullback.TargetLocation.Tile.X,
                wirePayload.ExpectedPullback.TargetLocation.Tile.Y,
                wirePayload.ExpectedPullback.TargetProperty
            );
        }

        var compositeEvidence = new CompositeExecutionReceiptPayload(
            request.Action,
            wirePayload.ExpectedPullback?.TargetProperty,
            wirePayload.ExpectedPullback?.TargetLocation,
            wirePayload.ExpectedPullback?.ExpectedValue,
            actualValue,
            result.IsSuccess,
            result.StepReceipts,
            result.FailedStepIndex
        );

        var evidenceJson = JsonSerializer.Serialize(compositeEvidence);
        return ledger.RememberTerminal(request.RequestId, Guid.NewGuid().ToString("N"), state, result.ReasonCode, evidenceJson);
    }
}
```

```csharp
// integrations/stardew/Handlers/SmapiLiveStepRunner.cs
namespace GameBuddy.Stardew.Handlers;

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.TerrainFeatures;

/// <summary>
/// Native SMAPI game-thread execution runner that dispatches atomic domain morphisms to Mod coordinators.
/// </summary>
internal sealed class SmapiLiveStepRunner : ISopStepRunner
{
    private static readonly Regex TileHandleRegex = new(@"(\d+)[\,_](\d+)", RegexOptions.Compiled);
    private readonly ExecutionManager _executions;

    public SmapiLiveStepRunner(ExecutionManager executions)
    {
        _executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public object? SampleStateProperty(string locationName, int tileX, int tileY, string propertyPath)
    {
        if (!Context.IsWorldReady || Game1.player?.currentLocation is null)
            return null;

        var location = Game1.getLocationFromName(locationName) ?? Game1.player.currentLocation;
        Vector2 tile = new(tileX, tileY);

        switch (propertyPath)
        {
            case "terrain.soil_dirt.state.watered":
                if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? feat) && feat is HoeDirt dirt)
                    return dirt.isWatered();
                return false;

            case "terrain.soil_dirt.state.tilled":
                return location.terrainFeatures.TryGetValue(tile, out TerrainFeature? tf) && tf is HoeDirt;

            case "terrain.crop.state.harvestable":
                if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? cFeature) && cFeature is HoeDirt hd && hd.crop != null)
                    return hd.crop.currentPhase.Value >= hd.crop.phaseDays.Count - 1;
                return false;

            default:
                return null;
        }
    }

    public Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args)
    {
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return Result.Fail<string, string>("world_not_ready");

        string stepReqId = $"step_{stepIndex}_{Guid.NewGuid():N}";
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        GameLocation location = Game1.player.currentLocation;

        LocalExecutionReceipt receipt;
        switch (actionType)
        {
            case "equip_tool":
            case "equip_tool_slot":
                if (args.TryGetValue("slot", out JsonElement slotElem) && slotElem.TryGetInt32(out int slot))
                {
                    receipt = _executions.RequestLocalEquipTool(stepReqId, slot);
                    return receipt.State == ExecutionState.Succeeded
                        ? Result.Ok<string, string>(receipt.ReasonCode)
                        : Result.Fail<string, string>(receipt.ReasonCode);
                }
                return Result.Fail<string, string>("missing_slot_arg");

            case "till_soil":
                if (args.TryGetValue("targetHandle", out JsonElement tillHandleElem))
                {
                    string handle = tillHandleElem.GetString() ?? string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        receipt = _executions.RequestLocalTillSoil(stepReqId, x, y, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_target_handle");

            case "water_crop":
                if (args.TryGetValue("targetHandle", out JsonElement waterHandleElem))
                {
                    string handle = waterHandleElem.GetString() ?? string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        string targetId = args.TryGetValue("expectedTargetId", out JsonElement idElem)
                            ? (idElem.GetString() ?? string.Empty)
                            : ResolveCropTargetId(location, x, y);

                        receipt = _executions.RequestLocalWaterCrop(stepReqId, x, y, targetId, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_target_handle");

            case "plant_seed":
                if (args.TryGetValue("slot", out JsonElement seedSlotElem) &&
                    args.TryGetValue("targetHandle", out JsonElement seedHandleElem) &&
                    args.TryGetValue("qualifiedItemId", out JsonElement seedItemElem))
                {
                    int seedSlot = seedSlotElem.GetInt32();
                    string handle = seedHandleElem.GetString() ?? string.Empty;
                    string itemId = seedItemElem.GetString() ?? string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        string targetId = args.TryGetValue("expectedTargetId", out JsonElement idElem)
                            ? (idElem.GetString() ?? string.Empty)
                            : $"seed_{location.NameOrUniqueName}:{seedSlot}:{x},{y}:{itemId}";

                        receipt = _executions.RequestLocalPlantSeed(stepReqId, seedSlot, x, y, itemId, targetId, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_plant_seed_args");

            case "fertilize_tile":
                if (args.TryGetValue("slot", out JsonElement fertSlotElem) &&
                    args.TryGetValue("targetHandle", out JsonElement fertHandleElem) &&
                    args.TryGetValue("qualifiedItemId", out JsonElement fertItemElem))
                {
                    int fertSlot = fertSlotElem.GetInt32();
                    string handle = fertHandleElem.GetString() ?? string.Empty;
                    string itemId = fertItemElem.GetString() ?? string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        string targetId = args.TryGetValue("expectedTargetId", out JsonElement idElem)
                            ? (idElem.GetString() ?? string.Empty)
                            : $"fertilizer_{location.NameOrUniqueName}:{fertSlot}:{x},{y}:{itemId}";

                        receipt = _executions.RequestLocalFertilizeTile(stepReqId, fertSlot, x, y, itemId, targetId, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_fertilize_tile_args");

            case "harvest_crop":
                if (args.TryGetValue("targetHandle", out JsonElement harvestHandleElem))
                {
                    string handle = harvestHandleElem.GetString() ?? string.Empty;
                    string itemId = args.TryGetValue("qualifiedItemId", out JsonElement itemElem) ? (itemElem.GetString() ?? string.Empty) : string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        string targetId = args.TryGetValue("expectedTargetId", out JsonElement idElem)
                            ? (idElem.GetString() ?? string.Empty)
                            : ResolveCropTargetId(location, x, y);

                        receipt = _executions.RequestLocalHarvestCrop(stepReqId, x, y, itemId, targetId, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_harvest_crop_args");

            case "pickup_forage":
            case "collect_forage":
                if (args.TryGetValue("targetHandle", out JsonElement forageHandleElem))
                {
                    string handle = forageHandleElem.GetString() ?? string.Empty;
                    string itemId = args.TryGetValue("qualifiedItemId", out JsonElement itemElem) ? (itemElem.GetString() ?? string.Empty) : string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        string targetId = args.TryGetValue("expectedTargetId", out JsonElement idElem)
                            ? (idElem.GetString() ?? string.Empty)
                            : ResolveForageTargetId(location, x, y);

                        receipt = _executions.RequestLocalPickupForage(stepReqId, x, y, itemId, targetId, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_forage_args");

            case "use_item":
                if (args.TryGetValue("slot", out JsonElement useSlotElem) && useSlotElem.TryGetInt32(out int useSlot))
                {
                    string itemId = args.TryGetValue("qualifiedItemId", out JsonElement itemElem) ? (itemElem.GetString() ?? string.Empty) : string.Empty;
                    receipt = _executions.RequestLocalUseItem(stepReqId, useSlot, itemId, deadline);
                    return receipt.State == ExecutionState.Succeeded
                        ? Result.Ok<string, string>(receipt.ReasonCode)
                        : Result.Fail<string, string>(receipt.ReasonCode);
                }
                return Result.Fail<string, string>("missing_slot_arg");

            case "clear_hoedirt":
                if (args.TryGetValue("slot", out JsonElement clearSlotElem) && clearSlotElem.TryGetInt32(out int clearSlot) &&
                    args.TryGetValue("targetHandle", out JsonElement clearHandleElem))
                {
                    string handle = clearHandleElem.GetString() ?? string.Empty;
                    if (TryParseTileHandle(handle, out int x, out int y))
                    {
                        string targetId = args.TryGetValue("expectedTargetId", out JsonElement idElem)
                            ? (idElem.GetString() ?? string.Empty)
                            : string.Empty;

                        receipt = _executions.RequestLocalClearHoeDirt(stepReqId, clearSlot, x, y, targetId, deadline);
                        return receipt.State == ExecutionState.Succeeded
                            ? Result.Ok<string, string>(receipt.ReasonCode)
                            : Result.Fail<string, string>(receipt.ReasonCode);
                    }
                }
                return Result.Fail<string, string>("invalid_clear_hoedirt_args");

            default:
                return Result.Fail<string, string>($"unsupported_step_action:{actionType.ToLowerInvariant()}");
        }
    }

    private static bool TryParseTileHandle(string handle, out int x, out int y)
    {
        x = 0;
        y = 0;
        if (string.IsNullOrWhiteSpace(handle)) return false;
        var match = TileHandleRegex.Match(handle);
        if (match.Success && int.TryParse(match.Groups[1].Value, out x) && int.TryParse(match.Groups[2].Value, out y))
        {
            return true;
        }
        return false;
    }

    private static string ResolveCropTargetId(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        if (location.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature) && feature is HoeDirt dirt && dirt.crop != null)
        {
            return ExecutionManager.BuildCropTargetId(location, x, y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value);
        }
        return string.Empty;
    }

    private static string ResolveForageTargetId(GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        if (location.objects.TryGetValue(tile, out StardewValley.Object? forage) && forage.isForage())
        {
            return ExecutionManager.BuildForageTargetId(location, x, y, forage);
        }
        return string.Empty;
    }
}
```

```csharp
// Modifications to integrations/stardew/BridgeSession.cs:
// 1. In HasExactArgumentShape:
private static bool HasExactArgumentShape(string action, BridgeExecutionArgs args)
{
    if (action == "sop_composite_pipeline")
    {
        return args.AdditionalProperties != null &&
               args.AdditionalProperties.ContainsKey("pipelinePayload") &&
               !args.X.HasValue && !args.Y.HasValue && !args.Slot.HasValue &&
               args.ExpectedQualifiedItemId is null && args.ExpectedTargetId is null;
    }
    if (args.AdditionalProperties is { Count: > 0 }) return false;
    // ... rest of method
}

// 2. In IsStructurallyValidExecutionRequest:
if (request.Action == "sop_composite_pipeline")
{
    if (request.Args.AdditionalProperties is null || !request.Args.AdditionalProperties.TryGetValue("pipelinePayload", out JsonElement elem) || elem.ValueKind != JsonValueKind.Object)
    {
        reasonCode = "invalid_execution_request";
        return false;
    }
}

// 3. In TryExecute Fingerprint computation:
string pipelinePart = request.Action == "sop_composite_pipeline" && request.Args.AdditionalProperties != null && request.Args.AdditionalProperties.TryGetValue("pipelinePayload", out JsonElement pipeElem)
    ? pipeElem.GetRawText().Length.ToString()
    : "none";
string fingerprint = $"{request.RequestId}:{request.Action}:{request.Args.X}:{request.Args.Y}:{request.Args.Slot}:{request.Args.ExpectedQualifiedItemId}:{request.Args.ExpectedTargetId}:{request.ExpectedRevision}:{pipelinePart}";
```

```csharp
// Modifications to integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs:
// Add Definition to FarmhandActionCatalog.Definitions:
Definition("sop_composite_pipeline", "meta_composition", 1, FarmhandActionLifecycle.Published),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~SopCompositeActionHandlerTests"`  
Expected: PASS.

---

### Task 6: Host Dynamic Domain SOP Registry, Hot-Registration & Diagnostic-Only Feedback

**Files:**
- Create: `host/src/dynamic-action-registry.ts`
- Test: `host/src/dynamic-action-registry.test.ts`

**Interfaces:**
- Consumes: `DomainActionPipeline`, `createDomainActionPipeline`, `interpretPreflight`, `PullbackSpec`, `verifyPullbackEqualizer`.
- Produces: `DeclarativeDomainActionSpec`, `DynamicActionRegistry`, `createDynamicActionRegistry`, `DynamicActionExecutionFeedback`.

- [ ] **Step 1: Write failing unit and PBT tests for dynamic hot-registration, preflight invariant validation, and diagnostic feedback**

```typescript
// host/src/dynamic-action-registry.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  createDynamicActionRegistry,
  type DeclarativeDomainActionSpec,
} from "./dynamic-action-registry.js";
import type { PreflightSnapshot } from "./action-preflight-interpreter.js";
import type { ExecutionReceipt } from "./protocol.js";

test("Dynamic Action Registry: catalogs SOP macro and produces diagnostic feedback", async () => {
  const registry = createDynamicActionRegistry();

  const spec: DeclarativeDomainActionSpec = {
    actionId: "custom_water_crop_sequence",
    family: "crop_farming",
    description: "Equip watering can in slot 1 and water target crop handle.",
    pipeline: [
      { type: "equip_tool", slot: 1, toolName: "Watering Can" },
      { type: "water_crop", targetHandle: "soil:24,34" },
    ],
    preflightInvariants: {
      requiredLocation: "Farm",
      requiredTools: ["Watering Can"],
      minimumStamina: 2,
    },
    pullbackEqualizer: {
      targetProperty: "terrain.soil_dirt.state.watered",
      targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
      expectedValue: true,
    },
  };

  const registerResult = registry.register(spec);
  assert.equal(registerResult.success, true);
  assert.equal(registry.hasAction("custom_water_crop_sequence"), true);

  const snapshot: PreflightSnapshot = {
    currentLocation: "Farm",
    playerStamina: 50,
    inventorySlots: [{ slot: 1, label: "Watering Can" }],
    verifiedHandles: ["soil:24,34"],
  };

  const preflight = registry.preflight("custom_water_crop_sequence", snapshot);
  assert.equal(preflight.isValid, true);
  assert.equal(preflight.estimatedStaminaCost, 2);

  // Equalizer verification feedback test
  const successReceipt: ExecutionReceipt = {
    executionId: "exec_01",
    requestId: "req_01",
    state: "succeeded",
    reasonCode: "equalizer_matched",
    revision: 10,
    evidence: {
      action: "custom_water_crop_sequence",
      targetProperty: "terrain.soil_dirt.state.watered",
      targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
      expectedValue: true,
      actualValue: true,
      equalizerMatched: true,
    },
  };
  const successFeedback = registry.evaluateReceipt("custom_water_crop_sequence", successReceipt);
  assert.equal(successFeedback.status, "verified");

  // Diagnostic feedback on mismatch (Zero auto-retry!)
  const mismatchReceipt: ExecutionReceipt = {
    executionId: "exec_02",
    requestId: "req_02",
    state: "failed",
    reasonCode: "equalizer_mismatch",
    revision: 11,
    evidence: {
      action: "custom_water_crop_sequence",
      targetProperty: "terrain.soil_dirt.state.watered",
      targetLocation: { location: "Farm", tile: { x: 24, y: 34 } },
      expectedValue: true,
      actualValue: false,
      equalizerMatched: false,
      failedStepIndex: null,
    },
  };
  const mismatchFeedback = registry.evaluateReceipt("custom_water_crop_sequence", mismatchReceipt);
  assert.equal(mismatchFeedback.status, "diagnostic_feedback");
  assert.equal(mismatchFeedback.delta?.expectedValue, true);
  assert.equal(mismatchFeedback.delta?.actualValue, false);

  // Infrastructure error feedback
  const errorReceipt: ExecutionReceipt = {
    executionId: "exec_03",
    requestId: "req_03",
    state: "cancelled",
    reasonCode: "epoch_interrupted",
    revision: 12,
    evidence: null,
  };
  const errorFeedback = registry.evaluateReceipt("custom_water_crop_sequence", errorReceipt);
  assert.equal(errorFeedback.status, "execution_error");
});

test("Dynamic Action Registry: enforces spec preflightInvariants", () => {
  const registry = createDynamicActionRegistry();
  const spec: DeclarativeDomainActionSpec = {
    actionId: "test_action_location_gate",
    family: "test",
    description: "Requires FarmHouse location",
    pipeline: [{ type: "skip_event" }],
    preflightInvariants: {
      requiredLocation: "FarmHouse",
      minimumStamina: 80,
    },
    pullbackEqualizer: {
      targetProperty: "none",
      targetLocation: { location: "FarmHouse", tile: { x: 0, y: 0 } },
      expectedValue: null,
    },
  };
  registry.register(spec);

  const wrongLocationSnapshot: PreflightSnapshot = {
    currentLocation: "Farm",
    playerStamina: 100,
    inventorySlots: [],
    verifiedHandles: [],
  };
  const preflightRes = registry.preflight("test_action_location_gate", wrongLocationSnapshot);
  assert.equal(preflightRes.isValid, false);
});

test("Dynamic Action Registry: PBT Registration Idempotency Invariants", () => {
  const registry = createDynamicActionRegistry();

  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (actionName) => {
      const spec: DeclarativeDomainActionSpec = {
        actionId: `action_${actionName}`,
        family: "generic",
        description: "Dynamic test action",
        pipeline: [{ type: "skip_event" }],
        preflightInvariants: { minimumStamina: 0 },
        pullbackEqualizer: {
          targetProperty: "none",
          targetLocation: { location: "Farm", tile: { x: 0, y: 0 } },
          expectedValue: null,
        },
      };

      registry.register(spec);
      assert.equal(registry.hasAction(`action_${actionName}`), true);
      registry.unregister(`action_${actionName}`);
      assert.equal(registry.hasAction(`action_${actionName}`), false);
    }),
    { numRuns: 100 },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/dynamic-action-registry.test.js`  
Expected: FAIL with "Cannot find module './dynamic-action-registry.js'".

- [ ] **Step 3: Implement `host/src/dynamic-action-registry.ts`**

```typescript
// host/src/dynamic-action-registry.ts
import { createDomainActionPipeline, type DomainActionNode } from "./action-ast.js";
import {
  interpretPreflight,
  type PreflightResult,
  type PreflightSnapshot,
} from "./action-preflight-interpreter.js";
import {
  type PullbackSpec,
  verifyPullbackEqualizer,
} from "./pullback-receipt.js";
import type { ExecutionReceipt } from "./protocol.js";

export interface DeclarativeDomainActionSpec {
  readonly actionId: string;
  readonly family: string;
  readonly description: string;
  readonly pipeline: readonly DomainActionNode[];
  readonly preflightInvariants: {
    readonly requiredTools?: readonly string[];
    readonly minimumStamina?: number;
    readonly requiredLocation?: string;
  };
  readonly pullbackEqualizer: PullbackSpec;
}

export interface DynamicActionExecutionFeedback {
  readonly status: "verified" | "diagnostic_feedback" | "execution_error";
  readonly reasonCode: string;
  readonly delta?: {
    readonly targetProperty: string;
    readonly expectedValue: unknown;
    readonly actualValue: unknown;
  };
}

export interface DynamicActionRegistry {
  register(spec: DeclarativeDomainActionSpec): { readonly success: boolean; readonly reason?: string };
  unregister(actionId: string): boolean;
  hasAction(actionId: string): boolean;
  getActionSpec(actionId: string): DeclarativeDomainActionSpec | undefined;
  preflight(actionId: string, snapshot: PreflightSnapshot): PreflightResult;
  evaluateReceipt(actionId: string, receipt: ExecutionReceipt): DynamicActionExecutionFeedback;
  listActions(): readonly DeclarativeDomainActionSpec[];
}

export function createDynamicActionRegistry(): DynamicActionRegistry {
  const actions = new Map<string, DeclarativeDomainActionSpec>();

  return {
    register: (spec: DeclarativeDomainActionSpec) => {
      if (!spec.actionId || typeof spec.actionId !== "string") {
        return { success: false, reason: "invalid_action_id" };
      }
      if (!Array.isArray(spec.pipeline) || spec.pipeline.length === 0) {
        return { success: false, reason: "empty_pipeline" };
      }
      actions.set(spec.actionId, Object.freeze({ ...spec }));
      return { success: true };
    },

    unregister: (actionId: string) => {
      return actions.delete(actionId);
    },

    hasAction: (actionId: string) => actions.has(actionId),

    getActionSpec: (actionId: string) => actions.get(actionId),

    preflight: (actionId: string, snapshot: PreflightSnapshot): PreflightResult => {
      const spec = actions.get(actionId);
      if (!spec) {
        return {
          isValid: false,
          estimatedStaminaCost: 0,
          missingTools: ["action_not_found"],
          missingHandles: [],
        };
      }

      const plan = createDomainActionPipeline(spec.pipeline);
      const baseResult = interpretPreflight(plan, snapshot);

      const missingTools = [...baseResult.missingTools];
      const missingHandles = [...baseResult.missingHandles];

      if (spec.preflightInvariants.requiredTools) {
        for (const tool of spec.preflightInvariants.requiredTools) {
          const hasTool = snapshot.inventorySlots.some((s) => s.label === tool);
          if (!hasTool && !missingTools.includes(tool)) {
            missingTools.push(tool);
          }
        }
      }

      if (spec.preflightInvariants.requiredLocation) {
        if (snapshot.currentLocation !== spec.preflightInvariants.requiredLocation) {
          missingHandles.push(`location_mismatch:${spec.preflightInvariants.requiredLocation}`);
        }
      }

      const minStamina = spec.preflightInvariants.minimumStamina ?? 0;
      const effectiveCost = Math.max(baseResult.estimatedStaminaCost, minStamina);
      const isValid =
        missingTools.length === 0 &&
        missingHandles.length === 0 &&
        snapshot.playerStamina >= effectiveCost;

      return {
        isValid,
        estimatedStaminaCost: effectiveCost,
        missingTools: Object.freeze(missingTools),
        missingHandles: Object.freeze(missingHandles),
      };
    },

    evaluateReceipt: (actionId: string, receipt: ExecutionReceipt): DynamicActionExecutionFeedback => {
      const spec = actions.get(actionId);
      if (!spec) {
        return { status: "execution_error", reasonCode: "action_not_found" };
      }

      if (receipt.state === "cancelled" || receipt.state === "timed_out" || receipt.state === "rejected") {
        return { status: "execution_error", reasonCode: receipt.reasonCode };
      }

      const isMatch = verifyPullbackEqualizer(receipt);
      if (isMatch && receipt.state === "succeeded") {
        return { status: "verified", reasonCode: receipt.reasonCode };
      }

      const evidence = (receipt.evidence ?? {}) as Record<string, unknown>;
      return {
        status: "diagnostic_feedback",
        reasonCode: receipt.reasonCode,
        delta: {
          targetProperty: spec.pullbackEqualizer.targetProperty,
          expectedValue: evidence.expectedValue ?? spec.pullbackEqualizer.expectedValue,
          actualValue: evidence.actualValue,
        },
      };
    },

    listActions: () => Array.from(actions.values()),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json && node --test host/dist-test/dynamic-action-registry.test.js`  
Expected: PASS.

---

### Task 7: Full Regression, Integration & Universal Law Verification Suite

- [ ] **Step 1: Execute complete host and .NET test verification suite**

Run all test gates across TypeScript and .NET:
```powershell
pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json
pnpm --filter @gamebuddy/companion-host test
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests
```
Expected: All suites pass with zero failures, full algebraic law conformance over domain-grounded actions, and fail-closed exception isolation.
