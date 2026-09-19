# M8 Ladder Floor-2 Native Given Implementation Plan — Superseded

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Superseded by `design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md`; do not run this observe-only route.

**Goal:** Historical record of the former validation-only staged floor-2 candidate, which depended on initial native generation producing a ladder before the independent `use_mine_ladder` action was admitted.

**Why superseded:** Target-version source makes initial ladder creation probabilistic. The one authorized target-version floor-2 preflight loaded successfully but fresh-observed no tile `173`, correctly rejected before bridge binding, sent no action request, and restored cleanly. Repeating generation would be an invalid retry. The approved replacement keeps the same staged floor-2 progress but has the closed fixture invoke exactly one fixed `MineShaft.createLadderDown` native facility setup after correlated arrival, then fresh-observe tile `173`.

**Tech Stack:** Stardew Valley 1.6.15 build 24356; SMAPI; C#; Node ESM tests.

**Spec:** `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `design/85_M8_LADDER_NATIVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- The canonical save remains immutable; `m8_ladder_given_v1` may alter only the owned staged slot's serialized `mine_lowestLevelReached` from baseline `0..5` to `2`, with `mine_lowestLevelReachedForOrder == -1` unchanged.
- The Mod fixture is default-disabled and derived only from the exact singleton `['use_mine_ladder']` profile. It is not an action, bridge message, Host/Agent input, configurable destination, retry facility, or receipt/evidence producer.
- This historical route's sole fixture native edge was `Game1.warpFarmer("UndergroundMine2", 6, 6, 2)`, followed by fresh observation only. It deliberately did not call ladder creation methods, so it cannot establish a reliable ladder Given.
- On target version, `MineShaft.populateLevel` attempts an initial ladder only when `mineLevel > 1`, `mineLevel % 5 != 0`, `!mustKillAllMonstersToAdvance()`, and its random branch succeeds. The observed failure is a source-backed reason this route is superseded, not a reason to retry it.
- Both exact native completion edges, post-warp floor-2/location identity, safe game state, `MineShaft.lowestLevelReached == 2`, and an actual Buildings tile `173` are required before binding. The `(6,6)` warp request was never a pose requirement: the target game may resolve the player at a different valid tile.
- The existing ladder action independently re-observes tile `173`, then alone owns its typed request, `Game1.enterMine(currentFloor + 1)`, terminal receipt, evidence, and fresh postcondition.

---

## File Structure

- Modify: `tools/lib/stardew-portfolio-staged-save-fixture.mjs` — declare the fixed floor-2 staged Given.
- Modify: `tools/lib/stardew-portfolio-staged-save-fixture.test.mjs` — verify only the fixed progress change and canonical integrity.
- Modify: `integrations/stardew/PortfolioMineLadderGivenFixture.cs` — use fixed floor-2 warp and fresh floor-2 settlement checks.
- Modify: `tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs` — assert the exact closed floor-2 seam and no forbidden capabilities.
- Modify: `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `design/85_M8_LADDER_NATIVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md` — replace the rejected floor-1 route with this floor-2 route.

### Task 1: Make the staged declaration reach the valid native-generation floor

**Files:** `tools/lib/stardew-portfolio-staged-save-fixture.mjs`; `tools/lib/stardew-portfolio-staged-save-fixture.test.mjs`.

- [ ] Change the exact ladder declaration to `lowestMineLevel: 2`; retain the sole serialized field and `lowestMineLevelForOrder: -1`.
- [ ] Add a declaration test that the ladder fixture patches a baseline level to `2`, permits no pose/floor/tile selector fields, and leaves the canonical manifest unchanged.
- [ ] Run `node --test tools/lib/stardew-portfolio-staged-save-fixture.test.mjs`.

### Task 2: Replace only the fixed Given floor

**Files:** `integrations/stardew/PortfolioMineLadderGivenFixture.cs`; `tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs`.

- [ ] Change the one literal edge and exact request/location/floor/lowest-level assertions from `UndergroundMine1`/`1` to `UndergroundMine2`/`2`; retain the same completion correlation and terminal lifecycle handling.
- [ ] Update source tests to require exactly `Game1.warpFarmer("UndergroundMine2", 6, 6, 2)`, exact floor-2 settle facts, tile `173`, and one-shot/no-`Game1.enterMine` boundary.
- [ ] Run `node --test tools/stardew-portfolio-m8-ladder-native-given-fixture.test.mjs tools/stardew-portfolio-m8-initial-native-load.test.mjs`.

### Task 3: Record the floor-2 condition and validate the offline candidate

**Files:** `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`; `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`; `design/85_M8_LADDER_NATIVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`.

- [ ] Mark floor-1 route rejected because it cannot use the initial native ladder branch. Make this plan the sole candidate.
- [ ] State that floor 2 is eligible but its ladder presence remains a fresh probabilistic target-game fact; failure stops the transaction rather than retrying setup or action mutation.
- [ ] Run `dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore`, the focused Node tests, and `git diff --check` on changed paths.

## Acceptance

**Given** a transaction-owned staged slot with mine level 2, **when** the exact profile loads and the fixture performs its one fixed native floor-2 warp, **then** binding opens only after both correlated completion edges and fresh floor-2 tile-173 observation. **And** if target generation has no ladder, the fixture rejects without a second warp or ladder request.

No further gate may use this route. Follow `design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md` for the approved replacement.
