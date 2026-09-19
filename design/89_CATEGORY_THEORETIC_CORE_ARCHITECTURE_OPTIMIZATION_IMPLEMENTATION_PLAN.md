# Category-Theoretic Core Architecture Optimization Implementation Plan (Production-Aligned, Non-Regressive & Mathematically Rigorous)

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Superseded by `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md` for its protocol-codegen, generic Result/SOP, and category verification runtime proposals. Do not execute this plan as written. Retain only independently production-owned laws that a current owning design explicitly adopts.

**Historical goal:** Refactor GameBuddy core architecture using Category Theory principles (Functorial Protocol SSOT, Synchronous Kleisli Action Step Composition, Pullback Capability Negotiation, Monoidal Lifecycle FSM, and Pure Snapshot Projections) to eliminate structural drift, decompose execution pathways, and establish mathematically sound boundaries—strictly adhering to [`AGENTS.md`](file:///E:/projects/ai-game-companion/AGENTS.md) (no heavy FP dependencies, zero over-engineering, zero action regressions, direct integration into existing production code paths, and default-deny execution authority).

**Architecture:**
1. **Functorial SSOT (`protocol/bridge-v1.schema.json` & `tools/generate-protocol.mjs`):** Authoritative Bridge Protocol Schema compiled directly into TypeScript DTOs/validators ([`host/src/protocol.generated.ts`](file:///E:/projects/ai-game-companion/host/src/protocol.generated.ts)) and C# record models ([`integrations/stardew/src/Core/Protocol/Protocol.Generated.cs`](file:///E:/projects/ai-game-companion/integrations/stardew/src/Core/Protocol/Protocol.Generated.cs)) with positive naturality roundtrip PBT covering all 12 production execution states and negative fuzzing PBT for fail-closed rejection of missing/invalid required fields.
2. **Zero-Allocation `Result<TValue, TError>` (`integrations/stardew/src/Core/Algebra/Result.cs`):** Value-type Railway monad with default-struct null safety across arbitrary generic value/error types, Monad Laws (`Bind`, `Map`, `Match`), Functor Laws, and backward-compatible `Fail` alias, throwing clean `InvalidOperationException` on uninitialized access.
3. **Decomposed Synchronous Step Handlers (`integrations/stardew/src/Core/Abstractions/IStepHandler.cs` & `Handlers/`):** Pure, synchronous step handlers supporting all 9 production farming and interaction actions (`till_soil`, `equip_tool`, `water_crop`, `plant_seed`, `fertilize_tile`, `harvest_crop`, `pickup_forage`, `use_item`, `clear_hoedirt`) executing directly on the MonoGame update thread without sync-over-async deadlock hazards or trampoline callbacks.
4. **Kleisli Action Pipeline Invariants (`integrations/stardew/src/Core/Algebra/SopStepPipeline.cs`):** Unified, non-redundant step pipeline runner enforcing Fail-Closed short-circuiting, timeout barriers, native exception containment, and preserving exact step-boundary receipts across 6 FsCheck PBT properties.
5. **Capability Pullback (`host/src/action-registry.ts`):** Direct hardening of `visiblePublishedActions` via `resolveCapabilityPullback` to satisfy the Category Pullback Universal Property ($R \cap L \cap P^{\complement}$) across both `deniedActions` and `deniedFamilies`, verified by fast-check PBT.
6. **Monoidal Lifecycle FSM (`packages/voice-protocol/src/lifecycle-fsm.ts`):** 5-state lifecycle FSM (`uninitialized -> starting -> active -> draining -> terminal`) with atomic cancellation absorption ($\text{Cancel}(\text{Starting}) \equiv \text{Terminal}$), Model-Based state machine PBT, and concurrent asynchronous race verification.
7. **State Snapshot Functional Projections (`host/src/snapshot-projection.ts`):** Deterministic, pure projections focusing on live [`Snapshot`](file:///E:/projects/ai-game-companion/host/src/protocol.ts) movement, farming, and inventory sub-structures, directly integrated into host presentation.
8. **Workspace Verification Gate (`tools/verify-category-theoretic-architecture.mjs`):** Recursive Core AST boundary audit (zero forbidden references), schema SSOT drift detection, and all-suite verification across Host, Voice Protocol, Stardew Core, and Integration tests.

**Tech Stack:** TypeScript 5.9 (Host), Node.js Test Runner, Host Zero-Dependency PBT ([`host/src/test-support/fast-check.ts`](file:///E:/projects/ai-game-companion/host/src/test-support/fast-check.ts)), C# 10 / .NET 6 (`GameBuddy.Stardew.Core`), xUnit, FluentAssertions, `FsCheck.Xunit` (C# PBT).

**Spec Reference:** [`design/88_CATEGORY_THEORETIC_CORE_ARCHITECTURE_OPTIMIZATION_SPEC.md`](file:///E:/projects/ai-game-companion/design/88_CATEGORY_THEORETIC_CORE_ARCHITECTURE_OPTIMIZATION_SPEC.md)

---

## Global Constraints & Codebase Invariants

- **Zero Heavy FP Dependencies:** Native TypeScript Discriminated Unions and C# `readonly record struct Result<TValue, TError>` with `CA1715`/`CA1000` compliance. No `fp-ts`, `LanguageExt`, or `Cats`.
- **True Single Source of Truth:** `protocol/bridge-v1.schema.json` is the sole protocol authority; no parallel mini-schemas.
- **Zero Action Regression:** All 9 production action types in `SmapiLiveStepRunner` must remain fully supported.
- **Default-Struct Null Safety:** C# `Result<TValue, TError>` struct default instances (`default(Result<T, E>)`) are treated safely as uninitialized failure and must never throw `NullReferenceException` when queried (`IsSuccess` is false, `IsFailure` is true), mapped, or bound. Explicit access to uninitialized `.Value`, `.Error`, or uninitialized `.Match` throws descriptive `InvalidOperationException`.
- **Game Thread Synchrony (No Sync-over-Async):** Mod domain morphisms on the MonoGame/SMAPI main game loop must execute synchronously. Never call `.GetAwaiter().GetResult()` or block the game thread.
- **No Trampoline Indirection:** Handlers handle pure argument parsing and validation; `SmapiLiveStepRunner` coordinates direct execution against `ExecutionManager`.
- **Step-Boundary Preservation:** Partial mutations are never masked; pipeline receipts record exact precursor step receipts and failure indices.
- **Mod Execution Authority:** Mod maintains default-deny execution authority on game thread; Host never issues tick-level control or raw unobserved coordinates.

---

### Task 1: Protocol Schema SSOT & Functorial Cross-Language Code Generation

**Files:**
- Create: `tools/generate-protocol.mjs`
- Create: `host/src/protocol.generated.ts`
- Create: `integrations/stardew/src/Core/Protocol/Protocol.Generated.cs`
- Test: `host/src/protocol-roundtrip.test.ts`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ProtocolRoundtripTests.cs`

**Interfaces:**
- Consumes: Authoritative schema definitions directly from [`protocol/bridge-v1.schema.json`](file:///E:/projects/ai-game-companion/protocol/bridge-v1.schema.json).
- Produces: `ExecutionRequestDto`, `ExecutionReceiptDto`, `EXECUTION_STATE_DTOS`, `EXECUTION_ACTION_DTOS`, `serializeExecutionRequest`, `deserializeExecutionRequest`, `serializeExecutionReceipt`, `deserializeExecutionReceipt` (TS) and C# records in `GameBuddy.Stardew.Core.Protocol`.

- [ ] **Step 1: Write failing positive & negative PBT tests for protocol types in TypeScript and C#**

```typescript
// host/src/protocol-roundtrip.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  type ExecutionRequestDto,
  type ExecutionReceiptDto,
  EXECUTION_STATE_DTOS,
  EXECUTION_ACTION_DTOS,
  serializeExecutionRequest,
  deserializeExecutionRequest,
  serializeExecutionReceipt,
  deserializeExecutionReceipt,
} from "./protocol.generated.js";

test("Functorial Naturality Invariant: ExecutionRequest JSON roundtrip preserves exact identity", () => {
  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: 0, max: 1000000 }),
        deadlineMs: fc.integer({ min: 1000, max: 10000000 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      (request: ExecutionRequestDto) => {
        const json = serializeExecutionRequest(request);
        const deserialized = deserializeExecutionRequest(json);
        assert.deepEqual(deserialized, request);
      }
    ),
    { numRuns: 100 }
  );
});

test("Functorial Naturality Invariant: ExecutionReceipt JSON roundtrip preserves all 12 production states and null evidence", () => {
  fc.assert(
    fc.property(
      fc.record({
        executionId: fc.string({ minLength: 1, maxLength: 36 }),
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        state: fc.constantFrom(...EXECUTION_STATE_DTOS),
        reasonCode: fc.string({ minLength: 1, maxLength: 128 }),
        revision: fc.integer({ min: 0, max: 1000000 }),
        evidence: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()), { nil: null }),
      }),
      (receipt: ExecutionReceiptDto) => {
        const json = serializeExecutionReceipt(receipt);
        const deserialized = deserializeExecutionReceipt(json);
        assert.deepEqual(deserialized, receipt);
      }
    ),
    { numRuns: 100 }
  );
});

test("Negative Fuzzing PBT: Malformed execution request payloads fail-closed", () => {
  const requiredKeys = ["requestId", "idempotencyKey", "action", "expectedRevision", "deadlineMs", "args"] as const;
  
  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: 0, max: 1000000 }),
        deadlineMs: fc.integer({ min: 1000, max: 10000000 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      fc.constantFrom(...requiredKeys),
      (validReq, keyToOmit) => {
        const mutated = { ...validReq };
        delete (mutated as any)[keyToOmit];
        assert.throws(() => deserializeExecutionRequest(JSON.stringify(mutated)));
      }
    ),
    { numRuns: 100 }
  );
});

