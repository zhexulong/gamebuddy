---
id: TASK-59-STARDEW-HUMANLIKE-COMPANION
type: task
status: active
owner: game-runtime
---

# Stardew Humanlike Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and verify the Mod-owned offline contract for two candidate Stardew Game Actions (`express_emote` and `face_direction`) and a bounded typed salient-event ingress, then hand the result to the current production release owner as `offline_complete/live_blocked` until a separately authorized formal action gate exists.

**Architecture:** The Mod remains the sole authority for registration, descriptor, lifecycle, capability publication, game-thread admission, actor binding, native transition, receipt, evidence, postcondition, and event identity. The actions reuse the existing `ModEntry → FarmhandActionRouter → family handler → ExecutionManager` path, the existing `BridgeSession`/`LocalPipeBridge`, and the existing Host admission/receipt path. Host consumes authenticated Mod projections restrictively; it does not become an action registry, event journal, receipt authority, Magic Context storage owner, or raw-tail writer. The action-development package is used only for source/projection parity and offline contract checks; it is not a second live runtime or formal production action gate. Magic Context verification is an external package-owned concern and is not implemented or claimed by this Stardew slice.

**Tech Stack:** C#/.NET 6, Stardew Valley `1.6.15` build `24356`, SMAPI `4.5.2`, xUnit, TypeScript, Node 24 (`node --test`), pnpm 11, the existing Stardew bridge, and the embedded GameBuddy Magic Context package when its separate package tests are run.

**Spec:** `design/architecture/stardew-humanlike-companion-architecture.md`

**Release boundary:** This plan owns offline action/event contract closure and target-version source/API characterization only. Installation registration, bootstrap containment, formal Player Host/AI Client lifecycle, production artifact attestation, the production `GameAdapter`/coordinator action runner, formal `native_ai_farmhand_multiplayer` execution, player onboarding, and the unique Stardew companion-experience gate remain external prerequisites. Preview, native-local fixtures, Portfolio evidence, the legacy `integrations/stardew/action-development` live/profile path, handwritten reports, and existing `equip_tool` evidence cannot satisfy a candidate action gate. Task 7 is an explicit handoff, not a parallel live implementation.

## Global Constraints

- `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` is the Mod registration authority. Host registry, protocol, tools, fixtures, action-development projections, and tests are restrictive consumers.
- The candidate descriptor must carry exact argument names/types, bounded enum values, canonical codec identity, native binding identity, resource template, effect, action-specific evidence schema, and postcondition identity. The current `FarmhandActionRegistrationWire` and Host `ActionRegistration` carry only identity/family/version/lifecycle/kind; the plan must extend that authenticated projection before candidate tool schemas can be materialized.
- `experimental` registrations are not published Agent-facing capabilities. The current `ActionPolicyEngine` may explicitly opt an experimental ID into a test-only policy surface; that existing behavior is not a production publication or formal live eligibility. Host visibility must additionally require `published`, current live capability, policy permission, and a matching complete descriptor. This slice must not silently change the current test-only opt-in semantics.
- Every mutation rechecks bridge scope, current Mod capability publication, catalog/capability revision, policy identity where present, deadline, request identity, idempotency identity, cancellation identity, bound actor identity, and game-state preconditions on the game thread before native dispatch.
- `express_emote` has exactly one action argument, `emote`. It has no `facePlayer`, social target, implicit facing, text, or target search. Its candidate native binding is expected to be `Farmer.doEmote(emoteId)`, but that binding, the ID mapping, and its completion boundary remain unverified until Task 1 and Task 7. It never writes `CurrentEmote`, `emoteInterval`, or another native private field. An active emote is `state: rejected`, `reasonCode: emote_busy`.
- `face_direction` is an independent `movement_navigation` action in the existing `Movement` handler group. It accepts only the Mod-declared cardinal enum. Its candidate native binding is expected to be `Farmer.faceDirection`, but the direction mapping remains unverified until Task 1 and Task 7. This slice rejects a moving actor as `state: rejected`, `reasonCode: actor_moving`; it does not stop the actor or silently downgrade the request.
- The actor is resolved by a named Mod resolver and must satisfy `actor.UniqueMultiplayerID == BridgeScope.PlayerId` in the formal AI-client process. These actions have no social target. A future social event must carry separate actor and target identities.
- `accepted`, `running`, and `meaningful_progress` are non-terminal states. `emote_busy`, `actor_moving`, `actor_not_available`, and `postcondition_failed` are reason codes, not states.
- A successful mutation requires the same request/execution lineage, terminal `succeeded` receipt, non-empty action-specific evidence, typed observation, fresh action-specific postcondition, and fresh observation. Action evidence and observation are separate fields.
- New candidate actions must receive durable admission before native dispatch. The current `BridgeSession` creates a durable journal admission only for `navigate_to_destination`; Task 3 must extend the same immutable `{scope, requestId, idempotencyKey, action, canonical args, expectedRevision, deadline, executionId}` tuple to the candidates before allowing a native call. An in-memory receipt is not restart-safe.
- Response-loss recovery uses the existing read-only query `{requestId, idempotencyKey}`. A known `executionId` is an additional exact-match check, never a required query field. Only authoritative `not_accepted` permits resubmission of the identical envelope; an uncertain native mutation is never blindly resent.
- The Mod does not add a generic event bus, event journal, retry loop, priority FIFO, or hidden drop queue. Existing `LocalPipeBridge` and Host `CompanionEventPump` backpressure remains an explicit transport/unavailable/containment outcome.
- The first event wire contains only `day_started` and milestone `time_milestone` for `0600`, `1200`, `1800`, and `2200`. `ReceiveGift`, combat/damage, low health, task transitions, `player_dwell_facing`, and natural-language heuristics are not published by this plan.
- Event identity is Mod-owned and stable within the authenticated scope: `day_started_day_<TotalDays>` and `time_milestone_day_<TotalDays>_<HHmm>`. `sourceEventId`, `eventId`, and `deduplicationKey` are not bridge `messageId` values and are not credentials. Reconnect may redeliver the same event; consumers deduplicate it. This plan makes no durable at-least-once event-log claim.
- `BridgeLocalObservation` is a bounded typed observation. It contains only the actor location/tile/facing, in-game time, whether another Farmer is within the declared local radius on the same location, and observation revision. It never contains prompt text, credentials, transport tokens, or inferred social intention. Its fields must be added to the existing receipt model without changing `BridgeReceipt.Evidence` into an arbitrary JSON container.
- Magic Context owns tags, `ctx_reduce`, `pending_ops`, protected-tag behavior, materialization, and Memory. Host tests do not inspect or write its SQLite. The current Game runtime constructs `SettingsManager.inMemory({ compaction: { enabled: false } })`, so the embedded Pi plugin reports `ctx_reduce` unavailable in that surface; this plan does not change that runtime configuration or claim Game-surface `ctx_reduce` availability.
- Short-lived world state, raw event payloads, receipts, and piggyback observations do not directly create global `SEMANTIC_MEMORY` or `INTERACTION_EPISODE` rows. Memory promotion is outside this slice.
- This plan does not publish or alter `navigate_to_destination`, `equip_tool`, `move_to_tile`, `water_crop`, a Body Program node, a multi-action cooperation scenario, Portfolio behavior, or the companion-experience gate.
- This plan does not implement or accept formal live evidence. Any later action eligibility must use the current production `GameAdapter`/coordinator owner, the formal `native_ai_farmhand_multiplayer` topology, production coordinator/bridge/Mod artifacts, and a legal isolated save. The legacy action-development package, Preview, native-local fixtures, Portfolio, and caller-authored JSON/Markdown logs are not completion authority.
- C# tests use `dotnet test`; Host tests use the repository's compiled Node 24 runner; action-development tests use the package script and standalone extraction rehearsal only for offline parity; `vitest` is not installed and must not be invoked.

