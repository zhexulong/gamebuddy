# 81. Stardew Mod & Test Architecture Redesign

## 1. Context & Motivation

The current Stardew Valley mod integration (`integrations/stardew`) provides reliable single-threaded game-loop execution and fail-closed permission gates. However, the current architecture suffers from four major architectural bottlenecks:

1. **Monolithic Partial Class (`ExecutionManager`)**: `ExecutionManager.cs` spans over 238 KB across 6 partial files, sharing mutable internal state, creating tight coupling between unrelated gameplay domains (e.g. movement vs animal harvesting vs coffee kegs vs terrain tilling).
2. **Defensive IL Opcode Sweeping & Ritualistic Gates**: Tests in `integrations/stardew/tests/` inspect compiled Mono.Cecil/reflection IL opcodes and compute SHA-256 binary digests rather than asserting behavioral contracts, violating `AGENTS.md` guidelines against ritualistic verification and creating brittle tests that break on minor compiler optimizations.
3. **Non-standard Console Test Runners**: Test executables are custom Console applications requiring external SHA-256 digests and file paths, bypassing standard `dotnet test`, xUnit discovery, and IDE test explorers.
4. **Tight Game Dependency Coupling in Core Logic**: Protocol serialization, permission validation, and action dispatching are bundled together with proprietary Stardew Valley assemblies, preventing pure logic tests from running in lightweight CI environments.

---

## 2. Target Architecture

```mermaid
graph TD
    subgraph Solution [GameBuddy.sln]
        subgraph Core_Project [GameBuddy.Stardew.Core (net6.0 - Zero Game Dependency)]
            BP[BridgeProtocol & Wire Models]
            AP[Action Authorization Policy & Engine]
            FAR[FarmhandActionRouter & Dispatch]
            IFH[IFarmhandActionHandler Interface]
            IEL[IExecutionLedger Abstraction]
            DMO[ExecutionState & LocalExecutionReceipt]
        end

        subgraph Mod_Project [GameBuddy.Stardew (SMAPI Mod - Requires GamePath)]
            ME[ModEntry & SMAPI Game-Loop Hooks]
            LPB[LocalPipeBridge Transport]
            SBC[StardewBodyController Native Routing]
            EM[ExecutionManager as IExecutionLedger & TickCoordinator]
            subgraph Handlers [Domain Action Handlers]
                FAH[FarmingActionHandler]
                GAH[GatheringActionHandler]
                MAH[MachineAndAnimalActionHandler]
                RAH[ResourceToolActionHandler]
                MVH[MovementActionHandler]
            end
        end

        subgraph Core_Tests [GameBuddy.Stardew.Core.Tests (xUnit - Fast CI Runner)]
            UT_Proto[Protocol Serialization & Framing Tests]
            UT_Router[Action Router & Dispatch Tests]
            UT_Policy[Policy Authorization & Denial Tests]
        end

        subgraph Integration_Tests [GameBuddy.Stardew.Integration.Tests (xUnit - Behavioral Contracts)]
            IT_Contract[Native Mechanical Contract Tests]
            IT_Body[Pathfinding & Movement Smoke Tests]
        end
    end

    Core_Project --> Mod_Project
    Core_Project --> Core_Tests
    Mod_Project --> Integration_Tests
    Handlers -.implements.-> IFH
    EM -.implements.-> IEL
    Handlers --> IEL
```

---

## 3. Key Design Decisions

### 3.1 Two-Tier Project Split (`Core` vs `Mod`)
- **`GameBuddy.Stardew.Core`** (`integrations/stardew/src/Core`):
  - Target Framework: `net6.0`.
  - External Dependencies: Standard library + System.Text.Json (zero MonoGame, SMAPI, or StardewValley DLLs).
  - Scope:
    - Wire protocol contracts and serialization/framing engine (`BridgeProtocol`, `BridgeExecutionRequest`, `BridgeExecutionArgs`, `BridgeReceipt`, `BridgeEnvelope<T>`) aligned with `protocol/bridge-v1.schema.json`.
    - Core execution abstractions (`IFarmhandActionHandler`, `IExecutionLedger`, `ExecutionState`, `LocalExecutionReceipt`).
    - Action authorization policy engine and deterministic capability surface (`ActionPolicyEngine`, `FarmhandCapabilitySurface`, `FarmhandActionDefinition`, `DeniedActions`, `DeniedActionFamilies`, `ExperimentalActions`).
    - Pure action routing table (`FarmhandActionRouter`).