test("Negative Fuzzing PBT: Unregistered or invalid action names fail-closed", () => {
  const invalidReq = {
    requestId: "req_1",
    idempotencyKey: "idem_1",
    action: "invalid_unregistered_action",
    expectedRevision: 1,
    deadlineMs: 5000,
    args: {},
  };
  assert.throws(() => deserializeExecutionRequest(JSON.stringify(invalidReq)), /invalid_action:invalid_unregistered_action/);
});

test("Negative Fuzzing PBT: ExecutionReceipt missing evidence key fails closed", () => {
  const validReceipt: ExecutionReceiptDto = {
    executionId: "exec_1",
    requestId: "req_1",
    state: "succeeded",
    reasonCode: "ok",
    revision: 1,
    evidence: null,
  };
  
  const withoutEvidence = { ...validReceipt };
  delete (withoutEvidence as any).evidence;
  assert.throws(() => deserializeExecutionReceipt(JSON.stringify(withoutEvidence)), /missing_required_field:evidence/);
});

test("Negative Numeric Fuzzing PBT: Non-positive deadlines and negative revisions fail-closed", () => {
  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: -10000, max: -1 }),
        deadlineMs: fc.integer({ min: 1000, max: 10000000 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      (invalidReq) => {
        assert.throws(() => deserializeExecutionRequest(JSON.stringify(invalidReq)), /invalid_expectedRevision/);
      }
    ),
    { numRuns: 50 }
  );

  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: 0, max: 1000000 }),
        deadlineMs: fc.integer({ min: -10000, max: 0 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      (invalidReq) => {
        assert.throws(() => deserializeExecutionRequest(JSON.stringify(invalidReq)), /invalid_deadlineMs/);
      }
    ),
    { numRuns: 50 }
  );
});

test("ExecutionRequest deserializer fails closed on invalid or malformed payload", () => {
  assert.throws(() => deserializeExecutionRequest("invalid json"), /invalid_request_json/);
  assert.throws(() => deserializeExecutionRequest(JSON.stringify(null)), /invalid_request_json/);
  assert.throws(() => deserializeExecutionRequest(JSON.stringify({ requestId: "" })), /missing_required_field/);
  assert.throws(() => deserializeExecutionRequest(JSON.stringify({ requestId: "r1", idempotencyKey: "k1", action: "till_soil", expectedRevision: "not_a_number" })), /invalid_expectedRevision/);
});

test("ExecutionReceipt deserializer fails closed on invalid state or missing fields", () => {
  assert.throws(() => deserializeExecutionReceipt("null"), /invalid_receipt_json/);
  assert.throws(() => deserializeExecutionReceipt(JSON.stringify({ executionId: "e1", requestId: "r1", state: "unknown_state" })), /missing_required_field/);
});

test("Functorial Immutability Invariant: Deserialized DTOs and their nested structures are deeply frozen", () => {
  const req = deserializeExecutionRequest(
    JSON.stringify({
      requestId: "req_1",
      idempotencyKey: "idem_1",
      action: "till_soil",
      expectedRevision: 1,
      deadlineMs: 5000,
      args: { nested: { prop: 42 } },
    })
  );
  assert.ok(Object.isFrozen(req));
  assert.ok(Object.isFrozen(req.args));
  assert.ok(Object.isFrozen((req.args as any).nested));

  const rec = deserializeExecutionReceipt(
    JSON.stringify({
      executionId: "exec_1",
      requestId: "req_1",
      state: "succeeded",
      reasonCode: "ok",
      revision: 1,
      evidence: { subEvidence: { value: "ok" } },
    })
  );
  assert.ok(Object.isFrozen(rec));
  assert.ok(Object.isFrozen(rec.evidence));
  assert.ok(Object.isFrozen((rec.evidence as any).subEvidence));
});
```

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ProtocolRoundtripTests.cs
using System;
using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class ProtocolRoundtripTests
{
    [Property(MaxTest = 100)]
    public Property ExecutionRequestDto_FsCheck_RoundtripPreservesExactValues(
        NonEmptyString reqId,
        NonEmptyString idemKey,
        NonNegativeInt rev,
        PositiveInt deadline,
        int x,
        int y)
    {
        var args = new Dictionary<string, JsonElement>
        {
            ["x"] = JsonSerializer.SerializeToElement(x),
            ["y"] = JsonSerializer.SerializeToElement(y)
        };
        var original = new ExecutionRequestDto(reqId.Get, idemKey.Get, "till_soil", rev.Get, deadline.Get, args);

        string json = JsonSerializer.Serialize(original);
        var deserialized = JsonSerializer.Deserialize<ExecutionRequestDto>(json);

        bool pass = deserialized != null &&
                    deserialized.RequestId == reqId.Get &&
                    deserialized.IdempotencyKey == idemKey.Get &&
                    deserialized.Action == "till_soil" &&
                    deserialized.ExpectedRevision == rev.Get &&
                    deserialized.DeadlineMs == deadline.Get &&
                    deserialized.Args != null &&
                    deserialized.Args.ContainsKey("x") &&
                    deserialized.Args["x"].GetInt32() == x;

        return pass.ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property ExecutionReceiptDto_FsCheck_RoundtripPreservesExactValues(
        NonEmptyString execId,
        NonEmptyString reqId,
        NonEmptyString reason,
        NonNegativeInt rev,
        bool hasEvidence,
        int evidenceVal)
    {
        IReadOnlyDictionary<string, JsonElement>? evidence = hasEvidence
            ? new Dictionary<string, JsonElement> { ["result"] = JsonSerializer.SerializeToElement(evidenceVal) }
            : null;

        var original = new ExecutionReceiptDto(execId.Get, reqId.Get, "succeeded", reason.Get, rev.Get, evidence);

        string json = JsonSerializer.Serialize(original);
        var deserialized = JsonSerializer.Deserialize<ExecutionReceiptDto>(json);

        bool pass = deserialized != null &&
                    deserialized.ExecutionId == execId.Get &&
                    deserialized.RequestId == reqId.Get &&
                    deserialized.State == "succeeded" &&
                    deserialized.ReasonCode == reason.Get &&
                    deserialized.Revision == rev.Get &&
                    (hasEvidence ? (deserialized.Evidence != null && deserialized.Evidence.ContainsKey("result") && deserialized.Evidence["result"].GetInt32() == evidenceVal) : deserialized.Evidence == null);

        return pass.ToProperty();
    }

    [Fact]
    public void ExecutionRequestDto_SystemTextJson_RoundtripPreservesExactValues()
    {
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15"),
            ["slot"] = JsonSerializer.SerializeToElement(2)
        };
        var original = new ExecutionRequestDto("req_100", "idem_200", "till_soil", 42, 5000, args);

        string json = JsonSerializer.Serialize(original);
        var deserialized = JsonSerializer.Deserialize<ExecutionRequestDto>(json);

        deserialized.Should().NotBeNull();
        deserialized!.RequestId.Should().Be("req_100");
        deserialized.IdempotencyKey.Should().Be("idem_200");
        deserialized.Action.Should().Be("till_soil");
        deserialized.ExpectedRevision.Should().Be(42);
        deserialized.DeadlineMs.Should().Be(5000);
        deserialized.Args.Should().ContainKey("targetHandle");
    }

    [Fact]
    public void ExecutionReceiptDto_SystemTextJson_HandlesNullAndNonNullEvidence()
    {
        var withNullEvidence = new ExecutionReceiptDto("exec_1", "req_1", "succeeded", "ok", 10, null);
        string jsonNull = JsonSerializer.Serialize(withNullEvidence);
        var deserializedNull = JsonSerializer.Deserialize<ExecutionReceiptDto>(jsonNull);
        deserializedNull.Should().NotBeNull();
        deserializedNull!.Evidence.Should().BeNull();

        var evidence = new Dictionary<string, JsonElement>
        {
            ["tilledTile"] = JsonSerializer.SerializeToElement("12,15")
        };
        var withEvidence = new ExecutionReceiptDto("exec_2", "req_2", "succeeded", "ok", 11, evidence);
        string jsonWith = JsonSerializer.Serialize(withEvidence);
        var deserializedWith = JsonSerializer.Deserialize<ExecutionReceiptDto>(jsonWith);
        deserializedWith.Should().NotBeNull();
        deserializedWith!.Evidence.Should().NotBeNull();
        deserializedWith.Evidence.Should().ContainKey("tilledTile");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix host run build:test && node --test host/dist-test/src/protocol-roundtrip.test.js`
Expected: FAIL with compilation error (module `./protocol.generated.js` not found).

- [ ] **Step 3: Implement schema-driven code generator reading directly from bridge-v1.schema.json**

```javascript
// tools/generate-protocol.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "../protocol/bridge-v1.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const executionStates = schema.$defs.executionState.enum;
const statesUnion = executionStates.map((s) => `"${s}"`).join(" | ");
const statesArrayJson = JSON.stringify(executionStates);

const executionActions = schema.$defs.executionRequest.properties.action.enum;
const actionsUnion = executionActions.map((a) => `"${a}"`).join(" | ");
const actionsArrayJson = JSON.stringify(executionActions);

const tsOutput = `// Auto-generated by tools/generate-protocol.mjs from protocol/bridge-v1.schema.json - DO NOT EDIT MANUALLY

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    const val = (value as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return Object.freeze(value);
}

export const EXECUTION_STATE_DTOS = Object.freeze(${statesArrayJson} as const);
export type ExecutionStateDto = ${statesUnion};

export const EXECUTION_ACTION_DTOS = Object.freeze(${actionsArrayJson} as const);
export type ExecutionActionDto = ${actionsUnion};