---

## File Structure

| File | Responsibility |
|---|---|
| `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` | Add the frozen `Expression` handler group and register both candidates as `Experimental`; extend candidate descriptors with enum/codec/native/evidence/postcondition metadata. Existing published registrations may retain their current restrictive identity projection in this slice; candidate descriptors must be complete before candidate visibility. This source must enter both source-projection inventories; generated action-surface JSON remains a projection, not the registration authority. |
| `integrations/stardew/src/Core/Policy/farmhandactionsurfacepublication.cs` | Project the Mod-owned descriptor, including candidate metadata, without publishing live availability. |
| `integrations/stardew/src/Core/Policy/farmhandcapabilityset.cs`, `integrations/stardew/src/Core/Policy/ActionPolicyEngine.cs`, `integrations/stardew/ModConfig.cs` | Keep the current published-default and explicit test-only experimental policy semantics, remove any new duplicate candidate membership, and prove that candidate lifecycle/policy cannot enter the formal Agent-facing production surface. |
| `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs` | Add candidate argument fields, descriptor projection fields, `BridgeLocalObservation`, and `BridgeWorldFact`. |
| `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs` and `protocol/bridge-v1.schema.json` | Validate exact candidate action/event wire shapes, bounded payloads, optional observations, and the unchanged receipt-query tuple. |
| `integrations/stardew/Handlers/ExpressionActionHandler.cs` | New thin `Expression` family handler delegating `express_emote` to `ExecutionManager`; it owns no ledger or publication. |
| `integrations/stardew/Handlers/MovementActionHandler.cs` | Add the `face_direction` dispatch to the existing movement handler. |
| `integrations/stardew/farmhandexecutioncontroller.cs` and its existing partials | Add durable candidate admission, named actor resolution, native methods, observation capture, postconditions, journal transitions, and cancellation/recovery behavior. |
| `integrations/stardew/FarmhandExecutionJournal.cs` | Extend the existing durable admission/receipt record for candidate canonical arguments and optional typed observation. |
| `integrations/stardew/BridgeSession.cs` and `integrations/stardew/ModEntry.cs` | Mint/bind candidate execution identities, enforce lifecycle/capability gates, compose handlers, publish typed facts, and retain current session boundaries. |
| `integrations/stardew/Sensory/ISalientEventFilter.cs` and `integrations/stardew/Sensory/StardewSalientEventHooks.cs` | Filter only the two frozen native sources, construct stable typed IDs, and best-effort publish through the existing bridge. |
| `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/` | Registration, lifecycle, descriptor, protocol, handler, actor-binding, journal, observation, and filter tests. |
| `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/` | Target-version source/API characterization and formal bridge recovery tests; absence of a game-thread harness is `blocked`, not a pass. |
| `integrations/stardew/action-development/src/action-source-projection-producer.mjs`, `action-source-projection-check.mjs`, `projection-source-layout.json`, and their `standalone/` counterparts | Extend both producer/checker modes, their fixed source inventories, `projection-source-layout.json` files, and standalone extraction inputs for the frozen handler group, descriptor fields, candidate lifecycle, and typed `world_fact`. The package is an offline source/projection checker only; update repository-root and standalone inputs through the existing producer/checker and `action:extraction-rehearsal` procedure, never by hand-editing generated artifacts. |
| `integrations/stardew/action-development/contracts/generated/action-surface.v1.json`, `contracts/projection/*.v1.json`, and the corresponding `standalone/inputs/action-projection-source/` artifacts | Regenerated restrictive Mod/source projections; never hand-edit them as a second authority. The fixed inventories must include the canonical registration/policy/descriptor/protocol/handler/journal sources, not merely the already-generated JSON. Standalone inputs are an extraction mirror and must remain coherent through the approved extraction procedure. |
| `host/src/protocol.ts` and `host/src/local-stardew-bridge.ts` | Consume authenticated descriptors, typed world facts, and optional observations while retaining `{requestId,idempotencyKey}` recovery. |
| `host/src/stardew-integration-launcher-body-program.internal.ts` | Convert the new authenticated `world_fact` to Host `WorldFact` without replacing Mod event identity with bridge `messageId`. |
| `host/src/game-integration-adapter.ts`, `host/src/action-registry.ts`, `host/src/game-tools.ts`, and `host/src/stardew-game-integration-adapter.ts` | Keep compiled adapter support separate from Mod membership and build candidate schemas only from authenticated descriptors. The existing static `STARDEW_ACTION_ADAPTERS` list is support metadata, not candidate membership or enum authority. |
| `host/src/event-pump.ts` and `host/src/host-service.ts` | Forward bounded typed facts through the existing integration-fact path; retain current coalescing/overflow/clear behavior. |
| `host/src/stardew-humanlike-event-boundary.test.ts` and direct Host tests | Test typed conversion, stable IDs, duplicate delivery, malformed input, ordering, and overflow only; no SQLite assertions. |
| `design/architecture/release-model.md`, `design/domains/stardew/integration.md`, and the external production action-gate owner | Define the handoff boundary for later formal live eligibility. This plan does not create a second evidence verifier, action-development runner, live charter, or publication authority. |
| `design/architecture/stardew-humanlike-companion-architecture.md` | Record candidate boundaries and actual evidence/status only; do not close installation, lifecycle, context, or companion gates here. |

