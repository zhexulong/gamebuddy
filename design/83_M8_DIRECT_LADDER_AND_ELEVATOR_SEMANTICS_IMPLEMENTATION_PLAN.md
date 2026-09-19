# M8 Direct Ladder and Elevator Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining M8 action semantics by making `use_mine_ladder` and `select_mine_elevator_floor` direct, independently evidenced native transitions without implicit movement or UI-ingress pose gates.

**Architecture:** Each action retains its existing typed request, Portfolio scope/binding lifecycle, game-thread revalidation, native `LocationRequest`/`Player.Warped` correlation, terminal receipt, and fresh-floor reread. Ladder derives exactly `currentFloor + 1` from a live `MineShaft` with a current Buildings-layer ladder tile `173`; elevator accepts only the existing typed, finite five-floor checkpoint request after live unlock/current-floor validation and a current Buildings-layer elevator tile `112`. Neither action reads UI, sends input, changes saves, moves the player, exposes raw `enterMine`, or inherits closure from the other action.

**Tech Stack:** Stardew Valley 1.6.15 build 24356; SMAPI; C#; TypeScript/Node test runner; existing Portfolio named-pipe bridge.

**Spec:** `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`, `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`, `design/80_M8_ENTER_MINE_ACTION_IMPLEMENTATION_PLAN.md`, and `design/82_M8_DIRECT_ENTER_MINE_SEMANTICS_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- M8 actions remain strictly independent: `enter_mine`, then `use_mine_ladder`, then `select_mine_elevator_floor`; receipts/evidence do not transfer between actions.
- All bridge requests are revalidated on the game thread for exact scope, binding, policy, revision, deadline, cancellation, single-player topology, player/world state, and action-specific Given.
- Do not add public actions, generic dispatch, caller-selected raw `whatLevel`/`forceLayout`, compatibility behavior, UI/menu reads, UI/input injection, raw input, direct action save mutation, ladder creation, rock breaking, combat, arbitrary warps, or direct action position writes. The validation-only exceptions are the launcher-owned staged-save Given fixture in `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md` and the closed Mod-owned native facility setup in `design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md`; neither can alter canonical saves, publish action authority, or mint action evidence/results.
- `PathFindController` belongs to Navigation. M8 direct transitions may not create a controller or move the player before native arm.
- UI `checkAction` proximity/grab-tile/facing conditions are source provenance for ordinary player ingress, not direct-action authorization gates. The direct action instead requires the corresponding live facility to exist somewhere on the current Buildings layer: tile `173` for ladder and tile `112` for elevator.
- Before native arm, rejected/cancelled/deadline/invalidated work has no action-owned world movement; after arm, a failed correlation/native completion remains `uncertain` and is never automatically retried.
- Each live closure is a single serial target-version mutation after static preflight, all affected offline gates, and independent review. The matching named staged-save Given fixture may establish only this action's declared starting facts before preflight; setup has separate redacted transaction evidence and cannot contribute to action receipts/evidence/postconditions. Profile transaction preparation/restore is shared infrastructure but cannot be concurrent.
- `design/13_STARDEW_NATIVE_PROVENANCE.md` exists but remains explicitly incomplete / not publish evidence; its current audit-aid status is an independent fail-closed source-audit blocker and must not be upgraded or substituted for live evidence as part of this batch.
- The rejected floor-1 and probabilistic observe-only floor-2 `m8_ladder_given_v1` routes are superseded by `design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md`: the staged fixture owns only serialized progress to floor 2, and the Mod-only `PortfolioMineLadderGivenFixture` owns one fixed floor-2 native warp followed by one fixture-selected native `MineShaft.createLadderDown` setup and fresh tile-173 observation. It is not an action, public capability, bridge route, receipt/evidence producer, or postcondition authority; `use_mine_ladder` still independently revalidates and owns its native transition.

---

## File Structure

- `integrations/stardew/PortfolioMineLadderSemanticAdapter.cs` — direct ladder Given, native arm/correlation, and removal of all approach/controller code.
- `integrations/stardew/PortfolioMineLadderActionCoordinator.cs` — fresh-observation and adapter-result rules without interaction/approach state.
- `integrations/stardew/PortfolioMineLadderActionProtocol.cs` — delete `ApproachPending` and controller-specific result surface if present.
- `integrations/stardew/PortfolioMineElevatorSemanticAdapter.cs` — direct checkpoint selection admission using a current-map elevator-facility scan, without player elevator-tile pose checks.
- `integrations/stardew/PortfolioMineElevatorActionCoordinator.cs` — continue accepting only finite unlocked non-current checkpoint observations.
- `integrations/stardew/PortfolioBridgeSession.cs`, `integrations/stardew/PortfolioBridgeProtocol.cs`, `host/src/portfolio-protocol.ts`, and bridge/lifecycle/interop tests — replace any authoritative interaction-pose observation with truthful action facility facts (tile `173` for ladder; tile `112` for elevator) or remove it consistently; preserve typed action payloads and receipt shapes.
- `tools/run-stardew-portfolio-m8-ladder-action.mjs` / `.test.mjs` — require ladder presence rather than interaction readiness.
- `tools/run-stardew-portfolio-m8-action.mjs`, relevant preflight/route runners and tests — do not use elevator interaction readiness as admission.
- `tools/stardew-portfolio-m8-ladder-source-realization.mjs` / `.test.mjs` and `tools/stardew-portfolio-m8-elevator-source-realization.mjs` / `.test.mjs` — state UI ingress only as provenance and assert direct-action boundaries.
- `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md` and this plan — record final direct-seam action semantics.

## Task 1: Freeze Direct Native Boundaries

**Files:**
- Modify: `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`
- Modify: `tools/stardew-portfolio-m8-ladder-source-realization.mjs`
- Modify: `tools/stardew-portfolio-m8-ladder-source-realization.test.mjs`
- Modify: `tools/stardew-portfolio-m8-elevator-source-realization.mjs`
- Modify: `tools/stardew-portfolio-m8-elevator-source-realization.test.mjs`

**Interfaces:**
- Consumes native source facts: `MineShaft.checkAction` case `173`, `MineElevatorMenu` finite checkpoint materialization, and `Game1.enterMine(int)`.
- Produces source-realization contracts that prohibit action-owned position/UI ingress requirements while preserving real ladder presence and finite unlock constraints.

- [ ] **Step 1: Add failing realization assertions for the direct-action boundary**

Add assertions that reject dossiers whose semantic boundary says direct ladder requires adjacency/grab tile/facing or direct elevator requires the elevator grab tile. Add assertions that retain: ladder targets `mineLevel + 1` only; elevator targets a finite unlocked five-floor checkpoint only.

- [ ] **Step 2: Run the targeted realization tests and confirm they fail**

Run:

```bash
node --test tools/stardew-portfolio-m8-ladder-source-realization.test.mjs tools/stardew-portfolio-m8-elevator-source-realization.test.mjs
```

Expected: failure until dossiers/validators express the direct boundary.

- [ ] **Step 3: Update realization wording and validation**

Write the exact boundary:

```text
Ladder: current MineShaft plus at least one currently observed Buildings tile 173;
exact target current mineLevel + 1; no player pose requirement.

