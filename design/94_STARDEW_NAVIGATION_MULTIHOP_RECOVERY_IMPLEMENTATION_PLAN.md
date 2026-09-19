# Stardew Navigation V1 — Multi-Hop Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task.

**Goal:** Restore the withdrawn `navigate_to_destination` action as a Mod-owned, ordinary-warp-only multi-hop execution with one receipt lineage and no artificial hop/replan completion quota.

**Architecture:** A private coordinator copies the accepted destination binding once and derives one next ordinary warp from a fresh loaded-location topology at each leg. `ExecutionManager` owns the persistent lifecycle, native body/controller handoff, exact warp correlation, and terminal receipt CAS; neither Host nor public projections receive route or primitive transition facts.

**Tech Stack:** C# / .NET Stardew SMAPI Mod, StardewValley native `Warp` APIs, xUnit and FluentAssertions.

**Spec:** `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`; `design/93_STARDEW_NAVIGATION_V1_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- Revalidate gameplay capability, scope, game state, deadline, cancellation, and live native facts on the game thread before native mutation.
- Production transitions must use target-version native entry points; no input injection, direct save/state mutation, or native-call fallback.
- No host/public route, tile, warp, door, or native-member authority; the Mod is the sole Navigation authority.
- No target-runtime mutation until Task 8 after static preflight, aggregate independent review, and its one serial live gate.
- No compatibility aliases or legacy direct-only release path.

---

## Status

`navigate_to_destination` is withdrawn from the Mod-owned catalog. The prior direct ordinary-warp lifecycle is a dormant, non-release tracer only. This plan restores the required multi-hop semantics before any re-publication or live mutation gate.

Task 4 is implemented: replay-stardew-navigation-operation.mjs supports explicit `multi_hop_ordinary_warp` replay mode requiring exactly one accepted, >=2 running, correct lifecycle ordering, and a single strict succeeded/navigation_completed terminal; forbidden route/tile/warp/leg/source primitives are rejected in any evidence representation. preflight-stardew-navigation-agent-live.mjs forwards requestedNavigationScope to topology preflight and enforces matching multi-hop replay mode. M8 scan covers ExecutionManager.cs, ExecutionManager.MovementHandlers.cs, BridgeSession.cs, ModEntry.cs and all Navigation source files. Testing confirms multi-hop-shaped success, fail-closed violations, scope propagation, and current-source-only topology blocker.

## Governing constraints

- The Mod/game thread owns selector interpretation, binding admission, topology, planning, native transition, receipt, and completion postcondition.
- A request has one `requestId`, one `executionId`, one active body owner, and one terminal settlement. `ExecutionManager` remains the sole receipt and ledger authority.
- Admission copies the accepted `NavigationDestinationBinding`. Subsequent planning must never re-resolve a public reference; public reference expiry cannot revoke an already accepted execution.
- Each leg is: fresh plan → safe approach → controller release → pre-commit revalidation → one native ordinary-warp commit → exact local-player `OldLocation → NewLocation` correlation → fresh reread/replan.
- The coordinator retains no public route. Old topology and next-edge facts are discarded after a correlated warp. No hop or replan quota defines task completion.
- A post-commit exception, correlation mismatch, cancellation/deadline/lifecycle invalidation after commit, or unreadable fresh state settles the original execution once as `Uncertain`; it never retries that armed leg.
- Only ordinary non-NPC warps are in scope. Doors, special transitions, primitive public action composition, Host route/tile/warp input, and public topology/route projection remain excluded.
- Task 8 remains the only target-runtime mutation gate. This plan does not authorize a game launch, pipe use, fixture write, or mutation.

## Completed recovery work

1. **Task 0 — withdrawal:** `navigate_to_destination` is absent from the sole Mod catalog; policy, capability, router, and Host projections fail closed.
2. **Task 1 — scope guard:** deterministic topology preflight blocks `multi_hop_ordinary_warp` when supplied only a `current_source_only` artifact.
3. **Task 2A — dormant planner:** private ordinary-warp topology plus pure BFS emits only `NextEdge`, `Arrived`, or a terminal.
4. **Task 2B — admission/source seam:** `Admit → copied binding → PlanFresh` and a fresh all-loaded ordinary-warp topology source exist, but no production execution calls them.

## Task 3 — manager-owned multi-hop lifecycle (frozen implementation brief)

### Permitted files

- `integrations/stardew/ExecutionModels.cs`
- `integrations/stardew/ExecutionManager.cs`
- `integrations/stardew/ExecutionManager.MovementHandlers.cs`
- `integrations/stardew/BridgeSession.cs` only if it must pass an already-existing runtime snapshot factory unchanged in authority
- `integrations/stardew/ModEntry.cs` only to retain the existing Navigation-first `Warped` callback ordering
- `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NavigationExecutionManagerTests.cs`
- narrowly related existing Navigation manager test helpers

Do not modify the catalog, Host, protocol/schema, router, public tool surface, fixtures/runners, or target-runtime tooling.

### Required design

1. At `RequestNavigate` admission, create one `NavigationAdmission` and one `NavigationExecutionCoordinator.FromAdmission(admission)`. Store the coordinator and copied binding in manager-private active state; do not retain a selector as an authority-bearing replan input.
2. `PlanFresh` must happen on every new leg after the previous correlated warp and before every approach arm. It can only yield `Arrived`, one ordinary next edge, or a terminal. `Arrived` is the only completion candidate and must still undergo the existing strict fresh postcondition/evidence check.
3. Replace the direct-only `LocalNavigateSpec` next-leg model with manager-private continuation state that stores the current frozen attempted edge only while its approach/commit/correlation is active. Do not retain a route suffix or expose planner data.
4. Reuse the existing safe cardinal approach, release-before-commit, pre-commit policy/deadline/current-source/edge checks, `AwaitingWarp`, exact `OldLocation → NewLocation` correlation, terminal settlement, cancellation, deadline, and invalidation authority. The post-warp exact correlation must discard the frozen edge, take a fresh topology snapshot, and arm the next edge only through a fresh plan.
5. Before the first native commit, a failed replan/arm is a normal terminal outcome. After a native commit begins, any exception, mismatch, unavailable fresh state, cancellation/deadline/lifecycle invalidation, or late callback settles the original lineage once as `Uncertain`; never retry that edge.
6. Preserve suppression of public Navigation body traces and receipt-safe bounded evidence. No route, tile, source, target, warp, or leg data may enter public trace/evidence.
7. Maintain the single active body-owner invariant across legs. A newly planned next approach may arm only after prior body ownership is fully released.

### Required deterministic tests

Using only the existing test-only native approach seam and fake world/connectivity sources:

- Two-hop `Farm → Mountain → Mine`: one accepted receipt lineage, two approach arms, two commits, fresh replan after the first exact warp, and one `navigation_completed` terminal only after the destination reread.
- A stale next-edge/topology after the first warp is discarded; a fresh replan chooses the current source’s edge instead.
- Accepted opaque reference continues after the reference store is cleared.
- Wrong `OldLocation`, wrong new target/tile, duplicate or late `Warped`, commit exception, cancellation/deadline/lifecycle invalidation after either commit, and unreadable post-warp topology each settle once fail closed and do not arm/commit another edge.
- No public body trace is emitted for either multi-hop success or multi-hop terminal failure.
- Current direct tests remain valid or are rewritten only where their expectation is deliberately superseded by the multi-hop lifecycle.

### Required checks

- Focused `NavigationExecutionManagerTests` and `NavigationExecutionCoordinatorTests`.
- Target Stardew Mod Release build.
- Scoped `git diff --check`.
- Narrow independent review for active ownership, binding-copy/replan authority, terminal CAS, post-commit uncertainty, `Warped` ordering, and projection safety.

## Task 4 — deterministic multi-hop replay and scope-bound preflight (frozen implementation brief)

### Permitted files

- `tools/replay-stardew-navigation-operation.mjs`
- `tools/replay-stardew-navigation-operation.test.mjs`
- `tools/stardew-navigation-topology-preflight.mjs`
- `tools/stardew-navigation-topology-preflight.test.mjs`
- `tools/preflight-stardew-navigation-agent-live.mjs`
- `tools/preflight-stardew-navigation-agent-live.test.mjs`
- this plan only for status/evidence wording

Do not modify Mod behavior, catalog/policy, Host production/schema/protocol, runners, fixtures, target artifacts, or target-runtime tooling.

### Required design

1. Keep `replayNavigationOperation(frames, options)` a deep, receipt-shape-only module. It validates the public lineage; it must not infer a route, inspect topology, expose a hop count, or accept route/edge/tile/source/warp/leg facts.
2. Add an explicit private replay mode for `multi_hop_ordinary_warp`. In that mode, success requires exactly one Navigation request, exactly one `accepted` receipt, at least two `running` receipts, all receipts sharing one request/execution pair and Navigation action identity, and exactly one final strict `succeeded / navigation_completed` terminal. Existing direct replay mode remains its current generic one-lineage behavior.
3. In every mode, reject forbidden route primitives in *any* evidence representation accepted by the bridge frame (string or object), including accepted/running/terminal receipts. A multi-hop replay with only one running receipt, multiple accepted receipts, progress/terminal before admission, or a non-final terminal must fail closed with named blockers.
4. The composed agent-live preflight must accept an explicit `requestedNavigationScope`, pass it unchanged to topology preflight, and invoke receipt replay in matching multi-hop mode when that scope is `multi_hop_ordinary_warp`. A multi-hop invocation cannot report ready from a direct-style replay, even if its caller injects a permissive replay operation.
5. Expand the composed no-M8 static closure over the actual active multi-hop producer/owner sources (`ExecutionManager.cs`, `ExecutionManager.MovementHandlers.cs`, `BridgeSession.cs`, `ModEntry.cs`, and all Navigation files). It is an M8-only source check; it must not reinterpret legitimate Mod-owned ordinary-warp commit as a forbidden generic dispatch anchor.
6. The preflight does not manufacture a multi-source target characterization artifact. Until a later zero-mutation multi-source artifact exists, `multi_hop_ordinary_warp` remains blocked by Task 1's `current_source_only_cannot_authorize_multi_hop` condition.

### Required deterministic tests

- A receipt-safe two-hop-shaped lineage (one accepted, two running, one strict final completion) passes multi-hop replay without outputting route/hop facts.
- One-running direct-style replay, duplicate accepted, terminal before/among nonterminal lifecycle receipts, foreign action/identity, and any forbidden primitive in either a string or object evidence form all fail closed in multi-hop mode.
- Direct replay behavior remains covered and does not accidentally require multi-hop receipts.
- Agent-live preflight forwards `multi_hop_ordinary_warp` scope into topology validation, requires multi-hop replay mode, and blocks when injected replay result does not demonstrate that mode or when topology reports the current-source-only blocker.
- No-M8 source checks include active manager/movement/bridge/entry plus Navigation source files and fail closed when one is unreadable or contains an M8 anchor.

### Required checks

- Run the three Node test files above together.
- `node --check` for all three tools.
- Scoped `git diff --check`.
- Narrow independent review of replay ordering, evidence privacy, scope propagation, and no-M8 scan scope.

## Task 5 — zero-mutation, production-extractor multi-source characterization (frozen implementation plan)

### Admission status

Task 4 is accepted. The current `current_source_only` artifact remains valid only as a direct ordinary-warp tracer and **must** continue to block `multi_hop_ordinary_warp`. Task 5 may produce one new caller-supplied artifact only after it proves that the target game invoked the exact production `GameBuddy.Stardew.Navigation.Game1NavigationWorldSource.TryCreateCurrentOrdinaryWarpTopology(...)` implementation against its live `Game1.locations` collection.

The artifact authorizes only the narrow statement that, for its authenticated target-version fixture transaction, that production extractor constructed a private all-loaded ordinary-warp topology satisfying the aggregate predicates below. It does **not** publish `navigate_to_destination`, prove a route, prove a destination is reachable, prove a future correlation, grant Host authority, or authorize Task 8 mutation.

### Chosen seam

Use a separate in-game SMAPI Mod named exactly `GameBuddy.Stardew.NavigationTopologyCharacterization` which references one frozen Release `GameBuddy.Stardew.dll` as a normal CLR dependency. The production assembly is **not** a SMAPI Mod in this profile: no production `manifest.json`, config, bridge file, catalog, or `ModEntry` instance is staged. Loading a CLR dependency does not invoke `ModEntry.Entry()`; the probe must never instantiate it.

`integrations/stardew/InternalsVisibleTo.cs` adds only this exact friend assembly name. This is not a security boundary: the evidence authority comes from the runner’s exact profile allowlist, binary identity binding, authenticated arm, direct-call static verifier, and runtime observation. Do not add a production observation hook, reflection invocation, a strong-name migration, a project/source reference that recompiles Navigation, or a duplicate `Game1.locations`/`warps` extraction loop.

### Artifact interface

Create a **separate**, exclusive multi-source validator and runner rather than widening the source-only artifact schema. Old current-source artifacts keep their direct-only semantics; they cannot be relabelled or converted.

The final passed artifact has an exact allowlisted schema with no free-form fields:

```json
{
  "schemaVersion": 1,
  "terminalStatus": "passed",
  "targetBuild": "1.6.15.24356",
  "observationScope": "multi_hop_ordinary_warp",
  "productionExtractorInvoked": true,
  "productionExtractorInvocationCount": 1,
  "gameThreadObserved": true,
  "worldReadyObserved": true,
  "multiSourceObserved": true,
  "ordinaryWarpFamilyObserved": true,
  "correlationApiShapeVerified": true,
  "gameplayMutationCount": 0,
  "playerWarpEventCount": 0,
  "executionReceiptCount": 0,
  "bridgeOrCatalogPublicationCount": 0,
  "fixtureCleanup": {
    "restored": true,
    "noStardewProcess": true,
    "noSmapiProcess": true,
    "temporaryProfileRemoved": true
  },
  "predicateCode": "successful_multisource_characterization"
}
```

A publishable blocked artifact carries the same exact keys and one named predicate consistent with its observed boolean/count body. It must never carry full pass evidence. The all-terminal invariants are: `schemaVersion`, `targetBuild`, and `observationScope` are exact; `productionExtractorInvocationCount` is `0` or `1`; every count is a non-negative integer; and `fixtureCleanup` is fully true. A **passed** artifact additionally requires every observation boolean true, invocation count exactly one, and every mutation/warp/receipt/publication count zero. A **blocked** artifact may truthfully carry a false observation boolean, invocation count zero, or a nonzero mutation/warp/receipt/publication count only when its named predicate requires that fact; it never enables topology implementation.

Cleanup and observation authentication are different: an incomplete fixture/profile/process cleanup, or a missing, raw, invalid, duplicate, or HMAC-invalid observation, is not a publishable terminal. The runner records the named `cleanup_incomplete` or `observation_authentication_failed` outcome in its private result/log and publishes **no artifact at all**. Consequently neither outcome is an artifact predicate or may appear in validator input. This prevents raw failed cleanup or unauthenticated observation from becoming a durable or caller-supplied proof.

The schema rejects unknown keys, locations/sources/targets/destinations, routes/paths/hops/legs, tiles/coordinates/x/y, warps/doors/edges or opaque IDs/counts, raw reason strings, assembly paths/hashes/MVIDs, logs, stack traces, raw topology, or arbitrary nested records. Assembly identity is validated inside the runner’s authenticated raw observation and intentionally does not enter the final artifact.

The only allowed passed predicate is `successful_multisource_characterization`. Publishable blocked predicates include: `production_binary_identity_mismatch`, `exact_production_callsite_invalid`, `profile_dependency_closure_invalid`, `production_modentry_activated`, `world_not_ready`, `production_topology_creation_rejected`, `multi_source_not_observed`, `ordinary_warp_family_not_observed`, `gameplay_mutation_observed`, and `player_state_changed_during_observation`.

### Task 5A — deterministic validator, topology-preflight selector, and static binding contract

**Files:**
- Create: `tools/stardew-navigation-multisource-characterization-validator.mjs`
- Create: `tools/stardew-navigation-multisource-characterization-validator.test.mjs`
- Create: `tools/replay-stardew-navigation-multisource-characterization.test.mjs`
- Create: `integrations/stardew/tests/NavigationTopologyCharacterization.Contract.csproj`
- Create: `integrations/stardew/tests/NavigationTopologyCharacterizationContract.cs`
- Modify: `tools/stardew-navigation-topology-preflight.mjs`
- Modify: `tools/stardew-navigation-topology-preflight.test.mjs`
- Modify: `integrations/stardew/InternalsVisibleTo.cs`

**Interfaces:**

```js
validateMultiSourceTransitionCharacterization(value)
allowsMultiHopTopologyImplementation(value)
```

Both functions are pure. `allowsMultiHopTopologyImplementation` is true only for a valid, `passed`, exact-scope artifact. It never accepts source-only validator output.

The topology preflight obtains an explicit `multiSourceTransitionArtifact` input. For `requestedNavigationScope === "multi_hop_ordinary_warp"`, it validates only that input with `allowsMultiHopTopologyImplementation`; absence, unreadability, source-only shape, any blocked terminal, or any invalid field produces the named `multi_source_artifact_required_or_invalid` blocker. The old `transitionArtifact` remains direct-only and must continue to yield `current_source_only_cannot_authorize_multi_hop` if supplied for the multi-hop scope.

The C# contract executable takes exactly:

```text
NavigationTopologyCharacterization.Contract --production-sha256 <64 lowercase hex> --production-dll <absolute path> --probe-dll <absolute path>
```

It reuses the snapshot/PE identity discipline of `ProductionAssemblyBinding`, without loading the probe into a game world. It verifies all of the following from the frozen binaries before a runner may launch:

- the production image SHA-256 and assembly name are exact;
- the probe references `GameBuddy.Stardew` by assembly reference, not a copied Navigation source type;
- exactly one probe IL `call`/`callvirt` target resolves to the exact internal production method `GameBuddy.Stardew.Navigation.Game1NavigationWorldSource.TryCreateCurrentOrdinaryWarpTopology` with its current signature;
- no dynamic member discovery or reflective invocation occurs in the probe: reject `Type.GetType`, string-based `GetMethod`/`GetType`, `MethodBase.Invoke`, `Type.InvokeMember`, `Delegate.CreateDelegate` from reflected members, `Activator.CreateInstance`, and expression/dynamic invocation. A compile-time typed reference may read `typeof(Game1NavigationWorldSource).Assembly` plus that assembly’s `Location` and module MVID strictly to compare it against the arm; this read-only assembly/module identity inspection is allowed and must not discover or invoke a member;
- the probe metadata contains no local `Game1NavigationWorldSource`, `NavigationOrdinaryWarpTopology`, `Game1.locations`, or `location.warps` extraction implementation;
- the probe assembly name is exactly the friend name and it has no production Mod manifest.

**Required tests:**

- valid multi-source artifact is accepted only by the multi-source validator and enables only the multi-hop selector;
- source-only artifacts, relabelled source-only shapes, unknown scope, extra field, topology primitive leak, incomplete cleanup, and blocked-implies-pass all reject; a passed artifact with a false observation boolean or nonzero mutation/receipt/publication/warp count rejects, while a structurally consistent publishable blocked artifact retains its required false/nonzero observation fact and never enables implementation;
- the old topology preflight still accepts its direct-only path when scope is omitted, but a multi-hop request fails without the new artifact even if given a valid source-only artifact;
- C# structural contract rejects wrong production SHA, wrong friend assembly identity, absent/duplicate exact call site, reflection call, and a probe assembly embedding forbidden extraction anchors.

### Task 5B — production-binary friend probe and authenticated runner

**Files:**
- Create: `tools/stardew-navigation-multisource-characterization/StardewNavigationMultiSourceCharacterization.csproj`
- Create: `tools/stardew-navigation-multisource-characterization/ModEntry.cs`
- Create: `tools/stardew-navigation-multisource-characterization/manifest.json`
- Create: `tools/start-stardew-navigation-multisource-characterization.ps1`
- Create: `tools/run-stardew-navigation-multisource-characterization.mjs`
- Create: `tools/run-stardew-navigation-multisource-characterization.test.mjs`
- Modify: `design/94_STARDEW_NAVIGATION_MULTIHOP_RECOVERY_IMPLEMENTATION_PLAN.md` status/evidence only

**Probe build interface:**

```xml
<AssemblyName>GameBuddy.Stardew.NavigationTopologyCharacterization</AssemblyName>
<!-- Compile against the frozen production binary without recursively copying
     its runtime graph. Copy the exact declared closure as explicit content. -->