export interface ExecutionRequestDto {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly action: ExecutionActionDto;
  readonly expectedRevision: number;
  readonly deadlineMs: number;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ExecutionReceiptDto {
  readonly executionId: string;
  readonly requestId: string;
  readonly state: ExecutionStateDto;
  readonly reasonCode: string;
  readonly revision: number;
  readonly evidence: Readonly<Record<string, unknown>> | null;
}

export function serializeExecutionRequest(req: ExecutionRequestDto): string {
  return JSON.stringify(req);
}

export function deserializeExecutionRequest(json: string): ExecutionRequestDto {
  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("invalid_request_json");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("invalid_request_json");
  if (!obj.requestId || typeof obj.requestId !== "string") throw new Error("missing_required_field:requestId");
  if (!obj.idempotencyKey || typeof obj.idempotencyKey !== "string") throw new Error("missing_required_field:idempotencyKey");
  if (!obj.action || typeof obj.action !== "string") throw new Error("missing_required_field:action");
  
  const validActions = new Set<string>(EXECUTION_ACTION_DTOS);
  if (!validActions.has(obj.action)) {
    throw new Error("invalid_action:" + obj.action);
  }

  if (typeof obj.expectedRevision !== "number" || !Number.isInteger(obj.expectedRevision) || obj.expectedRevision < 0) {
    throw new Error("invalid_expectedRevision");
  }
  if (typeof obj.deadlineMs !== "number" || !Number.isInteger(obj.deadlineMs) || obj.deadlineMs <= 0) {
    throw new Error("invalid_deadlineMs");
  }
  if (obj.args === undefined || obj.args === null || typeof obj.args !== "object" || Array.isArray(obj.args)) {
    throw new Error("invalid_args");
  }

  return deepFreeze({
    requestId: obj.requestId,
    idempotencyKey: obj.idempotencyKey,
    action: obj.action,
    expectedRevision: obj.expectedRevision,
    deadlineMs: obj.deadlineMs,
    args: { ...obj.args },
  });
}

export function serializeExecutionReceipt(rec: ExecutionReceiptDto): string {
  return JSON.stringify(rec);
}

export function deserializeExecutionReceipt(json: string): ExecutionReceiptDto {
  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("invalid_receipt_json");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("invalid_receipt_json");
  if (!obj.executionId || typeof obj.executionId !== "string") throw new Error("missing_required_field:executionId");
  if (!obj.requestId || typeof obj.requestId !== "string") throw new Error("missing_required_field:requestId");
  if (!("evidence" in obj)) throw new Error("missing_required_field:evidence");
  
  const validStates = new Set<string>(EXECUTION_STATE_DTOS);
  if (!validStates.has(obj.state)) {
    throw new Error("invalid_state:" + obj.state);
  }
  if (typeof obj.reasonCode !== "string") throw new Error("missing_required_field:reasonCode");
  if (typeof obj.revision !== "number" || !Number.isInteger(obj.revision) || obj.revision < 0) {
    throw new Error("invalid_revision");
  }
  
  let evidence: Readonly<Record<string, unknown>> | null = null;
  if (obj.evidence !== null) {
    if (typeof obj.evidence !== "object" || Array.isArray(obj.evidence)) {
      throw new Error("invalid_evidence");
    }
    evidence = { ...obj.evidence };
  }

  return deepFreeze({
    executionId: obj.executionId,
    requestId: obj.requestId,
    state: obj.state,
    reasonCode: obj.reasonCode,
    revision: obj.revision,
    evidence,
  });
}
`;

const csOutput = `// Auto-generated by tools/generate-protocol.mjs from protocol/bridge-v1.schema.json - DO NOT EDIT MANUALLY
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Protocol;

public sealed record ExecutionRequestDto(
    [property: JsonPropertyName("requestId")] string RequestId,
    [property: JsonPropertyName("idempotencyKey")] string IdempotencyKey,
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("expectedRevision")] long ExpectedRevision,
    [property: JsonPropertyName("deadlineMs")] long DeadlineMs,
    [property: JsonPropertyName("args")] IReadOnlyDictionary<string, JsonElement> Args
);

public sealed record ExecutionReceiptDto(
    [property: JsonPropertyName("executionId")] string ExecutionId,
    [property: JsonPropertyName("requestId")] string RequestId,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("reasonCode")] string ReasonCode,
    [property: JsonPropertyName("revision")] long Revision,
    [property: JsonPropertyName("evidence")] IReadOnlyDictionary<string, JsonElement>? Evidence
);
`;

writeFileSync(resolve(__dirname, "../host/src/protocol.generated.ts"), tsOutput, "utf-8");
const csDir = resolve(__dirname, "../integrations/stardew/src/Core/Protocol");
mkdirSync(csDir, { recursive: true });
writeFileSync(resolve(csDir, "Protocol.Generated.cs"), csOutput, "utf-8");
console.log("Generated protocol bindings successfully for TypeScript and C# from bridge-v1.schema.json.");
```

- [ ] **Step 4: Run generator, compile, and verify roundtrip test passes across both TS and C#**

Run: `node tools/generate-protocol.mjs && npm --prefix host run build:test && node --test host/dist-test/src/protocol-roundtrip.test.js && dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ --filter ProtocolRoundtrip`
Expected: PASS with 100/100 PBT runs across all 12 production execution states, all 28 action enum types, and dual-language C#/TS suites.

- [ ] **Step 5: Commit task**

```bash
git add tools/generate-protocol.mjs host/src/protocol.generated.ts integrations/stardew/src/Core/Protocol/Protocol.Generated.cs host/src/protocol-roundtrip.test.ts integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ProtocolRoundtripTests.cs
git commit -m "feat(protocol): add schema-driven dual TS/C# codegen directly from bridge-v1 schema with action enum validation"
```

---

### Task 2: Zero-Allocation `Result<TValue, TError>` with Monad Laws and Default-Safety in C#

**Files:**
- Modify: `integrations/stardew/src/Core/Algebra/Result.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ResultTests.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ResultPropertyTests.cs`

**Interfaces:**
- Produces: `Result<TValue, TError>` with `Ok`, `Err`, `Fail` (backward-compat alias), `Bind`, `Map`, `Match`, `IsSuccess`, `IsFailure`, and default-struct safety across arbitrary value and reference generic types.

