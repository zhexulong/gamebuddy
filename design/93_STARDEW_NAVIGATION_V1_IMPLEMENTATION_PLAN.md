# Stardew Navigation V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ordinary Farmhand `single_player_native_companion` topology 中交付三个 Agent-facing typed Navigation operations：只读的 `inspect_world_map`、只读的 `find_destination`，以及由 Mod/game thread 拥有路线与原生移动的 `navigate_to_destination`。

**Architecture:** Mod 在游戏线程从 target-version content 与当前世界构造唯一、generation-bound 的 `DerivedDestinationSet`。它派生 folded WorldMap directory、bounded lexical search 和私有 selector/ref binding；Host 只做 live-Mod-capability 的 restrictive typed projection、单次结果 delivery，以及 current invocation admission，绝不拥有 destination catalog、搜索、route、arrival authority 或跨 task disclosure quota。`navigate_to_destination` 作为一个 execution 复用 ordinary Farmhand 的 session/receipt/body ownership，但内部逐 hop revalidate、native commit 和 fresh reread；它不通过 Host 组合 `move_to_tile`、`travel` 或 `enter_exit`。

**Tech Stack:** Stardew Valley `1.6.15` build `24356`; SMAPI Mod / C# `net6.0`; `Raffinert.FuzzySharp` `5.0.3`; TypeScript ESM / TypeBox; existing ordinary bridge v1 JSON schema; Node.js `>=24.13.0`, pnpm `11.1.3`.

**Spec:** `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md` is the Navigation semantic authority. `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` §§P4–P5 and its Frozen Implementation Briefs are the release-stage/gate authority. This document is the executable implementation breakdown and does not supersede either source.

## Global Constraints

- **Topology and publication:** Only `single_player_native_companion` ordinary Farmhand topology is in scope. `ModConfig.FarmhandActionDefinitions` / policy-derived live publication remains the only capability authority; Host registry, typed tools, bridge schema and descriptors are restrictive or descriptive projections. Portfolio is topology-isolated and must not be changed.
- **Three contracts only:** public operations are exactly `inspect_world_map({} | { nodeRef } | { cursor })`, `find_destination({ query })`, and `navigate_to_destination({ destination: DestinationSelector })`. Do not retain an untyped string-only Navigation selector or any generic observation/action dispatcher.
- **Knowledge and destination boundary:** K2 + G1 are frozen. Search may cover installed-and-existing player-named canonical locations; Navigation arrives at a canonical location only. It does not target an NPC, counter, machine, chest, tile, facing or interaction pose.
- **No internal-map leak:** Never expose raw location/map/region keys, `Valley`, `GingerIsland`, coordinates, tiles, warps, route plans, source-lineage/audit fields, hidden conditions, scores, thresholds, margins or query echoes in an Agent result. `Valley` and `GingerIsland` are target `Data/WorldMap` internal region keys without legal player labels and must be transparent containers.
- **Read-only separation:** `inspect_world_map` and `find_destination` use a new typed authenticated read-only request/result route. They never create an execution ID, gameplay receipt, mutation evidence, `authoritatively_completed`, or a full `stardew_observe` snapshot.
- **Selector/ref boundary:** a unique fresh canonical label uses `{ kind: "label", label }`; alias, collision, duplicate, or non-provably-unique presentation uses the opaque selector `{ kind: "ref", ref: "dr1_…" }`. There is **no `destinationRef` compatibility field/alias**: the opaque selector key is always `ref` and its handle is a 128-bit CSPRNG `dr1_…` runtime lookup handle. `dr1_`, `nr1_`, and `wc1_` handles are 128-bit CSPRNG runtime lookup handles with a five-minute non-sliding TTL; they are not permits, JWTs, signatures, persisted authority, or self-describing data.
- **WorldMap projection:** first transparently flatten every unlabeled structural container, then fold a labeled group only when it has one effective child. Return only the resulting decision frontier. An entry may include both `nodeRef` and `destination`, avoiding duplicate group/destination rows.
- **Disclosure limits:** each inspect page is at most 20 G1 entries and 4096 UTF-8 bytes; each find result is at most 3 candidates and 2048 UTF-8 bytes. These are per-result projection limits, not a gameplay-task or control-epoch cumulative quota. Repeated reads and cursor continuation remain available while each source-owned result satisfies its own bound. A present `nextCursor` explicitly means the same frontier has a next page; an absent one only completes that frontier.
- **Search dependency:** production search uses `Raffinert.FuzzySharp` `5.0.3` plus the frozen Unicode-preserving NFKC pipeline. Do not vendor or reimplement Levenshtein, introduce remote/Lucene/vector retrieval, or publish search if the package/corpus/runtime gates fail.
- **Execution safety:** all game-thread checkpoints revalidate current scope, published capability/policy, revision/idempotency, deadline/cancel, actionability, ownership, world/content generation and selector binding. A given armed transition edge has one native commit attempt; a post-side-effect uncertain transition returns `native_transition_uncertain` and is never retried automatically. Hop/replan count does not terminate a valid player task; only fresh route facts, deadline, authenticated STOP/cancel, real impossibility, runtime terminal failure, or surface closure may do so. Partial movement is never rolled back.
- **Mine boundary:** arriving at Mine exterior is a Navigation success. Navigation must never invoke, wrap, claim, or supply evidence for completed M8 `enter_mine`, `use_mine_ladder`, or `select_mine_elevator_floor`; `reach_mine_floor` is out of scope.
- **No prohibited ingress:** no UI/OCR/keyboard/mouse/XInput injection; no direct player/save mutation; no generic native reflection dispatcher; no Agent/Host submitted map/tile/warp/route/facing/native member/matcher parameters.
- **Live-mutation discipline:** no production route/movement transition before P4E's read-only/direct/preflight gate passes, a non-mutating preflight is recorded, and an independent reviewer finds no blocker. One serial target-game mutation gate follows; a failure is fixed offline rather than retried for evidence.
- **Dirty-tree governance:** before a mutation-capable task, capture the P0 baseline required by design/38 §4.1 and establish a single owner for shared hubs: `ModConfig.cs`, `BridgeSession.cs`, `ExecutionManager*.cs`, `ModEntry.cs`, ordinary bridge schema/protocol, `host/src/action-registry.ts`, `host/src/game-tools.ts`, and related shared tests.

---

## File and Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Mod publication and wire DTOs | `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`, `FarmhandCapabilitySurface.cs`, `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`, `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs`, `integrations/stardew/ModConfig.cs` | Distinguish published execution actions from published read-only operations without giving Host publication authority; define strict typed payloads and exact C# structural validation. |
| Derived destination authority | Create `integrations/stardew/Navigation/DerivedDestinationSet.cs`, `WorldMapProjection.cs`, `NavigationReferenceStore.cs`, `DestinationSearch.cs` | One current-generation private destination set, native/content derivation, selector resolution, reference issuance, folded map projection, search and source-lineage/fresh-reread checks. |
| Mod read-only transport | `integrations/stardew/BridgeSession.cs`, `integrations/stardew/ModEntry.cs`, Create `integrations/stardew/Navigation/NavigationReadOnlyService.cs` | Authenticate, validate and route inspect/find read-only requests on the game thread; produce one correlated typed result without touching execution ledger. |
| Mod navigation execution | `integrations/stardew/ExecutionManager.cs`, `ExecutionManager.MovementHandlers.cs`, `StardewBodyController.cs`, `ModEntry.cs`, Create `integrations/stardew/Navigation/NavigationExecutionCoordinator.cs` | One semantic Navigation execution owner, internal local-leg results, allowed route planning, transition correlation, terminal receipt/evidence and fresh arrival reread. |
| Host transport/types | `host/src/protocol.ts`, `host/src/local-stardew-bridge.ts`, `host/src/integration-types.ts` | Strict TypeScript message unions, request correlation and typed read-only result client methods; never reinterpret result as completion. |
| Host tool projection | `host/src/action-registry.ts`, `host/src/game-tools.ts`, `host/src/stardew-integration-module.ts` | Restrictive live capability mount, three explicit typed tools, fresh pre-write admission, and bounded per-result delivery. |
| Wire parity | `protocol/bridge-v1.schema.json`, `host/src/schema-contract.test.ts`, Core protocol tests | Schema/C#/TS exact union parity and rejection of unknown keys/message types. |
| Verification | Create focused C# and Host tests under existing `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests`, `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests`, `host/src/*navigation*.test.ts`; create focused Node runners under `tools/` | Deterministic contracts, target content/runtime read-only gates, real-shaped replay, non-mutating preflight, serial live runner and teardown verification. |

