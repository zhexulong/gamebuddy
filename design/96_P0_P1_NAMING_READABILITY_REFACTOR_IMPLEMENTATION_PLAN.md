# P0–P1 Naming Readability Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the approved P0–P1 misleading, phase-coupled, compatibility-oriented, and overly generic production names with responsibility-oriented names while preserving runtime behavior and wire contracts.

**Architecture:** This is a destructive source-level rename: production exports, internal symbols, filenames, imports, tests, and comments move together, with no deprecated aliases or compatibility re-exports. The work is divided into a Host/TypeScript lane and a Stardew/C# lane; protocol field names, persisted schemas, environment variables, error codes, and external wire values remain unchanged unless they are source-only symbols explicitly listed below.

**Tech Stack:** TypeScript, Node.js, C#/.NET 6, pnpm, Biome, TypeScript compiler, xUnit.

**Spec:** `AGENTS.md` and the user-approved P0–P1 naming audit represented by the Rename Contract below.

## Global Constraints

- Do not optimize for backward compatibility: old source names are removed, not retained as aliases.
- Preserve runtime behavior, authority relationships, serialized field names, error reason codes, protocol discriminants, SQL schema, environment variables, and public tool names.
- Do not discard or overwrite unrelated dirty-worktree changes; rename the current working-tree content in place.
- Production names describe stable domain responsibility, not implementation-plan phases such as `P3`, `P4`, or `P5`.
- `Manager`, `Service`, `Module`, `Coordinator`, `Lifecycle`, `Surface`, and `Exact` are replaced only where the approved audit identified a more precise role.
- File names follow kebab-case for TypeScript and the primary type name for C#.
- Test names and imports follow production names so searches expose no stale source terminology.

## Rename Contract

### Chat pipeline

- `p3-exact-chat-state` → `mounted-chat-reader`
- `P3ExactChatBinding` → `MountedChatBinding`
- `P3ExactChatMessage` → `BrowserChatMessage`
- `P3ExactChatState` → `MountedChatSnapshot`
- `P3ExactChatStateFacade` → `MountedChatReader`
- `createP3ExactChatStateFacade` → `createMountedChatReader`
- `p3-static-shell-composition` → `tavern-static-shell-composition`
- `P3_BROWSER_ARTIFACT_IDENTITY` → `TAVERN_BROWSER_ARTIFACT_IDENTITY`
- `P3StaticShellCompositionOptions` → `TavernStaticShellCompositionOptions`
- `P3StaticShellComposition` → `TavernStaticShellComposition`
- `createP3StaticShellComposition` → `createTavernStaticShellComposition`
- `p4-durable-turn-acceptance` → `player-turn-acceptance`
- `P4AcceptPlayerMessageCommand` → `AcceptPlayerTurnCommand`
- `P4DurableTurnAcceptanceFacade` → `PlayerTurnAcceptor`
- `createP4DurableTurnAcceptanceFacade` → `createPlayerTurnAcceptor`
- `p4-provider-attempt` → `provider-attempt-claim`
- `P4ProviderAttemptFacade` → `ProviderAttemptClaimer`
- `createP4ProviderAttemptFacade` → `createProviderAttemptClaimer`
- `p4-provider-start-execution` → `provider-invocation`
- source-only `P4C*`, `P4ProviderStart*`, `MountedP4*`, `P5*`, and `P4P5*` names are replaced with responsibility names such as `ProviderInvocation*`, `MountedTurn*`, `Presentation*`, and `MountedTurnTransition*`; persisted/wire/error strings retain their established values.
- `chat-thread-store.p4-p5-transition-authority.internal` → `chat-thread-store.mounted-turn-transition.internal`

### Integration seam

- `CompanionIntegrationState` → `StardewBridgeConnectionState`
- `CompanionIntegration` → `StardewBridgeConnection`
- remove `LegacyStardewIntegration`
- `GameIntegrationModule` → `GameIntegrationAdapter`
- `integration-module.ts` → `game-integration-adapter.ts`
- `IntegrationConnection` → `GameConnection`
- `integration-types.ts` → `game-connection.ts`
- `CompanionIntegrationClient` → `GameBridgeClient`
- `integration.ts` → `game-bridge-client.ts`
- related `*Module*` source symbols become `*Adapter*` when they refer to the game-to-Host seam; protocol and product terminology containing integration remains unchanged.

### Stardew capability publication