- [ ] **Step 1: Write failing unit and FsCheck PBT tests for Result Monad & Functor Laws and default-struct safety**

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ResultPropertyTests.cs
using System;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Algebra;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class ResultPropertyTests
{
    [Property(MaxTest = 100)]
    public Property Monad_LeftIdentityLaw(int x)
    {
        Func<int, Result<int, string>> f = v => v >= 0 
            ? Result<int, string>.Ok(v * 2) 
            : Result<int, string>.Err("negative");

        var res1 = Result<int, string>.Ok(x).Bind(f);
        var res2 = f(x);
        return (res1.Equals(res2)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Monad_RightIdentityLaw_OkAndErr(bool isSuccess, int val, NonEmptyString err)
    {
        var m = isSuccess ? Result<int, string>.Ok(val) : Result<int, string>.Err(err.Get);
        var res = m.Bind(Result<int, string>.Ok);
        return (res.Equals(m)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Monad_AssociativityLaw_OkAndErr(bool isSuccess, int val, NonEmptyString err)
    {
        Func<int, Result<int, string>> f = v => v % 2 == 0 ? Result<int, string>.Ok(v / 2) : Result<int, string>.Err("odd");
        Func<int, Result<int, string>> g = v => v < 100 ? Result<int, string>.Ok(v + 10) : Result<int, string>.Err("too_large");

        var m = isSuccess ? Result<int, string>.Ok(val) : Result<int, string>.Err(err.Get);

        var left = m.Bind(f).Bind(g);
        var right = m.Bind(v => f(v).Bind(g));
        return (left.Equals(right)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Functor_IdentityAndCompositionLaws(bool isSuccess, int val, NonEmptyString err)
    {
        Func<int, int> f = v => v + 5;
        Func<int, string> g = v => $"val:{v}";

        var m = isSuccess ? Result<int, string>.Ok(val) : Result<int, string>.Err(err.Get);

        var identityPass = m.Map(x => x).Equals(m);
        var compositionPass = m.Map(f).Map(g).Equals(m.Map(x => g(f(x))));

        return (identityPass && compositionPass).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property DefaultStruct_NeverThrows_AndRemainsFailure(int offset)
    {
        var defaultResult = default(Result<int, string>);
        var mapped = defaultResult.Map(v => v + offset);
        var bound = defaultResult.Bind(v => Result<int, string>.Ok(v + offset));

        bool isMappedFailure = mapped.IsFailure && !mapped.IsSuccess;
        bool isBoundFailure = bound.IsFailure && !bound.IsSuccess;

        return (isMappedFailure && isBoundFailure).ToProperty();
    }
}
```

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ResultTests.cs
using System;
using FluentAssertions;
using GameBuddy.Stardew.Core.Algebra;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class ResultTests
{
    private sealed record CustomError(string Code, int Severity);

    [Fact]
    public void OkResult_PropertiesAndMap_WorkAsExpected()
    {
        var result = Result<int, string>.Ok(42);
        result.IsSuccess.Should().BeTrue();
        result.IsFailure.Should().BeFalse();
        result.Value.Should().Be(42);
        
        var mapped = result.Map(x => x.ToString());
        mapped.IsSuccess.Should().BeTrue();
        mapped.Value.Should().Be("42");
    }

    [Fact]
    public void ErrResult_FailCompatAliasAndMatch_WorkAsExpected()
    {
        var result = Result<int, string>.Fail("operation_failed");
        result.IsSuccess.Should().BeFalse();
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("operation_failed");

        var matched = result.Match(v => $"ok:{v}", e => $"err:{e}");
        matched.Should().Be("err:operation_failed");
    }

    [Fact]
    public void DefaultStructResult_AccessingValueOrErrorOrMatch_ThrowsInvalidOperationException()
    {
        var defaultStringErr = default(Result<int, string>);
        defaultStringErr.IsSuccess.Should().BeFalse();
        defaultStringErr.IsFailure.Should().BeTrue();

        Action actErr = () => { var _ = defaultStringErr.Error; };
        Action actVal = () => { var _ = defaultStringErr.Value; };
        Action actMatch = () => { var _ = defaultStringErr.Match(v => "ok", e => "err"); };

        actErr.Should().Throw<InvalidOperationException>().WithMessage("*uninitialized*");
        actVal.Should().Throw<InvalidOperationException>().WithMessage("*uninitialized*");
        actMatch.Should().Throw<InvalidOperationException>().WithMessage("*uninitialized*");
    }

    [Fact]
    public void DefaultStructResult_CustomReferenceType_NeverThrowsOnMapOrBind()
    {
        var defaultCustom = default(Result<int, CustomError>);
        defaultCustom.IsSuccess.Should().BeFalse();
        defaultCustom.IsFailure.Should().BeTrue();

        var mapped = defaultCustom.Map(v => v * 2);
        mapped.IsFailure.Should().BeTrue();

        var bound = defaultCustom.Bind(v => Result<string, CustomError>.Ok($"val:{v}"));
        bound.IsFailure.Should().BeTrue();
    }

    [Fact]
    public void AccessingInvalidField_ThrowsInvalidOperationException()
    {
        var ok = Result<int, string>.Ok(10);
        var err = Result<int, string>.Err("error");

        Action actOkErr = () => { var _ = ok.Error; };
        Action actErrVal = () => { var _ = err.Value; };

        actOkErr.Should().Throw<InvalidOperationException>();
        actErrVal.Should().Throw<InvalidOperationException>();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ --filter Result`
Expected: FAIL due to missing `Bind`, `Map`, `Match`, and uninitialized struct safety.

- [ ] **Step 3: Update `Result.cs` with zero-allocation struct, Monadic combinators, and default-struct safety**

```csharp
// integrations/stardew/src/Core/Algebra/Result.cs
using System;
using System.Diagnostics.CodeAnalysis;

namespace GameBuddy.Stardew.Core.Algebra;

[SuppressMessage("Design", "CA1000:Do not declare static members on generic types", Justification = "Ergonomic railway result constructors avoiding FsCheck namespace collisions")]
[SuppressMessage("Naming", "CA1715:Identifiers should have correct prefix", Justification = "Standard FP generic parameter naming")]
public readonly record struct Result<TValue, TError>
{
    private readonly TValue? _value;
    private readonly TError? _error;
    private readonly bool _initialized;

    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;

    private Result(TValue value)
    {
        _initialized = true;
        IsSuccess = true;
        _value = value;
        _error = default;
    }

    private Result(TError error, bool _)
    {
        ArgumentNullException.ThrowIfNull(error);
        _initialized = true;
        IsSuccess = false;
        _value = default;
        _error = error;
    }

    public static Result<TValue, TError> Ok(TValue value) => new(value);
    public static Result<TValue, TError> Err(TError error) => new(error, false);
    public static Result<TValue, TError> Fail(TError error) => new(error, false);

    public TValue Value => _initialized && IsSuccess 
        ? _value! 
        : throw new InvalidOperationException(_initialized ? "Cannot access Value on Failure Result" : "Cannot access Value on uninitialized Result");
    
    public TError Error => _initialized && !IsSuccess 
        ? _error! 
        : throw new InvalidOperationException(_initialized ? "Cannot access Error on Success Result" : "Cannot access Error on uninitialized Result");

    public Result<TOut, TError> Map<TOut>(Func<TValue, TOut> map)
    {
        ArgumentNullException.ThrowIfNull(map);
        if (!_initialized) return default;
        return IsSuccess ? Result<TOut, TError>.Ok(map(_value!)) : Result<TOut, TError>.Err(_error!);
    }

    public Result<TOut, TError> Bind<TOut>(Func<TValue, Result<TOut, TError>> bind)
    {
        ArgumentNullException.ThrowIfNull(bind);
        if (!_initialized) return default;
        return IsSuccess ? bind(_value!) : Result<TOut, TError>.Err(_error!);
    }

    public TOut Match<TOut>(Func<TValue, TOut> onSuccess, Func<TError, TOut> onFailure)
    {
        ArgumentNullException.ThrowIfNull(onSuccess);
        ArgumentNullException.ThrowIfNull(onFailure);
        if (!_initialized) throw new InvalidOperationException("Cannot match on uninitialized Result");
        return IsSuccess ? onSuccess(_value!) : onFailure(_error!);
    }
}
```

- [ ] **Step 4: Run all C# Core tests to verify zero regressions and all PBT Monad laws pass**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/`
Expected: PASS with 100% tests passing.

- [ ] **Step 5: Commit task**

```bash
git add integrations/stardew/src/Core/Algebra/Result.cs integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ResultTests.cs integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ResultPropertyTests.cs
git commit -m "feat(stardew): enhance Result struct with Monad combinators, default safety, and FsCheck PBT"
```

---

### Task 3: Decomposed Synchronous Step Handlers & Full Action Set SMAPI Execution Seam

**Files:**
- Create: `integrations/stardew/src/Core/Abstractions/IStepHandler.cs`
- Create: `integrations/stardew/src/Core/Handlers/StepHandlers.cs`
- Modify: `integrations/stardew/Handlers/SmapiLiveStepRunner.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerTests.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerPropertyTests.cs`

**Interfaces:**
- Consumes: `Result<TValue, TError>` from `GameBuddy.Stardew.Core.Algebra`.
- Produces: `IStepHandler` and isolated pure synchronous argument validators for all 9 production actions (`till_soil`, `equip_tool`, `water_crop`, `plant_seed`, `fertilize_tile`, `harvest_crop`, `pickup_forage`, `use_item`, `clear_hoedirt`), cleanly dispatched by `SmapiLiveStepRunner` without trampoline indirection.

- [ ] **Step 1: Write failing unit and FsCheck PBT tests for StepHandler argument parsing with positive prefix variations & negative fuzzing**

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerPropertyTests.cs
using System.Collections.Generic;
using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class StepHandlerPropertyTests
{
    [Property(MaxTest = 100)]
    public Property EquipToolHandler_RejectsInvalidSlots_AndAcceptsValidSlots(int slot)
    {
        var handler = new EquipToolStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(slot)
        };

        var result = handler.ValidateArgs(args);
        bool expectedSuccess = slot >= 0 && slot <= 36;
        return (result.IsSuccess == expectedSuccess).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property TillSoilHandler_ParsesCoordinates_AcrossPrefixVariations(NonNegativeInt x, NonNegativeInt y, int formatKind)
    {
        var handler = new TillSoilStepHandler();
        string handle = (formatKind % 4) switch
        {
            0 => $"soil:{x.Get},{y.Get}",
            1 => $"soil_Farm:{x.Get}_{y.Get}",
            2 => $"Farm:{x.Get},{y.Get}",
            _ => $"{x.Get},{y.Get}"
        };
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement(handle)
        };

        var result = handler.ValidateArgs(args);
        return (result.IsSuccess && result.Value.X == x.Get && result.Value.Y == y.Get).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property WaterCropHandler_ParsesCoordinates_AcrossPrefixVariations(NonNegativeInt x, NonNegativeInt y, int formatKind)
    {
        var handler = new WaterCropStepHandler();
        string handle = (formatKind % 4) switch
        {
            0 => $"crop:{x.Get},{y.Get}",
            1 => $"crop_Farm:{x.Get}_{y.Get}",
            2 => $"Farm:{x.Get},{y.Get}",
            _ => $"{x.Get},{y.Get}"
        };
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement(handle)
        };

        var result = handler.ValidateArgs(args);
        return (result.IsSuccess && result.Value.X == x.Get && result.Value.Y == y.Get).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property NegativeFuzzing_MalformedTargetHandles_FailClosed(NonEmptyString randomNoise)
    {
        var tillHandler = new TillSoilStepHandler();
        var waterHandler = new WaterCropStepHandler();

        // If noise does not contain valid numeric coordinates, it must fail closed
        if (!randomNoise.Get.Contains(","))
        {
            var args = new Dictionary<string, JsonElement> { ["targetHandle"] = JsonSerializer.SerializeToElement(randomNoise.Get) };
            var tillRes = tillHandler.ValidateArgs(args);
            var waterRes = waterHandler.ValidateArgs(args);
            return (tillRes.IsFailure && waterRes.IsFailure).ToProperty();
        }
        return true.ToProperty();
    }

    [Property(MaxTest = 50)]
    public Property NegativeFuzzing_NegativeCoordinates_FailClosed(NegativeInt negX, NegativeInt negY)
    {
        var tillHandler = new TillSoilStepHandler();
        var waterHandler = new WaterCropStepHandler();
        string handle = $"soil:{negX.Get},{negY.Get}";
        var args = new Dictionary<string, JsonElement> { ["targetHandle"] = JsonSerializer.SerializeToElement(handle) };
        var tillRes = tillHandler.ValidateArgs(args);
        var waterRes = waterHandler.ValidateArgs(args);
        return (tillRes.IsFailure && waterRes.IsFailure).ToProperty();
    }

    [Property(MaxTest = 50)]
    public Property CoordinateOverflow_ExceedingInt32_FailsClosedGracefully(PositiveInt largeOffset)
    {
        var tillHandler = new TillSoilStepHandler();
        long overflowX = (long)int.MaxValue + largeOffset.Get;
        string handle = $"soil:{overflowX},15";
        var args = new Dictionary<string, JsonElement> { ["targetHandle"] = JsonSerializer.SerializeToElement(handle) };
        var result = tillHandler.ValidateArgs(args);
        return (result.IsFailure && result.Error == "invalid_tile_coordinates").ToProperty();
    }
}
```

```csharp
// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerTests.cs
using System;
using System.Collections.Generic;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class StepHandlerTests
{
    [Fact]
    public void TillSoilHandler_MissingTargetHandle_FailsClosed()
    {
        var handler = new TillSoilStepHandler();
        var emptyArgs = new Dictionary<string, JsonElement>();

        var result = handler.ValidateArgs(emptyArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_target_handle");
    }

    [Fact]
    public void TillSoilHandler_CoordinateOverflow_FailsClosed()
    {
        var handler = new TillSoilStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:999999999999999999,10")
        };

        var result = handler.ValidateArgs(args);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("invalid_tile_coordinates");
    }

    [Fact]
    public void TillSoilHandler_NegativeCoordinates_FailsClosed()
    {
        var handler = new TillSoilStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:-5,-10")
        };

        var result = handler.ValidateArgs(args);
        result.IsFailure.Should().BeTrue();
    }

    [Fact]
    public void EquipToolHandler_NonIntegerOrOutOfRangeSlot_FailsClosed()
    {
        var handler = new EquipToolStepHandler();
        var strSlotArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement("first_slot")
        };
        handler.ValidateArgs(strSlotArgs).IsFailure.Should().BeTrue();

        var outOfRangeArgs = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(99)
        };
        handler.ValidateArgs(outOfRangeArgs).IsFailure.Should().BeTrue();
        handler.ValidateArgs(outOfRangeArgs).Error.Should().Be("invalid_tool_slot_range");
    }

    [Fact]
    public void WaterCropHandler_MissingCropTarget_FailsClosed()
    {
        var handler = new WaterCropStepHandler();
        var emptyArgs = new Dictionary<string, JsonElement>();

        var result = handler.ValidateArgs(emptyArgs);
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("missing_target_handle");
    }

    [Fact]
    public void PlantSeedHandler_ValidatesSlotAndTargetAndItemId()
    {
        var handler = new PlantSeedStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["slot"] = JsonSerializer.SerializeToElement(2),
            ["targetHandle"] = JsonSerializer.SerializeToElement("soil:12,15"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)472")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.Slot.Should().Be(2);
        result.Value.X.Should().Be(12);
        result.Value.Y.Should().Be(15);
        result.Value.QualifiedItemId.Should().Be("(O)472");
    }

    [Fact]
    public void HarvestCropHandler_ValidatesCoordinates()
    {
        var handler = new HarvestCropStepHandler();
        var args = new Dictionary<string, JsonElement>
        {
            ["targetHandle"] = JsonSerializer.SerializeToElement("crop:5,8"),
            ["qualifiedItemId"] = JsonSerializer.SerializeToElement("(O)24")
        };

        var result = handler.ValidateArgs(args);
        result.IsSuccess.Should().BeTrue();
        result.Value.X.Should().Be(5);
        result.Value.Y.Should().Be(8);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ --filter StepHandler`
Expected: FAIL with missing handler types.

- [ ] **Step 3: Implement IStepHandler abstraction and step handlers covering all 9 production actions**

```csharp
// integrations/stardew/src/Core/Abstractions/IStepHandler.cs
using System;
using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Algebra;

namespace GameBuddy.Stardew.Core.Abstractions;

public readonly record struct StepParsedTarget(
    int X, 
    int Y, 
    string RawHandle, 
    int? Slot = null, 
    string? QualifiedItemId = null, 
    string? ExpectedTargetId = null
);

public interface IStepHandler
{
    string ActionType { get; }
    Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args);
}
```

```csharp
// integrations/stardew/src/Core/Handlers/StepHandlers.cs
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;

namespace GameBuddy.Stardew.Core.Handlers;

internal static class TileHandleParser
{
    private static readonly Regex TileHandleRegex = new(@"^(?:(?:soil|crop)[_:])?(?:([A-Za-z0-9_]+)[_:])?(\d+)[,_](\d+)$", RegexOptions.Compiled);

    public static Result<(int X, int Y, string RawHandle), string> Parse(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("targetHandle", out var handleElem) || handleElem.ValueKind != JsonValueKind.String)
        {
            return Result<(int, int, string), string>.Err("missing_target_handle");
        }

        var handle = handleElem.GetString();
        if (string.IsNullOrWhiteSpace(handle)) return Result<(int, int, string), string>.Err("invalid_target_handle");

        var match = TileHandleRegex.Match(handle);
        if (!match.Success) return Result<(int, int, string), string>.Err("invalid_tile_handle_format");

        int xGroupIdx = match.Groups.Count - 2;
        int yGroupIdx = match.Groups.Count - 1;

        if (!int.TryParse(match.Groups[xGroupIdx].Value, out int x) || !int.TryParse(match.Groups[yGroupIdx].Value, out int y))
        {
            return Result<(int, int, string), string>.Err("invalid_tile_coordinates");
        }

        return Result<(int, int, string), string>.Ok((x, y, handle));
    }
}

public sealed class TillSoilStepHandler : IStepHandler
{
    public string ActionType => "till_soil";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle));
    }
}

public sealed class WaterCropStepHandler : IStepHandler
{
    public string ActionType => "water_crop";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) ? (idElem.GetString() ?? string.Empty) : string.Empty;
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class EquipToolStepHandler : IStepHandler
{
    public string ActionType => "equip_tool";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || !slotElem.TryGetInt32(out int slot))
        {
            return Result<StepParsedTarget, string>.Err("missing_tool_slot");
        }
        if (slot < 0 || slot > 36)
        {
            return Result<StepParsedTarget, string>.Err("invalid_tool_slot_range");
        }
        return Result<StepParsedTarget, string>.Ok(new StepParsedTarget(0, 0, $"slot:{slot}", Slot: slot));
    }
}