- **`GameBuddy.Stardew`** (`integrations/stardew`):
  - SMAPI plugin package containing `ModEntry`, `LocalPipeBridge`, `StardewBodyController`, `ExecutionManager` (implementing `IExecutionLedger` and coordinating multi-tick state machines), and concrete domain action handlers.

### 3.2 Decoupling `ExecutionManager` into Domain Action Handlers & Execution Ledger
Replace the 238KB partial god-class with cohesive, independently testable handler classes implementing `IFarmhandActionHandler` with injected `IExecutionLedger`:

1. **`IFarmhandActionHandler` Contract** (in `Core`):
   - Exposes `IReadOnlyCollection<string> SupportedActions { get; }` allowing cohesive domain handlers to declare and route all member actions (e.g. `FarmingActionHandler` handles `till_soil`, `water_crop`, etc.).
   - Dispatches via `LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)`.
2. **`IExecutionLedger` Abstraction** (in `Core`):
   - Single-point-of-truth runtime ledger for idempotency caching (`TryGetExistingReceipt`), optimistic revision checking (`CurrentRevision`), body concurrency locking (`IsBodyBusy`), receipt recording (`Remember` for general/in-progress receipts, `RememberTerminal` for terminal receipts), and trace collection (`AddTrace`).
3. **Idempotency & Replay Boundary**:
   - Transport-layer idempotency (in `BridgeSession`) performs fingerprint checks against duplicate keys or requests (`idempotency_key_conflict`, `request_id_conflict`).
   - The ledger in `ExecutionManager` maintains the authoritative `LocalExecutionReceipt` cache (`receiptsByRequestId`) with FIFO eviction ring-buffers, serving replay queries and state queries safely.
4. **Execution Lifecycle Coordination** (in `Mod`):
   - **Single-Tick Actions** (e.g. `till_soil`, `water_crop`, `clear_debris`): Handlers synchronously execute logic on the game thread and record/return terminal receipts immediately via `ledger.RememberTerminal(...)`.
   - **Multi-Tick Actions** (e.g. `move_to_tile`, `travel`, `pet_animal`, `collect_animal_product`, `use_item`, `pickup_item`): Handlers record initial `Accepted`/`Running` receipts via `ledger.Remember(...)`, register active execution specifications in `ExecutionManager` / `StardewBodyController`, and let `ExecutionManager.Tick()` advance the state machine per frame to terminal resolution.
5. **`ExecutionManager` Refactoring** (in `Mod`):
   - Implements `IExecutionLedger`. Retains the single-threaded game-thread lifecycle, FIFO ring-buffer memory, and multi-tick frame update loop (`Tick()`).
6. **Domain Action Handlers** (in `Mod`):
   - `MovementActionHandler`: Handles `move_to_tile`, `travel`, `enter_exit` via `StardewBodyController`.
   - `FarmingActionHandler`: Handles `till_soil`, `water_crop`, `plant_seed`, `fertilize_tile`, `harvest_crop`, `clear_hoedirt`.
   - `GatheringActionHandler`: Handles `pickup_forage`, `pickup_item`.
   - `MachineAndAnimalActionHandler`: Handles `machine_inspect`, `machine_load`, `machine_collect_output`, `pet_animal`, `collect_animal_product`, `feed_animal`, `npc_relationship`.
   - `ResourceToolActionHandler`: Handles `equip_tool`, `clear_debris`, `refill_watering_can`, `use_item`, `place_wood_fence`, `place_crab_pot`, `bait_crab_pot`, `dig_artifact_spot`, `break_rock_source`, `chop_tree_source`.
7. **`ActionPreconditionGuard` Unified Guard Helper** (in `Mod`):
   - Encapsulates universal game preconditions (`world_not_ready`, `player_not_actionable`, `invalid_deadline`, `body_owned`, `IsWithinChebyshevDistance`) into a shared helper to eliminate duplicated boilerplate across all 5 action handlers.
