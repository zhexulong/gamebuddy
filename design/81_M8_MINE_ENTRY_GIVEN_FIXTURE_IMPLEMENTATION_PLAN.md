# M8 Mine Entry Given Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a default-disabled, Portfolio-internal fixture that establishes the target-version Mine-exterior Given required by the independent `enter_mine` action without adding a fourth bridge action. The native warp fixture itself does not modify the save; separately authorized staged-save Given preparation is defined only by `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`.

**Architecture:** The fixture is armed only by the existing-save profile transaction for an `enter_mine` closure. After `InitialNativeLoad` verifies the single-player target slot and before `TryInitializePortfolioBinding()` can open the bridge, the Mod performs one target-version native `Game1.warpFarmer` setup warp to the fixed Mine exterior tile. It waits for `Player.Warped`, then fresh-checks only the local player and Mine exterior location. Binding opens only after that observation succeeds. The fixture does not create or prove a UI interaction pose; `enter_mine` directly owns the fixed default native transition to floor 1.

**Tech Stack:** C# target-bound Stardew Mod (`net6.0`), Node.js ESM Portfolio profile/launcher tooling, Node test runner, target version Stardew Valley `1.6.15` build `24356`.

**Spec:** `design/80_M8_ENTER_MINE_ACTION_IMPLEMENTATION_PLAN.md`, `design/15_STARDEW_CAPABILITY_SET.md`, `design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`, and `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- The fixture is internal setup, not an action: no Host request, bridge message, capability advertisement, receipt, evidence, or caller-supplied coordinate.
- It is default-disabled. It may be enabled only by a transaction preparing either the exact one-action `enter_mine` profile or the exact ordered `skip_event` → `enter_mine` profile. In the latter form, setup establishes Mine exterior before binding and leaves the active Event exclusively for the independently requested `skip_event` action.
- The destination is a target-bound fixed Mine-exterior setup tile. It is not a player-interaction stance: the fixture neither sets nor validates facing, `GetGrabTile()`, or `Buildings` action data.
- It is invoked only after `InitialNativeLoad` succeeds and before Portfolio bridge binding; unsuccessful setup leaves the bridge closed.
- It performs no `Game1.enterMine`, ladder mutation, direct action save edit, UI/input injection, or arbitrary navigation. This in-game fixture is distinct from the launcher-owned staged-save Given fixture in `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`.
- `enter_mine` remains the sole public action that enters MineShaft floor 1 and generates its own request, receipt, evidence, and fresh postcondition.
- M8 action profiles remain default-deny exact allowlists: this fixture permits only `['enter_mine']` or the ordered `['skip_event', 'enter_mine']`, never ladder/elevator expansion. A separate staged-save fixture may establish ladder/elevator Given facts only under `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`; it does not change these action allowlists. Target-version topology remains `single_player_native_companion`, and the launcher owns a single SMAPI process tree and transaction restore.

---

### Task 1: Define the private fixture configuration and profile contract

**Files:**
- Modify: `integrations/stardew/ModConfig.cs`
- Modify: `integrations/stardew/PortfolioInitialNativeLoad.cs`
- Modify: `tools/lib/stardew-portfolio-profile.mjs`
- Modify: `tools/lib/stardew-portfolio-profile.test.mjs`
- Modify: `tools/launch-stardew-portfolio-m8-action-live.mjs`
- Modify: `tools/launch-stardew-portfolio-m8-action-live.test.mjs`

**Interfaces:**
- Produces `Portfolio.MineEntryGivenFixture: { Enable: boolean }`.
- `preparePortfolioExistingSaveProfile({ enabledActions: ["enter_mine"], mineEntryGivenFixture: true, ... })` or `preparePortfolioExistingSaveProfile({ enabledActions: ["skip_event", "enter_mine"], mineEntryGivenFixture: true, ... })` produces an armed form; all other action lists are rejected.
- Launcher admission requires the fixture exactly when action is `enter_mine` and rejects it for ladder/elevator actions.

- [ ] Add a default-disabled `PortfolioMineEntryGivenFixtureConfig` with `IsValid` true only for the known boolean shape.
- [ ] Preserve the value when native-load/bootstrap code rebuilds `PortfolioConfig`.
- [ ] Extend the profile whitelist and validation so the fixture is enabled iff the action list is exactly `["enter_mine"]` or exactly `["skip_event", "enter_mine"]` in that order.
- [ ] Add profile and launcher tests for direct and ordered-sequence enablement, plus action/profile mismatch rejection.

### Task 2: Gate binding on the fresh native Mine-exterior Given

**Files:**
- Create: `integrations/stardew/PortfolioMineEntryGivenFixture.cs`
- Modify: `integrations/stardew/ModEntry.cs`
- Test: `tools/test-stardew-portfolio-m8-static.mjs` or the repository's existing lifecycle-focused test seam

**Interfaces:**
- `TryPreparePortfolioMineEntryGivenFixture()` returns `NotArmed`, `Pending`, `Succeeded`, or `Rejected`.
- `TryCompletePortfolioMineEntryGivenFixtureWarped(WarpedEventArgs)` completes only after the exact target-version native observation.

- [ ] Write the failing lifecycle assertion: binding cannot be called before fixture success when the fixture is armed, and fixture source must not introduce bridge protocol identifiers or receipt/evidence types.
- [ ] Implement a one-shot native `Game1.warpFarmer("Mine", 23, 8, flip: false)` setup warp after exact single-player and no-binding checks; it must remain effective while the Mine introduction Event is active.
- [ ] On the fresh local-player `Warped` callback, verify the exact local player and Mine exterior location. Do not write or validate facing, `GetGrabTile()`, standing tile, or a map `Action` producer.
- [ ] On any failed setup observation, mark the fixture terminal and do not initialize the bridge.
- [ ] Run the focused lifecycle/static test and target-bound Mod compilation.

### Task 3: Rebuild and run non-mutating live preflight

**Files:**
- Verify: current target-bound Mod release directory
- Verify: `tools/launch-stardew-portfolio-m8-action-live.mjs`

**Interfaces:**
- The entry-only transaction enables the internal fixture and the normal entry runner `--preflight` receives a real Mine-exterior observation.

- [ ] Run profile/launcher/lifecycle focused checks and `git diff --check`.
- [ ] Build the target-bound Mod with the pinned game path.
- [ ] Use `preparePortfolioExistingSaveProfile()` to deploy a new direct `enter_mine` or exact ordered `skip_event` → `enter_mine` transaction with `mineEntryGivenFixture: true`.
- [ ] Run only launcher `preflight`; it must report `M8_ACTION_LIVE_PREFLIGHT_READY` for direct entry or `M8_ACTION_LIVE_PREFLIGHT_SEQUENCE_READY` when an active Event requires the ordered sequence, before any unique `enter_mine` mutation is considered.
- [ ] Stop if the fixture fails, topology changes, an extra Stardew process appears, or restore verification fails.