public sealed class PlantSeedStepHandler : IStepHandler
{
    public string ActionType => "plant_seed";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("invalid_slot_arg");
        if (!args.TryGetValue("qualifiedItemId", out var itemElem) || string.IsNullOrWhiteSpace(itemElem.GetString()))
            return Result<StepParsedTarget, string>.Err("missing_qualified_item_id");

        string itemId = itemElem.GetString()!;
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) ? (idElem.GetString() ?? string.Empty) : string.Empty;

        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, Slot: slot, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class FertilizeTileStepHandler : IStepHandler
{
    public string ActionType => "fertilize_tile";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("invalid_slot_arg");
        if (!args.TryGetValue("qualifiedItemId", out var itemElem) || string.IsNullOrWhiteSpace(itemElem.GetString()))
            return Result<StepParsedTarget, string>.Err("missing_qualified_item_id");

        string itemId = itemElem.GetString()!;
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) ? (idElem.GetString() ?? string.Empty) : string.Empty;

        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, Slot: slot, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class HarvestCropStepHandler : IStepHandler
{
    public string ActionType => "harvest_crop";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        string itemId = args.TryGetValue("qualifiedItemId", out var itemElem) ? (itemElem.GetString() ?? string.Empty) : string.Empty;
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) ? (idElem.GetString() ?? string.Empty) : string.Empty;
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class ForageStepHandler : IStepHandler
{
    public string ActionType => "pickup_forage";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        string itemId = args.TryGetValue("qualifiedItemId", out var itemElem) ? (itemElem.GetString() ?? string.Empty) : string.Empty;
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) ? (idElem.GetString() ?? string.Empty) : string.Empty;
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, QualifiedItemId: itemId, ExpectedTargetId: expectedTargetId));
    }
}

public sealed class UseItemStepHandler : IStepHandler
{
    public string ActionType => "use_item";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("missing_slot_arg");
        string itemId = args.TryGetValue("qualifiedItemId", out var itemElem) ? (itemElem.GetString() ?? string.Empty) : string.Empty;
        return Result<StepParsedTarget, string>.Ok(new StepParsedTarget(0, 0, $"slot:{slot}", Slot: slot, QualifiedItemId: itemId));
    }
}

public sealed class ClearHoeDirtStepHandler : IStepHandler
{
    public string ActionType => "clear_hoedirt";
    public Result<StepParsedTarget, string> ValidateArgs(IReadOnlyDictionary<string, JsonElement> args)
    {
        if (args == null || !args.TryGetValue("slot", out var slotElem) || !slotElem.TryGetInt32(out int slot) || slot < 0 || slot > 36)
            return Result<StepParsedTarget, string>.Err("missing_slot_arg");
        string expectedTargetId = args.TryGetValue("expectedTargetId", out var idElem) ? (idElem.GetString() ?? string.Empty) : string.Empty;
        return TileHandleParser.Parse(args).Map(t => new StepParsedTarget(t.X, t.Y, t.RawHandle, Slot: slot, ExpectedTargetId: expectedTargetId));
    }
}
```

- [ ] **Step 4: Refactor `SmapiLiveStepRunner.cs` to dispatch synchronously to step handlers without trampoline callback**

```csharp
// integrations/stardew/Handlers/SmapiLiveStepRunner.cs
namespace GameBuddy.Stardew.Handlers;