---

### Task 0: Freeze the boundary against the actual current seams

**Files:**
- Test/check only: `integrations/stardew/action-development/tests/action-source-projection-drift.test.mjs`, `integrations/stardew/action-development/tests/action-surface-consumer.test.mjs`, `integrations/stardew/action-development/tests/extraction-audit.test.mjs` (the boundary matrix is recorded in this plan plus the linked candidate architecture; execution must not rewrite either document as an implementation side effect)

**Interfaces:**
- Consumes: `design/domains/stardew/integration.md`, `design/architecture/game-action-model.md`, `design/architecture/release-model.md`, `design/09_BDD_VALIDATION_PLAN.md`, `design/tasks/active/open-gameplay-release.md`, `ModEntry → FarmhandActionRouter → family handler → ExecutionManager`, and `BridgeSession.TryExecute`/`TryQueryExecutionReceipt`.
- Produces: a checked boundary matrix in this plan naming the new `ExpressionActionHandler`, existing `MovementActionHandler`, durable candidate-admission seam, actor resolver, descriptor wire, `world_fact` wire, receipt/observation split, and external blockers. No separate boundary authority is created.

- [ ] **Step 1: Add boundary assertions** that reject accepted-as-terminal, `executionId`-required receipt queries, unverified `Game1.player` actor use, Preview/native-local/Portfolio formal evidence, experimental execution capabilities, and Host-created enum membership.
- [ ] **Step 2: Record the fixed composition.** The new route is `FarmhandActionHandlerGroup.Expression → ExpressionActionHandler`; `face_direction` is added to existing `MovementActionHandler`. Both delegate to the same `ExecutionManager`, journal, cancel, and receipt publication path. If the production source-projection closure or current handler composition cannot carry `Expression`, stop with `blocked` rather than choosing a parallel router or second authority.
- [ ] **Step 3: Record the current gaps explicitly.** The current Mod has no `Expression` group, candidate registrations, typed world-fact envelope, typed observation field, or durable candidate admission; the current Host registration is identity-only and the current Game runtime does not mount `ctx_reduce`.
- [ ] **Step 4: Run the existing offline projection checks:**
  ```bash
  pnpm --dir integrations/stardew/action-development test
  node integrations/stardew/action-development/src/action-source-projection-check.mjs
  node integrations/stardew/action-development/standalone/src/action-source-projection-check.mjs
  pnpm --dir integrations/stardew/action-development action:extraction-rehearsal
  ```
  A missing prerequisite is recorded as `blocked` with its reason; it is never converted to a fake pass. These commands prove source/projection parity only; they do not establish a production live gate.
- [ ] **Step 5: Do not begin native implementation** until the boundary card has one fixed handler owner, one durable admission method, one actor resolver, one event envelope, and one recovery tuple. Task 0 itself does not modify the two design documents; later implementation tasks update architecture status only through their evidence rules.

### Task 1: Characterize target-version source/API facts without mislabelling live behavior