## Frozen Slice Card

```text
User-visible result:
  Agent can browse a compact current WorldMap directory, perform bounded lexical
  destination discovery, and navigate to a G1 location through one typed operation.

In scope:
  K2 named-location search; G1 locations; folded directory; label-or-ref selector;
  Mod-owned route/body execution; the frozen current-source transition characterization.

Explicit non-goals:
  Player-facing map UI; open natural-language parsing in Mod; an Atlas; arbitrary
  route primitives; POIs/interaction pose; M8 invocation; persisted handles; full map dump.

Authority:
  Mod game thread owns derivation, publication, refs, search, route, native commits
  and arrival. Host owns only restrictive projection, current invocation admission and
  result-byte disclosure accounting.

Acceptance scenario:
  Given a target-version normal Farmhand world and a current published Navigation
  capability, when Agent invokes a typed operation, then the Mod supplies a bounded
  fresh typed fact or a same-execution navigation receipt; and every claimed result
  has its corresponding source/readback or receipt/evidence/postcondition verifier.

Batch boundary:
  P4A–P4D prerequisites → P4E materialization/read-only gates → P5 non-mutating
  preflight → one serial target-game Navigation gate. No step may skip a prior gate.

Mutation lanes:
  One shared integration owner writes all shared Mod/Host/schema hubs. Read-only
  corpus/content runners can be independently reviewed, but no parallel writer edits a hub.

Stop condition:
  Unresolved native derivation/transition fact, failed parity/preflight, dirty
  shared-owner conflict, or any route that needs an unapproved native ingress blocks
  the next stage.
```

## Task 1: Establish P4 Admission Record

**Files:**
- Create: `design/review/93_STARDEW_NAVIGATION_V1_P4_ADMISSION_RECORD.md`
- Modify: `design/93_STARDEW_NAVIGATION_V1_IMPLEMENTATION_PLAN.md` only to record a later completed gate date/evidence path; do not alter contract text.
- Verify: `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`, `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` §§P4A–P4E.

**Interfaces:**
- Consumes the P4A/P4B probe artifacts, P4D model-test evidence and package/runtime facts.
- Produces a reviewed `ready_for_p4e: true | false` record with each applicable prerequisite, artifact path/digest, owner, and exact blocker. It is release evidence only—not Mod/Host authority.

- [x] **Step 1: Capture the protected working baseline before any writer starts.**

  Run exactly and insert their outputs/digests into the admission record:

  ```powershell
  git status --short --branch
  git diff --stat
  git diff --name-status
  git diff --check
  ```

  Record the named shared-hub owner and explicitly list every Navigation-owned versus pre-existing changed path. Stop if a shared hub has no single owner.

- [x] **Step 2: Write the P4 admission table with falsifiable predicates.**

  The record must contain exactly these rows:

  ```markdown
  | Predicate | Required producer → consumer → verifier | Verdict | Evidence / blocker |
  |---|---|---|---|
  | P4A source derivation and Mine lineage | target content → redacted source artifact → strict reducer | pending | ... |
  | P4B runtime hierarchy characterization | target WorldMap APIs → authenticated probe → strict validator | pending | ... |
  | P4D ref binding model | trusted frozen fact → model tests → negative-case verifier | pending | ... |
  ```

  Do not write raw labels, queries, aliases, canonical keys, routes, corpus bytes or private evidence content into this record.

- [x] **Step 4: Verify admission record hygiene.**

  **2026-08-22 status update:** Task 1 remains `ready_for_p4e: false`. P4A and
  P4B are `characterization_ready_not_materialized`; their current probe diff
  (`c48ad0a54da00736e7373665469312cdbdf8d7b4d48f28835ed82ce199284bd1`) has
  passed 16 focused Node checks, both 0-warning C# builds, and one fresh
  authenticated exact-two-Mod target-runtime transaction (`world_map_completed`,
  strict validator `valid: true`, cleanup verified). Any later probe-code change
  requires a new authenticated target run. P4D remains
  `characterization_ready_not_materialized`. The authoritative
  per-row evidence, non-claims, and next prerequisite are in
  `design/review/93_STARDEW_NAVIGATION_V1_P4_ADMISSION_RECORD.md`. On
  2026-08-22, the user explicitly accepted the current shared-hub working tree
  as the collaboration baseline (digest
  `c232b4e53fef8911a798cf42906dee51308f7eece5b04d847713f85a67a1c23b`) and
  assigned one Navigation integration writer for the bounded inspect-only
  publication foundation. The read-only contract may be expanded to
  `find_destination`; `navigate_to_destination` remains subject to its own preflight.

  Run:

  ```powershell
  rg -n "(TODO|TBD|implement later|raw query|canonical key|route|coordinate)" design/review/93_STARDew_NAVIGATION_V1_P4_ADMISSION_RECORD.md
  ```

  Expected: no placeholder phrase and no prohibited private data. A `route` occurrence is allowed only in the literal producer/consumer/verifier header above; otherwise remove it.

## Task 2: Make Ordinary Farmhand Publication Support Explicit Read-Only Operations

**Files:**
- Modify: `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`
- Modify: `integrations/stardew/src/Core/Policy/FarmhandCapabilitySurface.cs`
- Modify: `integrations/stardew/ModConfig.cs`
- Modify: `host/src/action-registry.ts`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ActionPolicyEngineTests.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/NativeToolContractTests.cs`
- Test: `host/src/action-registry.test.ts`

**Interfaces:**
- Produces three Mod-defined published operation IDs: `inspect_world_map`, `find_destination`, `navigate_to_destination`.
- `navigate_to_destination` remains an executable primitive action. `inspect_world_map` and `find_destination` are published read-only operations that can be advertised and policy-withdrawn but can never enter `BridgeSession.TryExecute`, `FarmhandActionRouter`, `ExecutionManager` receipt ledger, or `visiblePublishedActions()`.
- `FarmhandCapabilitySurface` must expose a capability sequence containing both kinds while retaining separate predicates:

  ```csharp
  bool ContainsGameAction(string actionId);
  bool ContainsReadOnlyOperation(string operationId);
  ```

- [x] **Step 1: Write failing Mod publication tests.**

  Add tests equivalent to:

  ```csharp
  [Fact]
  public void PublishedNavigationOperations_AreAdvertisedButOnlyNavigateIsExecutable()
  {
      FarmhandCapabilitySurface surface = FarmhandCapabilitySurface.FromEnabledActions(
          new HashSet<string>(StringComparer.Ordinal)
          {
              "inspect_world_map", "find_destination", "navigate_to_destination",
          });

      Assert.Contains("inspect_world_map", surface.Capabilities);
      Assert.Contains("find_destination", surface.Capabilities);
      Assert.Contains("navigate_to_destination", surface.Capabilities);
      Assert.True(surface.ContainsReadOnlyOperation("inspect_world_map"));
      Assert.True(surface.ContainsReadOnlyOperation("find_destination"));
      Assert.False(surface.ContainsGameAction("inspect_world_map"));
      Assert.True(surface.ContainsGameAction("navigate_to_destination"));
  }
  ```

  Add a second test where policy denies `find_destination`; hello/snapshot omit only that capability and `ContainsReadOnlyOperation("find_destination")` is false.

- [x] **Step 2: Run the focused Mod test before implementation.**

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~ActionPolicyEngineTests|FullyQualifiedName~NativeToolContractTests"
  ```

  Expected: failure because definitions/surface cannot yet represent a read-only operation separately from a game action.