8. **`BridgeSession` Dependency Injection Assembly** (in `Mod`):
   - `BridgeSession` accepts `FarmhandActionRouter` via constructor injection. During `ModEntry.OnSaveLoaded`, `ModEntry` initializes `ExecutionManager`, creates the router, registers the 5 handlers, and passes the populated router into `BridgeSession`, eliminating unpopulated router runtime failure modes.

### 3.3 Test Suite Standardization, PBT & Tooling Cleanup
- Replace custom Console applications (`Program.cs` with exit codes) with standard **xUnit** + **Property-Based Testing (FsCheck.Xunit)**.
- Eliminate IL opcode scanning (`Mono.Cecil` / `System.Reflection.Metadata` instruction matching) and SHA-256 binary validation. Replace with behavioral assertions on inputs, returns, state machines, and fail-closed error envelopes.
- Structure test suites into two distinct discoverable test projects:
  - `GameBuddy.Stardew.Core.Tests`: 100% pure unit & property-based tests running in milliseconds on any machine/CI without game dependencies.
  - `GameBuddy.Stardew.Integration.Tests`: Native game mechanical contract tests run when `GamePath` is available.
- Synchronize downstream promotion checkers and toolchain scripts:
  - Update `tools/check-stardew-action-promotion.mjs` and `tools/check-stardew-action-promotion.test.mjs` to reflect modular handler registrations and capability surfaces instead of hardcoded `DelegateActionHandler` regexes.
  - Update `tools/verify-stardew-action-projection-p2c.ps1` and `package.json` test scripts to standardize on `dotnet test`.
  - Isolate Portfolio test suites (`PortfolioMineElevatorProjection.Contract.csproj`, etc.) so legacy Farmhand IL cleanup does not break Portfolio verification.
- Clean up legacy toolchain references (`InternalsVisibleTo.cs`, `FarmhandHandlerSplit.Contract.csproj`, `Run-FarmhandHandlerSplitContract.ps1`).

---

## 4. Verification Strategy

1. **Pure Unit & Property-Based Verification (`dotnet test GameBuddy.Stardew.Core.Tests`)**:
   - **Property-Based Invariants (`FsCheck.Xunit`)**:
     - *Serialization Lossless Round-trip*: $\forall \text{req}, \text{Deserialize}(\text{Serialize}(\text{req})) \equiv \text{req}$.
     - *Malformed Payload Fail-Closed*: $\forall \text{corrupted JSON}, \text{TryDeserialize}(\dots) \equiv \text{false}$.
     - *Policy Denial Non-Membership*: $\forall \text{deniedActions}, \text{deniedActions} \cap \text{enabledActions} = \emptyset$.
     - *Policy Family Denial Completeness*: $\forall \text{action}, \text{Family}(\text{action}) \in \text{DeniedFamilies} \implies \text{action} \notin \text{enabledActions}$.
     - *Router Off-Thread Fail-Closed*: $\forall \text{request on background thread}, \text{TryRoute}(\dots) \implies \text{false} \land \text{reasonCode} = \text{"game\_thread\_required"}$.
     - *Router Unregistered Action Fail-Closed*: $\forall \text{unregistered action ID}, \text{TryRoute}(\dots) \implies \text{false} \land \text{reasonCode} = \text{"action\_not\_available"}$.
   - **Example-Based Behavioral Tests**:
     - Complete serialization round-trips for all 28 canonical action types matching `protocol/bridge-v1.schema.json`.
     - Router replay deduplication and thread boundary tests.
     - Deterministic capability surface projections (v0 legacy, v1 default consent, v1 deny/experimental).
2. **Native Contract Verification (`dotnet test GameBuddy.Stardew.Integration.Tests`)**:
   - Verified execution receipts for native tool usage, pathfinding, and state changes.
3. **End-to-End Live Pipe Compatibility**:
   - Existing TypeScript / Node.js runners (`tools/run-stardew-agent-game-smoke.mjs`) continue to operate over the local named pipe with zero wire-protocol breaking changes.