using System;
using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Algebra;
using GameBuddy.Stardew.Core.Handlers;
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
    private readonly ExecutionManager executions;
    private readonly IReadOnlyDictionary<string, IStepHandler> handlers;

    public SmapiLiveStepRunner(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
        var equip = new EquipToolStepHandler();
        var forage = new ForageStepHandler();
        this.handlers = new Dictionary<string, IStepHandler>(StringComparer.OrdinalIgnoreCase)
        {
            ["till_soil"] = new TillSoilStepHandler(),
            ["equip_tool"] = equip,
            ["equip_tool_slot"] = equip,
            ["water_crop"] = new WaterCropStepHandler(),
            ["plant_seed"] = new PlantSeedStepHandler(),
            ["fertilize_tile"] = new FertilizeTileStepHandler(),
            ["harvest_crop"] = new HarvestCropStepHandler(),
            ["pickup_forage"] = forage,
            ["collect_forage"] = forage,
            ["use_item"] = new UseItemStepHandler(),
            ["clear_hoedirt"] = new ClearHoeDirtStepHandler(),
        };
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
            return Result<string, string>.Fail("world_not_ready");

        if (!this.handlers.TryGetValue(actionType, out var handler))
        {
            return Result<string, string>.Fail($"unsupported_step_action:{actionType.ToLowerInvariant()}");
        }

        var validation = handler.ValidateArgs(args);
        if (validation.IsFailure)
        {
            return Result<string, string>.Fail(validation.Error);
        }

        string stepReqId = $"step_{stepIndex}_{Guid.NewGuid():N}";
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        GameLocation location = Game1.player.currentLocation;
        var target = validation.Value;

        LocalExecutionReceipt receipt;
        switch (actionType.ToLowerInvariant())
        {
            case "equip_tool":
            case "equip_tool_slot":
                receipt = this.executions.RequestLocalEquipTool(stepReqId, target.Slot ?? 0);
                break;

            case "till_soil":
                receipt = this.executions.RequestLocalTillSoil(stepReqId, target.X, target.Y, deadline);
                break;

            case "water_crop":
                string waterTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : ResolveCropTargetId(location, target.X, target.Y);
                receipt = this.executions.RequestLocalWaterCrop(stepReqId, target.X, target.Y, waterTargetId, deadline);
                break;

            case "plant_seed":
                string seedTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : $"seed_{location.NameOrUniqueName}:{target.Slot}:{target.X},{target.Y}:{target.QualifiedItemId}";
                receipt = this.executions.RequestLocalPlantSeed(stepReqId, target.Slot ?? 0, target.X, target.Y, target.QualifiedItemId ?? string.Empty, seedTargetId, deadline);
                break;

            case "fertilize_tile":
                string fertTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : $"fertilizer_{location.NameOrUniqueName}:{target.Slot}:{target.X},{target.Y}:{target.QualifiedItemId}";
                receipt = this.executions.RequestLocalFertilizeTile(stepReqId, target.Slot ?? 0, target.X, target.Y, target.QualifiedItemId ?? string.Empty, fertTargetId, deadline);
                break;

            case "harvest_crop":
                string harvestTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : ResolveCropTargetId(location, target.X, target.Y);
                receipt = this.executions.RequestLocalHarvestCrop(stepReqId, target.X, target.Y, target.QualifiedItemId ?? string.Empty, harvestTargetId, deadline);
                break;

            case "pickup_forage":
            case "collect_forage":
                string forageTargetId = !string.IsNullOrEmpty(target.ExpectedTargetId)
                    ? target.ExpectedTargetId
                    : ResolveForageTargetId(location, target.X, target.Y);
                receipt = this.executions.RequestLocalPickupForage(stepReqId, target.X, target.Y, target.QualifiedItemId ?? string.Empty, forageTargetId, deadline);
                break;

            case "use_item":
                receipt = this.executions.RequestLocalUseItem(stepReqId, target.Slot ?? 0, target.QualifiedItemId ?? string.Empty, deadline);
                break;

            case "clear_hoedirt":
                receipt = this.executions.RequestLocalClearHoeDirt(stepReqId, target.Slot ?? 0, target.X, target.Y, target.ExpectedTargetId ?? string.Empty, deadline);
                break;

            default:
                return Result<string, string>.Fail($"unsupported_step_action:{actionType.ToLowerInvariant()}");
        }

        return receipt.State == ExecutionState.Succeeded
            ? Result<string, string>.Ok(receipt.ReasonCode)
            : Result<string, string>.Fail(receipt.ReasonCode);
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

- [ ] **Step 5: Run tests to verify all pass**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ --filter StepHandler`
Expected: PASS across all property and unit tests.

- [ ] **Step 6: Commit task**

```bash
git add integrations/stardew/src/Core/Abstractions/IStepHandler.cs integrations/stardew/src/Core/Handlers/StepHandlers.cs integrations/stardew/Handlers/SmapiLiveStepRunner.cs integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerTests.cs integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/StepHandlerPropertyTests.cs
git commit -m "feat(stardew): decompose 9 production actions into pure step handlers with zero trampoline indirection"
```

---

### Task 4: Kleisli Step Pipeline Invariant Maintenance & Multi-Property Verification

**Files:**
- Verify: `integrations/stardew/src/Core/Algebra/SopStepPipeline.cs`
- Verify: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopStepPipelinePropertyTests.cs`

**Interfaces:**
- Consumes: `ISopStepRunner`, `Result<TValue, TError>`.
- Produces: Preserved 6-property FsCheck suite covering Short-Circuiting, Happy-Path, Native Exception Containment, Step Sequence Validation, Timeout Short-Circuiting, and Maximum Step Limits.

- [ ] **Step 1: Run complete SopStepPipelinePropertyTests suite to confirm all 6 invariants pass**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ --filter SopStepPipeline`
Expected: PASS across all 6 property theories (`Pipeline_ShortCircuitsAtFirstFailure_AndPreservesExactStepReceipts`, `Pipeline_SucceedsAll_WhenNoStepFails`, `Pipeline_ContainsNativeExceptions_FailClosed`, `Pipeline_FailsClosed_OnCorruptedStepIndexSequence`, `Pipeline_ShortCircuits_OnExpiredDeadline`, `Pipeline_Enforces_MaxPipelineSteps_Limit`).

- [ ] **Step 2: Commit task verification**

```bash
git status
# Confirm zero unexpected changes in SopStepPipeline
```

---

### Task 5: Capability Pullback Universal Property & Action Registry Production Hardening

**Files:**
- Modify: `host/src/action-registry.ts`
- Test: `host/src/action-registry-pullback.test.ts`

**Interfaces:**
- Exposes: `resolveCapabilityPullback` with Universal Property guarantees across both `deniedActions` and `deniedFamilies`, directly backing `visiblePublishedActions`.

- [ ] **Step 1: Write failing PBT test for Capability Pullback Universal Property on STARDEW_ACTION_REGISTRY**

```typescript
// host/src/action-registry-pullback.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  STARDEW_ACTION_REGISTRY,
  visiblePublishedActions,
  resolveCapabilityPullback,
  type ActionPolicy,
} from "./action-registry.js";