**Files:**
- Create: `tools/stardew-humanlike-target-version-characterization.mjs` and `tools/stardew-humanlike-target-version-characterization.test.mjs` for executable redacted source/API assertions.
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/target-version-evidence/emote-facing-characterization.json` only after the tool emits a redacted artifact.
- Do not add a conditional xUnit fixture that cannot load the target game-thread runtime; existing xUnit projects remain contract/harness tests, not native target characterization.
- Modify: `tools/inspect-stardew-gameplay-surface.mjs` and its focused test only if the existing inspector cannot emit the required fixed target anchors.
- Modify: `design/architecture/stardew-humanlike-companion-architecture.md` only to record observed facts.

**Interfaces:**
- Consumes: an explicitly supplied Stardew Valley `1.6.15.24356` installation, SMAPI `4.5.2`, the existing `tools/inspect-stardew-gameplay-surface.mjs`, and a named characterization entrypoint. The current xUnit integration project conditionally references DLLs; it is not a game-thread harness.
- Produces: redacted source/API facts for `Farmer.doEmote`, `Farmer.faceDirection`, four cardinal values, candidate emote mapping, `isEmoting`, moving-state behavior, and the exact postcondition fields. It separately reports `live_observation: unavailable` when no real game-thread harness exists.

- [x] **Step 1: Add red source/API tests** for method presence/signature, the four direction values, candidate emote mapping, and the `isEmoting`/moving-state questions. A metadata/decompilation assertion must not be named a native side-effect test.
- [x] **Step 2: Run the existing fixed-target audit** using the documented `--game-path`/environment-variable input and a disposable report path:
  ```powershell
   $env:GAMEBUDDY_STARDEW_GAME_PATH = (Resolve-Path $env:GAMEBUDDY_STARDEW_GAME_PATH).Path
   node tools/inspect-stardew-gameplay-surface.mjs --game-path "$env:GAMEBUDDY_STARDEW_GAME_PATH" --out "$env:TEMP\gamebuddy-stardew-gameplay-surface.json"
  ```
  Redact the report before retention. A missing or mismatched installation is `blocked/target_installation_unavailable`; an absent game-thread harness is `blocked/live_harness_unavailable`.
- [x] **Step 3: Record only target version/build, source/API anchors, mapping facts, and redacted artifact identity. Do not store installation paths, full decompiled source, save data, prompt text, model output, or fabricated actor state.
- [x] **Step 4: Keep both registrations `experimental` and block live eligibility** whenever the native transition, completion lifecycle, or mapping is not proven. No fallback native method is added.
- [x] **Step 5: Run the executable characterization tool test and the existing source-inspection tests:**
  ```bash
  node --test tools/stardew-humanlike-target-version-characterization.test.mjs tools/stardew-gameplay-surface-rules.test.mjs
  git diff --check
  ```
  A missing target is `blocked`, not a skipped/pass result. Do not add a conditional xUnit test whose absence of a game-thread fixture is silently treated as success.

### Task 2: Extend the Mod-owned descriptor, capability lifecycle, and bridge wire

**Precondition:** Task 1 may provide source/API facts, but this task keeps both registrations `Experimental` and does not publish a live capability.

**Files:**
- Modify: `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`
- Modify: `integrations/stardew/src/Core/Policy/farmhandactionsurfacepublication.cs`
- Modify: `integrations/stardew/src/Core/Policy/farmhandcapabilityset.cs`, `integrations/stardew/src/Core/Policy/farmhandcapabilitypublication.cs`, `integrations/stardew/src/Core/Policy/ActionPolicyEngine.cs`, and `integrations/stardew/ModConfig.cs`
- Modify: `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`
- Modify: `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs`
- Modify: `protocol/bridge-v1.schema.json`
- Modify/regenerate: `integrations/stardew/action-development/src/action-source-projection-producer.mjs`, `integrations/stardew/action-development/src/action-source-projection-check.mjs`, `integrations/stardew/action-development/projection-source-layout.json`, `integrations/stardew/action-development/contracts/generated/action-surface.v1.json`, `integrations/stardew/action-development/contracts/projection/action-source-projection.v1.json`, plus the corresponding `standalone/` producer/checker/layout and `inputs/action-projection-source/` mirror. Include the repository-root and standalone copies of `farmhandcapabilitypublication.cs`; it is a publication projection input, not a second policy authority.
- Test: existing `FarmhandActionSurfaceExportTests`, new registration/descriptor/capability/protocol tests, and action-development parity tests.

**Interfaces:**
- Consumes: Task 1 mapping facts and the current `FarmhandActionRegistration`/`FarmhandActionDescriptor` projection.
- Produces: candidate registrations with `actionId`, `familyId`, `identityVersion: 1`, `lifecycle: experimental`, `kind: execution`, exact arguments, bounded enum values, canonical codec, native binding, resource template, effect, evidence schema, and postcondition. The authenticated wire must carry these fields for candidate actions; legacy identity-only entries remain non-publishable until their descriptor is complete.

```csharp
FarmhandActionArgument(name, type, boundedEnumValues)
FarmhandActionDescriptor(arguments, outputFacts, resourceTemplate,
    effect, evidenceSchema, nativeBinding, canonicalCodec, postcondition)
