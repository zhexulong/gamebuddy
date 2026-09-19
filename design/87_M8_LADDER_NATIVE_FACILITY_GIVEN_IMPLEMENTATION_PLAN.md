# M8 Ladder Native Facility Given Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one real ladder facility in the transaction-owned M8 ladder validation world before bridge binding, so the independent `use_mine_ladder` action can be preflighted and then closed without treating ladder creation as an action result.

**Architecture:** The launcher-owned staged slot still changes only the source-backed serialized mine progress to floor 2. The closed Mod fixture performs the existing fixed native warp to generated floor 2, then exactly once uses the target game's `MineShaft.createLadderDown` on a fixture-selected, currently clear map tile. The game method produces the normal Buildings-layer ladder tile `173`; the fixture fresh-observes it before bridge binding. No external caller selects a tile or requests this setup, and the ladder action itself remains a parameterless direct native transition that independently fresh-rereads the facility.

**Tech Stack:** Stardew Valley `1.6.15` build `24356`; SMAPI; C#; Node.js ESM tests.

**Spec:** `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, and user approval at §16453.

## Global Constraints

- This is a validation-only, Mod-owned Given setup. It is not a player capability, GameBuddy action, bridge route, Host tool, Agent input, receipt/evidence producer, or postcondition authority.
- Canonical save remains byte-for-byte read-only. The staged fixture owns only `mine_lowestLevelReached = 2` and keeps `mine_lowestLevelReachedForOrder = -1`; the created ladder lives only in the loaded staged runtime and is never saved back.
- The fixture is enabled only by the exact singleton `['use_mine_ladder']` profile, only before bridge binding, only after the existing fixed warp has correlated both `LocationRequest.OnWarp` and SMAPI `Player.Warped` edges, and only while all existing single-player/safe-state facts remain true.
- It must use exactly one target-version-native `MineShaft.createLadderDown(x, y)` call. It must select `x,y` internally from the current floor-2 map using the target method's own required clear-tile predicate; it cannot accept coordinates, floor, direction, pose, or force-shaft input from Mod config, profile, launcher, bridge, Host, or Agent.
- It must reject rather than retry when no valid fixture tile exists, the native call throws, the required live facts drift, or the fresh check cannot find a normal Buildings tile `173` at its one private selected point. The fixed warp request literal `(6,6)` is not a player-pose contract: the target version may choose a different valid final player tile, which the fixture neither controls nor admits upon. It must not warp again, regenerate a MineShaft, invoke UI/input, pathfinding, rock breaking, combat, `Game1.enterMine`, map/tile writers, action coordinator, or bridge ingress.
- The fixture may record only its redacted setup outcome. It must not create a typed action request, execution, receipt, evidence, action result, correlation fact presented as action evidence, or action postcondition.
- `use_mine_ladder` still independently observes tile `173`, derives `currentFloor + 1`, revalidates scope/policy/deadline/cancel/world facts on the game thread, owns its native transition and correlation, and alone can issue its receipt/evidence/postcondition.

---

## File Structure

- Modify: `integrations/stardew/PortfolioMineLadderGivenFixture.cs` — add the one fixed native facility setup after correlated floor-2 arrival and before final fresh observation.
- Modify: `tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs` — test exact capability closure, source seam, one-call bound, no action ingress, and fresh tile-173 settlement.
- Modify: `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `design/86_M8_LADDER_FLOOR_2_NATIVE_GIVEN_IMPLEMENTATION_PLAN.md` — supersede the probabilistic “observe-only” route with this user-approved fixed facility Given.

### Task 1: Add the red capability-boundary test

**Files:** `tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs`.

**Interfaces:**

```csharp
private bool TryCreatePortfolioMineLadderGivenFacility(MineShaft mine)
```

The method is private to `ModEntry`; it returns `true` only after exactly one `mine.createLadderDown(x, y)` invocation was scheduled from a current fixture-selected clear tile. It has no parameter except the correlated current `MineShaft`. The fixture retains the internally selected `Point` and observes tile `173` exactly at that point on a later game tick; a scan elsewhere cannot satisfy this Given.

- [ ] **Step 1: Write the failing test**

Require one private helper called from fixture settlement after native/SMAPI warp correlation; require exactly one `.createLadderDown(` call; require `mine.isTileClearForMineObjects(...)` before it; reject `forceShaft`, `setMapTile`, `Game1.enterMine`, `PathFindController`, `GetGrabTile`, `HandlePortfolio`, bridge/coordinator references, external parameters, and a second `Game1.warpFarmer`.