<Reference Include="GameBuddy.Stardew">
  <HintPath>$(ProductionModBuildPath)\GameBuddy.Stardew.dll</HintPath>
  <Private>false</Private>
</Reference>
```

`ProductionModBuildPath` is mandatory and absolute. The probe must not use a `ProjectReference` to `GameBuddy.Stardew.csproj`, and it must not compile/link any production Navigation source. The build copies the exact frozen DLL plus an explicit, bounded dependency closure (currently `GameBuddy.Stardew.Core.dll` and `Raffinert.FuzzySharp.dll`) into the probe output. Build/runner rejects a missing or unexpected closure member rather than copying a whole production release directory.

**Authenticated runtime flow:**

1. Build the production Mod Release against the target assemblies, hash the resulting `GameBuddy.Stardew.dll`, inspect its MVID, and build the probe against that exact output path.
2. Run the structural contract from Task 5A against the frozen production/probe pair. Failure prevents profile construction.
3. Create an exclusive transaction with the existing manifest-owned fixture copy/restore protocol. The runner arm binds nonce, deadline, transaction path, observation path, frozen production SHA-256 and MVID, staged probe profile path, and a one-time HMAC key.
4. Stage exactly two SMAPI manifests: the existing loader and the multi-source probe. Stage the probe DLL, its explicit dependency closure, and `arm.json` only in the probe directory. No `GameBuddy.Stardew` manifest/config, production action files, pipe/control environment values, or unknown DLL/manifests are permitted. Every staged item is a regular non-reparse file and byte-checked against the frozen output.
5. The probe waits on the game thread for `Context.IsWorldReady`, `Game1.player`, and `currentLocation`, then constructs a private `NavigationDestinationBinding` whose canonical identity is the current location identity. It constructs `Game1NavigationWorldSource` and directly invokes `TryCreateCurrentOrdinaryWarpTopology` **exactly once**. It must not call `PlanFresh`, `NavigationRoutePlanner`, `ExecutionManager`, `BridgeSession`, `ModEntry`, action/policy/catalog APIs, controller APIs, warp/action/tool/menu/dispatcher/input seams, or invoke/induce `Player.Warped`. It may subscribe to `Player.Warped` only to increment the passive zero-mutation counter described in step 7; the event cannot be a control, transition, or action seam.
6. The probe privately requires `true`, `reasonCode == "accepted"`, non-null topology, at least two sources, and at least one non-door ordinary leg. It immediately discards topology without serializing any member. It reads the loaded production assembly’s `Location`, SHA-256 and MVID only to compare against the arm; it outputs only aggregate booleans/zero counters.
7. The probe captures pre/post player reference, current-location reference and tile locally; it subscribes through the compile-time typed `IPlayerEvents.Warped` API only to increment the passive zero-mutation counter (that typed subscription is the only basis for `correlationApiShapeVerified`). The arm is an exact MACed record over `nonce`, `transactionPath`, `observationPath`, `deadlineUnixMs`, frozen production SHA-256 and MVID. The raw authenticated observation may repeat only those production identity facts for runner comparison; neither enters the final artifact. A changed player/location/tile, nonzero warp count, any receipt/publication count, or any unexpected exception emits an authenticated blocked observation. No raw state is emitted.
8. The runner verifies exactly one HMAC-authenticated observation before deadline, validates internal production identity facts, and finalizes a redacted passed or publishable blocked artifact only after fixture removal, process absence, and temporary-profile removal all succeed. Cleanup failure is recorded privately as `cleanup_incomplete` and yields no artifact; a terminal collision or an artifact path inside the transaction likewise yields no artifact.

**Probe-only arm and raw-observation records (not final artifacts):**

The staged `arm.json` is an exact record with `schemaVersion`, `nonce`, `transactionPath`, `observationPath`, `deadlineUnixMs`, `productionSha256`, `productionMvid`, and `integrityMac`. Its canonical MAC input is exactly `arm|<nonce>|<transactionPath>|<observationPath>|<deadlineUnixMs>|<productionSha256>|<productionMvid>`. `nonce` is 48 lowercase hex characters; SHA-256 and MAC are 64 lowercase hex characters; MVID is canonical lowercase `D` GUID text; `observationPath` is the non-existing `transactionPath/observation.json` child. Any missing, extra, malformed, expired, non-owned, or MAC-invalid arm must produce no output.

The probe writes at most one new `observation.json` envelope with exact keys `nonce`, `observation`, and `integrityMac`; `observation` is a compact JSON string and its canonical MAC input is exactly `observation|<nonce>|<transactionPath>|<observationPath>|<observation>`. Before cleanup, the raw observation has exact keys: `schemaVersion`, `terminalStatus`, `targetBuild`, `observationScope`, `predicateCode`, `productionSha256`, `productionMvid`, `productionExtractorInvoked`, `productionExtractorInvocationCount`, `gameThreadObserved`, `worldReadyObserved`, `multiSourceObserved`, `ordinaryWarpFamilyObserved`, `correlationApiShapeVerified`, `gameplayMutationCount`, `playerWarpEventCount`, `executionReceiptCount`, and `bridgeOrCatalogPublicationCount`. It contains no cleanup record, path, location, tile, edge, source, route, or exception detail. The runner checks the raw identity facts against the arm, consumes this exact raw record once, and only then adds verified cleanup facts to the final validator artifact.

**Required deterministic tests:**

- absolute build/game/fixture/save/artifact paths, frozen production binary identity, profile allowlist/closure, exact SMAPI command, arm MAC/nonce/deadline, staged-file byte equality, and profile removal all have explicit pass/fail tests;
- missing/extra dependency, production manifest/config in profile, replaced staged DLL, wrong MVID/hash, invalid/duplicate/raw observation, wrong transaction/observation path, missing terminal, process residue, fixture hash drift, and cleanup failure produce no artifact;
- runner accepts only the exact final redacted artifact and proves it removed raw observation/profile/owned working slot;
- no test synthesizes a passed multi-source artifact as a substitute for target output; Node tests only exercise validator/runner authentication and cleanup.

### Task 5C — admitted-adapter offline slice (implemented; no target transaction)

The fixed-path admitted adapter is implemented offline. It exposes only the runner's three injected seams: frozen-binary static-contract verification, metadata-only production MVID reading, and exact SMAPI PowerShell launch composition. The factory itself neither starts a process nor stages a profile, fixture, save, observation, or artifact. The launcher boundary accepts only runner-owned transaction facts and the exact inherited allowlisted environment; it does not read artifacts, Mod manifests, catalog data, or action/input APIs. Deterministic fake-spawn tests cover no-launch construction, exact fixed command/environment vectors, and fail-closed invalid path/descriptor/output handling.

### Task 5C — target build-only evidence run and review

The normal budget is one active Task 5 target-runtime **observation transaction per attempt**. This is not a lifetime cap on characterization and is not Task 8: every attempt is zero-mutation and uses one fresh transaction, one fresh owned fixture/profile state, and one fresh artifact destination. There is no automatic retry loop. Before each attempt, independently verify the production and probe builds, static contract, fixture ownership, empty destination slot, profile allowlist, and no existing Stardew/SMAPI process. A later attempt is admissible only after the preceding attempt has been classified, any harness/protocol defect has been repaired offline, cleanup has been independently verified, and the full preflight has been repeated.

The retry boundary follows the existing Stardew action runbook. A pre-spawn adapter rejection consumes no transaction. A launched attempt that produces no authenticated observation and proves zero gameplay mutation is an infrastructure/protocol failure: it produces no artifact, but may be followed by a fresh attempt after offline repair and cleanup. An authenticated observation with a valid `passed` or publishable `blocked` body is a terminal characterization result and is consumed exactly once by the runner; it cannot be replayed or edited into another artifact. An invalid, duplicate, raw, or missing observation produces no artifact and requires offline diagnosis before any fresh attempt. Any observed gameplay mutation, warp, action receipt, or uncertain native side effect is a characterization safety breach: do not retry the same request or fixture, and require a new fixture identity plus explicit independent admission before any further target work.

Cleanup failure is a recovery stop, not evidence and not an automatic retry permission. The owner must verify and complete the matching cleanup transaction before a new attempt; an unresolved lock, backup, working save, profile divergence, or target process blocks all later attempts. A launcher/process failure must never be reinterpreted as a passed or blocked artifact merely because no observation was received.

### Task 5C attempt records and prior failures

The initial Task 5C pre-spawn adapter rejection did not create a transaction. The first launched fixture attempt, recorded as `task5c-launched-fixture-failure-2026-08-24`, failed before producing an authenticated observation or artifact; it observed no gameplay mutation, warp, receipt, or residual save/profile after cleanup. The runner initially generated a 48-hex transaction key while loader/probe ingress required 64 hex, and the repaired launcher then exposed Windows PowerShell 5.1 path-API and exact process-command-line validation defects. It remains a failed infrastructure attempt and is not converted to success or deleted from the record.

The next attempt, recorded as `task5c-replacement-failure-2026-08-24`, also failed before producing an authenticated observation or artifact: target SMAPI launched but loaded zero staged Mods. The runner reported cleanup incomplete because the owned process remained alive; the exact process was independently verified and stopped, and the temporary profile, working save, staging state, artifact destination, and target-process absence were then verified. This is a second failed infrastructure attempt, not a characterization result and not a mutation lineage. Its failure does not permanently consume the characterization capability; it requires offline correction of the staging/launcher defect and a new independent preflight before a fresh attempt.

The subsequent attempt, recorded as `task5c-launcher-unicode-interop-failure-2026-08-24`, loaded the exact staged loader and multi-source probe successfully; SMAPI logged `Loaded 2 mods`, and the loader began its authenticated fixture load. It nevertheless produced no runner-authenticated terminal or artifact because the PowerShell launcher's `CommandLineToArgvW` P/Invoke omitted `CharSet.Unicode`. That declaration passed the Windows command line with the wrong character encoding, so exact argv verification fail-closed and left the cleanup-owned process running. The process was stopped only after an independent recovery check matched its PID, CreationDate, executable, and correctly Unicode-decoded argv to that transaction. A regular private `observation.json` existed in the recovered transaction but was deliberately not read, authenticated, consumed, replayed, or converted into an artifact; it was cleanup residue, not evidence. The verified owned profile and **working-save destination** `%APPDATA%\StardewValley\Saves\GameBuddyFixtureNavigation_447088730` were removed, and process, working-save destination, transaction, and artifact-destination absence were rechecked. The separate manifest-owned fixture **source** `E:\temp\gamebuddy-navigation-multisource-fixture-447088730\GameBuddyFixtureNavigation_447088730` remains deliberately intact and hash-verified; it is not a working slot and may only be copied into a new transaction-owned destination after later admission. This is a third failed infrastructure attempt, not a characterization result or mutation lineage.

The next attempt, recorded as `task5c-creation-date-identity-failure-2026-08-24`, again loaded the exact staged loader and multi-source probe and loaded the authenticated fixture, but produced no `observation.json`, terminal, or artifact. Its PowerShell launcher captured `Win32_Process.CreationDate` and compared it later using a PowerShell string representation. That representation is not a stable process-identity form: exact recovery established that the same child was instead safely identified by the tuple `(PID, CreationUnixMs, exact executable, Unicode-decoded argv)`. The unstable string comparison made the launcher reject its own child, return `multisource_adapter_launcher_failed`, and leave the runner to preserve profile and working destination. The child was then stopped only after the stable tuple was re-read and matched. The exact two-Mod profile and byte-verified working-save destination were removed after the target exit; no observation existed to consume or inspect, and no artifact was published. This is a fourth failed infrastructure attempt, not a characterization result or mutation lineage.

The next admissible Task 5C attempt must therefore use a new transaction and artifact destination, repeat all static contract/binary SHA/MVID/profile/fixture/process checks immediately before launch, and preserve the same no-action/no-warp/no-input/no-publication constraints. It must not reuse any failed transaction, observation path, process identity, or fixture working slot. It is not authorized merely by this text: the launcher must use the stable `CreationUnixMs` identity value on both initial snapshot and each recheck; that repair must pass its red/green regression, focused deterministic checks and an independent narrow review, followed by the full preflight gate. There is no arbitrary lifetime retry count, but every attempt is individually recorded and governed by these fail-closed boundaries.

### Task 5C diagnostic successor slice — private fixed phase trace (frozen; offline only)

The fifth launched attempt loaded the exact profile and fixture but left no `observation.json`. Before any further target attempt, the probe may add a diagnosis-only, fixed-code trace to the existing private SMAPI log. This trace is **not evidence**: it is not read by the runner, adapter, validator, replay/preflight consumer, catalog, Host, bridge, or final artifact, and it cannot grant any capability or alter a terminal result.

Only one `TracePhase` helper may call `this.Monitor.Log`, at `LogLevel.Trace`, via a closed enum/switch allowlist. Every emitted value is a fixed `GBMS_PHASE:<code>` literal. It must contain no interpolation, exception message/type, arm/key/nonce, path, SHA/MVID, location/tile/player/topology member, extractor reason, raw observation, or dynamic value. It may distinguish only: arm accepted/rejected; subscription installation success/failure; first stable-world readiness; observation/extractor attempt; fixed terminal category; and atomic observation write success/failure. Existing authenticated envelope keys, MAC inputs, raw-observation schema, runner/adapter/launcher interfaces, and all gameplay/SMAPI subscriptions remain unchanged. The trace must not add reflection, dynamic invocation, raw topology extraction, action/controller/bridge/catalog/input seams, or any write other than the existing `FileMode.CreateNew` observation write.

The offline acceptance set is: a static probe test locks the exact closed phase allowlist, `LogLevel.Trace`, one logging helper, no dynamic log construction, and no trace value in any envelope/artifact field; the probe rebuilds against the frozen production closure; the existing static contract still proves exactly one typed production call and rejects reflection/raw topology extraction; and an independent review finds no authority/privacy blocker. This successor slice itself does not stage a profile, create a fixture/artifact, or launch Stardew.

The sixth launched attempt reached `arm_accepted` and `subscriptions_installed`, the loader completed the fixture load, but it never reached `stable_world_ready`. Its old deadline branch initiated its `world_not_ready` terminal write only after the arm deadline, while the runner/launcher correctly require a regular authenticated observation before that deadline; the private trace showed the write success only after launcher failure. This is an infrastructure/protocol failure with no consumed observation or artifact. Before another attempt, the probe must reserve a bounded pre-deadline terminal-write window: it may emit `world_not_ready` only while the remaining time is positive and no greater than `TerminalWriteReserveMilliseconds`; it must detach after expiry without beginning a terminal write, and must flush the writer and durable file stream before logging write success. `ReturnedToTitle` uses the same reserve predicate. This changes neither extractor authority nor observation schema; it only permits an otherwise valid blocked outcome to become durably visible while the runner can still authenticate it.

The seventh launched attempt, recorded as `task5c-terminal-blocked-world-not-ready-2026-08-24`, used fresh production/probe/loader output, a fresh transaction and artifact destination, and a hash-verified copy of the manifest-owned fixture source. The runner consumed exactly one HMAC-authenticated observation before its deadline and published the external artifact at `E:\temp\task5c-multisource-artifact-447088736.json` (SHA-256 `d6b65a328843e908236c97dd56b80c691e57c76c018bae87f7748aec54940a2d`). Its public body is a valid `blocked` terminal with predicate `world_not_ready`: `gameThreadObserved` and `correlationApiShapeVerified` are true; `worldReadyObserved`, multi-source and ordinary-warp-family booleans are false; the production extractor invocation count is zero; and mutation, player-warp, receipt, and publication counts are all zero. Fixture cleanup facts are all true. Independent post-run checks revalidated the final artifact, confirmed its absence of raw observation/identity/path/topology/log fields, rehashed the two fixture-source files against their manifest, and confirmed no working save, transaction, or Stardew/SMAPI process remained. This is a consumed terminal characterization result, not an infrastructure retry: its artifact may not be replayed, edited, or replaced. It proves only that this real fixture/runtime did not reach the required ready state before the bounded terminal window; it does not authorize multi-hop topology implementation, Navigation catalog publication, or any Task 8 mutation.

### Task 5D — digest-bound passed-receipt consumption (frozen; no target transaction)

**User-visible result:** a redacted public multi-source artifact is an audit projection only. A structurally valid or edited JSON body cannot authorize multi-hop topology implementation. Only a receipt explicitly pinned in reviewed source to the exact raw artifact bytes, exact target build, and `multi_hop_ordinary_warp` scope can do so, and it can be consumed exactly once.

**Threat model:** this prevents accidental or ordinary-tooling artifact editing, substituted `passed` JSON, and replay of a previously admitted artifact. It does not attempt to defend against an actor able to modify reviewed source, the code-owned receipt registry, or the durable ledger root; those are the trusted computing base and require independent code review. This narrow binding is justified because the P1 demonstrated that valid artifact shape alone would otherwise expand capability.

**Producer → consumer → verifier:** the Task 5C runner remains the sole private consumer of the HMAC-authenticated raw observation and cleanup proof. It produces the same privacy-safe public artifact and **never** creates a capability receipt. A separately reviewed source registry may add a passed-only record only after an already-produced target artifact has been independently audited; each record has exactly `receiptId`, raw artifact SHA-256, `targetBuild`, and `observationScope`. The **standalone topology implementation-admission** preflight reads the caller-supplied public artifact bytes, validates its redacted schema, and validates a registry-bound receipt claim against raw-byte digest/build/scope/passed predicate. It then atomically creates the final consumption marker in the fixed project-owned `.task5-multisource-receipt-ledger` root. The fixed production ledger cannot be overridden by API or CLI: caller-supplied ledger/registry/root test injection is rejected or ignored and cannot create a marker. This receipt is not an agent-live action-admission input: it proves only that this topology implementation may consume one independently reviewed characterization result. The agent-live preflight does not import the topology consumer, replay receipt frames, consume a receipt, or expose receipt registry/ledger/root/marker/claim detail. Injectable composition exists only in a physically separate `.test-harness.` module imported directly by deterministic `.test.mjs` tests; production entries never call that harness.

**Privacy/non-goals:** no HMAC key, arm, raw observation, transaction/path, production SHA/MVID, topology/location/route/tile, logs, or exception data enters the public artifact, registry, or marker. The receipt registry is not a runner output, an artifact signature, a generic JSON-signing framework, an agent-live action-admission fact, or a route/catalog publication. No Task 5D work stages a profile, creates a fixture/working save, launches Stardew/SMAPI, invokes the extractor, or executes mutation.

**Files and tests:** create `tools/stardew-navigation-multisource-receipt-ledger.mjs` with the fixed empty production registry and raw-byte digest/exclusive marker primitive plus its deterministic test. Modify `tools/stardew-navigation-topology-preflight.mjs` and its tests to require and consume the fixed receipt exclusively at the standalone topology implementation-admission boundary. Agent-live tests must prove that no caller-supplied replay, Host test artifact, topology artifact, receipt ledger, registry, or marker root participates in action admission. The existing validator remains a structural/privacy validator only; its tests must stop describing artifact shape as authority. The Task 5C runner and artifact schema do not change. A real `passed` target artifact, if later admissible under a distinct fresh characterization request, requires its own independent audit and code-reviewed registry addition; the existing seventh `blocked / world_not_ready` artifact gets no entry and cannot authorize topology implementation.

A positive artifact may be caller-supplied only to the standalone topology implementation-admission command; it is not committed as a repository fixture, reconstructed from session history, or consumed by agent-live action admission. After a positive run, perform an aggregate independent review of Task 0–5 authority, lifecycle, privacy, replay, artifact and teardown evidence. Catalog re-publication and the Task 8 serial mutation gate remain separately blocked until that review explicitly admits them.

### Task 5E — Host contract parity prerequisite (frozen; no target transaction)

**Status:** Host mapping, selector, and completion behavior must be covered by current Host-owned focused tests and C#↔Host parity checks before a Navigation action gate. They are a **test prerequisite**, not an agent-live verification artifact or a Mod capability authority. The historical `host/dist-test/stardew-integration-module.js` source is deleted; no compatibility module, mounted-surface loader, source-text scan, test-artifact manifest consumer, or test skip may restore it.

**Owning plan:** current Host `*stardew*` runtime behavior remains in the separate runtime-seam follow-up recorded by `design/95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`. The Navigation consumer does not decide the Host runtime split, add a dynamic module loader, publish an additional artifact, or make a test projection part of release/live authority.

**Required Host parity facts:** current Host tests must prove, directly from the typed action implementation and strict protocol/receipt validators:

- `navigate_to_destination` maps to `stardew_navigate_to_destination` with target kinds exactly `["destination"]`;
- reference-selector support is present and deprecated `destinationRef` compatibility is absent;
- the completion predicate requires `reasonCode === "navigation_completed"`, `hasNavigationCompletionEvidence`, `evidence.arrived === "true"`, and `evidence.postcondition === "true"`;
- C# serializer/parser and Host strict validator remain in parity for the current Navigation request and receipt shapes.

These tests are restrictive Host contract evidence only. They must not grant a Mod capability, discover arbitrary modules, select a game/action dynamically, expose credentials, route/topology facts, receipt claims, raw artifact bytes, or runtime mutation authority.

**Agent-live boundary:** `PREFLIGHT_READY` means the current environment, fixture transaction, process ownership, cleanup path, and fresh runtime readiness permit one action attempt. It does not mean Host tests have been used as runtime authority, a topology characterization receipt has been consumed, a replay has completed, or the future action has a receipt. Agent-live preflight must not read `host/dist-test`, a Host test-artifact manifest, a Host verification surface, Host source text, caller-supplied replay frames, topology artifacts, receipt registries, ledgers, or marker roots.

**Required Navigation work:** delete the direct `dist-test` source-file reads, Host verification-surface/manifest consumer, replay readiness, and topology-receipt consumption from `tools/preflight-stardew-navigation-agent-live.mjs` and its harness/tests. Retain `tools/replay-stardew-navigation-operation.mjs` only as an independent deterministic protocol/completion test. Keep topology implementation-admission independent. Delete any unapproved Navigation verification-surface producer/output/manifest coupling unless it is retained exclusively inside Host's own parity-test command.

**Acceptance scenario:** Given current Host focused tests and C#↔Host parity have passed, when the agent-live preflight runs without a Host test artifact, replay input, or topology receipt, then it returns a bounded `PREFLIGHT_READY` only when its own live-environment and fixture/cleanup facts are ready; it neither consumes a receipt nor claims action completion. Missing or failed Host parity is reported by the explicit preflight command list before the live gate, not reinterpreted by agent-live.

**Required checks:** exact Host focused mapping/selector/completion tests; C#↔Host request/receipt parity; the agent-live production suite proving no `.test-harness.`, `dist-test`, manifest, replay, topology consumer, receipt ledger, registry, or marker import; `node --check` for changed tools; scoped `git diff --check`; and one independent review of authority ownership, receipt separation, report redaction, and removal of the historical source dependency.

### Cross-game action-development alignment (Design 95 references; no Task 8 authority)

The following are architecture investments motivated by Task 5C/5D but intentionally owned by `design/95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`. They do not authorize a new Navigation characterization transaction, catalog publication, or Task 8 mutation. This plan records their Navigation consumer requirements so that later implementation removes repeated mechanics without moving Stardew semantics into a generic Devkit.

| Design 95 evolution | Owner and deep-module seam | Navigation / future-action value | Extraction rule |
|---|---|---|---|
| **Task 0.5 — minimal work-brief enforcement, before Tasks 1–7** | Devkit `validateActionWorkBrief({ baseCommit, ownedPaths, sharedHubs, requiredChecks, liveAuthorized })` | Prevents shared-dirty-tree writer collisions, wrong-base builds, unowned Host/tool edits, and accidental live eligibility. | Generic from its first use; it only validates collaboration facts and never grants merge/live/publication authority. |
| **Task 3A — Attempt/Recovery Journal, after atomic evidence finalization** | Devkit `AttemptJournal` with monotonic `prepared → launched → (terminal-settled or incomplete) → recovery-required → recovered` lifecycle. | Makes process ownership, cleanup uncertainty, recovery stop, and fresh-attempt admission explicit instead of rediscovering them across runner, launcher, and runbook. | Generic lifecycle only. Stardew retains process identity, mutation/side-effect classification, retry policy, fixture semantics, and target commands. |
| **Stardew FixtureTransactionManifest** | Stardew project module owned under `integrations/stardew/action-development/`, not the Devkit. | Distinguishes immutable manifest-owned source, transaction staging/profile, working save destination, private diagnostic capture, artifact destination, and cleanup/recovery order. | Only its ownership/lifecycle shape may later be generalized; save/profile/SMAPI details remain Stardew-specific. |
| **Stardew ClaimObligation declaration** | Stardew portfolio/scenario module maps a claim to typed request, receipt lineage, action evidence, fresh postcondition, cleanup predicates, forbidden substitutions, and publication consequence. | Makes `blocked / world_not_ready` mechanically distinguishable from an implementation or mutation authorization; reduces multi-file review reconstruction. | Devkit may later parse a generic envelope, but claim semantics and proof obligations stay game/action-owned. |
| **Private bounded diagnostic channel** | Devkit may provide bounded retention/transport; each game project owns fixed phase-code vocabulary. | Preserves Task 5C's privacy-safe phase diagnosis without elevating logs into evidence or authority. | No cross-game phase taxonomy, free-form exception logging, or diagnostic-to-verdict/publication conversion. |
| **Optional evidence-consumption capability** | Keep Task 5D's fixed registry/ledger local until a second independent consumer proves a shared need. | Prevents edited/replayed public audit JSON from authorizing a later capability. | Do not create a generic signing/attestation framework now; extract only the raw-byte binding and exclusive-consume mechanics after a second real consumer. |
| **Optional static native-boundary contract harness** | Game-project proof module, initially Navigation-specific. | Retains exact typed-call/no-reflection proof for probes that must not duplicate production extraction. | Do not put Stardew assemblies, type names, or native semantics into the Devkit; generalize only after a second same-class proof. |

### Subagent-driven implementation topology and parallelism

Every future implementation task named above must use the `subagent-driven-development` skill. A task starts only after a slice card states its user-visible result, owned paths, shared hubs, producer → consumer → verifier assertion, focused checks, writer/reviewer budget, and explicit live allowance. The default is `liveAuthorized: false`.

**Serial decisions and integration owners**

1. The Host/action-surface owner first freezes the Task 5E verification-surface interface/version and its artifact location. A read-only architecture oracle and a read-only consumer reviewer may assess that decision in parallel; no writer starts until their findings are synthesized by the Host integration owner.
2. The Devkit integration owner first freezes Task 0.5 work-brief schema and the package export list before the Task 2/3/3A waves. The Stardew integration owner separately freezes the fixture-manifest and claim-obligation interfaces before those project lanes start.
3. A shared hub has one serial integrator: `packages/game-action-devkit/package.json`, `packages/game-action-devkit/src/index.mjs`, root workspace/lockfile files, the Host test-artifact builder, and each Stardew package manifest/portfolio file. Writers never edit a hub merely because their lane needs an export; they submit a bounded change to its assigned integrator.

**Permitted parallel waves after those interfaces are frozen**

| Wave | Independent mutation lanes and owned paths | Must not overlap | Merge / verification gate |
|---|---|---|---|
| A — Task 5E producer → consumer completion (**serial**) | **A1 Host writer:** Host source/test-artifact builder/tests publishes and proves the fixed verification surface. **Only after A1 accepts:** **A2 Navigation writer:** `tools/preflight-stardew-navigation-agent-live.mjs` and its production tests migrate to that published surface. A read-only consumer mapping may run during A1, but it may not edit or validate the consumer against an unbuilt surface. | The frozen surface interface and artifact version; A2 may not start before the A1 production surface/build evidence exists. | A1 official Host build + surface contract tests, then A2 unskipped mounted-surface suite, then Task 5D receipt suite and one combined authority review. |
| B — generic Devkit mechanics | Task 2 writer: `packages/game-action-devkit/src/process-supervisor.mjs` and tests; Task 3/3A writer: `src/atomic-directory.mjs`, `src/evidence.mjs`, `src/attempt-journal.mjs` and tests. | package exports, package manifest, workspace/lockfile, and generic caller cutover files; those are owned by the Devkit integrator. | Each lane proves its own deterministic suite in an isolated worktree; the integrator performs one serial export/caller cutover and runs combined Devkit + affected caller checks. |
| C — Stardew project contracts | Fixture writer: `integrations/stardew/action-development/src/fixture-transaction-manifest.mjs` and tests; Claim writer: `src/claim-obligation.mjs` and tests. | `game-action-project.json`, `portfolio.json`, package scripts, and action adapter composition; those are owned by the Stardew integrator. | Each lane proves fake filesystem/schema cases; the integrator wires declarations into the project adapter and runs package-local conformance. |
| D — diagnostics and consumer migration | Diagnostic transport writer: Devkit bounded diagnostic mechanism/tests; Stardew diagnostic writer: fixed code vocabulary, projection/redaction tests, and runbook. | diagnostic envelope/version and package entrypoint, owned by the Devkit/Stardew integrators respectively. | Combined proof that diagnostics are bounded and never affect verdict, evidence authority, catalog, or publication. |

No producer → consumer → verifier authority chain is split across independent writers. In particular, Task 5D fixed receipt validation/deferred consumption remains one connected writer lane, and any later generic evidence-consumption extraction waits for a second real consumer. Within every wave, reviewers are fresh, read-only, and inspect the merged post-write diff plus actual focused results; they do not substitute for writer validation. A failed check, incomplete official artifact, unresolved ownership, or a new authority model stops only dependent lanes and produces a named blocker; it never permits a mock, compatibility fallback, stale artifact, or target retry.

## Later tasks

Only after Task 5E and Task 5D are accepted and the aggregate independent review passes may the project decide whether the withdrawn action may be re-published and whether to enter the one serial Task 8 target-version mutation gate. Task 5 cannot itself make the action published, establish a route, or replace that review/gate. Design 95 platform work may proceed under its own Task 0 work-brief admission in parallel with non-conflicting Task 5E preparation, but no Design 95 task constitutes Navigation evidence or Task 8 authorization.

### Task 8 — durable same-lineage execution recovery (approved; implementation not yet accepted)

**Problem corrected:** an `execute` response timeout proves only that Host did not receive that response. It does **not** prove that the Mod did not accept, execute, or terminally settle the native action. Treating every timeout as permanently abandoned and immediately restoring/deleting the fixture destroys the exact recovery material, turns transient pipe loss into an operator dead end, and risks an unsafe new-identity retry.

**User-visible result:** an accepted Stardew action has one durable logical lineage. A response-loss timeout automatically queries and settles that same lineage. It never silently starts a second native action. A new action identity is created only for a genuinely new player intent after the previous lineage has authoritatively settled or been explicitly handed off as recovery-required.

**Authority and stored facts:**

1. The **Mod action ledger is the only execution/receipt truth**. Before `FarmhandActionRouter.TryRoute(...)` can begin a native body, the game thread durably records the exact immutable dispatch tuple: `requestId`, `idempotencyKey`, authenticated scope/binding identity, action ID, canonical arguments, expected revision, absolute deadline, and `accepted_or_pending` state. Every receipt transition, especially a terminal receipt, is durably written before it is sent over the pipe. A failed write quarantines the lineage and permits neither routing nor a fabricated receipt. The first Stardew implementation uses a private, versioned Mod-owned `IDataHelper.WriteGlobalData` journal, because SMAPI `WriteSaveData` is discarded when the player exits without saving and therefore cannot establish pre-native-body durability. A Mod-folder private file is also rejected: the native-local fixture transaction deploys/restores that folder and would destroy recovery truth during cleanup. Each global record is still exact-scope-bound and rejected outside its recorded save/world/player/companion tuple; it is not cross-save authority. Terminal records are retained only for the bounded recovery retention policy, then deleted by the Mod-owned journal after their recovery window; no caller, fixture, or Host chooses retention/deletion. This first tracer proves normal Host/SMAPI restart recovery using SMAPI's immediate global-data write semantics; it does not claim sudden-power-loss filesystem atomicity. A malformed, partial, duplicate, inaccessible, or scope-mismatched journal is an ambiguous state: it must fail closed into recovery-required and can never authorize route or resend.
2. The **Host recovery journal is not a second receipt ledger**. Before the pipe write, it durably records only the exact tuple it may later ask the Mod about, together with logical-action ID, dispatch ordinal, actor/epoch, binding identity, absolute deadline, immutable envelope bytes/fields, and transport state. After a possibly-successful write with no correlated response it records `sent_unknown`. It never creates, edits, or infers a Mod receipt.
3. The **Host recovery supervisor** obtains a freshly authenticated binding to the same scope/actor and queries the exact Mod tuple. It may admit only the response returned by the Mod's authoritative ledger through the existing strict receipt path.
4. The **fixture transaction owner** retains the working save, Mod transaction backup, and recovery journal while a lineage is `sent_unknown` or `recovery_pending`. It may restore/delete only after authoritative settlement or an explicit recovery-required handoff. Cleanup remains mandatory; retained state is private recovery material, not action evidence or a publication artifact.

**State machine and resend rule:**

```text
prepared
  -> sent_unknown
  -> accepted_or_pending | terminal_settled | recovery_required