```

- [ ] **Step 1: Add failing tests** asserting `express_emote` has exactly `emote`, `face_direction` has exactly `direction`, neither has `facePlayer`/social target, both are experimental, and candidate descriptor fields are non-empty and Mod-generated.
- [ ] **Step 2: Add the `Expression` group and two registrations**. The emote enum/ID mapping comes only from Task 1; a missing/conflicting mapping keeps `express_emote` unavailable. `face_direction` uses the four registered cardinal strings and native binding `Farmer.faceDirection`.
- [ ] **Step 3: Extend `FarmhandActionSurfacePublication`** to project candidate metadata directly from `FarmhandActionCatalog.Registrations`; update both producers/checkers, both `projection-source-layout.json` files, their fixed source inventories, `HANDLER_GROUP_CLASS_NAMES.Expression`, the repository-root/standalone source layouts, and the approved extraction inputs, then regenerate projection artifacts through the existing producer/checker procedure. No Host enum map is added. The producer inventory must also include `ActionPolicyEngine.cs`, `ModConfig.cs`, both repository-root and standalone `farmhandcapabilitypublication.cs` inputs, `BridgeSession.cs`, `BridgeProtocolModels.cs`, `BridgeProtocol.cs`, `IFarmhandActionHandler.cs`, `IExecutionLedger.cs`, `IDispatchExecutionLedger.cs`, `ActionPreconditionGuard.cs`, `FarmhandExecutionJournal.cs`, and relevant handler sources so policy, descriptor, router and journal drift is observable.
- [ ] **Step 4: Update the Mod policy projection without changing current policy meaning.** Preserve `ActionPolicyEngine`'s explicit test-only experimental opt-in, but ensure candidate actions are never in the published-default Agent surface and never visible from an incomplete descriptor. Add tests for default policy, explicit experimental policy, denied action/family, live capability publication, and Host visibility. Do not assert that every experimental ID is excluded from `FarmhandCapabilitySet.FromPolicyEnabledOperations`; that would contradict the current test-only policy contract.
- [ ] **Step 5: Extend C# and JSON validation** to reject unknown keys, duplicate arguments, empty enum values, incomplete candidate metadata, unsupported lifecycle/kind combinations, and arguments that do not match the registered descriptor. Keep receipt queries exactly `{requestId,idempotencyKey}`.
- [ ] **Step 6: Run:**
  ```bash
  pnpm test:stardew:core
  pnpm --dir integrations/stardew/action-development test
  node integrations/stardew/action-development/src/action-source-projection-check.mjs
  node integrations/stardew/action-development/standalone/src/action-source-projection-check.mjs
  pnpm --dir integrations/stardew/action-development action:extraction-rehearsal
  ```
  Expected: existing published actions remain unchanged; candidates remain non-published and absent from production Agent visibility unless a later reviewed publication changes lifecycle and complete descriptor validity.
- [ ] **Step 7: Commit only descriptor/capability/protocol files and generated projection artifacts** with an exact allowlist.

**Task 2 completion:** The candidate descriptor/wire may be complete while both actions remain hidden and non-executable. No native side-effect claim is made.

### Task 3: Implement candidate actions through durable ExecutionManager admission

**Precondition:** The current production route is `ModEntry → FarmhandActionRouter → family handler → ExecutionManager`; ordinary non-navigation actions currently use in-memory receipt admission, while Navigation alone uses `FarmhandExecutionJournal`. Candidate native dispatch is forbidden until durable candidate admission is added.

**Files:**
- Create: `integrations/stardew/Handlers/ExpressionActionHandler.cs`
- Modify: `integrations/stardew/Handlers/MovementActionHandler.cs`
- Modify: `integrations/stardew/ModEntry.cs`
- Modify: `integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs`
- Modify: `integrations/stardew/BridgeSession.cs`
- Modify: `integrations/stardew/farmhandexecutioncontroller.cs` and `farmhandexecutioncontroller.movementactions.cs`
- Modify: `integrations/stardew/Handlers/ActionPreconditionGuard.cs`
- Modify: `integrations/stardew/FarmhandExecutionJournal.cs`
- Test: new candidate action/journal/bridge recovery tests in Core and Integration projects.

**Interfaces:**
- `BridgeSession` mints one `executionId` for each candidate before routing, calls a shared durable admission method, and passes that identity to `FarmhandActionRouter.TryRoute`.
- `ExpressionActionHandler.Execute` obtains the already bound execution identity from `IDispatchExecutionLedger` and delegates only `express_emote`.
- `MovementActionHandler.Execute` delegates only `face_direction` to the new `ExecutionManager` method.
- `IDispatchExecutionLedger` remains the only existing identity-binding interface (`TryBindDispatch` and `TryGetBoundExecutionId`). The implementation must add a named candidate-admission method beside `TryAdmitNavigation`, and candidate handler methods must match the existing `IFarmhandActionHandler.Execute(BridgeExecutionRequest, IExecutionLedger)` signature. Any new `TryGetBoundActor`, `RequestLocalExpressEmote`, or `RequestLocalFaceDirection` helper is internal to `ExecutionManager`; its exact parameters must use the canonical request/ledger types introduced by this task, not an invented public interface. Both methods use the existing receipt publication, trace, idle-release, cancellation, and journal owners.

- [x] **Step 1: Add red tests** for invalid enum, missing/world-unready actor, `UniqueMultiplayerID` mismatch, stale revision, expired deadline, candidate absent from the published/default capability surface, explicit test-only experimental policy isolation, active embodied-actor mutation, active emote (`rejected/emote_busy`), moving actor (`rejected/actor_moving`), duplicate request/idempotency replay, cancellation before native dispatch, journal write failure, response-loss query, and postcondition mismatch.
- [x] **Step 2: Implement durable candidate admission** using the same immutable tuple as Navigation. A failed journal write quarantines the request and prevents any native call. A durable pending record is created before `doEmote`/`faceDirection`.
- [x] **Step 3: Implement `TryGetBoundActor`** as the only conversion from the current native `Game1.player` object to the scope-bound actor. It checks world readiness, current location, and `actor.UniqueMultiplayerID == executionScope.PlayerId`; it never scans `Game1.otherFarmers` or nearest players. If formal actor binding cannot be proven in the current lifecycle, keep the candidate `live_ineligible`; do not promote local-fixture identity.
- [x] **Step 4: Implement `RequestLocalExpressEmote`**. Recheck the current publication/revision/deadline/cancel/body owner, reject `actor.isEmoting`, decode the Mod-registered enum, call `actor.doEmote(emoteId)` on the game thread, and wait for the characterized lifecycle boundary. Only the same actor/request/execution postcondition can produce `succeeded`; otherwise produce the characterized `failed`/`uncertain` result.
- [x] **Step 5: Implement `RequestLocalFaceDirection`**. Decode the Mod descriptor's strings, reject `actor_moving`, call `actor.faceDirection(expectedDir)`, and verify fresh `actor.FacingDirection == expectedDir`. Never assign `FacingDirection` directly.
- [x] **Step 6: Extend `FarmhandExecutionJournal`, `LocalExecutionReceipt`, `FarmhandExecutionReceipt`, and `BridgeReceipt`** with a versioned optional observation field while retaining action-specific evidence separately. The current journal/`BridgeSession` durable-admission path covers Navigation only; extend the same candidate admission/transition tuple before native dispatch, then update every serializer/parser/constructor. Unaffected existing actions use `observation: null`, and `equip_tool` wire semantics remain unchanged.
- [x] **Step 7: Prove response-loss recovery** for both candidates with only `{requestId,idempotencyKey}`. A known execution ID is an additional returned-lineage check. A missing durable candidate admission keeps the action `live_ineligible` rather than falling back to memory.
- [x] **Step 8: Run:**
  ```bash
  pnpm test:stardew:core
  pnpm test:stardew:integration
  ```
  Expected: PASS for offline lifecycle tests; no test may claim target-version native success.
- [x] **Step 9: Commit only the action lifecycle/journal files and direct tests** with an exact allowlist.

**Task 3 completion:** Offline routing, durable admission, failure semantics, and recovery are proven. Native success remains live-gated.

### Task 4: Add typed observations and the two frozen salient-event producers

**Precondition:** Extend the existing `BridgeSession`/`LocalPipeBridge` publication path. Do not create an event journal, generic event bus, priority queue, or retry loop.

**Files:**
- Modify: `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`, `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs`, and `protocol/bridge-v1.schema.json`
- Create: `integrations/stardew/Sensory/ISalientEventFilter.cs`
- Create: `integrations/stardew/Sensory/StardewSalientEventHooks.cs`
- Modify: `integrations/stardew/BridgeSession.cs` and `integrations/stardew/ModEntry.cs`
- Modify: candidate `ExecutionManager` partials and `FarmhandExecutionJournal.cs`
- Test: event, observation, bridge-schema, and source-projection parity tests.

**Interfaces:**

```text
BridgeLocalObservation {
  location, actorTile, facing, gameTime,
  otherPlayerNearby, observationRevision
}