- `FarmhandActionAvailability` → `FarmhandCapabilityPublication`
- `FarmhandActionAvailability.cs` → `FarmhandCapabilityPublication.cs`
- `FarmhandCapabilitySurface` → `FarmhandCapabilitySet`
- `FarmhandCapabilitySurface.cs` → `FarmhandCapabilitySet.cs`
- `CatalogRevision` → `CapabilityRevision`
- `Surface` → `CapabilitySet`
- `Capabilities` → `AdvertisedCapabilityIds`
- `FromEnabledActions` → `FromPolicyEnabledOperations`
- `ContainsGameAction` → `AllowsExecutionAction`
- `ContainsReadOnlyOperation` → `AllowsReadOperation`

### Stardew role/process projection

- `StardewGameLifecycleService` → `StardewRoleLifecycleFacade`
- `stardew-game-lifecycle.service.ts` → `stardew-role-lifecycle-facade.ts`
- `StardewGameLifecycleView` → `StardewRoleLifecycleView`
- `readLifecycle` → `readRoleLifecycleView`
- `StardewRoleProcessManager` → `StardewAiClientProcessOwner`
- `stardew-role-process-manager.ts` → `stardew-ai-client-process-owner.ts`
- `StardewRoleStatus` → `StardewAiClientProcessStatus`
- `ManagerState` → `OwnedProcessState`
- `StopResult` → `StopOwnedAiClientResult`
- raw spawn/probe types use `AiClientProcess` and `OwnedProcessIdentity` rather than `RoleProcessManagerRaw`.

### Stardew execution and navigation

- `ExecutionManager` → `FarmhandExecutionController`
- `ExecutionManager*.cs` → `FarmhandExecutionController*.cs`
- partial category suffix `*Handlers.cs` → `*Actions.cs`; real `IFarmhandActionHandler` classes retain `Handler`.
- `NavigationExecutionCoordinator` → `AcceptedNavigationExecution`
- `NavigationExecutionCoordinator.cs` → `AcceptedNavigationExecution.cs`
- `FromAdmission` → `ForAcceptedDestination`
- `HasAcceptedBinding` → `HasAcceptedDestination`
- `Plan` → `PlanDirectTransition`
- `PlanFresh` → `PlanNextRouteLeg`
- `NavigationLifecycle` → `NavigationOutcomeDecider`
- `NavigationLifecycle.cs` → `NavigationOutcomeDecider.cs`
- `Decide` → `DecideDirectTransition`
- `DecideBeforeRoute` → `DecideTerminalBeforeRouting`
- comments stop describing current production paths as `legacy` or `dormant`; they describe the actual direct-transition and accepted-destination paths.

### Precise invariant vocabulary

- Source-only identifiers where `Exact` merely means current binding, key-shape equality, mounted attempt identity, or one-shot authority are renamed to the concrete invariant (`Current`, `Binding`, `OnlyKeys`, `MountedTurn`, `SingleUse`).
- Domain phrases and wire/error values in which `exact` is part of an established external contract are unchanged.
- This task does not perform a blind repository-wide replacement of prose uses of the English word “exact”.

---

### Task 1: Freeze source inventory and rename guard

**Files:**
- Create: `design/96_P0_P1_NAMING_READABILITY_REFACTOR_IMPLEMENTATION_PLAN.md`
- Inspect: `host/src/**/*.ts`
- Inspect: `integrations/stardew/**/*.cs`

**Interfaces:**
- Consumes: the Rename Contract above and the current dirty working tree.
- Produces: a complete list of source and test references to each old identifier and filename.

- [ ] **Step 1: Capture source references**

Run targeted `rg -l` searches for every old TypeScript and C# identifier in the Rename Contract. Record all production and test files; exclude generated output, `bin`, `obj`, and archived design documents.

- [ ] **Step 2: Confirm dirty-worktree ownership**

Run `git status --short -- host/src integrations/stardew` and preserve every pre-existing edit. Use moves and identifier substitutions on current file content; do not restore files from `HEAD`.

- [ ] **Step 3: Define the residual scan**

Prepare a final `rg` command that fails if old source identifiers, old imports, or old filenames remain in active production/test code. External strings explicitly protected by Global Constraints are excluded.

### Task 2: Rename the mounted Chat read and turn pipeline

