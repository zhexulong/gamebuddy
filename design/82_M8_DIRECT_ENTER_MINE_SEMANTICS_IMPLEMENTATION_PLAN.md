# M8 Direct Enter Mine Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the published `enter_mine` action directly invoke the normal Mine-exterior native transition `Game1.enterMine(1)` without hidden navigation or UI-ingress pose requirements.

**Architecture:** `enter_mine` retains its bounded typed request, game-thread authorization, native warp correlation, terminal receipt, and fresh floor-1 reread. The adapter removes action-private movement, producer-grab-tile gating, and approach pending state: the only mutation edge is the fixed native call after a fresh Mine-exterior and runtime-state recheck. The setup fixture establishes only the Mine-exterior context; it no longer writes position/facing or proves UI interaction geometry.

**Tech Stack:** C# target-bound Stardew Mod (`net6.0`), Node.js ESM Portfolio runners/tests, TypeScript Host protocol, Stardew Valley `1.6.15` build `24356`.

**Spec:** `design/80_M8_ENTER_MINE_ACTION_IMPLEMENTATION_PLAN.md`, `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`, and the user-approved direct-native semantics recorded in this session.

## Global Constraints

- `enter_mine` remains Mine exterior → MineShaft floor 1 and does not own Farm-to-Mine navigation.
- `Game1.enterMine(1)` is the fixed normal-entry native seam; Agent does not supply a floor or layout parameter.
- No UI/input injection, direct action player position/facing writes, generic dispatch, raw coordinate input, direct action save modification, or native fallback. An isolated launcher-owned staged-save Given fixture may be used only under `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`; it cannot be called by `enter_mine`, write canonical saves, or contribute action receipts/evidence/results.
- Every mutation is re-authorized on the game thread for exact scope, policy, revision, deadline, cancellation, world/player state, Event/UI, and `CanMove`.
- The native edge remains arm-before-call and any indeterminate post-arm result remains `uncertain/native_operation_uncertain`.
- No target-version live mutation is permitted in this slice; a later formal gate needs fresh preflight, independent review, and one live action transaction.

---

### Task 1: Remove action-private approach from the Mod entry lifecycle

**Files:**
- Modify: `integrations/stardew/PortfolioMineEntrySemanticAdapter.cs`
- Modify: `integrations/stardew/PortfolioMineEntryActionCoordinator.cs`
- Modify: `integrations/stardew/PortfolioMineEntryActionProtocol.cs`
- Modify: `integrations/stardew/PortfolioIntegration.cs`

**Interfaces:**
- `RequestMineEntry(context, out result)` either reports deterministic pre-arm native failure or arms the exact execution and invokes `Game1.enterMine(1)`.
- `PortfolioMineEntryAdapterResult` has only one valid outcome flag: `TransitionArmed` or `NativeOperationFailed`.

- [ ] Replace the failing source contracts that permit `ApproachPending` with assertions that the entry adapter has no `PathFindController`, pending controller, watchdog, `GetGrabTile`, or `Action="Mine"` runtime admission.
- [ ] Run the source contracts and confirm they fail while the approach lifecycle exists.
- [ ] Delete the approach state and producer-pose helpers; re-admit only a fresh ordinary Mine exterior plus policy/state facts immediately before `ArmNativeTransition` and `Game1.enterMine(1)`.
- [ ] Remove entry watchdog dispatch and entry-specific `ApproachPending` protocol/coordinator branches.
- [ ] Run focused C# lifecycle and source contracts.

### Task 2: Align fixture, bridge projection, runners, and Host validation

**Files:**
- Modify: `integrations/stardew/PortfolioMineEntryGivenFixture.cs`
- Modify: `integrations/stardew/PortfolioMineEntryActionProtocol.cs`
- Modify: `integrations/stardew/PortfolioBridgeSession.cs`
- Modify: `host/src/portfolio-protocol.ts`
- Modify: `tools/run-stardew-portfolio-m8-entry-action.mjs`
- Modify: `tools/run-stardew-portfolio-m8-mine-route-action.mjs`
- Modify: affected tests under `tools/` and `host/src/`

**Interfaces:**
- Mine entry probe exposes no `entryInteractionAvailable` field.
- The fixture succeeds only after its own native Mine exterior warp and fresh exterior/world state confirmation; it does not modify player pose.
- Entry runners require correlated fresh Mine-exterior proof and fixed target floor `1`.

- [ ] Update wire schemas and tests to remove the interaction-ready observation field.
- [ ] Reduce fixture success to ordinary Mine exterior identity, removing all position/facing/grab/action-tile checks and mutations.
- [ ] Update runner source contracts so entry admission does not depend on interaction geometry.
- [ ] Run Host protocol, fixture lifecycle, and runner tests.

### Task 3: Verify the direct-native slice and record residual live work

**Files:**
- Modify: `design/80_M8_ENTER_MINE_ACTION_IMPLEMENTATION_PLAN.md`
- Modify: `design/81_M8_MINE_ENTRY_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`
- Verify: target-bound Mod output and focused suites

- [ ] Update design wording to distinguish UI `checkAction` provenance from typed direct native entry and remove private approach requirements.
- [ ] Build the target-bound Mod and run focused Host, C# lifecycle, M8 runner, launcher, and fixture checks serially.
- [ ] Run `git diff --check` and a fresh independent review of the post-write diff.
- [ ] Record that the old private-approach live result cannot close the corrected direct action; do not run a mutation in this slice.