- [x] **Step 3: Implement operation kind in the sole Mod definition composition.**

  Extend the definition model with a closed kind, for example:

  ```csharp
  public enum FarmhandOperationKind { Execution, ReadOnly }

  public sealed record FarmhandActionDefinition(
      string ActionId,
      string FamilyId,
      int IdentityVersion,
      FarmhandActionLifecycle Lifecycle,
      FarmhandOperationKind Kind = FarmhandOperationKind.Execution);
  ```

  Add the three Navigation definitions in `FarmhandActionCatalog` with `inspect_world_map` and `find_destination` as `ReadOnly`, `navigate_to_destination` as `Execution`, all `Published`. Derive all enabled IDs from this same catalog/policy path. Refactor `FarmhandCapabilitySurface` to retain immutable execution and read-only membership sets; `Capabilities` is their deterministic combined projection. Do not add a second navigation allowlist.

- [x] **Step 4: Make the Host registry an explicitly restrictive mirror.**

  Add registry entries for all three IDs. Model the two discovery operations as a non-executable/read-only category that is never returned by `visiblePublishedActions()` and is never mapped by `PUBLISHED_PRIMITIVE_TOOL_NAMES`; retain `navigate_to_destination` as a published primitive action. Ensure Host entries cannot add a Mod-absent capability.

  Add a Host test asserting:

  ```ts
  expect(visiblePublishedActions(["inspect_world_map", "find_destination"], policy)).not.toContainEqual(
    expect.objectContaining({ actionId: "inspect_world_map" }),
  );
  ```

  The future read-only tool materializer must inspect its exact live capability directly, not sneak it into the execution wrapper factory.

- [x] **Step 5: Re-run focused publication tests.**

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~ActionPolicyEngineTests|FullyQualifiedName~NativeToolContractTests"
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/action-registry.test.js
  ```

  Expected: green; a denied or unknown Navigation ID cannot be advertised/mounted, and inspect/find cannot execute through the ordinary action router.

  **2026-08-22 completion evidence:** this publication foundation is intentionally
  narrower than the original three-operation task wording. It materializes only
  Mod-owned `inspect_world_map` as a published `read_only` operation. The same
  read-only publication path is extended for `find_destination`; P5 still
  prohibits `navigate_to_destination`. The current catalog/revision baseline
  provides the shared cross-hub support. `inspect_world_map` is included in
  `Capabilities` and its `read_only` registration, excluded from
  `EnabledActionIds`, `TryExecute`, router registration, execution receipts,
  `visibleActions`, and action-tool names. Both Host catalog-update consumers
  reject a read-only ID in execution `enabledActionIds`. Evidence:

  ```text
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/integration-module.test.js host/dist-test/integration.test.js \
    host/dist-test/local-stardew-bridge.test.js host/dist-test/protocol.test.js \
    host/dist-test/schema-contract.test.js
  # 53 passed, 0 failed

  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj --no-restore
  # 9 passed, 0 failed

  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj --no-restore
  # 26 passed, 0 failed

  pnpm --filter @gamebuddy/companion-host typecheck
  node tools/check-stardew-action-promotion.mjs
  # passed (publishedCount: 25)
  ```

  Fresh independent review of the actual post-fix publication diff found no
  P0/P1/P2 finding. The reviewer run wrapper reported an unavailable
  `intercom` child-tool request after producing its review; this harness status
  does not invalidate the separately captured review conclusion or the above
  author-run commands. The next slice is **inspect-only Task 3 contract
  narrowing**; it must not add `find_destination` to the catalog.

## Task 3: Define Strict Read-Only Wire Contracts and a Typed Mod-Owned Ref Store

**Files:**
- Modify: `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`
- Modify: `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs`
- Modify: `host/src/protocol.ts`
- Modify: `protocol/bridge-v1.schema.json`
- Create: `integrations/stardew/Navigation/NavigationContracts.cs`
- Create: `integrations/stardew/Navigation/NavigationReferenceStore.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BridgeProtocolSerializationTests.cs`
- Test: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BridgeProtocolPropertyTests.cs`
- Test: `host/src/protocol.test.ts`
- Test: `host/src/schema-contract.test.ts`

**Interfaces:**
- Adds exact read-only message types:

  ```text
  navigation_read_request
  navigation_read_result
  ```

- Defines the C#/TS/schema-equivalent request discriminated union:

  ```ts
  type NavigationReadRequest =
    | { operation: "inspect_world_map"; args: {} | { nodeRef: string } | { cursor: string } }
    | { operation: "find_destination"; args: { query: string } };
  ```

- Defines only the result unions from design/36; rejected bridge ingress returns the existing typed `error` envelope, not a success-shaped operation result.
- `NavigationReferenceStore` has no public `Decode` method. Its operation-facing resolution signature is:

  ```csharp
  bool TryResolveNode(string nodeRef, NavigationBindingContext context, out NavigationNodeBinding binding, out string reasonCode);
  bool TryResolveCursor(string cursor, NavigationBindingContext context, out NavigationCursorBinding binding, out string reasonCode);
  bool TryResolveDestination(NavigationDestinationSelector selector, NavigationBindingContext context, out NavigationDestinationBinding binding, out string reasonCode);
  ```

- [x] **Step 1: Write failing C#/TS/schema parity vectors.**

  Add vectors for each exact valid request and these invalid cases:

  ```json
  {"operation":"inspect_world_map","args":{"nodeRef":"nr1_x","cursor":"wc1_x"}}
  {"operation":"inspect_world_map","args":{"pageSize":20}}
  {"operation":"find_destination","args":{"query":"mine","locale":"en-US"}}
  {"operation":"find_destination","args":{"query":""}}
  {"operation":"unknown","args":{}}
  ```

  Assert every implementation rejects all five and accepts only `{}`, `{nodeRef}`, `{cursor}`, and `{query}` respective shapes. Add result vectors ensuring `nextCursor` is optional and never accompanied by `total`, `page`, `score`, `route`, raw key, coordinates or source lineage.