BridgeWorldFact {
  eventId, sourceEventId, kind,
  observedTick, gameTime, revision,
  deduplicationKey, payload
}
```

`kind` is `day_started` or `time_milestone`; payload is `{day}` or `{milestone}`. The authenticated outer envelope supplies scope. The fixed identity algorithm is `day_started_day_<TotalDays>` for DayStarted and `time_milestone_day_<TotalDays>_<HHmm>` for TimeChanged. `sourceEventId`, `eventId`, and `deduplicationKey` use the same stable identity for one source fact.

- [x] **Step 1: Add red tests** for exact observation keys/bounds, candidate action evidence/observation separation, DayStarted identity, all four milestones, non-milestone suppression, duplicate milestone suppression within one loaded world session, malformed world facts, and scope validation.
- [x] **Step 2: Implement `ISalientEventFilter`** with one fixed rule: each `(loaded scope, TotalDays, milestone)` emits once; each DayStarted callback for one `TotalDays` emits once. Use SMAPI callback/update tick and game time; no wall-clock debounce range, task state, combat callback, or nearest-player scan.
- [x] **Step 3: Implement `StardewSalientEventHooks`** in the existing `ModEntry.Entry` event subscription composition. Construct facts on the game thread and call a named `BridgeSession.TryCreateWorldFactEvent` method that emits the new typed `world_fact` bridge message; update the C# serializer, TypeScript union/validator, JSON schema, repository-root projection, standalone projection input, and extraction mirror together. Do not overload the existing `semantic_event` constructor. A closed/backpressured bridge records `event_delivery_unavailable`; it does not queue or retry.
- [x] **Step 4: Attach observation through the separate receipt field** on every candidate terminal path: success, `emote_busy`, `actor_moving`, invalidation, failed, uncertain, and journal/persistence failure where a local observation is available. Missing observation makes the result incomplete; Host cannot infer it.
- [x] **Step 5: Run Core/Integration/parity tests** and prove all existing receipt consumers, especially `equip_tool`, accept the optional field as absent without changed meaning. Run the package-owned projection checks in both modes:
  ```bash
  pnpm test:stardew:core
  pnpm test:stardew:integration
  pnpm --dir integrations/stardew/action-development test
  node integrations/stardew/action-development/src/action-source-projection-check.mjs
  node integrations/stardew/action-development/standalone/src/action-source-projection-check.mjs
  pnpm --dir integrations/stardew/action-development action:extraction-rehearsal
  ```
- [x] **Step 6: Commit only the event/observation files, the repository-root/standalone source-projection inputs and generated artifacts, and direct tests** with an exact allowlist; never stage generated Host output.

**Task 4 completion:** Typed event creation and observation ownership are offline-verified. Delivery failure is not event success and does not establish durable replay.

### Task 5: Consume typed world facts in Host without moving Magic Context ownership

**Precondition:** The current path is `LocalStardewBridgeClient.onFact → IntegrationLaunchHandle.events.onFact → CompanionHostService.acceptIntegrationFact → CompanionEventPump`. The new `world_fact` enters that path and no parallel pump is created.

**Files:**
- Modify: `host/src/protocol.ts`
- Modify: `host/src/local-stardew-bridge.ts`
- Modify: `host/src/stardew-integration-launcher-body-program.internal.ts`
- Modify: `host/src/event-pump.ts` and `host/src/host-service.ts` only at the existing integration-fact boundary; add a dedicated bounded `worldFacts` map/limit in `CompanionEventPump` rather than routing `world_fact` through the existing lifecycle map
- Modify: both repository-root and standalone source-projection producers/checkers, their `projection-source-layout.json` files, approved extraction inputs, and generated projection artifacts
- Create/modify: `host/src/stardew-humanlike-event-boundary.test.ts` and `host/src/event-pump.test.ts`

**Interfaces:**
- Add Host `FactKind` value `world_fact`; do not overload untyped `semantic_event`.
- `toWorldFact` preserves Mod `eventId`, `sourceEventId`, `observedTick`, and typed payload, and sets `correlationId` to the stable Mod event ID. It must not use bridge `messageId` or transport `timestampMs` as native event identity or ordering.
- `WorldFact` gains an optional `observedTick` used only for Mod `world_fact` ordering. `CompanionEventPump` adds a dedicated bounded `worldFacts` map and clear/overflow path; duplicate deliveries with the same stable correlation replace the same pending fact, a new event consumes one bounded slot, and world facts sort by `observedTick → revision → eventId` before falling back to existing transport ordering for other fact kinds. Existing lifecycle/semantic/receipt map semantics remain unchanged. No Host cursor or event journal is added.

- [x] **Step 1: Add red Host tests** for valid typed conversion, stable ID preservation across repeated frames and reconnect-like redelivery, deterministic world-fact ordering by `observedTick/revision/eventId` (never bridge wall clock), duplicate suppression, malformed-payload closure, partial-delivery rejection, and terminal overflow containment.
- [x] **Step 2: Extend the TypeScript union and validator** for `world_fact`, `observedTick`, the bounded typed payload, and typed receipt observation; update the canonical bridge JSON schema, both source-projection producers/checkers, and the approved standalone extraction inputs in the same change. Keep `execution_receipt_query` exactly `{requestId,idempotencyKey}`.
- [x] **Step 3: Change only the new `world_fact` conversion** in `toWorldFact`; preserve existing snapshot, lifecycle, execution-receipt, and semantic-event behavior. A stable Mod event ID is required; missing/invalid IDs fail closed. Because the current Host fact union and Mod bridge have no `world_fact` member, update the typed C#/TypeScript/schema projection together; do not add a Host-only pseudo-kind.
- [x] **Step 4: Forward through the existing Host service/pump path** and test that a world-only fact can trigger the ordinary follow-up delivery while held snapshot/progress facts retain their existing behavior. Add dedicated `world_fact` storage, a bounded limit, duplicate replacement, clear handling, and terminal overflow containment; do not silently route `world_fact` into the lifecycle map.
- [x] **Step 5: Run:**
  ```bash
  pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json
  pnpm --filter @gamebuddy/companion-host exec node --test dist-test/stardew-humanlike-event-boundary.test.js dist-test/event-pump.test.js
  pnpm --filter @gamebuddy/companion-host typecheck
  ```
  These tests prove transport only. They do not invoke `ctx_reduce`, inspect SQLite, claim Memory, or claim provider cache behavior.
- [x] **Step 6: Commit only the Host fact-boundary files and direct tests** with an exact allowlist; compiled `dist-test` output is generated verification output, not a source commit target.

**Task 5 completion:** Host proves typed bounded delivery only; it does not prove Magic Context, Memory, native mutation, or the formal Farmhand gate.

### Task 6: Project candidate tools restrictively from authenticated descriptors

**Precondition:** The current Host has static support metadata (`STARDEW_ACTION_ADAPTERS`, `STARDEW_ACTION_TOOL_NAMES`) and hard-coded tool factories. Those structures may describe compiled execution support, but they cannot publish membership or provide candidate enum values.

**Files:**
- Modify: `host/src/protocol.ts`, `host/src/action-registry.ts`, `host/src/game-tools.ts`, `host/src/stardew-game-integration-adapter.ts`, and `host/src/local-stardew-bridge.ts` when descriptor transport requires it
- Modify: direct Host action-registry/game-tool tests
- Create: `host/src/stardew-humanlike-action-projection.test.ts`

**Interfaces:**
- `ActionRegistration` gains a restrictive optional descriptor projection. Candidate actions require the complete descriptor; an identity-only registration yields no candidate tool.
- `visibleActionsFromModCatalog` remains the intersection of Mod registration, current live capabilities, explicit Host policy, and compiled adapter support. It excludes `experimental`.
- Candidate TypeBox schemas are built from Mod enum values with `additionalProperties: false`; Host contains no emote-ID map and no direction enum map.

- [x] **Step 1: Add red tests** proving absent/incomplete descriptor, unknown descriptor field, experimental lifecycle, missing live capability, denied action/family, scope mismatch, or descriptor/catalog revision mismatch produces no candidate tool.
- [x] **Step 2: Extend and validate the authenticated registration projection** with exact descriptor shape, enum bounds, codec/native/evidence/postcondition identity, and no unknown keys. Retain static adapter IDs only as support metadata.
- [x] **Step 3: Build candidate schemas from descriptor data**: `express_emote` forwards `{emote}` and `face_direction` forwards `{direction}`. Request/idempotency fields remain outside the action argument schema under the existing Host wrapper.
- [x] **Step 4: Recheck connection, current capability, catalog/capability revision, policy, snapshot revision, deadline, and fresh dispatch admission immediately before bridge write. A withdrawn action fails closed; a mounted closure cannot grant a candidate capability.
- [x] **Step 5: Run focused Host projection tests and existing Host tests:**
  ```bash
  pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json
  pnpm --filter @gamebuddy/companion-host exec node --test dist-test/stardew-humanlike-action-projection.test.js dist-test/game-tools.test.js
  pnpm --filter @gamebuddy/companion-host typecheck
  ```
  Expected: candidates remain absent while experimental and existing published actions, especially `equip_tool`, remain unchanged.
- [x] **Step 6: Commit only the restrictive projection files and direct tests** with an exact allowlist; compiled `dist-test` output is generated verification output, not a source commit target.

**Task 6 completion:** Tool schema support is not publication, authorization, or live evidence. Candidates remain hidden until Mod publication changes lifecycle.

### Task 7: Handoff to the current production action-gate owner

**Precondition:** Tasks 0–6 pass offline; installation registration, bootstrap containment, formal lifecycle, production artifact attestation, and the production action-runner owner are separately closed. If the current owners have not named a production `GameAdapter`/coordinator action-runner entrypoint, stop with `blocked`; do not create a second runner in this plan.

**Files:**
- Modify: no implementation files and no action-development live/profile files.
- Record: `design/architecture/stardew-humanlike-companion-architecture.md` only with the offline result and the external blocker classification required by its current status section.

**Interfaces:**
- Consumes: Tasks 0–6 offline reports, complete Mod descriptor/protocol projections, typed event/observation contract, Host restrictive projection tests, and the current `design/architecture/release-model.md` / `design/domains/stardew/integration.md` owner boundaries.
- Produces: `offline_complete/live_blocked` handoff facts. It does not create a live report, mint publication authority, change lifecycle, or prove a native side effect.

- [ ] **Step 1: Run the offline closure checks** from `## Required final checks` and classify each unavailable target-version, production-coordinator, or embedded-runtime prerequisite as `blocked`, never as pass.
- [ ] **Step 2: Confirm the handoff has no Preview/native-local/Portfolio/action-development substitution.** The legacy action-development package may report source/projection parity and deterministic offline checks only; it cannot be the formal action runner or live evidence owner.
- [ ] **Step 3: Hand the frozen candidate descriptor, request/recovery tuple, actor binding, event wire, and receipt/observation contract to the current production action-gate owner.** The receiving owner must independently freeze its action-specific evidence/postcondition/cleanup contract before any target-version mutation is authorized.
- [ ] **Step 4: Keep both candidates `experimental`, hidden from production Agent visibility, and live-ineligible.** A later reviewed publication change may alter lifecycle only after that external owner closes its formal action gate; this plan does not perform that change.