**Files:**
- Move/Modify: `host/src/tavern/p3-exact-chat-state.ts` and test → `mounted-chat-reader.ts` and test
- Move/Modify: `host/src/tavern/p3-static-shell-composition.ts` and test → `tavern-static-shell-composition.ts` and test
- Move/Modify: `host/src/tavern/p4-durable-turn-acceptance*.ts` → `player-turn-acceptance*.ts`
- Move/Modify: `host/src/tavern/p4-provider-attempt*.ts` → `provider-attempt-claim*.ts`
- Move/Modify: `host/src/tavern/p4-provider-start-execution*.ts` → `provider-invocation*.ts`
- Move/Modify: `host/src/tavern/chat-thread-store.p4-p5-transition-authority.internal.ts` → `chat-thread-store.mounted-turn-transition.internal.ts`
- Modify: all direct Host callers and tests returned by Task 1

**Interfaces:**
- Consumes: `MountedChatRuntimeLease`, `HostDeploymentManifest`, `ChatThreadStore`, and existing coordinator-owned authority.
- Produces: `MountedChatReader`, `PlayerTurnAcceptor`, `ProviderAttemptClaimer`, and responsibility-named provider/presentation transition interfaces with unchanged behavior.

- [ ] **Step 1: Move files and rename exports/imports**

Apply every Chat pipeline mapping in the Rename Contract. Update ESM `.js` import paths together with TypeScript source paths and rename matching tests.

- [ ] **Step 2: Replace phase names inside the production coordinator**

Rename source-only P4/P5 capability, binding, invocation, and transition symbols according to their actual responsibility. Do not change error strings, durable ledger discriminants, SQL fields, or browser contract fields.

- [ ] **Step 3: Run focused Chat tests**

Run the renamed test artifacts through the Host test runner or build-test artifact workflow, plus `pnpm --filter @gamebuddy/companion-host typecheck`. Expected: all selected tests and both TypeScript projects pass.

### Task 3: Rename the game integration seam

**Files:**
- Move/Modify: `host/src/integration-types.ts` → `host/src/game-connection.ts`
- Move/Modify: `host/src/integration-module.ts` and test → `host/src/game-integration-adapter.ts` and test
- Move/Modify: `host/src/integration.ts` and test → `host/src/game-bridge-client.ts` and test
- Move/Modify: affected launchers, catalogs, materializers, runtime, tools, knowledge, manifests, and tests from Task 1

**Interfaces:**
- Consumes: existing launch handles, protocol types, and adapter-owned game state.
- Produces: `GameConnection`, `StardewBridgeConnection`, `GameIntegrationAdapter`, and `GameBridgeClient`; no legacy alias.

- [ ] **Step 1: Move the three owning files**

Move each source and matching test file without reconstructing it from `HEAD`. Update all imports to the new filenames.

- [ ] **Step 2: Rename seam symbols**

Replace the approved type/class names and all `GameIntegrationModule`-derived source names with adapter terminology. Delete `LegacyStardewIntegration` and update callers directly.

- [ ] **Step 3: Verify the seam**

Run Host typecheck and focused integration catalog/launcher/adapter/bridge tests. Expected: no old type names and no behavior assertion changes.

### Task 4: Rename Stardew capability publication

**Files:**
- Move/Modify: `integrations/stardew/src/Core/Policy/FarmhandActionAvailability.cs` → `FarmhandCapabilityPublication.cs`
- Move/Modify: `integrations/stardew/src/Core/Policy/FarmhandCapabilitySurface.cs` → `FarmhandCapabilitySet.cs`
- Move/Modify: matching core tests
- Modify: `BridgeSession.cs`, `ExecutionManager.cs`/renamed controller, `ModConfig.cs`, `ModEntry.cs`, protocol projections, and affected tests

**Interfaces:**
- Consumes: `FarmhandActionCatalog` and policy-enabled operation IDs.
- Produces: immutable `FarmhandCapabilityPublication` containing `CapabilityRevision` and `FarmhandCapabilitySet`.

- [ ] **Step 1: Rename the publication and set**

Apply all capability mappings while preserving ordering, revision increment behavior, protocol values, and action/read/control membership.

- [ ] **Step 2: Update all producers and consumers**

Update Mod policy resolution, bridge hello/snapshot publication, execution authorization, and tests to use the new names.

- [ ] **Step 3: Run capability tests**

Run `dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests` with filters for policy/publication tests, followed by the complete Core suite.

### Task 5: Rename Stardew process ownership and role projection

**Files:**
- Move/Modify: `host/src/stardew-role-process-manager.ts` and test → `stardew-ai-client-process-owner.ts` and test
- Move/Modify: `host/src/stardew-game-lifecycle.service.ts` and test → `stardew-role-lifecycle-facade.ts` and test
- Modify: game browser state provider and all direct callers