Elevator: current MineShaft at floor 0..120 whose Buildings layer contains tile 112
plus an existing typed selected checkpoint which is a finite five-floor checkpoint,
unlocked by `min(lowestMineLevel, 120)`, and different from the current floor; no
player pose requirement.
```

Retain that native UI guards/menus are provenance, not bridge inputs; retain excluded UI/input/save/spawn/movement/raw-enterMine claims.

- [ ] **Step 4: Re-run targeted realization tests**

Run the same Node command. Expected: PASS.

## Task 2: Make `use_mine_ladder` a Direct Native Transition

**Files:**
- Modify: `integrations/stardew/PortfolioMineLadderSemanticAdapter.cs`
- Modify: `integrations/stardew/PortfolioMineLadderActionProtocol.cs`
- Modify: `integrations/stardew/PortfolioMineLadderActionCoordinator.cs`
- Modify: `integrations/stardew/tests/PortfolioMineCoordinatorLifecycle.Contract.cs`
- Modify: `tools/run-stardew-portfolio-m8-ladder-action.mjs`
- Modify: `tools/run-stardew-portfolio-m8-ladder-action.test.mjs`

**Interfaces:**
- Consumes `PortfolioMineLadderAdapterContext` with action-owned target floor derived during fresh observation.
- Produces only `TransitionArmed` or a pre-arm native failure result. No `ApproachPending`, `PathFindController`, standing tile, facing direction, or grab-tile API remains in the ladder action.

- [ ] **Step 1: Write failing lifecycle and runner tests**

Add checks that:

```text
- a current MineShaft with any Buildings tile 173 admits a fresh ladder probe even
  when player grab tile/facing/standing pose is unrelated;