**Task 7 completion:** The plan ends at `offline_complete/live_blocked` or an explicit offline failure/blocker. No action-live-eligible, published, open-gameplay, or companion-experience claim is produced by this plan.

---

## Dependency and Acceptance Matrix

| Dependency | Required before | Failure behavior |
|---|---|---|
| Task 0 boundary card | Tasks 1–7 | Stop with `blocked`; do not guess a handler, actor, descriptor, journal, or recovery owner. |
| Task 1 target-version source/API facts | Tasks 2, 3, and 7 | Keep both actions experimental and live-ineligible; source inspection never substitutes for native live evidence. |
| Task 2 descriptor/capability/wire | Tasks 3, 5, and 6 | No handler, capability, Host schema, or verifier may infer enum/native metadata. |
| Task 3 durable action lifecycle | Tasks 4, 6, and 7 | No candidate native dispatch/publication; uncertain results remain recovery-required. |
| Task 4 event/observation contract | Task 5 and candidate evidence | Do not deliver untyped facts or claim piggyback perception. |
| Task 5 Host fact boundary | Task 7 evidence correlation | Integration remains unavailable on malformed/overflow facts; no partial delivery pass. |
| Task 6 restrictive tool projection | Task 7 handoff | Candidates remain hidden until a later reviewed Mod publication changes lifecycle and complete descriptor validity. |
| Magic Context package behavior | Context claim only | Existing package tests may be run separately; current Game runtime `ctx_reduce` availability remains explicitly blocked unless a separate runtime-configuration plan changes it. |
| Installation/bootstrap/formal lifecycle/action-runner owners | Task 7 handoff | `offline_complete/live_blocked`; no Preview, native-local fixture, Portfolio, action-development live/profile path, or harness substitution. |