- [x] **Step 2: Run before implementation.**

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~BridgeProtocol"
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/protocol.test.js host/dist-test/schema-contract.test.js
  ```

  Expected: failing compilation/validation because the two typed read-only messages and contracts do not exist.

- [x] **Step 3: Add exact envelope/model/schema unions.**

  Add the two message types to all three closed discriminators (`BridgeProtocol` parser, TypeScript `BridgeMessage`, JSON schema enum/allOf). Use distinct C# payload records rather than adding optional navigation fields to `BridgeExecutionArgs` or `BridgeSnapshot`. Keep `execution_request` action/args validation unchanged, so an inspect/find request cannot enter `TryExecute`.

- [x] **Step 4: Implement opaque reference issuance and deterministic negative validation.**

  In `NavigationReferenceStore`, generate a 16-byte handle with `RandomNumberGenerator.Fill`, encode base64url without padding, and prefix only with `dr1_`, `nr1_`, or `wc1_`. Bind every record to runtime instance, full `BridgeScope`, content owner/canonical identity, source generation, issued observation sequence and absolute expiry. Cursor bindings additionally retain one immutable folded-frontier page snapshot.

  Resolution must reject malformed prefix/encoding, unknown handle, expiry, scope mismatch, runtime close/world unload, generation mismatch without canonical rebind proof, and wrong handle kind. It must not inspect labels, parse a handle payload, auto-reset a cursor, or choose the first duplicate label.

- [x] **Step 5: Re-run wire and ref negative tests.**

  Run the Task 3 commands plus focused new ref-store tests. Expected: C#, TS and JSON schema make identical accept/reject decisions; a forged/cross-scope/stale handle yields its exact reason and does not create any execution receipt.

  **2026-08-22 completion evidence:** Task 3 is intentionally narrowed to the only
  P4E-admitted `inspect_world_map`; `find_destination` is its separate query-only
  discriminator. The three closed wire validators accept only `{}`, `{ nodeRef:
  "nr1_" + 22 base64url chars }`, or `{ cursor: "wc1_" + 22 base64url chars }` for
  inspect, and only `{ query }` for find. They reject mixed selectors, extra keys,
  malformed/prefix-mismatched refs, and unknown operations. `navigation_read_result`
  is a distinct non-receipt union whose inspect success result has only entries and optional cursor;
  it cannot carry totals, score, route, coordinates, source lineage, evidence,
  request/execution IDs, or completion state.

  `NavigationReferenceStore` is Mod-private and uses a random 16-byte
  base64url lookup handle with `nr1_`, `wc1_`, or `dr1_` prefix. It stores the
  runtime instance, entire `BridgeScope`, canonical owner/identity, generation,
  observation sequence, absolute five-minute expiry, and (only for cursor) its
  immutable frontier snapshot. It has no decode API and rejects scope/runtime /
  generation/expiry/handle-kind mismatches fail closed. No bridge/session/tool
  routing exists yet, so this slice cannot create an execution or receipt.

  Evidence:
  ```text
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests --filter "FullyQualifiedName~BridgeProtocolSerializationTests" --no-restore
  # 13 passed, 0 failed
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~NavigationReferenceStoreTests" --no-restore -p:GamePath='E:/temp/gamebuddy-stardew-ai-client'
  # 3 passed, 0 failed
  pnpm --filter @gamebuddy/companion-host typecheck
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/protocol.test.js host/dist-test/schema-contract.test.js
  # 27 passed, 0 failed
  ```

  A fresh independent review found and this slice closed two parity defects:
  inbound C# scope values are now required to satisfy `BridgeScope.IsValid`,
  and C#/schema result validation now requires `nr1_` node refs (rather than
  generic opaque IDs) and rejects invalid success/blocked DTO combinations.

## Task 4: Derive One Current `DerivedDestinationSet` and Materialize `inspect_world_map`

**Prerequisite:** Task 1 admission record says P4A and P4B are ready and preserves the P4D characterization-ready/non-permit verdict. Complete Task 2 and Task 3 first: their production publication and ref-contract artifacts are P4E deliverables, not a circular P4D precondition.

**Files:**
- Create: `integrations/stardew/Navigation/DerivedDestinationSet.cs`
- Create: `integrations/stardew/Navigation/WorldMapProjection.cs`
- Create: `integrations/stardew/Navigation/NavigationReadOnlyService.cs`
- Modify: `integrations/stardew/BridgeSession.cs`
- Modify: `integrations/stardew/ModEntry.cs`
- Modify: `host/src/local-stardew-bridge.ts`
- Modify: `host/src/protocol.ts`
- Create: `host/src/stardew-world-map-tools.ts`
- Modify: `host/src/game-tools.ts`, `host/src/stardew-integration-module.ts`
- Test: Create `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/WorldMapProjectionTests.cs`
- Test: Create `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NavigationReadOnlySessionTests.cs`
- Test: Create `host/src/stardew-world-map-tools.test.ts`
- Test: Modify `host/src/local-stardew-bridge.test.ts`
- Create: `tools/replay-stardew-world-map-operation.mjs`

**Interfaces:**
- `DerivedDestinationSet.CreateCurrent()` is game-thread-only and returns one immutable generation snapshot built from `Data/Locations`, `Data/WorldMap`, explicit content metadata, current world existence, native condition/KnownCondition and token results.
- `NavigationReadOnlyService.Inspect(...)` returns `InspectWorldMapResult`; it emits no execution receipt and never writes player/game state.
- `BridgeSession.TryNavigationRead(...)` must require authenticated current generation, exact envelope/scope/timestamp, owner thread, current read-only capability and current source generation.

- [x] **Step 1: Write projection tests before implementation.**

  Cover these exact assertions:

  ```csharp
  [Fact]
  public void Root_FlattensUnlabeledValleyAndGingerIslandContainers()
  {
      // Given two unlabeled structural root containers with effective area children.
      // Then neither internal dictionary key is present in the public result.
      Assert.DoesNotContain(result.Entries, entry => entry.Label is "Valley" or "GingerIsland");
      Assert.All(result.Entries, entry => Assert.True(entry.NodeRef is not null || entry.Destination is not null));
  }

  [Fact]
  public void LabeledSingleton_IsFolded_ButLabeledBranchIsReturned()
  {
      // A label-bearing one-child group is skipped; a two-child group becomes the frontier.
  }
  ```

  Add vectors for: a destination that is both expandable/navigable (one entry containing both fields), duplicate labels requiring `contextLabel + ref`, an unresolved leaf that is omitted, `nextCursor` only when a 21st valid frontier item exists, and a long valid label that would exceed 4096 bytes producing `world_map_projection_too_large` rather than a truncated selector.

- [x] **Step 2: Run projection tests red.**

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~WorldMapProjectionTests|FullyQualifiedName~NavigationReadOnlySessionTests"
  ```

  Expected: tests fail because no derived set/projection/read-only service exists.

- [x] **Step 3: Implement derivation and folded projection in the Mod.**

  Create one current `DerivedDestinationSet`; do not build a Host catalog or infer identity from tooltip text. Join only explicit source-proven canonical location identity. Apply current native condition/KnownCondition evaluation before projection. Treat source records with no legal display label as structural-only; transparently flatten them whether one or many exist. Then fold only labeled groups with exactly one effective child.

  Issue label selectors only when the current canonical label is unique in the current generation. Issue a destination ref for aliases, duplicate labels, owner collisions or any non-provably-unique presentation. Build public DTOs, serialize strictly and measure UTF-8 bytes before signing/returning an executable selector; never truncate a label.

- [x] **Step 4: Add the minimal authenticated request/result bridge path.**

  In `BridgeSession`, add a read-only method with this gate order:

  ```text
  authenticated generation
  → exact envelope and full scope
  → owner game thread
  → live published read-only capability
  → strict request union
  → fresh DerivedDestinationSet creation/read
  → typed result
  → correlated navigation_read_result envelope
  ```

  In `ModEntry`, add a dedicated `HandleNavigationRead` branch and response serializer. It must not call `TryExecute`, `FarmhandActionRouter.TryRoute`, `ExecutionManager`, or the receipt event publisher. In the Host client, correlate it exactly like a solicited response but exclude it from unsolicited execution-fact listeners.

- [x] **Step 5: Materialize one explicit Host inspect tool.**

  `stardew_inspect_world_map` accepts a TypeBox strict union matching Task 3. Before bridge write, it re-reads the authenticated live Mod read-only capability and matching catalog/snapshot revision; it refuses missing/revoked/stale capability and does not capture an execution admission at mount time. Its output is exactly the Mod result JSON. It does not append source lineage/audit data, call `stardew_observe`, or use an execution tool factory.

  **2026-08-22 partial completion evidence:** Steps 1–5 materialize only the inspect-only chain. `DerivedDestinationSet.TryCreateCurrent` runs in the Mod game-thread request path, derives candidates only from current native `MapRegion.GetAreas()` / `MapArea.GetWorldPositions()` source-correlated locations, and obtains the public label only through the target-native `MapRegion.GetLocationName(GameLocation)` resolver. It never projects raw location/map keys, positions, routes, tooltip text, condition text, source lineage, or gameplay state. `WorldMapProjection` implements structural flattening, singleton folding, 20-entry / 4096-byte bounds, opaque node/cursor refs, duplicate label ref selection, and a cursor frontier digest. `BridgeSession.TryNavigationRead` is a separate correlated read-only route and checks authenticated generation, envelope/scope/timestamp, owner game thread, live Mod read-only publication, then builds a fresh set and emits only `navigation_read_result`; it never uses the execution manager, router, receipt or completion pipeline. `ModEntry` adds the matching request branch; the local Host client correlates it as a solicited non-fact response; the explicit Host tool mounts only from a matching current read-only registration/capability/snapshot and returns the exact result.

  Focused evidence currently obtained:

  ```text
  dotnet build integrations/stardew/GameBuddy.Stardew.csproj -p:GamePath=E:/temp/gamebuddy-stardew-ai-client --no-restore
  # 0 warnings, 0 errors
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj --no-restore -p:GamePath=E:/temp/gamebuddy-stardew-ai-client
  # 19 passed, 0 failed
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj --no-restore -p:GamePath=E:/temp/gamebuddy-stardew-ai-client --filter "FullyQualifiedName~BridgeProtocolSerializationTests"
  # 13 passed, 0 failed
  pnpm --filter @gamebuddy/companion-host typecheck
  # passed
  pnpm --filter @gamebuddy/companion-host build:test && node --test host/dist-test/game-tools.test.js host/dist-test/local-stardew-bridge.test.js host/dist-test/protocol.test.js host/dist-test/schema-contract.test.js
  # 59 passed, 0 failed (before the later focused inspect-tool test was queued behind an active artifact lock)
  ```

  **2026-08-22 completion evidence:** Steps 1–5 above have now been re-run with the final mounted-tool pre-write capability withdrawal gate. `NavigationReadOnlySessionTests` adds a real `BridgeSession` authentication/request path that proves a current Mod-owned `inspect_world_map` publication succeeds only on the authenticated generation, a withdrawn read-only capability is rejected as `operation_not_available`, and neither success nor denial creates an execution receipt. The Host tool re-reads the live registration/capability/snapshot revision immediately before `navigationRead`, so a withdrawal after tool mounting rejects with `bridge_capability_not_ready` before bridge write. This still does not close `find_destination`'s own focused correctness/replay gate or any P5 Navigation mutation.