- no ladder adapter source contains PathFindController, player.controller,
  GetGrabTile, IsAccessibleLadderInteraction, or approach-pending behavior;
- absence of any tile 173 rejects before arm and does not call Game1.enterMine;
- after arm, missing LocationRequest/correlation still becomes uncertain.
```

Update runner tests so a valid probe requires `entryObserved`, a valid current floor, and `targetFloor === currentFloor + 1`; it must not require `ladderInteractionAvailable`.

- [ ] **Step 2: Run focused tests to verify red state**

Run the smallest existing contract/test commands that exercise ladder lifecycle and runner behavior. Expected: fail on retained approach/interaction APIs.

- [ ] **Step 3: Remove the private approach lifecycle**

In `PortfolioMineLadderSemanticAdapter.cs`:

```csharp
// Replace TryFindLadderApproach with a pure map fact.
private static bool HasExistingLadder(MineShaft mine)
{
    var layer = mine.map?.GetLayer("Buildings");
    if (layer is null)
        return false;

    for (var x = 0; x < layer.LayerWidth; x++)
    for (var y = 0; y < layer.LayerHeight; y++)
        if (mine.getTileIndexAt(new xTile.Dimensions.Location(x, y), "Buildings") == 173)
            return true;

    return false;
}
```

Use that fact in fresh read/admission immediately before arm. Replace an authoritative `LadderInteractionAvailable` wire fact with a truthful `LadderObserved` fact sourced by this fresh scan, or remove it from every authoritative C#/Host consumer in one shared-owner change; never fabricate it as true. Delete `LadderApproach`, `PathFindController`, `ApproachPending`, approach watchdog logic, controller cancellation cleanup, standing/facing/grab-tile checks, and all `requireLadderInteraction` parameters. Preserve exact `LocationRequest` correlation, `Player.Warped`, fresh target-floor reread, and arm-before-native `uncertain` behavior.

- [ ] **Step 4: Simplify coordinator/protocol and runner**

Make successful fresh observations require only a truthful real-ladder facility fact, not interaction readiness. Remove approach-specific adapter-result acceptance. A single shared owner must update every wire/schema/session/Host consumer if the public field changes. Keep target floor derived as exactly current + 1 and keep the action request parameterless.

- [ ] **Step 5: Run focused ladder tests**

Run relevant C# lifecycle contract plus:

```bash
node --test tools/run-stardew-portfolio-m8-ladder-action.test.mjs tools/stardew-portfolio-m8-ladder-source-realization.test.mjs
```

Expected: PASS.

## Task 3: Make `select_mine_elevator_floor` a Direct Native Transition

**Files:**
- Modify: `integrations/stardew/PortfolioMineElevatorSemanticAdapter.cs`
- Modify: `integrations/stardew/PortfolioMineElevatorActionCoordinator.cs`
- Modify: `integrations/stardew/tests/PortfolioMineCoordinatorLifecycle.Contract.cs`
- Modify: `host/src/portfolio-protocol.ts` and relevant tests only if interaction-only probe fields are removed from wire shape
- Modify: `tools/run-stardew-portfolio-m8-action.mjs` and tests
- Modify: `tools/run-stardew-portfolio-m8-preflight.mjs` and tests as needed

**Interfaces:**
- Consumes `PortfolioMineElevatorActionRequest.SelectedCheckpoint`; this is the only permitted selected target surface.
- Produces a direct `Game1.enterMine(selectedCheckpoint)` transition only after selected checkpoint is a valid five-floor checkpoint, live-unlocked, non-current, and all standard game-thread admission facts hold.

- [ ] **Step 1: Write failing elevator lifecycle and runner tests**

Add checks that a fresh MineShaft whose Buildings layer contains tile `112`, with valid live unlock data, admits an elevator request even when player grab tile is unrelated, while these still reject before arm:

```text
- checkpoint is not one of 5..120 in increments of five;
- checkpoint exceeds `min(live lowestMineLevel, 120)`;
- checkpoint equals current floor;
- no current Buildings-layer tile `112` exists, even when checkpoint progress is valid;
- world/scope/policy/revision/deadline/cancel topology is invalid.
```

Also assert that no `GetGrabTile`, `tileWithinRadiusOfPlayer`, or `IsAccessibleElevatorInteraction` is used by the semantic adapter admission.

- [ ] **Step 2: Run targeted tests to verify red state**

Run the focused elevator coordinator/Host protocol test selection. Expected: fail due to current interaction gate.

- [ ] **Step 3: Remove only pose-derived elevator admission**

Replace `requireElevatorInteraction` and `IsAccessibleElevatorInteraction` with a pure current-map `HasElevatorFacility(MineShaft mine)` scan for Buildings-layer tile `112`. Retain all standard world/policy/scope checks, source-floor `0..120`, `IsUnlockedSelection` based on `min(lowestMineLevel, 120)`, `selectedCheckpoint != currentFloor`, and bounded checkpoint checks. Raw `lowestMineLevel` may exceed 120; the source floor and requested checkpoint remain bounded.

Keep `player.ridingMineElevator = true` only if target-version native warp lifecycle requires it to reproduce the selected-elevator transition state; restore it only when `Game1.enterMine` throws before scheduling a changed `LocationRequest`. Do not construct/read `MineElevatorMenu` or invoke UI dispatch.

- [ ] **Step 4: Update observation and runner contracts**

Replace any retained authoritative `elevatorInteractionAvailable` field with truthful current facility observation (tile `112`), or remove it consistently from C#, Host schema, fixtures, and tests under a single shared owner. It must never represent player pose or be fabricated; fresh admission may depend only on the facility fact, not player location/facing/grab tile.

- [ ] **Step 5: Run focused elevator tests**

Run the affected C# lifecycle, Host protocol, and runner/preflight Node tests. Expected: PASS.

## Task 4: Integrate, Verify, and Review the Batch

**Files:**
- Modify only files required by test corrections from Tasks 1–3.

**Interfaces:**
- Consumes the two direct actions with their independent existing typed protocols.
- Produces an offline-verified batch, ready for serial preflight/live gates but not a live closure claim.

- [ ] **Step 1: Build and execute complete offline M8 checks**

Run serially to avoid DLL locks:

```bash
dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore
dotnet run --project integrations/stardew/tests/PortfolioTerminalDeliveryCore.Contract.csproj -c Release --no-build
pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.portfolio.json
node --test tools/run-stardew-portfolio-m8-ladder-action.test.mjs tools/run-stardew-portfolio-m8-action.test.mjs tools/run-stardew-portfolio-m8-mine-route-action.test.mjs tools/stardew-portfolio-m8-ladder-source-realization.test.mjs tools/stardew-portfolio-m8-elevator-source-realization.test.mjs
git diff --check
```

Expected: all commands pass with no build warnings/errors and no whitespace errors.

- [ ] **Step 2: Run independent review**

Review the final diff against these rejection criteria:

```text
- direct ladder action contains no PathFindController or implicit movement;
- neither direct action admits on grab tile/facing/interaction pose;
- ladder still proves a current real tile-173 ladder before arm;
- elevator still proves current Buildings-layer tile `112` plus finite, unlocked, non-current checkpoint before arm;
- neither exposes raw level/layout authority nor injects UI/input/saves;
- arm-after failure is still uncertain and exact native warp correlation survives.
```

- [ ] **Step 3: Verify clean non-live state before any live gate**

Use the existing profile inspection command. Expected: no transaction lock, no deployed profile, and no Stardew/SMAPI process. If not clean, stop; do not restore/delete unmanaged material or start a second game process.

## Task 5: Serial Live Closure (Only After Task 4 Is Green)

**Files:**
- No source edit required unless an offline-covered defect is discovered. Record run journals under `.tmp/m8-live-runs/`.

**Interfaces:**
- Consumes the final Release Mod/Host artifacts, one action-specific enabled profile, a clean transaction state, and only when required the matching named staged-save Given fixture from `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`.
- Produces separate ladder/elevator terminal receipts and fresh floor evidence. Fixture setup is not action evidence and does not use an aggregate monitor as a substitute.

- [ ] **Step 1: Ladder non-mutating preflight**

Create a new transaction-owned staged slot and apply only the named ladder Given fixture if required by `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`. Launch only the ladder action profile with `--preflight`. It may observe real Given but must not send `mine_ladder_request`. Verify bridge connection, fresh live probe correlation, ladder-present Given, canonical-slot integrity, and completed owned-stage/profile cleanup. Fixture setup cannot appear in ladder receipt/evidence/postcondition fields.

- [ ] **Step 2: Ladder unique mutation gate**

After clean-state confirmation, run exactly one ladder action worker. Require its own `succeeded / mine_ladder_floor_used` receipt with non-empty evidence plus same-execution fresh `currentFloor == targetFloor` reread. On any uncertain/blocked/restore issue, stop without retry.

- [ ] **Step 3: Elevator non-mutating preflight**

Only after ladder worker cleanup is verified, create a distinct new transaction-owned staged slot and apply only the named elevator Given fixture if required by `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`. Its fixed floor-5 facility observation uses staged `mine_lowestLevelReached = 10`, while the worker independently requests checkpoint `10`; it must remain fresh, unlocked, and non-current. Use an exact elevator-enabled profile and run `--preflight`; it must not send `mine_elevator_request`. Verify the facility and distinct finite checkpoint are actually observed, canonical-slot integrity holds, and owned-stage/profile cleanup completes. Fixture setup cannot appear in elevator receipt/evidence/postcondition fields.

- [x] **Step 4: Elevator unique mutation gate — accepted action closure**

The originally authorized worker was evidence-incomplete because it summarized an obsolete nested runner-output path; that record remains rejected and was never upgraded. After the capture boundary was repaired and regression-tested, the separately authorized successor gate completed with journal `.tmp/m8-live-runs/m8-elevator-staged-action-v2.json`. It records `M8_ACTION_LIVE_TERMINAL`, `succeeded / mine_elevator_floor_selected`, non-empty evidence, same-execution postcondition `actualCurrentFloor: 10`, and the runner's independent fresh reread `currentFloor: 10`, `lowestMineLevel: 10`. The associated transaction-owned staged fixture reports canonical integrity verified and completed cleanup. Final process/profile/slot checks found no residual Stardew/SMAPI process, transaction lock, or owned staged slot; target-version SMAPI independently logged the native warp to `UndergroundMine10`.

This closes the independent `select_mine_elevator_floor` action only. The floor-10 unlock fact is fixture-owned staged Given, never action evidence or a persistence claim; it does not retroactively close the old journal or grant aggregate progress.

- [x] **Step 5: Record M8 action-set completion without conflating it with a Goal evaluator**

All three independent M8 actions now have their own target-version closure records. `reach_mine_floor` is not a fourth M8 action and does not block M8 completion. If a future product Goal needs to make an end-to-end mine-depth claim, it may introduce `reach_mine_floor` only as a separate read-only aggregate evaluator with its own scope: it must not send a request, move/warp the player, mint an action receipt, or infer persistent progress from an elevator fixture's staged `lowestMineLevel` or from unrelated isolated action runs.

## Self-Review

- **Spec coverage:** Tasks 1–3 remove pose-derived ingress conditions, retain action-specific real Given, retain parameter/domain bounds, preserve game-thread admission and uncertain semantics. Task 4 gates implementation before live work. Task 5 keeps closures independent and serial.
- **Placeholder scan:** No TODO/TBD steps; each task names files, predicates, code/seams, and commands.
- **Type consistency:** Existing public request types remain `PortfolioMineLadderActionRequest` (parameterless target) and `PortfolioMineElevatorActionRequest.SelectedCheckpoint`; adapter result removal is explicitly coordinated with C#/Host consumers.

## Execution Handoff

Plan complete and saved to `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`. Execute it now using the `subagent-driven-development` skill: fresh implementation worker per task, independent review after each task, one writer for shared files, and no live action before Task 4 passes.