The plan is **offline-complete** only when Tasks 0–6 pass with no unresolved implementation failure, both repository-root and standalone source-projection producer/checker modes pass, and candidates remain `experimental`. Task 7 can only produce an **offline handoff/live blocked** result. Action-live eligibility and publication belong to the current production action-gate and Mod publication owners; they are not outcomes of this plan. This plan is not a companion-experience, open-gameplay, Body Program, Portfolio, or full Stardew release.

## Required final checks

```bash
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host test
pnpm test:stardew:core
pnpm test:stardew:integration
pnpm --dir integrations/stardew/action-development test
node --test tools/stardew-gameplay-surface-rules.test.mjs tools/check-stardew-action-promotion.test.mjs
node --test integrations/stardew/action-development/tests/project-adapter.test.mjs packages/game-action-devkit/tests/project-runner.test.mjs
node integrations/stardew/action-development/src/action-source-projection-check.mjs
node integrations/stardew/action-development/standalone/src/action-source-projection-check.mjs
pnpm --dir integrations/stardew/action-development action:extraction-rehearsal
pnpm check:host-production-import-boundary
pnpm check:text-hygiene
pnpm check:diff
```

Run the embedded Magic Context package tests separately from `vendor/magic-context/packages/pi-plugin` with that package's declared Bun command (`bun test` from the package directory, using its pinned dependency installation). The package path is the GameBuddy-owned `@cortexkit/pi-magic-context` file dependency; do not use a system Pi installation or user-owned session/configuration. Those tests are not a Host event-pump test and do not establish Game-surface availability. Run target-version source inspection and formal live commands only under their named preconditions. `tools/inspect-stardew-gameplay-surface.mjs` is source/API inspection, not live mutation evidence. `tools/lib/stardew-formal-action-gate.mjs` supplies shared receipt/fresh-reread mechanics, not candidate action acceptance. Because `/design/` is ignored by this repository's `.gitignore`, do not use `git add design/...` as evidence that a design update is staged; use the mounted design-repository workflow and exact implementation-file allowlists.

## Execution Handoff

Plan complete and saved to `design/tasks/active/59_STARDEW_HUMANLIKE_COMPANION_IMPLEMENTATION_PLAN.md`. Execute it now?

Use the project's `subagent-driven-development` skill for execution: dispatch a fresh subagent per task, review each task before starting the next, and stop at the first failed gate. Do not use a parallel writer in the shared checkout.
