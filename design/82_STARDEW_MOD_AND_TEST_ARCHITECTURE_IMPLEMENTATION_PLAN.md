# Stardew Mod & Test Architecture Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the Stardew integration into a pure `GameBuddy.Stardew.Core` logic library and a focused `GameBuddy.Stardew` SMAPI plugin, migrate fragile IL opcode scanning to standard `xUnit` test suites, and decompose the 238KB `ExecutionManager` god-class into modular action handlers.

**Architecture:** A two-tier library architecture separating pure C# protocol parsing, wire contracts, action routing, and authorization policy (`GameBuddy.Stardew.Core`) from native SMAPI game loop interaction (`GameBuddy.Stardew`). Testing is standardized onto `xUnit` across standalone fast unit tests (`GameBuddy.Stardew.Core.Tests`) and native game integration tests (`GameBuddy.Stardew.Integration.Tests`).

**Tech Stack:** C# 10 / .NET 6 (`net6.0`), SMAPI 4.x, xUnit 2.9, FluentAssertions, System.Text.Json.

**Spec:** [`design/81_STARDEW_MOD_AND_TEST_ARCHITECTURE_REDESIGN.md`](file:///E:/projects/ai-game-companion/design/81_STARDEW_MOD_AND_TEST_ARCHITECTURE_REDESIGN.md)

## Global Constraints

- **Strict Wire-Protocol Fidelity:** Preserve all existing JSON wire-format contracts defined in `protocol/bridge-v1.schema.json`; do not break field names (`requestId`, `idempotencyKey`, `action`, `args`, `expectedRevision`, `deadlineMs`), envelope structures, or status enums.
- **Zero-Dependency Core:** `GameBuddy.Stardew.Core` must have zero reference to `StardewValley`, `StardewModdingAPI`, or `Microsoft.Xna.Framework`.
- **Single-Threaded Game-Loop Safety:** `GameBuddy.Stardew` SMAPI Mod must retain single-threaded game-loop execution for all game state mutations and respect body concurrency locks.
- **No Ritualistic Validation:** Remove legacy IL opcode scanning tests, SHA-256 binary validation, and custom Console runners; do not keep dead reflection verification paths. Follow `AGENTS.md`.

---

### Task 1: Create `GameBuddy.Stardew.Core` Project, Extract Pure Data Contracts & Clean Up Root Duplicates

**Files:**
- Create: `integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj`
- Create: `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`
- Create: `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs` (extract framing parser, argument property maps & serialization from Mod)
- Create: `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` (canonical 28 action definitions, family identities, versions)
- Create: `integrations/stardew/src/Core/Policy/FarmhandCapabilitySurface.cs`
- Create: `integrations/stardew/src/Core/Policy/ActionPolicyEngine.cs`
- Create: `integrations/stardew/src/Core/Abstractions/IFarmhandActionHandler.cs`
- Create: `integrations/stardew/src/Core/Abstractions/IExecutionLedger.cs`
- Delete: `integrations/stardew/BridgeProtocol.cs` (superseded by `GameBuddy.Stardew.Core.Protocol`)
- Delete: `integrations/stardew/IFarmhandActionHandler.cs` (superseded by `GameBuddy.Stardew.Core.Abstractions`)
- Delete: `integrations/stardew/FarmhandActionRouter.cs` (superseded by `GameBuddy.Stardew.Core.Routing`)
- Modify: `integrations/stardew/ExecutionModels.cs` (remove duplicated `ExecutionState`, `ExecutionStateWire`, `LocalExecutionReceipt` to avoid `CS0104` collisions, retaining internal multi-tick specs)
- Modify: `GameBuddy.sln`

**Interfaces:**
- Consumes: None (root core library, zero MonoGame/SMAPI/Stardew Valley dependencies).
- Produces: `BridgeProtocol`, `BridgeExecutionRequest`, `BridgeExecutionArgs`, `BridgeReceipt`, `BridgeEnvelope<T>`, `ExecutionState`, `LocalExecutionReceipt`, `FarmhandCapabilitySurface`, `ActionPolicyEngine`, `IFarmhandActionHandler`, `IExecutionLedger`.

- [ ] **Step 1: Create `GameBuddy.Stardew.Core.csproj`**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net6.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <RootNamespace>GameBuddy.Stardew.Core</RootNamespace>
    <AssemblyName>GameBuddy.Stardew.Core</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <InternalsVisibleTo Include="GameBuddy.Stardew" />
    <InternalsVisibleTo Include="GameBuddy.Stardew.Core.Tests" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Define pure protocol and execution models in `BridgeProtocolModels.cs` matching `bridge-v1.schema.json`**

```csharp
namespace GameBuddy.Stardew.Core.Models;

using System.Text.Json;
using System.Text.Json.Serialization;

public enum ExecutionState
{
    Accepted,
    Running,
    MeaningfulProgress,
    Blocked,
    Invalidated,
    Succeeded,
    PartiallySucceeded,
    Failed,
    Cancelled,
    Rejected,
    Expired,
    Uncertain,
}

public static class ExecutionStateWire
{
    public static string ToWireValue(this ExecutionState state) => state switch
    {
        ExecutionState.Accepted => "accepted",
        ExecutionState.Running => "running",
        ExecutionState.MeaningfulProgress => "meaningful_progress",
        ExecutionState.Blocked => "blocked",
        ExecutionState.Invalidated => "invalidated",
        ExecutionState.Succeeded => "succeeded",
        ExecutionState.PartiallySucceeded => "partially_succeeded",
        ExecutionState.Failed => "failed",
        ExecutionState.Cancelled => "cancelled",
        ExecutionState.Rejected => "rejected",
        ExecutionState.Expired => "expired",
        ExecutionState.Uncertain => "uncertain",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown execution state."),
    };
}

public sealed class BridgeExecutionArgs
{
    public float? X { get; init; }
    public float? Y { get; init; }
    public int? Slot { get; init; }
    public string? ExpectedQualifiedItemId { get; init; }
    public string? ExpectedTargetId { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

public sealed record BridgeExecutionRequest(
    string RequestId,
    string IdempotencyKey,
    string Action,
    BridgeExecutionArgs Args,
    long ExpectedRevision,
    long DeadlineMs
);

public sealed record LocalExecutionReceipt(
    string ExecutionId,
    string RequestId,
    ExecutionState State,
    string ReasonCode,
    long Revision,
    string? Evidence
);

public sealed record BridgeReceipt(
    string ExecutionId,
    string RequestId,
    string State,
    string ReasonCode,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence
);

public sealed record BridgeScope(string IntegrationId, string SaveId, string WorldId, string PlayerId, string CompanionId);

public sealed record BridgeEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    BridgeScope Scope,
    string Type,
    TPayload Payload
);
```

- [ ] **Step 3: Define `IExecutionLedger.cs` and `IFarmhandActionHandler.cs` in `Abstractions/`**

```csharp
namespace GameBuddy.Stardew.Core.Abstractions;

using GameBuddy.Stardew.Core.Models;

public interface IExecutionLedger
{
    long CurrentRevision { get; }
    bool IsBodyBusy { get; }
    bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt);
    LocalExecutionReceipt Remember(LocalExecutionReceipt receipt);
    LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence);
    void AddTrace(LocalExecutionReceipt receipt);
}

public interface IFarmhandActionHandler
{
    IReadOnlyCollection<string> SupportedActions { get; }
    LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger);
}
```

- [ ] **Step 4: Add `GameBuddy.Stardew.Core.csproj` to `GameBuddy.sln`**

Run: `dotnet sln GameBuddy.sln add integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj`
Expected: Project added successfully.

---

### Task 2: Implement Pure Action Router & Policy Engine in `Core` with xUnit & Property-Based Test (PBT) Suite

**Files:**
- Create: `integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs`
- Create: `integrations/stardew/src/Core/Policy/ActionPolicyEngine.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/FarmhandActionRouterTests.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/FarmhandActionRouterPropertyTests.cs` (PBT)
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ActionPolicyEngineTests.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ActionPolicyEnginePropertyTests.cs` (PBT)
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BridgeProtocolSerializationTests.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BridgeProtocolPropertyTests.cs` (PBT)
- Modify: `GameBuddy.sln`

**Interfaces:**
- Consumes: `IFarmhandActionHandler`, `IExecutionLedger`, `BridgeExecutionRequest`, `ActionPolicyEngine`, `BridgeProtocol`.
- Produces: `FarmhandActionRouter.TryRoute(request, ledger, out receipt, out reasonCode)`, `ActionPolicyEngine.ComputeEnabledActions(...)`.

- [ ] **Step 1: Create `GameBuddy.Stardew.Core.Tests.csproj` with xUnit and FsCheck.Xunit**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net6.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <IsPackable>false</IsPackable>
    <RootNamespace>GameBuddy.Stardew.Core.Tests</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="FluentAssertions" Version="6.12.2" />
    <PackageReference Include="FsCheck.Xunit" Version="2.16.6" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\..\src\Core\GameBuddy.Stardew.Core.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Implement and test `FarmhandActionRouter.cs`**

```csharp
namespace GameBuddy.Stardew.Core.Routing;

using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

public sealed class FarmhandActionRouter
{
    private readonly Dictionary<string, IFarmhandActionHandler> handlers = new(StringComparer.Ordinal);
    private readonly int ownerManagedThreadId;

    public FarmhandActionRouter(int? ownerManagedThreadId = null)
    {
        this.ownerManagedThreadId = ownerManagedThreadId ?? Environment.CurrentManagedThreadId;
    }

    public void Register(IFarmhandActionHandler handler)
    {
        foreach (string actionId in handler.SupportedActions)
        {
            if (this.handlers.ContainsKey(actionId))
                throw new InvalidOperationException($"Duplicate farmhand action handler registration: {actionId}");
            this.handlers[actionId] = handler;
        }
    }

    public bool IsOnOwnerThread => Environment.CurrentManagedThreadId == this.ownerManagedThreadId;

    public bool TryRoute(
        BridgeExecutionRequest request,
        IExecutionLedger ledger,
        out LocalExecutionReceipt receipt,
        out string reasonCode)
    {
        if (!this.IsOnOwnerThread)
        {
            receipt = default!;
            reasonCode = "game_thread_required";
            return false;
        }

        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
        {
            receipt = existing;
            reasonCode = "replayed_existing_receipt";
            return true;
        }

        if (!this.handlers.TryGetValue(request.Action, out IFarmhandActionHandler? handler))
        {
            receipt = default!;
            reasonCode = "action_not_available";
            return false;
        }

        receipt = handler.Execute(request, ledger);
        reasonCode = "accepted";
        return true;
    }
}
```

- [ ] **Step 3: Write xUnit Unit Tests & Property-Based Invariant Tests (PBT)**

1. **`BridgeProtocolPropertyTests.cs` (PBT)**:
   - Property: *Round-trip lossless serialization*: For any valid generated `BridgeExecutionRequest` / `BridgeReceipt`, `TryDeserialize(TrySerialize(obj)) == obj`.
   - Property: *Fail-closed corruption invariant*: For any mutated JSON with missing required fields or unknown extra fields, `TryDeserializeInbound` returns `false` with `"invalid_envelope"`.
2. **`ActionPolicyEnginePropertyTests.cs` (PBT)**:
   - Property: *Denied action non-membership invariant*: For any random subset of denied actions, `deniedActions ∩ enabledActions == ∅`.
   - Property: *Denied family isolation invariant*: For any denied family, no actions belonging to that family ever appear in the enabled capability set.
3. **`FarmhandActionRouterPropertyTests.cs` (PBT)**:
   - Property: *Unregistered action fail-closed*: For any arbitrary random action string not in `handler.SupportedActions`, `TryRoute` returns `false` with `reasonCode = "action_not_available"`.
   - Property: *Off-thread fail-closed*: For any request dispatched from a non-owner thread ID, `TryRoute` returns `false` with `reasonCode = "game_thread_required"`.
4. **`FarmhandActionRouterTests.cs` & `BridgeProtocolSerializationTests.cs` (Unit Tests)**:
   - Exact round-trips for all 28 canonical action types matching `protocol/bridge-v1.schema.json`.
   - Replay deduplication returning exact cached receipt from ledger.

- [ ] **Step 4: Run unit & property tests to verify they pass**

Run: `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests`
Expected: All tests pass (0 failures).

---

### Task 3: Refactor `ExecutionManager` into Cohesive Domain Action Handlers, ActionPreconditionGuard & Connect to Router

**Files:**
- Create: `integrations/stardew/Handlers/ActionPreconditionGuard.cs`
- Create: `integrations/stardew/Handlers/FarmingActionHandler.cs`
- Create: `integrations/stardew/Handlers/GatheringActionHandler.cs`
- Create: `integrations/stardew/Handlers/MovementActionHandler.cs`
- Create: `integrations/stardew/Handlers/MachineAndAnimalActionHandler.cs`
- Create: `integrations/stardew/Handlers/ResourceToolActionHandler.cs`
- Modify: `integrations/stardew/ExecutionManager.cs` (implements `IExecutionLedger`, removes partial classes)
- Delete: `integrations/stardew/ExecutionManager.FarmingConstructionHandlers.cs`
- Delete: `integrations/stardew/ExecutionManager.GatheringHandlers.cs`
- Delete: `integrations/stardew/ExecutionManager.MachinesAnimalsItemsHandlers.cs`
- Delete: `integrations/stardew/ExecutionManager.MovementHandlers.cs`
- Delete: `integrations/stardew/ExecutionManager.ResourceToolHandlers.cs`
- Modify: `integrations/stardew/BridgeSession.cs` (inject `FarmhandActionRouter` via constructor)
- Modify: `integrations/stardew/GameBuddy.Stardew.csproj` (reference `GameBuddy.Stardew.Core`)
- Modify: `integrations/stardew/ModEntry.cs`

**Interfaces:**
- Consumes: `GameBuddy.Stardew.Core.Abstractions.IFarmhandActionHandler`, `IExecutionLedger`, `FarmhandActionRouter`, `StardewBodyController`, `StardewValley` APIs.
- Produces: Fully modular action handlers registered into `FarmhandActionRouter` and injected into `BridgeSession`.

- [ ] **Step 1: Add ProjectReference to `GameBuddy.Stardew.Core` in `GameBuddy.Stardew.csproj`**

```xml
  <ItemGroup>
    <ProjectReference Include="src\Core\GameBuddy.Stardew.Core.csproj" />
  </ItemGroup>
```

- [ ] **Step 2: Implement `ActionPreconditionGuard.cs` and Domain Action Handlers with full native Stardew logic**

1. `ActionPreconditionGuard`:
   - Unified helper validating: `world_not_ready` (`!Context.IsWorldReady` or `Game1.player is null`), `player_not_actionable` (`Game1.activeClickableMenu != null` or `!Game1.player.CanMove`), `invalid_deadline` (`deadlineMs <= nowMs`), `body_owned` (`ledger.IsBodyBusy`), and `IsWithinChebyshevDistance`.
2. `FarmingActionHandler`:
   - `SupportedActions`: `till_soil`, `water_crop`, `plant_seed`, `fertilize_tile`, `harvest_crop`, `clear_hoedirt`.
   - Single-tick synchronous operations using real game APIs (`Hoe.DoFunction`, `WateringCan.DoFunction`, `GetHoeDirtAtTile`, `ItemRegistry.Create`, `Game1.player.Items`), returning terminal receipts immediately via `ledger.RememberTerminal(...)`.
3. `GatheringActionHandler`:
   - `SupportedActions`: `pickup_forage`, `pickup_item`.
   - Handles single-tick forage pickups and coordinate-targeted item collection.
4. `MovementActionHandler`:
   - `SupportedActions`: `move_to_tile`, `travel`, `enter_exit`.
   - Multi-tick operations: delegates navigation to `StardewBodyController`, returns initial `Accepted` receipt via `ledger.Remember(...)`, and coordinates completion via `ExecutionManager`.
5. `MachineAndAnimalActionHandler`:
   - `SupportedActions`: `machine_inspect`, `machine_load`, `machine_collect_output`, `pet_animal`, `collect_animal_product`, `feed_animal`, `npc_relationship`.
   - Handles both single-tick machine interactions and multi-tick petting / milking animations.
6. `ResourceToolActionHandler`:
   - `SupportedActions`: `equip_tool`, `clear_debris`, `refill_watering_can`, `use_item`, `place_wood_fence`, `place_crab_pot`, `bait_crab_pot`, `dig_artifact_spot`, `break_rock_source`, `chop_tree_source`.
   - Handles single-tick tool usages, item consumption, and fence/crabpot placement.

- [ ] **Step 3: Update `ExecutionManager` to implement `IExecutionLedger`**

Retain and implement in `ExecutionManager`:
- Monotonic `revision` counter and `CurrentRevision` property.
- `receiptsByRequestId` cache with FIFO `receiptOrder` ring buffer.
- Active multi-tick spec management (`active`, `activeTravel`, `activePet`, `activeAnimalProduct`, `activeItemUse`, `activeItemPickup`).
- `Tick()` frame update coordinator driving active multi-tick state machines.
- `Remember(LocalExecutionReceipt receipt)` for registering initial (`Accepted`/`Running`) or transition receipts.
- `RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence)` for recording final receipts and releasing active state machines.
- `AddTrace(LocalExecutionReceipt receipt)` ledger telemetry publication.

- [ ] **Step 4: Update `BridgeSession.cs` to receive `FarmhandActionRouter`, wire Router in `ModEntry.cs`, and verify compilation**

1. Update `BridgeSession.cs` constructor:
```csharp
internal BridgeSession(
    ExecutionManager executions,
    FarmhandActionRouter actionRouter,
    BridgeScope scope,
    string token,
    FarmhandCapabilitySurface publishedCapabilities,
    Func<string>? presentationLocale = null)
{
    this.executions = executions;
    this.actionRouter = actionRouter ?? throw new ArgumentNullException(nameof(actionRouter));
    this.scope = scope;
    this.token = token;
    this.publishedCapabilities = publishedCapabilities;
    this.presentationLocale = presentationLocale ?? NativeChatPresentationPolicy.CurrentBcp47Locale;
}
```

2. In `ModEntry.cs` during `OnSaveLoaded`:
```csharp
FarmhandActionRouter router = new();
router.Register(new MovementActionHandler(this.bodyController, state.Executions));
router.Register(new FarmingActionHandler(state.Executions));
router.Register(new GatheringActionHandler(state.Executions));
router.Register(new MachineAndAnimalActionHandler(state.Executions));
router.Register(new ResourceToolActionHandler(state.Executions));

state.BridgeSession = bridgeConfigValid && scopeMatchesWorld
    ? new BridgeSession(state.Executions, router, new BridgeScope("stardew", saveId, worldId, playerId, companionId), this.config.BridgeToken, capabilitySurface)
    : null;
```

Run: `dotnet build integrations/stardew/GameBuddy.Stardew.csproj`
Expected: Build succeeded with 0 errors.

---

### Task 4: Standardize Integration Tests, Deprecate Legacy IL Sweepers, and Update Tooling

**Files:**
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NativeFarmingContractTests.cs`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NativeToolContractTests.cs`
- Remove: `integrations/stardew/tests/FarmhandHandlerSplitContractTests.cs`
- Remove: `integrations/stardew/tests/FarmhandHandlerSplitContractProgram.cs`
- Remove: `integrations/stardew/tests/FarmhandHandlerSplit.Contract.csproj`
- Remove: `integrations/stardew/tests/Run-FarmhandHandlerSplitContract.ps1`
- Remove: `integrations/stardew/tests/FarmhandActionCapabilityProjection.Contract.csproj`
- Remove: `integrations/stardew/tests/FarmhandActionCapabilityProjectionProgram.cs`
- Remove: `integrations/stardew/tests/FarmhandActionCapabilityProjectionTests.cs`
- Remove: `integrations/stardew/tests/FarmhandActionProjectionManifest.cs`
- Remove: `integrations/stardew/tests/FarmhandCapabilityRuntimeStaticTests.cs`
- Remove: `integrations/stardew/tests/Run-ProjectionContractTests.ps1`
- Remove: `integrations/stardew/tests/Run-ProjectionContractTests.test.ps1`
- Remove: `integrations/stardew/tests/FarmhandBridgeInterop.Contract.csproj`
- Remove: `integrations/stardew/tests/FarmhandBridgeInteropProgram.cs`
- Modify: `integrations/stardew/InternalsVisibleTo.cs`
- Modify: `tools/verify-stardew-action-projection-p2c.ps1`
- Modify: `tools/check-stardew-action-promotion.mjs`
- Modify: `tools/check-stardew-action-promotion.test.mjs`
- Modify: `package.json`
- Modify: `GameBuddy.sln`

**Interfaces:**
- Consumes: `GameBuddy.Stardew`, `GameBuddy.Stardew.Core`.
- Produces: Standard xUnit test executable discovered by `dotnet test` and IDE test explorers.

- [ ] **Step 1: Create `GameBuddy.Stardew.Integration.Tests.csproj`**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net6.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <PackageReference Include="FluentAssertions" Version="6.12.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\..\GameBuddy.Stardew.csproj" />
    <ProjectReference Include="..\..\src\Core\GameBuddy.Stardew.Core.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Write behavioral contract tests in `NativeFarmingContractTests.cs` and `NativeToolContractTests.cs`**

Verify:
- Action handlers reject requests when coordinates or slots are missing (`invalid_arguments`).
- Action handlers respect Chebyshev interaction radius constraints.
- Action handlers fail closed when preconditions are unmet.

- [ ] **Step 3: Remove obsolete IL sweeper files, update toolchain scripts, and preserve Portfolio test isolation**

1. Remove obsolete Farmhand contract projects (`FarmhandHandlerSplit.Contract.*`, `FarmhandActionCapabilityProjection.Contract.*`, `FarmhandBridgeInterop.Contract.*`, and legacy `.ps1` runners).
2. Update `integrations/stardew/InternalsVisibleTo.cs`: Remove retired contract assemblies, add `GameBuddy.Stardew.Integration.Tests` and `GameBuddy.Stardew.Core.Tests`.
3. Update `GameBuddy.sln`: Remove retired contract projects and add `GameBuddy.Stardew.Integration.Tests.csproj`.
4. Update `tools/check-stardew-action-promotion.mjs` and `tools/check-stardew-action-promotion.test.mjs` to adapt router dispatch validation to modular Handler registrations while keeping capability surface checks strict.
5. Update `tools/verify-stardew-action-projection-p2c.ps1` to replace the deprecated IL contract executable with `GameBuddy.Stardew.Core.Tests` and `GameBuddy.Stardew.Integration.Tests`.
6. Maintain strict isolation for Portfolio test suites (`PortfolioMineElevatorProjection.Contract.csproj`, etc.) so that Farmhand IL cleanup does not break Portfolio verification.
7. Update `package.json` test scripts to standardize on `dotnet test`:
   - Add `"test:stardew:core": "dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests"`
   - Add `"test:stardew:integration": "dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests"`
   - Remove obsolete `"test:stardew-static-capability-projection"` raw DLL invocation.

- [ ] **Step 4: Run full test suite to ensure end-to-end green**

Run:
```powershell
pnpm test:stardew:core
pnpm quality:check
pnpm test:stardew-action-projection
```
Expected: All pure unit and property-based tests PASS, promotion checks PASS, text hygiene and lint checks PASS.