accepted_or_pending
  -> terminal_settled | recovery_required
```

- A query returning a nonterminal receipt keeps the same lineage fenced and schedules bounded query/wait recovery; it never emits a second dispatch.
- A query returning a terminal receipt goes through the existing strict receipt/evidence/fresh-postcondition settlement path.
- Only an explicit Mod-owned `not_accepted` result may permit a resend, and only while the original absolute deadline is live. That resend must reproduce the **same** `requestId`, `idempotencyKey`, scope/binding, action, canonical arguments, revision and deadline. It is transport recovery, not a new action.
- `receipt_not_found`, connection loss, a mismatched binding, malformed response, or any ambiguous state is **not** `not_accepted`; it becomes `recovery_required` and cannot authorize resend.
- A terminal `uncertain`, including any navigation state after native warp has begun, is settled as that terminal state and is never retransmitted. A later player request is a new intent with a new logical-action identity; it cannot overwrite the old receipt.
- STOP, redirect, deadline and lifecycle close retain their existing action-specific semantics. Recovery must recheck the original epoch/scope/deadline before every query, resend, fresh replan, or terminal projection.

**Required implementation order:**

1. **Mod producer:** durable ingress/receipt journal and exact recovery query, including durable `not_accepted` semantics. Replace bounded in-memory idempotency/receipt data as the recovery truth; in-memory indexes may only be caches of the durable record.
2. **Host consumer:** durable logical-action recovery journal and a supervisor that can restart, reconnect, query, and pass an authoritative receipt to the current strict coordinator without replaying a native action.
3. **Lifecycle consumer:** native-local fixture/smoke timeout transitions from immediate teardown to `recovery_pending`, resolves the same lineage, then executes restore/cleanup exactly once.
4. **Failure-injection evidence:** response lost after Mod acceptance, lost terminal delivery, Host restart, Mod/SMAPI restart, exact `not_accepted`, query ambiguity, STOP/redirect, deadline expiry, and post-warp `uncertain`. Tests must prove no duplicate native body and byte-for-byte fixture restore after terminal settlement.

**Non-goals and prohibitions:** do not add a generic hash/manifest/attestation chain, caller-supplied receipt registry, synthetic success receipt, second receipt authority, general retry framework, or a route/action budget. Do not reuse the Task 5D topology receipt ledger, replay tools, agent-live preflight, or Host parity artifacts as recovery authority. This task does not retroactively settle historical attempts that lack a durable exact tuple, surviving Mod journal, and recoverable fixture state; those remain `historical_unrecoverable_incomplete`, not proof that recovery is categorically forbidden.

**Acceptance:** a response-loss injection after a single Mod acceptance automatically converges to the same terminal receipt/evidence/fresh postcondition without a second native dispatch; an explicit durable `not_accepted` permits at most one same-envelope resend inside the original deadline; all other ambiguous cases retain recoverable state and fail closed without executing again. No live mutation is authorized by this design text alone.