- [x] **Step 6: Add real-shaped replay and run focused checks.**

  `tools/replay-stardew-world-map-operation.mjs` must feed captured redacted valid/invalid bridge frames into the actual TS parser/client and assert correlation, no receipt classification, no extra keys and expected error/result union.

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~WorldMapProjectionTests|FullyQualifiedName~NavigationReadOnlySessionTests"
  pnpm --filter @gamebuddy/companion-host typecheck
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/stardew-world-map-tools.test.js host/dist-test/local-stardew-bridge.test.js
  node tools/replay-stardew-world-map-operation.mjs
  ```

  Expected: successful inspect has no `executionId`, `receipt`, evidence or completion projection; every stale/forged/cross-scope node/cursor and missing/revoked admission fails closed.

  **2026-08-22 focused verification:**

  ```text
  dotnet test ...Integration.Tests --filter "...WorldMapProjectionTests|...NavigationReadOnlySessionTests|...NavigationReferenceStoreTests|...BridgeSessionPublicationTests"
  # 13 passed, 0 failed
  pnpm --filter @gamebuddy/companion-host build:test && node --test host/dist-test/stardew-world-map-tools.test.js host/dist-test/game-tools.test.js host/dist-test/local-stardew-bridge.test.js host/dist-test/protocol.test.js host/dist-test/schema-contract.test.js
  # 62 passed, 0 failed
  node tools/replay-stardew-world-map-operation.mjs
  # {"state":"world_map_replay_completed","validation":{"valid":true,"mutationCount":0,"executionReceiptCount":0}}
  git diff --check <Task-4 scoped paths>
  # passed
  ```

  An independent review remains required before treating Task 4 as formally closed. The next permitted implementation task is `find_destination`; Navigation mutation remains separately gated.

## Task 5: Materialize `find_destination` from Current Source-Derived Destinations

**Prerequisite:** Tasks 2–4's read-only publication, typed route and `DerivedDestinationSet` are materialized. Search has no external corpus or attestation prerequisite: its bounded behavior is established by source-derived, synthetic focused regression cases and package/runtime validation.

**Files:**
- Modify: `integrations/stardew/GameBuddy.Stardew.csproj`
- Create: `integrations/stardew/Navigation/DestinationSearch.cs`
- Modify: `integrations/stardew/Navigation/NavigationReadOnlyService.cs`
- Create: `host/src/stardew-destination-search-tools.ts`
- Modify: `host/src/game-tools.ts`, `host/src/stardew-integration-module.ts`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/DestinationSearchTests.cs`
- Create: `host/src/stardew-destination-search-tools.test.ts`
- Create: `tools/replay-stardew-destination-search-operation.mjs`
- Verify: focused synthetic regression cases, target package restore/load, protocol/schema parity, and a no-mutation replay.

**Interfaces:**
- `DestinationSearch.Find(DerivedDestinationSet set, string query, NavigationBindingContext context)` returns the exact `FindDestinationResult` union.
- Input normalization preserves Unicode/CJK and accepts 1–128 Unicode scalar values after NFKC. It rejects blank, control, coordinate, path and raw map/action-shaped inputs.
- Exact current locale/fallback/explicit alias may return `resolved`; ambiguous exact and every non-exact result returns no more than three `candidates`; otherwise `not_found`.

- [x] **Step 1: Write package/load and result-shape tests.**

  Add tests with synthetic labels proving:

  ```csharp
  Assert.Equal("exact_current_locale", exact.Reason);
  Assert.Equal("resolved", exact.Status);
  Assert.Equal("candidates", nonExact.Status);
  Assert.InRange(nonExact.Candidates.Count, 1, 3);
  Assert.Equal("not_found", lowConfidence.Status);
  Assert.Equal("destination_search_invalid", invalid.Status);
  ```

  Add test vectors for NFKC full-width punctuation, CJK preservation, exact fallback, explicit alias, same-label ambiguity, a tied fuzzy pair, a below-policy result and control/path/coordinate strings. Assert non-exact never returns `resolved`, scores never enter the DTO, and each candidate has exactly one selector.