- [ ] **Step 2: Run the focused test red**

Run:

```bash
node --test tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs
```

Expected: failure because the current fixture only observes probabilistic generation and does not have the private native facility setup helper.

- [ ] **Step 3: Add only the named assertions**

The test must also retain the existing fixed `Game1.warpFarmer("UndergroundMine2", 6, 6, 2)` assertion, both native completion edges, current location/floor/safety/lowest-level fresh checks, lifecycle invalidation, and pre-binding ordering. It must reject any use of the request literal or actual player tile as a player-pose admission check.

- [ ] **Step 4: Run focused test green**

Run the same command. Expected: PASS.

### Task 2: Implement the single native facility setup

**Files:** `integrations/stardew/PortfolioMineLadderGivenFixture.cs`.

**Interfaces:**

```csharp
private bool TryCreatePortfolioMineLadderGivenFacility(MineShaft mine)
// The fixture stores one private Point and later checks that exact tile for 173.
```

- [ ] **Step 1: Keep all existing floor-2 arrival correlation intact**

Do not alter the profile gate, fixed warp literal, native `LocationRequest.OnWarp` handler, SMAPI `Player.Warped` handler, lifecycle resets, or action-independent final facility scan.

- [ ] **Step 2: Select a tile internally and invoke the native seam once**

After both warp facts are true and before final acceptance, iterate the current `Buildings` layer in stable `x` then `y` order. For the first tile satisfying the existing target-version `mine.isTileClearForMineObjects(x, y)` predicate, call:

```csharp
mine.createLadderDown(x, y);
```

Do not pass `forceShaft`; do not call any map/tile setter. If there is no clear candidate, reject with `fixture_ladder_tile_unavailable`. If the native call throws, reject with `fixture_ladder_creation_exception`.

- [ ] **Step 3: Freshly observe the native result**

After the call, return to the game loop, then require current scope/location/request/safety/floor facts again and require a current Buildings tile `173` at the exact internally selected tile. If it is absent, reject with `fixture_ladder_not_observed`. Detach the warp handler and set `Succeeded` only after this fresh check.

- [ ] **Step 4: Run focused static and build checks**

```bash
node --test tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs tools/stardew-portfolio-m8-initial-native-load.test.mjs
dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore
```

Expected: PASS.

### Task 3: Replace the superseded route documentation

**Files:** `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `design/86_M8_LADDER_FLOOR_2_NATIVE_GIVEN_IMPLEMENTATION_PLAN.md`.

- [ ] **Step 1: Mark the old floor-2 route superseded**

Document that source eligibility does not ensure a ladder because the generation branch is probabilistic and the target run yielded no tile `173`; therefore an observe-only floor-2 fixture cannot establish the required Given reliably.

- [ ] **Step 2: Record the approved boundary exactly**

State that the closed fixture creates one normal ladder through `MineShaft.createLadderDown` in the loaded staged validation world, then fresh-observes tile `173`. State explicitly that it is fixture setup—not a player or action capability—and that it cannot mint action authority/evidence/results.

- [ ] **Step 3: Validate documentation closure**

```bash
rg -n "createLadderDown|probabilistic|fixture|tile 173" design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md design/86_M8_LADDER_FLOOR_2_NATIVE_GIVEN_IMPLEMENTATION_PLAN.md design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md
git diff --check -- integrations/stardew/PortfolioMineLadderGivenFixture.cs tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md design/86_M8_LADDER_FLOOR_2_NATIVE_GIVEN_IMPLEMENTATION_PLAN.md design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md
```

Expected: required language present and no scoped whitespace error.

## Acceptance

**Given** the target game has loaded the transaction-owned staged floor-2 save, **when** the closed fixture correlates its exact native and SMAPI warp completion and invokes one internal `MineShaft.createLadderDown` on a valid current map tile, **then** it opens bridge binding only after a fresh scan observes a normal tile `173`. **And** no typed `use_mine_ladder` request, action receipt/evidence/postcondition, public capability, canonical save modification, or caller-selected world mutation occurs during setup.

After all offline checks, one independent review, and a non-mutating target-version preflight establish this Given and restore successfully, the upstream M8 closure owner may decide whether to consume the already-authorized single ladder action mutation gate.