test("Pullback Universal Property: ActiveActions == Published ∩ LiveCapabilities ∩ ActionNotDenied ∩ FamilyNotDenied", () => {
  const candidateActions = STARDEW_ACTION_REGISTRY.map((a) => a.actionId);
  const candidateFamilies = Array.from(new Set(STARDEW_ACTION_REGISTRY.map((a) => a.familyId)));

  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...candidateActions), { minLength: 0, maxLength: 6 }),
      fc.array(fc.constantFrom(...candidateActions), { minLength: 0, maxLength: 6 }),
      fc.array(fc.constantFrom(...candidateFamilies), { minLength: 0, maxLength: 3 }),
      (liveCapsList, deniedActionsList, deniedFamiliesList) => {
        const liveCaps = Array.from(new Set(liveCapsList));
        const deniedActions = Array.from(new Set(deniedActionsList));
        const deniedFamilies = Array.from(new Set(deniedFamiliesList));
        const policy: ActionPolicy = { policyVersion: 1, deniedActions, deniedFamilies };

        const result = resolveCapabilityPullback(STARDEW_ACTION_REGISTRY, liveCaps, policy);
        const resultSet = new Set(result.map((a) => a.actionId));

        for (const action of STARDEW_ACTION_REGISTRY) {
          const isPublished = action.lifecycle === "published" && action.actionClass === "primitive";
          const isLive = liveCaps.includes(action.requiredCapability);
          const isNotDeniedAction = !deniedActions.includes(action.actionId);
          const isNotDeniedFamily = !deniedFamilies.includes(action.familyId);

          const shouldBeIncluded = isPublished && isLive && isNotDeniedAction && isNotDeniedFamily;
          assert.equal(resultSet.has(action.actionId), shouldBeIncluded);
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("visiblePublishedActions delegates directly to resolveCapabilityPullback", () => {
  const caps = ["till_soil", "equip_tool"];
  const policy: ActionPolicy = { policyVersion: 1, deniedActions: ["equip_tool"], deniedFamilies: [] };
  
  const fromPullback = resolveCapabilityPullback(STARDEW_ACTION_REGISTRY, caps, policy);
  const fromVisible = visiblePublishedActions(caps, policy);
  
  assert.deepEqual(fromVisible, fromPullback);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix host run build:test && node --test host/dist-test/src/action-registry-pullback.test.js`
Expected: FAIL due to missing `resolveCapabilityPullback` in `host/src/action-registry.ts`.

- [ ] **Step 3: Implement resolveCapabilityPullback in action-registry.ts**

```typescript
// Add to host/src/action-registry.ts
export function resolveCapabilityPullback(
  registry: readonly PublishedAction[],
  liveCapabilities: readonly string[],
  policy: ActionPolicy = DEFAULT_ACTION_POLICY,
): readonly PublishedAction[] {
  if (!registry || registry.length === 0) return Object.freeze([]);
  if (!liveCapabilities || liveCapabilities.length === 0) return Object.freeze([]);

  const liveSet = new Set(liveCapabilities);
  const deniedActionSet = new Set(policy.deniedActions);
  const deniedFamilySet = new Set(policy.deniedFamilies);

  return Object.freeze(
    registry.filter((action) => {
      if (!isMaterializablePublishedAction(action)) return false;
      if (!liveSet.has(action.requiredCapability)) return false;
      if (deniedActionSet.has(action.actionId)) return false;
      if (deniedFamilySet.has(action.familyId)) return false;
      return true;
    }),
  );
}

export function visiblePublishedActions(
  capabilities: readonly string[],
  policy: ActionPolicy = DEFAULT_ACTION_POLICY,
): readonly PublishedAction[] {
  return resolveCapabilityPullback(PUBLISHED_STARDEW_ACTIONS, capabilities, policy);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix host run build:test && node --test host/dist-test/src/action-registry-pullback.test.js`
Expected: PASS across all 100 PBT iterations and edge cases.

- [ ] **Step 5: Commit task**

```bash
git add host/src/action-registry.ts host/src/action-registry-pullback.test.ts
git commit -m "feat(host): harden capability pullback resolver with universal property PBT"
```

---

### Task 6: Monoidal Lifecycle FSM with Model-Based Concurrent PBT

**Files:**
- Create: `packages/voice-protocol/src/lifecycle-fsm.ts`
- Modify: `packages/voice-protocol/src/index.ts`
- Test: `packages/voice-protocol/src/lifecycle-fsm.test.ts`

**Interfaces:**
- Produces: `LifecycleFsm`, `createLifecycleFsm`, exported from `@gamebuddy/voice-protocol`.
- Transitions: `uninitialized -> starting -> active -> draining -> terminal`.
- Monoidal Law: $\text{Cancel}(\text{Starting}) \equiv \text{Terminal}$.

- [ ] **Step 1: Write failing unit and Model-Based PBT test for Lifecycle FSM**

```typescript
// packages/voice-protocol/src/lifecycle-fsm.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycleFsm, type LifecycleState } from "./lifecycle-fsm.js";

test("Monoidal Law: Cancel during Starting window immediately transitions to Terminal and aborts native activation", async () => {
  const fsm = createLifecycleFsm();

  let nativeSpawned = false;
  const startPromise = fsm.start(async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (signal.aborted) return;
    nativeSpawned = true;
  });

  const cancelResult = fsm.cancel("user_cancelled");

  assert.equal(cancelResult.state, "terminal");
  assert.equal(cancelResult.reasonCode, "user_cancelled");

  await startPromise;
  assert.equal(nativeSpawned, false, "Native process MUST NOT spawn after starting-window cancel");
  assert.equal(fsm.currentState, "terminal");
});

test("Normal Lifecycle with Draining: uninitialized -> starting -> active -> draining -> terminal", async () => {
  const fsm = createLifecycleFsm();
  assert.equal(fsm.currentState, "uninitialized");

  await fsm.start(async () => {});
  assert.equal(fsm.currentState, "active");

  const drainResult = fsm.drain("session_draining");
  assert.equal(drainResult.state, "draining");
  assert.equal(fsm.currentState, "draining");

  const completeResult = fsm.complete("session_ended");
  assert.equal(completeResult.state, "terminal");
  assert.equal(fsm.currentState, "terminal");
});

test("Invalid State Guard: Calling start when already starting or active throws error", async () => {
  const fsm = createLifecycleFsm();
  await fsm.start(async () => {});
  
  await assert.rejects(
    async () => fsm.start(async () => {}),
    /invalid_start_state:active/
  );
});

test("Model-Based Property: Generated command sequences maintain state machine invariants and terminal irreversibility", async () => {
  const commands = ["start", "drain", "complete", "cancel", "invalid_start"] as const;

  for (let seed = 1; seed <= 100; seed++) {
    const fsm = createLifecycleFsm();
    let wasTerminal = false;

    let s = seed;
    const nextRand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    const stepCount = Math.floor(nextRand() * 6) + 1;

    for (let i = 0; i < stepCount; i++) {
      const cmd = commands[Math.floor(nextRand() * commands.length)]!;

      if (wasTerminal) {
        assert.equal(fsm.currentState, "terminal", "Terminal state must be strictly irreversible");
      }

      switch (cmd) {
        case "start":
          if (fsm.currentState === "uninitialized") {
            await fsm.start(async () => {});
          }
          break;
        case "invalid_start":
          if (fsm.currentState !== "uninitialized") {
            await assert.rejects(async () => fsm.start(async () => {}), /invalid_start_state/);
          }
          break;
        case "drain":
          fsm.drain("test_drain");
          break;
        case "complete":
          fsm.complete("test_complete");
          wasTerminal = true;
          break;
        case "cancel":
          fsm.cancel("test_cancel");
          wasTerminal = true;
          break;
      }

      const validStates: readonly LifecycleState[] = ["uninitialized", "starting", "active", "draining", "terminal"];
      assert.ok(validStates.includes(fsm.currentState));
    }
  }
});

test("Non-abort exception in start action transitions to Terminal and rethrows error", async () => {
  const fsm = createLifecycleFsm();
  await assert.rejects(
    async () =>
      fsm.start(async () => {
        throw new Error("unexpected_native_boot_failure");
      }),
    /unexpected_native_boot_failure/
  );
  assert.equal(fsm.currentState, "terminal");
});

test("Asynchronous Race PBT: Concurrent start and cancel always resolve to terminal with aborted signal", async () => {
  for (let delay = 0; delay <= 20; delay += 5) {
    const fsm = createLifecycleFsm();
    let signalSawAbort = false;

    const startTask = fsm.start(async (signal) => {
      await new Promise((res) => setTimeout(res, 10));
      signalSawAbort = signal.aborted;
    });

    await new Promise((res) => setTimeout(res, delay));
    fsm.cancel("race_cancel");

    await startTask;
    assert.equal(fsm.currentState, "terminal");
    assert.equal(signalSawAbort, true);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/voice-protocol`
Expected: FAIL with "Cannot find module './lifecycle-fsm.js'".

- [ ] **Step 3: Implement createLifecycleFsm and export from index.ts**

```typescript
// packages/voice-protocol/src/lifecycle-fsm.ts
/**
 * 5-State Monoidal Lifecycle Finite State Machine.
 * Transitions: uninitialized -> starting -> active -> draining -> terminal
 * Monoidal Cancellation Absorption: Cancel(Starting) === Terminal
 * Terminal state is strictly absorbing and irreversible.
 */
export type LifecycleState = "uninitialized" | "starting" | "active" | "draining" | "terminal";

export interface LifecycleResult {
  readonly state: LifecycleState;
  readonly reasonCode: string;
}

export interface LifecycleFsm {
  readonly currentState: LifecycleState;
  start(action: (signal: AbortSignal) => Promise<void>): Promise<void>;
  drain(reasonCode?: string): LifecycleResult;
  complete(reasonCode?: string): LifecycleResult;
  cancel(reasonCode: string): LifecycleResult;
}

export function createLifecycleFsm(): LifecycleFsm {
  let state: LifecycleState = "uninitialized";
  let abortController = new AbortController();

  return {
    get currentState() {
      return state;
    },
    async start(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
      if (state !== "uninitialized") {
        throw new Error(`invalid_start_state:${state}`);
      }
      state = "starting";
      abortController = new AbortController();

      try {
        await action(abortController.signal);
        if (abortController.signal.aborted || state === "terminal") {
          state = "terminal";
        } else if (state === "starting") {
          state = "active";
        }
      } catch (err) {
        state = "terminal";
        if (abortController.signal.aborted) {
          return;
        }
        throw err;
      }
    },
    drain(reasonCode = "draining"): LifecycleResult {
      if (state === "active") {
        state = "draining";
      }
      return { state, reasonCode };
    },
    complete(reasonCode = "completed"): LifecycleResult {
      state = "terminal";
      return { state: "terminal", reasonCode };
    },
    cancel(reasonCode: string): LifecycleResult {
      abortController.abort(reasonCode);
      state = "terminal";
      return { state: "terminal", reasonCode };
    },
  };
}
```

```typescript
// In packages/voice-protocol/src/index.ts
export * from "./lifecycle-fsm.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/voice-protocol`
Expected: PASS across all suites, async race tests, and Model-Based PBT runs.

- [ ] **Step 5: Commit task**

```bash
git add packages/voice-protocol/src/lifecycle-fsm.ts packages/voice-protocol/src/lifecycle-fsm.test.ts packages/voice-protocol/src/index.ts
git commit -m "feat(voice-protocol): implement 5-state Lifecycle FSM with model-based concurrent PBT"
```

---

### Task 7: State Snapshot Functional Projections & Companion Integration

**Files:**
- Create: `host/src/snapshot-projection.ts`
- Modify: `host/src/farmhand-companion-presentation.ts`
- Test: `host/src/snapshot-projection.test.ts`

**Interfaces:**
- Consumes: [`Snapshot`](file:///E:/projects/ai-game-companion/host/src/protocol.ts) from `host/src/protocol.ts`.
- Produces: Pure projection functions (`projectMovementContext`, `projectFarmingContext`, `projectInventoryContext`) integrated directly into presentation consumers.

- [ ] **Step 1: Write failing PBT test for Snapshot Functional Projections and Purity Invariants**

```typescript
// host/src/snapshot-projection.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  projectMovementContext,
  projectFarmingContext,
  projectInventoryContext,
  type MovementContextProjection,
  type FarmingContextProjection,
  type InventoryContextProjection,
} from "./snapshot-projection.js";
import type { Snapshot } from "./protocol.js";

test("Projection Purity Invariant: project(S) == project(S) and does not mutate source Snapshot across optional field variations", () => {
  fc.assert(
    fc.property(
      fc.record({
        revision: fc.integer({ min: 0, max: 100000 }),
        location: fc.string({ minLength: 1, maxLength: 20 }),
        tile: fc.record({ x: fc.integer({ min: 0, max: 200 }), y: fc.integer({ min: 0, max: 200 }) }),
        stamina: fc.integer({ min: 0, max: 500 }),
        health: fc.integer({ min: 0, max: 100 }),
        actionable: fc.boolean(),
        capabilities: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
        presentationLocale: fc.constant("en-US"),
        inventorySlots: fc.option(fc.integer({ min: 12, max: 36 }), { nil: undefined }),
        soilTiles: fc.option(fc.array(fc.record({ x: fc.integer({ min: 0, max: 200 }), y: fc.integer({ min: 0, max: 200 }) }), { minLength: 0, maxLength: 5 }), { nil: undefined }),
        toolSlots: fc.option(fc.array(fc.record({ slot: fc.integer({ min: 0, max: 36 }), label: fc.string({ minLength: 1, maxLength: 20 }) }), { minLength: 0, maxLength: 5 }), { nil: undefined }),
        warps: fc.option(fc.array(fc.record({ sourceX: fc.integer({ min: 0, max: 200 }), sourceY: fc.integer({ min: 0, max: 200 }), targetLocation: fc.string({ minLength: 1, maxLength: 20 }), targetX: fc.integer({ min: 0, max: 200 }), targetY: fc.integer({ min: 0, max: 200 }) }), { minLength: 0, maxLength: 3 }), { nil: undefined }),
        doorTargets: fc.option(fc.array(fc.record({ sourceX: fc.integer({ min: 0, max: 200 }), sourceY: fc.integer({ min: 0, max: 200 }), targetLocation: fc.string({ minLength: 1, maxLength: 20 }), targetX: fc.integer({ min: 0, max: 200 }), targetY: fc.integer({ min: 0, max: 200 }) }), { minLength: 0, maxLength: 3 }), { nil: undefined }),
      }),
      (snapshot: Snapshot) => {
        const frozen = Object.freeze(JSON.parse(JSON.stringify(snapshot)));
        const proj1 = projectMovementContext(frozen);
        const proj2 = projectMovementContext(frozen);
        
        assert.deepEqual(proj1, proj2);
        assert.deepEqual(frozen, snapshot);

        const invProj = projectInventoryContext(frozen);
        assert.equal(invProj.inventorySlots, snapshot.inventorySlots ?? 12);
        assert.equal(invProj.toolSlotsCount, snapshot.toolSlots?.length ?? 0);

        const farmProj = projectFarmingContext(frozen);
        assert.equal(farmProj.soilTilesCount, snapshot.soilTiles?.length ?? 0);
        assert.equal(farmProj.stamina, snapshot.stamina);
      }
    ),
    { numRuns: 100 }
  );
});

test("projectFarmingContext and projectInventoryContext extract structured facts without memory bloat", () => {
  const snapshot: Snapshot = {
    revision: 10,
    location: "Farm",
    tile: { x: 5, y: 10 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: ["till_soil", "water_crop"],
    presentationLocale: "en-US",
    soilTiles: [{ x: 5, y: 10 }, { x: 5, y: 11 }],
    toolSlots: [{ slot: 0, label: "Axe" }, { slot: 1, label: "Hoe" }],
    inventorySlots: 24,
  };

  const farming = projectFarmingContext(snapshot);
  assert.equal(farming.location, "Farm");
  assert.equal(farming.soilTilesCount, 2);
  assert.equal(farming.stamina, 270);

  const inventory = projectInventoryContext(snapshot);
  assert.equal(inventory.inventorySlots, 24);
  assert.equal(inventory.toolSlotsCount, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix host run build:test && node --test host/dist-test/src/snapshot-projection.test.js`
Expected: FAIL with missing module `./snapshot-projection.js`.

- [ ] **Step 3: Implement snapshot functional projections and integrate into presentation**

```typescript
// host/src/snapshot-projection.ts
import type { Snapshot } from "./protocol.js";

export interface MovementContextProjection {
  readonly revision: number;
  readonly location: string;
  readonly tile: { readonly x: number; readonly y: number };
  readonly actionable: boolean;
  readonly warpsCount: number;
  readonly doorsCount: number;
}

export interface FarmingContextProjection {
  readonly revision: number;
  readonly location: string;
  readonly stamina: number;
  readonly soilTilesCount: number;
  readonly canTill: boolean;
  readonly canWater: boolean;
}

export interface InventoryContextProjection {
  readonly revision: number;
  readonly inventorySlots: number;
  readonly toolSlotsCount: number;
  readonly toolLabels: readonly string[];
}

export function projectMovementContext(snapshot: Snapshot): MovementContextProjection {
  return Object.freeze({
    revision: snapshot.revision,
    location: snapshot.location,
    tile: Object.freeze({ ...snapshot.tile }),
    actionable: snapshot.actionable,
    warpsCount: snapshot.warps?.length ?? 0,
    doorsCount: snapshot.doorTargets?.length ?? 0,
  });
}

export function projectFarmingContext(snapshot: Snapshot): FarmingContextProjection {
  const capabilities = new Set(snapshot.capabilities ?? []);
  return Object.freeze({
    revision: snapshot.revision,
    location: snapshot.location,
    stamina: snapshot.stamina,
    soilTilesCount: snapshot.soilTiles?.length ?? 0,
    canTill: capabilities.has("till_soil"),
    canWater: capabilities.has("water_crop"),
  });
}

export function projectInventoryContext(snapshot: Snapshot): InventoryContextProjection {
  const toolSlots = snapshot.toolSlots ?? [];
  return Object.freeze({
    revision: snapshot.revision,
    inventorySlots: snapshot.inventorySlots ?? 12,
    toolSlotsCount: toolSlots.length,
    toolLabels: Object.freeze(toolSlots.map((t) => t.label)),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix host run build:test && node --test host/dist-test/src/snapshot-projection.test.js`
Expected: PASS across all 100 PBT runs.

- [ ] **Step 5: Commit task**

```bash
git add host/src/snapshot-projection.ts host/src/snapshot-projection.test.ts
git commit -m "feat(host): implement pure snapshot projections with purity invariant PBT"
```

---

### Task 8: Comprehensive Workspace Architecture Verification & All-Suite Gate

**Files:**
- Create: `tools/verify-category-theoretic-architecture.mjs`
- Test: All suites across `host`, `integrations/stardew`, and `packages/voice-protocol`.

- [ ] **Step 1: Write comprehensive recursive architecture boundary & schema drift verification script**

```javascript
// tools/verify-category-theoretic-architecture.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 1. Recursive Core Algebra Isolation Audit
const coreDir = resolve(__dirname, "../integrations/stardew/src/Core");
const forbiddenSMAPITypes = ["StardewValley.", "StardewModdingAPI", "Microsoft.Xna."];

function scanFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      scanFiles(fullPath);
    } else if (entry.name.endsWith(".cs")) {
      const content = readFileSync(fullPath, "utf-8");
      for (const forbidden of forbiddenSMAPITypes) {
        if (content.includes(forbidden)) {
          console.error(`[Architecture Violation] File ${entry.name} directly references forbidden type "${forbidden}"`);
          process.exit(1);
        }
      }
    }
  }
}

scanFiles(coreDir);

// 2. Verify Schema SSOT File & Generated File Consistency
const schemaFile = resolve(__dirname, "../protocol/bridge-v1.schema.json");
const generatedTsFile = resolve(__dirname, "../host/src/protocol.generated.ts");
const generatedCsFile = resolve(__dirname, "../integrations/stardew/src/Core/Protocol/Protocol.Generated.cs");

const schemaContent = readFileSync(schemaFile, "utf-8");
const generatedTsContent = readFileSync(generatedTsFile, "utf-8");
const generatedCsContent = readFileSync(generatedCsFile, "utf-8");

const schema = JSON.parse(schemaContent);
const expectedStates = schema.$defs.executionState.enum;

for (const state of expectedStates) {
  if (!generatedTsContent.includes(`"${state}"`)) {
    console.error(`[SSOT Drift] State "${state}" missing in TypeScript generated protocol`);
    process.exit(1);
  }
}

if (!generatedCsContent.includes("ExecutionRequestDto") || !generatedCsContent.includes("ExecutionReceiptDto")) {
  console.error("[SSOT Drift] Generated C# DTOs missing required protocol records");
  process.exit(1);
}

// 3. Guarantee Clean Codegen (Re-run codegen and verify zero disk diff)
const codegenScript = resolve(__dirname, "generate-protocol.mjs");
execFileSync(process.execPath, [codegenScript], { stdio: "inherit" });

const postGenTs = readFileSync(generatedTsFile, "utf-8");
const postGenCs = readFileSync(generatedCsFile, "utf-8");
if (postGenTs !== generatedTsContent || postGenCs !== generatedCsContent) {
  console.error("[SSOT Drift] Generated files on disk differed from compiler output. Generated files must not be manually edited.");
  process.exit(1);
}

console.log("Category-Theoretic architecture boundary & schema drift verification passed successfully!");
```

- [x] **Step 2: Run all workspace tests and verification suites**

Run: `node tools/verify-category-theoretic-architecture.mjs && npm test --prefix packages/voice-protocol && dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ && npm --prefix host run build:test && node --test host/dist-test/protocol-roundtrip.test.js host/dist-test/action-registry-pullback.test.js host/dist-test/snapshot-projection.test.js`
Expected: All suites PASS with 0 errors.

- [ ] **Step 3: Final commit**

```bash
git add tools/verify-category-theoretic-architecture.mjs
git commit -m "test: add categorical architecture boundary and schema drift verification gate"
```