- [x] **Step 2: Run the tests red.**

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~DestinationSearchTests"
  ```

  Expected: failing compilation until the selected dependency and typed search service are present.

- [x] **Step 3: Add only the approved dependency and implement the frozen pipeline.**

  Add exactly:

  ```xml
  <PackageReference Include="Raffinert.FuzzySharp" Version="5.0.3" />
  ```

  to `GameBuddy.Stardew.csproj`. Implement only this pipeline:

  ```text
  validate scalar shape
  → NFKC
  → invariant case fold where applicable
  → whitespace/punctuation fold without deleting CJK characters
  → exact current locale
  → exact fallback locale
  → exact explicit alias
  → deterministic prefix/contains feature
  → Raffinert.FuzzySharp bounded score
  → stable top-three candidates
  ```

  Store threshold, tie and margin constants in one private versioned policy type. Do not expose them in a result. If runtime package restore/load fails, leave capability unpublished and stop rather than adding a fallback matcher.

- [x] **Step 4: Wire it through the existing read-only service and an explicit Host tool.**

  Route `find_destination` through `navigation_read_request`, with live read-only-capability and fresh pre-write-admission checks identical in strength to inspect. `stardew_find_destination` has only `{ query }` parameters and returns exactly the Mod result. It must not echo the query, pick a candidate, invoke navigation, or create a receipt.

- [x] **Step 5: Run focused correctness, packaging and replay checks.**

  Run:

  ```powershell
  dotnet build integrations/stardew/GameBuddy.Stardew.csproj --no-restore -p:StardewGamePath=E:/temp/gamebuddy-stardew-ai-client
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~DestinationSearchTests|FullyQualifiedName~NavigationReadOnlySessionTests"
  pnpm --filter @gamebuddy/companion-host typecheck
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/stardew-destination-search-tools.test.js host/dist-test/local-stardew-bridge.test.js
  node tools/replay-stardew-destination-search-operation.mjs
  pnpm dependency-audit
  ```

  Expected: package loads on the target build and exact/non-exact behavior stays bounded.

  **2026-08-23 completion evidence:** `find_destination` is now a Mod-owned
  read-only operation over the current `DerivedDestinationSet`, with exact
  current/fallback/alias resolution and bounded `Raffinert.FuzzySharp` ranking.
  Its wire union contains only `resolved`, `candidates`, `not_found`, `invalid`,
  or `blocked`; candidates contain a label, optional context label, and
  label-or-opaque-ref selector—never a query, score, internal identity,
  unlock state, receipt, or execution evidence. Find results have their own
  3-candidate / 2 KiB UTF-8 ceiling; inspect remains 20 entries / 4 KiB.
  The Host tool independently rechecks live Mod read-only publication just
  before its bridge request. Verification: Mod build 0 warnings / 0 errors;
  Core protocol suite 19 passed; destination/read-only/reference/projection
  Integration suites 29 passed; Host typecheck/build and protocol/schema/world
  map focused suites 33 passed; both find and inspect no-mutation replays report
  `valid: true`, `mutationCount: 0`, and `executionReceiptCount: 0`. Target
  runtime direct gate and Navigation mutation remain outside this completion.

## Task 6: Complete the Read-Only P4E Gate

**Files:**
- Create: `tools/stardew-navigation-read-only-direct-gate.mjs`
- Create: `tools/replay-stardew-navigation-read-only-gate.test.mjs`
- Modify: focused inspect/find Mod and Host tests as needed.

**Contract:** per-result limits are enforced by the Mod before a result is published: inspect has at most 20 entries and 4096 UTF-8 bytes; find has at most 3 candidates and 2048 UTF-8 bytes. Host performs restrictive typed projection and live pre-write capability admission only. It does not maintain a task, epoch, cursor, occurrence, call-count, or byte quota.

- [x] **Step 1: Remove the historical cumulative budget.**

  `NavigationDisclosureBudget`, its factory, task/control-epoch wiring, exhaustion result codes, and focused tests were removed. This was a product gameplay quota, not a context safety boundary. Repeated valid reads and cursor continuations remain available while the source-owned per-result contracts are satisfied.

- [x] **Step 2: Prove fresh pre-write admission for both tools.**

  Focused `host/src/stardew-world-map-tools.test.ts` fault-injection tests withdraw the live read-only capability after tool mounting but before `execute()`. Both `stardew_inspect_world_map` and `stardew_find_destination` return `bridge_capability_not_ready` before any bridge write; neither captures an admission object across invocations.

- [x] **Step 3: Run the complete direct read-only gate.**

  `tools/stardew-navigation-read-only-direct-gate.mjs` authenticates the target-version non-mutating fixture, invokes valid inspect/find requests, rereads the unchanged source/world revision after each result, injects malformed references and invalid queries, proves a distinct-scope hello is rejected, withdraws the capability and proves both mounted tool operations fail before a bridge write, then asserts zero player mutations and zero execution receipts. `tools/replay-stardew-navigation-read-only-gate.test.mjs` deterministically tests the runner's control flow; `tools/run-stardew-native-local-player-navigation-read-only-fixture.ps1` runs the direct gate against the target-runtime fixture.

  **2026-08-23 completion evidence:** The target-version fixture direct gate passed using the current production Host artifact and the Mod built from this tree. Its terminal report was `navigation_read_only_direct_gate_completed`, with unchanged before/after observations across root inspection, continuation, find, and reconnect; malformed reference and invalid query were rejected; a foreign scope was rejected; withdrawal made both mounted tools fail with `bridge_capability_not_ready` before a bridge write; and `mutationCount: 0`, `executionReceiptCount: 0`. The runner restored the managed Mod bundle/config, removed its transaction backup, removed the working save, and left no Stardew/SMAPI process. Supporting focused verification also passed: Core Navigation 16 tests, Integration Navigation 7 tests, isolated Host local bridge 12 tests, read-only gate replay, named-pipe readiness 3 tests, fixture helper 18 tests, Host typecheck/build, Mod Release build (0 warnings / 0 errors), and `git diff --check`. A full Host-suite attempt exceeded its external 10-minute harness timeout and was stopped; it is not counted as evidence.

## Task 7: Materialize `navigate_to_destination` Admission, Preflight and One Execution Lifecycle

**Prerequisite:** Tasks 2–6 are green; P4E admission record is `ready_for_p5: true`; a target-version non-mutating transition characterization records, for the **current loaded source location only**, the observed non-NPC `GameLocation.warps` candidates and `location.doors.Pairs` candidates resolved through exact `GameLocation.getWarpFromDoor(point, currentPlayer)`, aggregate permitted/excluded family facts, opaque IDs for observed source candidates, a static `Player.Warped` API-shape proof, and a fixture cleanup verdict. This zero-mutation artifact does **not** prove a full source→Mine tracer, a canonical full route, or causal correlation with any future warp. Until that artifact is positive, Task 7 is blocked: no production execution ID, route planner, Navigation coordinator, Host mutation tool, or lifecycle tests that invent an access taxonomy may be introduced. This task still performs **no target-game mutation**.

**Frozen successor prerequisite — source-only transition characterization:**

```text
Scenario: characterize the current source transition seam without dispatching it
  Given target Stardew 1.6.15 build 24356 and the managed native-local fixture
  When a probe enumerates every non-NPC current GameLocation.warps candidate and
       each current location.doors.Pairs candidate via exact
       GameLocation.getWarpFromDoor(point, currentPlayer), and statically proves
       the SMAPI helper.Events.Player.Warped / WarpedEventArgs Player,
       OldLocation, NewLocation API shape
  Then it records only target binding, method-bound API anchors, opaque IDs for
       observed source candidates, permitted/excluded family counts, the static
       API-shape correlation flag, and pass/fail predicates; it never calls or
       observes a future warp, and player/world state and execution-receipt
       counts remain unchanged.
```

The characterization is strictly source-only and must not call or observe any
future warp. It must fail closed when a candidate requires `Action`,
`TouchAction`, a mod hook, a special/M8 transition, missing identity, or an
approach that cannot be dry-planned without assigning a player controller.
It must not serialize route/location keys/tiles/labels to an Agent-facing surface,
publish an action, call `warpFarmer`, assign `Game1.player.controller`, create an
execution receipt, or use direct player/save mutation. Later Task 7 execution,
if admitted, must dynamically revalidate its current source and the exact
transition immediately before each commit; unknown state fails closed. There is
no hop/replan gameplay quota. The owner writes its redacted artifact and
deterministic validator before reopening Task 7.

**Files:**
- Create: `integrations/stardew/Navigation/NavigationExecutionCoordinator.cs`
- Create: `integrations/stardew/Navigation/NavigationRoutePlanner.cs`
- Modify: `integrations/stardew/ExecutionManager.cs`
- Modify: `integrations/stardew/ExecutionManager.MovementHandlers.cs`
- Modify: `integrations/stardew/StardewBodyController.cs`
- Modify: `integrations/stardew/BridgeSession.cs`, `integrations/stardew/ModEntry.cs`
- Modify: `host/src/action-registry.ts`, `host/src/game-tools.ts`, `host/src/stardew-integration-module.ts`, `host/src/protocol.ts`
- Create: `host/src/stardew-navigation-tools.test.ts`
- Create: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NavigationExecutionCoordinatorTests.cs`
- Create: `tools/replay-stardew-navigation-operation.mjs`
- Create: `tools/stardew-navigation-topology-preflight.mjs`
- Create: `tools/preflight-stardew-navigation-agent-live.mjs`

**Interfaces:**
- Public executable request remains the existing execution envelope:

  ```ts
  { action: "navigate_to_destination", args: { destination: DestinationSelector }, requestId, idempotencyKey, expectedRevision, deadlineMs }
  ```

- `NavigationExecutionCoordinator` owns the sole external receipt and terminal CAS. It accepts a validated `NavigationDestinationBinding`; local movement and each native transition return internal leg/transition outcomes only.
- The body controller gains an owner-neutral internal local-leg completion callback/result. It must not emit public `move_to_tile` receipts for Navigation legs or create a second body controller.

- [ ] **Step 1: Write failing lifecycle tests.**

  Cover the frozen terminal taxonomy at minimum:

  ```csharp
  AssertTerminal("destination_selector_invalid");
  AssertTerminal("destination_selector_ambiguous");
  AssertTerminal("destination_selector_stale");
  AssertTerminal("destination_locked");
  AssertTerminal("destination_temporarily_unavailable");
  AssertTerminal("destination_access_indeterminate");
  AssertTerminal("destination_unreachable");
  AssertTerminal("path_not_found");
  AssertTerminal("native_transition_uncertain");
  ```

  Add lifecycle cases for already-at-destination, cancelled during a local leg, deadline before transition commit, policy revocation before replan, controller replacement, location drift, one edge commit maximum, exact idempotent replay and terminal fresh canonical-location mismatch. Assert that no hop/replan-count terminal exists: a valid task continues only while fresh source facts yield a route and ends only through deadline, authenticated STOP/cancel, real impossibility, runtime terminal failure, surface closure, or an already-attempted edge. Assert no successful terminal without non-empty evidence and fresh same-destination postcondition.