**Interfaces:**
- Consumes: `StardewAttachmentFlow` and the direct-spawn AI-client process owner.
- Produces: `StardewAiClientProcessOwner` and `StardewRoleLifecycleFacade` with unchanged ownership and stop semantics.

- [ ] **Step 1: Move files and rename ownership types**

Apply the process owner mappings, including test dependency types and factory names.

- [ ] **Step 2: Rename the composed role view**

Apply the role lifecycle facade mappings and replace `#manager` with `#processOwner`. Keep categorical browser values and schema version unchanged.

- [ ] **Step 3: Run focused lifecycle tests**

Run the renamed process-owner, role-lifecycle, and game-browser-state-provider tests plus Host typecheck.

### Task 6: Rename the Farmhand execution owner and Navigation decision modules

**Files:**
- Move/Modify: `integrations/stardew/ExecutionManager*.cs` → `FarmhandExecutionController*.cs`
- Move/Modify: `integrations/stardew/Navigation/NavigationExecutionCoordinator.cs` → `AcceptedNavigationExecution.cs`
- Move/Modify: `integrations/stardew/Navigation/NavigationLifecycle.cs` → `NavigationOutcomeDecider.cs`
- Move/Modify: matching tests and all C# callers

**Interfaces:**
- Consumes: existing action handlers, execution ledger, navigation runtime snapshot, admitted destination, and native transition driver.
- Produces: `FarmhandExecutionController`, `AcceptedNavigationExecution`, and `NavigationOutcomeDecider`; behavior and authority remain unchanged.

- [ ] **Step 1: Rename the execution owner**

Move the partial class files, rename the partial class and all references, and change partial category suffixes from `Handlers` to `Actions`. Do not split behavior in this naming-only batch.

- [ ] **Step 2: Rename Navigation responsibility symbols**

Apply the Navigation mappings. Update direct-transition and accepted-destination callers so method names expose which path is used.

- [ ] **Step 3: Remove misleading compatibility prose**

Replace source comments that call active paths `legacy`, `dormant`, or `unintegrated` with descriptions of their concrete direct-transition or accepted-destination semantics. Do not remove either behavior path in this batch.

- [ ] **Step 4: Run focused and complete Stardew tests**

Run filtered Navigation/execution tests, then `pnpm test:stardew:core` and `pnpm test:stardew:integration`.

### Task 7: Normalize precise invariant vocabulary

**Files:**
- Modify: active production/test files touched by Tasks 2–6 only

**Interfaces:**
- Consumes: source-only identifiers containing ambiguous `Exact` terminology.
- Produces: invariant-specific names without changing established wire, persistence, or error contracts.

- [ ] **Step 1: Classify touched `Exact` identifiers**

For each touched identifier, classify whether it means key-shape equality, binding identity, current lease, mounted turn, or single-use capability. Leave domain/external contract strings unchanged.

- [ ] **Step 2: Rename only classified source symbols**

Use names such as `hasOnlyKeys`, `matchesBinding`, `CurrentMountedTurn`, and `SingleUseAdmission`; update tests and comments together.

- [ ] **Step 3: Run Host typecheck and affected tests**

Expected: source symbols compile, external string assertions are unchanged, and behavioral tests pass.

### Task 8: Final verification and independent review

**Files:**
- Inspect: all files changed by Tasks 2–7
- Modify: only defects found by verification/review

**Interfaces:**
- Consumes: completed TypeScript and C# rename lanes.
- Produces: verified behavior-preserving P0–P1 naming refactor.

- [ ] **Step 1: Run residual naming scans**

Search active Host/Stardew production and tests for every old source identifier and old import path. Expected: zero matches except explicitly protected external strings or historical design text.

- [ ] **Step 2: Run static verification**

Run `pnpm --filter @gamebuddy/companion-host typecheck`, `pnpm --filter @gamebuddy/companion-host build`, `pnpm lint`, and `git diff --check`.

- [ ] **Step 3: Run behavioral suites**

Run Host focused/complete tests as practical, `pnpm test:stardew:core`, and `pnpm test:stardew:integration`. Record pre-existing unrelated failures separately; any rename-caused failure blocks completion.

- [ ] **Step 4: Review the actual diff**

A fresh read-only reviewer checks: Rename Contract coverage, no compatibility aliases, no accidental wire/schema/error changes, no overwritten dirty-worktree content, filename/import consistency, and test evidence.

- [ ] **Step 5: Close the batch**

Report moved/modified files, exact commands and exit codes, residual risks, and any protected old strings intentionally retained. Do not commit unless the user separately requests a commit.