- [ ] **Step 2: Run lifecycle tests red.**

  Run:

  ```powershell
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~NavigationExecutionCoordinatorTests"
  ```

- [ ] **Step 3: Implement selector admission and private route planning.**

  In `BridgeSession.TryExecute`, retain the ordinary gate order, add the exact typed `navigate_to_destination` args shape to C#/TS/schema validation, and call the game-thread router only after fresh selector resolution. Label resolution requires a unique current canonical match; ref resolution requires a valid current private binding. Return `destination_selector_ambiguous` rather than choosing a label collision.

  `NavigationRoutePlanner` may derive a bounded graph only from characterized live native warp/door/approved transition facts. It returns private canonical edges and never serializes the graph, route, tile or source identity to Host/Agent. Unknown action/touch-action/mod-hook/special-transition family is absent from the graph and yields a truthful terminal rather than a fallback native call.

- [ ] **Step 4: Implement one coordinator-owned per-hop lifecycle.**

  Follow exactly:

  ```text
  admission + validated binding
  → initial bounded route
  → checkpoint before local controller arm
  → internal PathFindController local-leg result
  → checkpoint before one approved transition commit
  → exact same-execution location-change correlation
  → post-transition fresh reread
  → discard old suffix and replan only while fresh source facts yield a route
  → fresh final canonical destination reread
  → one terminal receipt CAS
  ```

  Before every arm/commit check scope, live capability/policy, revision/idempotency, deadline/cancel, player actionability, body ownership, current location/edge, generation and binding. A potentially side-effected but uncorrelated transition must terminalize `native_transition_uncertain`; it cannot replan or retry. Preserve partial movement and stop.

- [ ] **Step 5: Add one explicit Host mutation tool without primitive composition.**

  Add `stardew_navigate_to_destination` with only the strict label-or-ref `DestinationSelector` plus existing optional request identity fields. Use the existing execution wrapper's fresh pre-write admission/correlation path, but add an action-specific `toArgs` adapter and receipt parser/evidence predicate. Do not expose public `move_to_tile`, `travel` or `enter_exit` as its implementation; do not describe a `destinationRef` as permission.

- [ ] **Step 6: Build non-mutating replay and preflight.**

  `tools/replay-stardew-navigation-operation.mjs` replays real-shaped accepted/running/terminal frames and asserts one correlation/terminal outcome. `tools/stardew-navigation-topology-preflight.mjs` validates target version/build, permitted transition-family source facts and route derivation without dispatch. `tools/preflight-stardew-navigation-agent-live.mjs` additionally checks frozen prompts, exact mounted tool surface, fixture Given, no M8 invocation path, parser replay, postcondition reader and verified teardown path.

  Run:

  ```powershell
  dotnet build integrations/stardew/GameBuddy.Stardew.csproj --no-restore -p:StardewGamePath=E:/temp/gamebuddy-stardew-ai-client
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter "FullyQualifiedName~NavigationExecutionCoordinatorTests"
  pnpm --filter @gamebuddy/companion-host typecheck
  pnpm --filter @gamebuddy/companion-host build:test
  node --test host/dist-test/stardew-navigation-tools.test.js host/dist-test/local-stardew-bridge.test.js
  node tools/replay-stardew-navigation-operation.mjs <frames.json>
  node tools/stardew-navigation-topology-preflight.mjs --game-path E:/temp/gamebuddy-stardew-ai-client
  node tools/preflight-stardew-navigation-agent-live.mjs --transition-artifact <transition-artifact.json> --replay-frames <frames.json>
  ```

  Expected: all are non-mutating. Any missing proof/preflight item is a blocker; do not launch Stardew for mutation.

  **Non-mutating preflight boundary (frozen).** The Task 7 preflight package is `tools/replay-stardew-navigation-operation.mjs`, `tools/stardew-navigation-topology-preflight.mjs` and `tools/preflight-stardew-navigation-agent-live.mjs` (with their `.test.mjs`). These three executable checks are strictly non-mutating: they never launch Stardew, never connect a named pipe, never write fixtures/profiles/config, never call `execute()`, never publish a receipt, and never create or mutate a target artifact. Target transition proof is accepted **only** from a caller-supplied JSON artifact that passes existing `validateTransitionCharacterization` AND `allowsTransitionImplementation`; that runtime proof is never reconstructed or inferred from source, fixtures, or doc/session prose, and no target artifact is ever fabricated in-repo.

### Task 7 recovery status — direct-only P1 (2026-08-23)

The implementation and deterministic preflight work documented above were reviewed as a **direct ordinary-warp tracer slice**, not as a released Navigation V1 lifecycle. Aggregate review found a P1: `NavigationLifecycle.Decide` selects only an ordinary edge whose target is already the final canonical destination, and `ExecutionManager` terminalizes a correlated non-final arrival instead of fresh reread/replan. This contradicts the authority in design/36: a valid Navigation task must progress through private per-hop revalidation/replanning without a hop/replan-count terminal.

Accordingly:

```text
Task 7 Navigation V1: blocked — direct_only_lifecycle_not_multihop_navigation
Task 8 mutation gate: prohibited
source-only transition artifact: cannot authorize multi-hop execution
```

Scope gate: `tools/stardew-navigation-topology-preflight.mjs` now requires an explicit `requestedNavigationScope` input. When `multi_hop_ordinary_warp` is requested, a `current_source_only` artifact is blocked with `transition_scope` / `current_source_only_cannot_authorize_multi_hop`. This gate ensures no static source-only proof can authorize a multi-hop release claim.

The direct slice remains a tested first-leg foundation only: selector admission, one receipt/ledger lineage, controller-release ordering, exact source→target correlation, safe approach selection, trace suppression, strict selector contract, and deterministic replay/preflight fail-closed behavior remain valid. It does **not** authorize public/released `navigate_to_destination`, target artifact regeneration, or a live mutation.

The recovery authority is [`94_STARDEW_NAVIGATION_MULTIHOP_RECOVERY_IMPLEMENTATION_PLAN.md`](94_STARDEW_NAVIGATION_MULTIHOP_RECOVERY_IMPLEMENTATION_PLAN.md). It requires a private fresh-per-hop planner/coordinator under the same manager-owned receipt, scope-bound multi-source target characterization, a new aggregate review, and only then a separately admitted Task 8 decision.

## Task 8: Run the Single Serial P5 Formal Gate and Record Operation-Specific Evidence

**Prerequisite:** independent reviewer has inspected the complete multi-hop recovery Tasks 1–7 in design/94, declares no blocker, and the scope-bound Task 7 preflight report is fully green from an explicitly supplied validated multi-hop artifact. This is the only task allowed to consume the Navigation target-game mutation gate.

**Files:**
- Create: `tools/run-stardew-navigation-p5-live.mjs`
- Create: `tools/run-stardew-navigation-p5-live.test.mjs`
- Create: `design/review/93_STARDew_NAVIGATION_V1_P5_CLOSURE_RECORD.md`
- Modify only when a non-mutating replay proves a runner defect: `tools/lib/stardew-native-smoke-harness-v1.*` and its focused tests.

**Interfaces:**
- Runner owns profile transaction, exact target launch/attachment, tool invocation transcript capture, result/receipt correlation, post-operation rereads, restore and residual process checks.
- The closure record separates formal contract verdict from empirical-use verdict:

  ```text
  inspect: direct formal verdict
  find: direct formal verdict + used_and_consumed | used_not_consumed | not_invoked | failed_to_resolve | misresolved
  navigate: one same-execution receipt/evidence/fresh-postcondition verdict
  ```

- [ ] **Step 1: Write runner parser/teardown tests first.**

  Use fixed redacted fixtures to require:

  ```text
  - exact target build and one SMAPI root;
  - one authenticated ordinary Farmhand bridge scope;
  - every tool invocation/result captured before scoring;
  - no raw query, exact hidden target label, internal key, coordinates, route or ref in shared output;
  - no Navigation success when receipt/evidence/fresh postcondition are not all present;
  - teardown/restore failure overrides every claimed pass.
  ```

  Add a case where an accepted/running receipt arrives but no terminal success: scorer must report it as incomplete, never succeeded.

- [ ] **Step 2: Run runner tests red.**

  Run:

  ```powershell
  node --test tools/run-stardew-navigation-p5-live.test.mjs
  ```

- [ ] **Step 3: Implement the frozen serial scenario batch.**

  The runner executes only after all preflight predicates are loaded and checked. It performs these scenarios serially in one controlled transaction:

  ```text
  I: Agent invokes inspect root/branch/cursor as needed; each result must have a fresh read-only source reread and no receipt.
  F: Agent attempts a realistic non-exact short lexical query; record formal result and whether it is consumed by Navigation.
  N: Agent obtains a selector and invokes navigate; verify one execution's terminal succeeded,
     non-empty evidence, and fresh canonical G1 arrival.
  Mine composition: a frozen ordinary Farm-start prompt may use the player-visible Mine name;
     Agent reaches Mine exterior only and no M8 action is invoked.
  ```

  Add one non-Mine non-exact scenario so Mine exact success cannot replace search/map value evidence. Prompts may not leak coordinates, route, internal name/key or an exact destination label, except the explicitly allowed Mine player-visible name.

- [ ] **Step 4: Execute the formal live gate exactly once.**

  Run:

  ```powershell
  node tools/run-stardew-navigation-p5-live.mjs --game-path E:/temp/gamebuddy-stardew-ai-client
  ```

  On any harness/protocol/scorer failure, preserve its redacted failure record, restore/teardown, repair offline and re-run only after a changed hypothesis and a new independent review. Do not use a second mutation merely to compensate for missing verification.

- [ ] **Step 5: Write the closure record and determine the truthful release state.**

  The record must name the producer → consumer → verifier for every claimed operation, actual tool-call counts, `find` empirical verdict, exact receipt/postcondition evidence path, restore/teardown result and residual risks.

  Apply these rules:

  ```text
  inspect is closed only by its own target observation gate.
  find has demonstrated product value only when direct formal search passes and at least one
  realistic Agent scenario is used_and_consumed; otherwise report formal_only_no_empirical_use.
  navigate is live-closed only by its own same-execution succeeded receipt + non-empty
  evidence + fresh canonical postcondition.
  A shared scenario never closes an uninvoked operation and never closes any M8 action.
  ```

## Task 9: Final Parity, Review, and Documentation Closure

**Files:**
- Modify: `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md` only to replace its materialization status with evidence-backed results.
- Modify: `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` only at P4/P5 status/checklist locations.
- Modify: `design/README.md` to index the plan and closure record.
- Verify: all Task 2–8 owned code/tests and `protocol/bridge-v1.schema.json`.

**Interfaces:**
- Produces no new runtime feature. It verifies the completed implementation still matches design/36's contracts, design/38 P4/P5 gates and the plan's exact boundaries.

- [ ] **Step 1: Run the structural parity suite.**

  Run:

  ```powershell
  dotnet build integrations/stardew/GameBuddy.Stardew.csproj --no-restore -p:StardewGamePath=E:/temp/gamebuddy-stardew-ai-client
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests
  pnpm --filter @gamebuddy/companion-host typecheck
  node tools/check-stardew-action-promotion.mjs
  pnpm test:stardew-action-projection
  git diff --check HEAD
  ```

  Any type/schema/publication mismatch blocks closure. Do not weaken a negative test to make a parity command pass.

- [ ] **Step 2: Perform an independent review against the actual diff.**

  The reviewer must answer, with file/line evidence:

  ```text
  1. Are all three identities published by Mod policy and only restrictively mounted by Host?
  2. Can inspect/find reach execution ledger, receipt, authoritatively_completed, or snapshot dump?
  3. Can Host/Agent choose map/tile/route/native member or forge/interpret a ref?
  4. Are Valley/GingerIsland internal keys excluded, unlabeled containers flattened and nextCursor correct?
  5. Is FuzzySharp exactly 5.0.3, its source-derived lexical policy bounded, and its package/runtime load verified?
  6. Does Navigation have one body owner/receipt, fresh per-hop revalidation and uncertain-transition stop?
  7. Does Mine arrival stop exterior and avoid all M8 actions?
  ```

  A `no` or unproven answer is a blocker, not a documentation caveat.

- [ ] **Step 3: Update status only from verified evidence.**

  Record P4E/P5 status with artifact paths and dates. Do not claim global navigation, arbitrary destinations, complete search value, M8 composition or player-facing UI. If `find` is not `used_and_consumed`, retain `formal_only_no_empirical_use` rather than marking the complete batch closed.

- [ ] **Step 4: Perform the final boundary scan.**

  Run:

  ```powershell
  rg -n "destination_not_available|8 entries|2 KiB|48 occurrences|12 KiB|Valley.*Agent|GingerIsland.*Agent" design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md
  rg -n "TODO|TBD|implement later|fill in details" design/93_STARDEW_NAVIGATION_V1_IMPLEMENTATION_PLAN.md
  ```

  Expected: no output. If a historically quoted string must remain, rewrite it as a precise non-contract historical statement rather than leaving an executable-looking stale contract.

## Self-Review

### Spec coverage

| Frozen requirement | Plan task(s) |
|---|---|
| K2 + G1, label-or-ref selector, no string fallback | 2, 3, 4, 5, 7, 9 |
| Current Mod-owned derived set; no Atlas/Host catalog | 4, 5, 7, 9 |
| `Valley`/`GingerIsland` internal-key suppression and folded frontier | 4, 9 |
| 20 / 4 KiB inspect page, 3 / 2 KiB find result, `nextCursor` | 4, 5, 6, 9 |
| Typed authenticated read-only route distinct from snapshot/receipt | 3, 4, 5, 6 |
| FuzzySharp 5.0.3 + no weak fallback + package/runtime load validation | 5, 9 |
| Ref binding/TTL/scope/generation negatives | 3, 4, 5, 7 |
| Fresh pre-write admission for every tool | 4, 5, 6, 7 |
| One Mod-owned native navigation execution and uncertainty semantics | 7, 8, 9 |
| Mine exterior boundary and independent M8 preservation | 7, 8, 9 |
| Formal preflight, one serial live gate, truthful empirical search outcome | 7, 8, 9 |

No frozen design/38 P4/P5 requirement is intentionally omitted. Search is bounded by the Mod-owned source-derived directory, deterministic lexical policy, package/runtime load validation, and focused regressions; no separate corpus authority is required.

### Placeholder scan

This plan has no unassigned implementation step or deferred design decision. Each task names exact files, closed interface shapes, inputs/outputs, negative cases and executable checks.

### Type consistency

- Task 2 defines published operation categories and separate `ContainsGameAction` / `ContainsReadOnlyOperation` predicates.
- Task 3 defines `NavigationReadRequest`, `DestinationSelector`, typed result unions and `NavigationReferenceStore` resolution methods.
- Task 4/5 consume the same reference/destination types through `NavigationReadOnlyService`.
- Task 6 verifies Mod-owned per-result limits and Host restrictive typed projection without introducing cumulative accounting.
- Task 7 consumes `DestinationSelector` through the existing typed `execution_request` envelope and produces one ordinary execution receipt; it does not reuse the read-only result type as mutation evidence.

## Execution Handoff

Plan complete and saved to `design/93_STARDEW_NAVIGATION_V1_IMPLEMENTATION_PLAN.md`. Execute it now?

**Subagent-Driven (project path):** dispatch one fresh subagent per task using `subagent-driven-development`, with the frozen slice card, a single shared integration writer for hub files, focused checks after every changed seam, and one independent post-batch review. Do not launch a mutation-capable task until the read-only direct gate and non-mutating navigation preflight are complete.
