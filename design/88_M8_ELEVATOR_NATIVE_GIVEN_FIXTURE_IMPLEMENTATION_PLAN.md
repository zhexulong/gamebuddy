# M8 Elevator Native Given Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a validation-only, action-independent target-version `MineShaft` floor-5 elevator Given for the single `select_mine_elevator_floor` live closure.

**Architecture:** The existing launcher-owned staged-save transaction remains the only persistence setup: it copies the canonical slot, sets only `mine_lowestLevelReached = 10`, and verifies canonical integrity. The closed Mod fixture, enabled only by the exact one-action elevator profile, performs one fixed `Game1.warpFarmer("UndergroundMine5", 6, 6, 2)` before bridge binding and correlates the native `LocationRequest.OnWarp` and SMAPI `Player.Warped` edges. Once the same current `MineShaft` is freshly stable, the fixture scans its current Buildings layer for tile `112`; the worker independently asks for the distinct runtime checkpoint `10`. Neither fixture nor stage selects that checkpoint, writes the map, calls an elevator action, opens a UI, or treats the requested warp coordinate/player pose as a Given.

**Tech Stack:** Stardew Valley 1.6.15 build 24356; SMAPI; C#; TypeScript/Node test runner; existing Portfolio named-pipe bridge and M8 staged-save transaction.

**Spec:** `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `fixtures/stardew/portfolio-m8-elevator-contract.example.json`, and `design/13_STARDEW_NATIVE_PROVENANCE.md`.

## Global Constraints

- This work creates only a pre-binding, validation-only Given fixture. It is not an action, public capability, bridge route, Host tool, receipt/evidence producer, postcondition authority, or an alternative to `select_mine_elevator_floor` game-thread admission.
- The fixture is available only when `EnabledActions` equals exactly `["select_mine_elevator_floor"]`; callers cannot supply a floor, map tile, player pose, layout, checkpoint, or native method argument.
- The launcher-owned transaction copies from a manifest-verified canonical save, changes only declared target-version serialized mine progress in its owned staged slot, verifies the canonical manifest before/after, and deletes only a journal-owned staged root.
- The fixture must run before `portfolioBinding` is created and only after world-ready single-player/master/local-player scope and safe-state checks succeed.
- The sole fixture transition is fixed `Game1.warpFarmer("UndergroundMine5", 6, 6, 2)`. It must correlate its exact `LocationRequest.OnWarp` and matching `Player.Warped` event, then fresh-check the same `MineShaft`, name `UndergroundMine5`, `mineLevel == 5`, `MineShaft.lowestLevelReached >= 10`, safe state, and Buildings tile `112`. The worker's fixed validation checkpoint is `10`, which remains a distinct typed request and is independently revalidated.
- The fixture must not require that native warp request coordinate `(6,6)` equal the resolved player landing tile. The action itself has no player-pose admission.
- Missing layer/tile, mismatched native edge, mismatched SMAPI edge, lifecycle invalidation, unsafe state after warp, or any unexpected existing binding must reject before bridge publication. It must not re-warp, retry, randomize, mutate map data, invoke `setMapTile`, create facilities, use pathfinding/UI/input, use `Game1.enterMine`, or send `mine_elevator_request`.
- `select_mine_elevator_floor` remains independently responsible for fresh current facility tile `112`, finite selected checkpoint validation, live unlocked/non-current checks, arm-before-native uncertain behavior, exact native transition correlation, terminal receipt/evidence, and fresh postcondition reread.
- The target-version source establishes that `MineShaft.findLadder()` recognizes current Buildings tile `112` as its elevator facility and `MineShaft.checkAction` uses tile `112` only for normal UI ingress. The fixture and typed action consume the former fact, never invoke the latter ingress.
- Perform no live mutation until focused contracts, Release build, target-version non-mutating preflight, clean transaction/process state, and independent post-diff review all pass. Preflight sends no `mine_elevator_request`; a qualified preflight may authorize exactly one serial live mutation.

## File Structure

- `integrations/stardew/PortfolioMineElevatorGivenFixture.cs` — closed fixture state machine, fixed native warp, dual-edge correlation, and fresh tile-112 observation. It owns no action code.
- `integrations/stardew/ModConfig.cs` — adds the optional closed config shape and validates its exact elevator-action profile ownership.
- `integrations/stardew/PortfolioInitialNativeLoad.cs` — carries the closed config through the existing initial-native-load handoff without changing its shape.
- `integrations/stardew/PortfolioIntegration.cs` — invokes the fixture before Portfolio binding and after the existing entry/ladder fixture checks.
- `integrations/stardew/ModEntry.cs` — forwards `Player.Warped` and saving/title lifecycle invalidations into the fixture.
- `tools/lib/stardew-portfolio-profile.mjs` — derives the config only from the exact elevator action identity and rejects user-supplied fixture overrides/unknown config fields.
- `tools/launch-stardew-portfolio-m8-action-live.mjs` — verifies exact prepared config identity for elevator staged runs.
- `tools/stardew-portfolio-m8-elevator-native-given-fixture.test.mjs` — static structural regression contract for fixture authority and lifecycle boundaries.
- `tools/stardew-portfolio-m8-initial-native-load.test.mjs`, `tools/stardew-portfolio-profile.test.mjs`, `tools/launch-stardew-portfolio-m8-action-live.test.mjs` — profile/initial-load/launcher closed-schema contracts.
- `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, and `fixtures/stardew/portfolio-m8-elevator-contract.example.json` — synchronize the exact fixture boundary and remove the obsolete “unprovisioned” assertion.

## Task 1: Add Closed Elevator Fixture Configuration and Binding Order

**Files:**
- Modify: `integrations/stardew/ModConfig.cs`
- Modify: `integrations/stardew/PortfolioInitialNativeLoad.cs`
- Modify: `integrations/stardew/PortfolioIntegration.cs`
- Modify: `tools/lib/stardew-portfolio-profile.mjs`
- Modify: `tools/stardew-portfolio-profile.test.mjs`
- Modify: `tools/stardew-portfolio-m8-initial-native-load.test.mjs`

**Interfaces:**
- Consumes: exact `EnabledActions == ["select_mine_elevator_floor"]` and the existing initial-native-load `PortfolioConfig` copy.
- Produces: `PortfolioMineElevatorGivenFixtureConfig? MineElevatorGivenFixture` with only `Enable: true`, and a pre-binding call to `TryPreparePortfolioMineElevatorGivenFixture()`.

- [ ] **Step 1: Write failing profile and initial-load assertions**

Add assertions that the profile writer derives this exact config only for the one elevator action:

```js
assert.deepEqual(written.Portfolio.MineElevatorGivenFixture, { Enable: true });
assert.equal(Object.keys(written.Portfolio.MineElevatorGivenFixture).length, 1);
```

Add negative calls proving these fail:

```js
await assert.rejects(
  () => preparePortfolioExistingSaveProfile({ ...base, enabledActions: ["use_mine_ladder"], mineElevatorGivenFixture: true }),
  /portfolio_existing_save_mine_elevator_fixture_is_action_derived/,
);
await assert.rejects(
  () => preparePortfolioExistingSaveProfile({ ...base, enabledActions: ["select_mine_elevator_floor"], mineElevatorGivenFixture: false }),
  /portfolio_existing_save_mine_elevator_fixture_must_match_action/,
);
```

Extend initial-load source assertions to require the config member copy and an integration call that occurs before `this.portfolioBinding =`.

- [ ] **Step 2: Run the focused tests to verify red state**

Run:

```bash
node --test tools/stardew-portfolio-profile.test.mjs tools/stardew-portfolio-m8-initial-native-load.test.mjs
```

Expected: failures because no elevator fixture config exists or the profile cannot derive it.

- [ ] **Step 3: Implement the closed configuration**

In `ModConfig.cs`, add:

```csharp
public PortfolioMineElevatorGivenFixtureConfig? MineElevatorGivenFixture { get; init; }

public sealed class PortfolioMineElevatorGivenFixtureConfig
{
    public bool Enable { get; init; }
    internal bool IsValid => true;
}
```

Extend `PortfolioConfig.IsValid` so `MineElevatorGivenFixture.Enable` is valid only when `IsMineElevatorActionSequence` is true. Implement `IsMineElevatorActionSequence` as exactly one enabled action equal to `"select_mine_elevator_floor"`; do not broaden the Profile allowlist.

In `PortfolioInitialNativeLoad.cs`, copy `MineElevatorGivenFixture = portfolio.MineElevatorGivenFixture`. In `PortfolioIntegration.cs`, call `TryPreparePortfolioMineElevatorGivenFixture()` before any binding construction, after the existing fixture calls.

In `tools/lib/stardew-portfolio-profile.mjs`, derive `mineElevatorGivenFixture` from `isMineElevatorActionSequence(enabledActions)`, reject an explicit caller override, emit the one-field configuration only when derived true, and add it to the existing closed config key sets/checks.

- [ ] **Step 4: Re-run focused configuration tests**

Run:

```bash
node --test tools/stardew-portfolio-profile.test.mjs tools/stardew-portfolio-m8-initial-native-load.test.mjs
```

Expected: PASS.

## Task 2: Implement the Pre-Binding Native Elevator Given Fixture

**Files:**
- Create: `integrations/stardew/PortfolioMineElevatorGivenFixture.cs`
- Modify: `integrations/stardew/ModEntry.cs`
- Create: `tools/stardew-portfolio-m8-elevator-native-given-fixture.test.mjs`

**Interfaces:**
- Consumes: `PortfolioMineElevatorGivenFixtureConfig.Enable`, no existing binding, valid single-player game-thread state, and staged `MineShaft.lowestLevelReached >= 10`.
- Produces: boolean `TryPreparePortfolioMineElevatorGivenFixture()` that returns true only after a single fixed native floor-5 warp is correlated on both edges and a current Buildings tile `112` is freshly observed.

- [ ] **Step 1: Write the failing structural fixture contract**

Create a Node test that reads the fixture source and asserts all of the following:

```js
assert.match(executable, /Game1\.warpFarmer\("UndergroundMine5", 6, 6, 2\)/);
assert.equal((executable.match(/Game1\.warpFarmer\(/g) ?? []).length, 1);
assert.doesNotMatch(executable, /setMapTile\(|Game1\.enterMine\(|createLadderDown\(/);
assert.doesNotMatch(executable, /GetGrabTile\(|PathFindController|MineElevatorMenu|checkAction\(/);
assert.doesNotMatch(executable, /player\.Tile|freshPlayer\.Tile|new Vector2\(6, 6\)/);
assert.match(executable, /freshMine\.getTileIndexAt\(new Location\(x, y\), "Buildings"\) == 112/);
```

Assert a five-state terminal state machine (`NotArmed`, `AwaitingSafeTick`, `Pending`, `Succeeded`, `Rejected`), exactly one request handler attachment/detachment, native-edge then SMAPI-edge correlation, `MineShaft.lowestLevelReached >= 10`, no bridge/coordinator/handler references, and saving/title reset invalidation.

- [ ] **Step 2: Run the new test to verify red state**

Run:

```bash
node --test tools/stardew-portfolio-m8-elevator-native-given-fixture.test.mjs
```

Expected: FAIL because the fixture source does not exist.

- [ ] **Step 3: Implement the minimal fixture**

Model the private lifecycle on the proven ladder fixture, but do not copy its facility-creation state. The state machine fields are request/player/source/target-mine identities, generation, native edge, and SMAPI edge only.

Use this fixed arm seam:

```csharp
Game1.warpFarmer("UndergroundMine5", 6, 6, 2);
LocationRequest? request = Game1.locationRequest;
if (request is null || request.Name != "UndergroundMine5"
    || request.Location is not MineShaft mine || mine.mineLevel != 5)
    return this.RejectPortfolioMineElevatorGivenFixture("native_warp_request_invalid");
```

Attach a `LocationRequest.OnWarp` callback. On that callback, require the pending generation, same request, same `Game1.locationRequest`, same player/current location, `MineShaft` identity, and floor 5; then mark the native edge. In `ObservePortfolioMineElevatorGivenWarped(WarpedEventArgs e)`, require the marked native edge, exact original player/source, request target/new location/current location, same floor-5 MineShaft, and no prior SMAPI edge; then mark the SMAPI edge.

Once both edges have happened on a later safe tick, require all fresh facts and scan the current `mine.map?.GetLayer("Buildings")` deterministically. Succeed only if `mine.getTileIndexAt(new Location(x, y), "Buildings") == 112` for at least one tile. Reject missing layer/tile as `fixture_elevator_not_observed`; reject bad fresh state as `fresh_given_invalid`.

Use the same safe predicate as the ladder fixture: no pending `Game1.locationRequest`, event, dialogue, active menu, or immobilized player. `ResetPortfolioMineElevatorGivenFixture("saving")` and `("returned_to_title")` must detach/clear and terminal-reject. Do not emit map coordinates in logs or bridge facts.

- [ ] **Step 4: Connect lifecycle event delivery and run fixture test**

In `ModEntry.OnWarped`, call `ObservePortfolioMineElevatorGivenWarped(e)` alongside existing fixture observers. In saving/title lifecycle handlers, call the matching reset function.

Run:

```bash
node --test tools/stardew-portfolio-m8-elevator-native-given-fixture.test.mjs
```

Expected: PASS.

## Task 3: Close Launcher and Fixture Declaration Boundaries

**Files:**
- Modify: `tools/launch-stardew-portfolio-m8-action-live.mjs`
- Modify: `tools/launch-stardew-portfolio-m8-action-live.test.mjs`
- Modify: `fixtures/stardew/portfolio-m8-elevator-contract.example.json`
- Modify: `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`
- Modify: `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`

**Interfaces:**
- Consumes: action-derived staged declaration `m8_elevator_floor_5_given_v1` and exact one-field profile config.
- Produces: launcher verification that the elevator fixture is enabled exactly for elevator, redacted setup record outcomes, and documentation explicitly separating fixture Given setup from action closure evidence.

- [ ] **Step 1: Extend failing launcher contract cases**

Add cases asserting an elevator profile with no `MineElevatorGivenFixture` fails `m8_live_prepared_config_invalid`, a profile with `{ Enable: true, Extra: true }` fails, and ladder/entry profiles cannot carry this config. Assert the runner still requires its independent `probe.elevatorObserved === true` before action mode.

- [ ] **Step 2: Run launcher tests to verify red state**

Run:

```bash
node --test tools/launch-stardew-portfolio-m8-action-live.test.mjs tools/run-stardew-portfolio-m8-action.test.mjs
```

Expected: failure because config verification has no elevator fixture rule.

- [ ] **Step 3: Implement exact launcher validation and documentation updates**

In `verifyPreparedM8Profile`, add exact equivalence:

```js
[portfolio?.MineElevatorGivenFixture?.Enable === true, input.action === ELEVATOR_ACTION],
```

Then enforce that when present it is a non-array object with exactly key `Enable`, and its boolean value equals `input.action === ELEVATOR_ACTION`. Add `mineElevatorGivenFixture` to `validateStagedProfileOptions` forbidden caller overrides.

Update the elevator contract’s fixture state to describe `m8_elevator_floor_5_given_v1` as staged progress plus closed native fixture. State that it creates no action authority or evidence and that tile `112` is fresh-observed only after native arrival. Update `design/83` and `design/84` with the same fixed native floor-5 warp/dual-edge/tile-scan boundary and remove “unprovisioned/not implemented” wording.

- [ ] **Step 4: Re-run launcher tests**

Run:

```bash
node --test tools/launch-stardew-portfolio-m8-action-live.test.mjs tools/run-stardew-portfolio-m8-action.test.mjs
```

Expected: PASS.

## Task 4: Offline Verification and Independent Review

**Files:**
- Modify only files required by a failed focused check from Tasks 1–3.

**Interfaces:**
- Consumes: the completed fixture/config/launcher chain.
- Produces: an offline-verified, review-ready elevator non-mutation preflight candidate.

- [ ] **Step 1: Run the affected test and build set**

Run serially:

```bash
node --test tools/stardew-portfolio-profile.test.mjs tools/stardew-portfolio-m8-initial-native-load.test.mjs tools/stardew-portfolio-m8-elevator-native-given-fixture.test.mjs tools/launch-stardew-portfolio-m8-action-live.test.mjs tools/run-stardew-portfolio-m8-action.test.mjs tools/stardew-portfolio-m8-elevator-source-realization.test.mjs
dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore
pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.portfolio.json
git diff --check -- integrations/stardew/ModConfig.cs integrations/stardew/PortfolioInitialNativeLoad.cs integrations/stardew/PortfolioIntegration.cs integrations/stardew/ModEntry.cs integrations/stardew/PortfolioMineElevatorGivenFixture.cs tools/lib/stardew-portfolio-profile.mjs tools/launch-stardew-portfolio-m8-action-live.mjs tools/stardew-portfolio-m8-elevator-native-given-fixture.test.mjs tools/stardew-portfolio-profile.test.mjs tools/stardew-portfolio-m8-initial-native-load.test.mjs tools/launch-stardew-portfolio-m8-action-live.test.mjs fixtures/stardew/portfolio-m8-elevator-contract.example.json design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md design/88_M8_ELEVATOR_NATIVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md
```

Expected: tests pass, Release build has no warnings/errors, TypeScript passes, and scoped diff has no whitespace errors.

- [ ] **Step 2: Run one independent post-write review**

Review the actual diff against these rejection criteria:

```text
- Config/profile cannot enable the fixture for any action other than exact elevator.
- The fixture has one fixed floor-5 native warp and accepts no target/pose/checkpoint input.
- Bridge binding is impossible until both correlated edges and fresh tile-112 scan succeed.
- No map writes, facility injection, UI/input, pathfinding, generic warp surface, action request, receipt, evidence, or postcondition exists in the fixture.
- The fixture does not admit based on player pose/request coordinate.
- Terminal reset cannot reuse a prior successful Given.
- The regular elevator adapter still independently checks tile 112 plus finite/unlocked/non-current selected checkpoint before arm.
```

Expected: no blocker before target-version preflight.

## Task 5: Serial Target-Version Closure Gates

**Files:**
- No source edits unless an offline-covered defect is found.
- Create evidence journals only under `.tmp/m8-live-runs/`.

**Interfaces:**
- Consumes: Release Mod/Host artifacts, clean process/profile transaction state, a manifest-verified staged slot, exact elevator profile, and the new closed pre-binding fixture.
- Produces: one non-mutating Given preflight and, only if it succeeds, exactly one elevator action terminal receipt plus same-execution fresh floor reread.

- [ ] **Step 1: Verify clean transaction state**

Run the existing profile inspection and process checks. Confirm no deployed profile, no M8 staged transaction lock, and no `StardewModdingAPI.exe` / `Stardew Valley.exe` process. If any check fails, stop; do not remove an unowned staged directory or start another game process.

- [ ] **Step 2: Run exactly one non-mutating elevator preflight**

Set `GAMEBUDDY_PORTFOLIO_M8_ACTION=select_mine_elevator_floor`, `GAMEBUDDY_PORTFOLIO_M8_MODE=preflight`, and `GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT=10`; run the existing launcher once. Require `M8_ACTION_LIVE_PREFLIGHT_READY` whose runner payload is `M8_GIVEN_READY` and contains a fresh `entryObserved`, `elevatorObserved`, and unlocked checkpoint `10` distinct from the fresh current floor. Verify its journal shows `fresh_given_observed`, no `mine_elevator_request`, canonical integrity, profile restore, owned staged cleanup, and no residual process.

- [x] **Step 3: Run the separately authorized successor mutation gate — accepted action closure**

The original permitted worker was evidence-incomplete: it read an obsolete nested result shape (`live.action.result`) rather than the actual `live.action.terminal` / `live.action.freshFloor` output and therefore did not persist authority-bearing receipt/postcondition fields. It remains an unaccepted historical record; the repair did not backfill it.

After the capture boundary was repaired and covered by `.tmp/run-m8-elevator-staged-action-worker.test.mjs`, a separately authorized successor gate produced `.tmp/m8-live-runs/m8-elevator-staged-action-v2.json`. The persisted record contains `M8_ACTION_LIVE_TERMINAL`, receipt `succeeded`, reason `mine_elevator_floor_selected`, non-empty evidence, `sameExecution: true`, `actualCurrentFloor: 10`, and independent fresh reread `currentFloor: 10`, `lowestMineLevel: 10`. The fixture outcome reports a transaction-owned staged slot and canonical integrity verified; final checks confirmed profile restore, no residual game process, no profile transaction lock, and no owned staged slot. Target-version SMAPI also logs the native transition to `UndergroundMine10`.

This accepts the direct elevator action closure. The staged unlock belongs exclusively to the Given transaction; it is neither action evidence nor a persistent aggregate-progress claim.

- [x] **Step 4: Keep any future Goal evaluator outside M8 action closure**

The elevator receipt and fresh facts complete this action. `reach_mine_floor`, if ever required by a separately scoped product Goal, is a read-only aggregate evaluator rather than an M8 action or completion blocker. It must require route-associated receipts and genuine persisted progress; it must never reuse fixture-owned staged progress, send a request, replace an action receipt, move/warp the player, or claim action closure.

## Self-Review

- **Spec coverage:** Task 1 creates action-derived closed configuration and pre-binding invocation; Task 2 implements the native floor-5 fixture, dual-edge correlation, fresh facility observation, and lifecycle rejection; Task 3 closes profile/launcher/documentation boundaries; Task 4 checks all changed seams and review criteria; Task 5 separates preflight, one live mutation, cleanup, and monitor-only evaluation.
- **Placeholder scan:** The plan contains no deferred implementation markers or vague validation instructions; rejection reasons, exact method names, sources, tests, and commands are stated.
- **Type consistency:** `MineElevatorGivenFixture` is used consistently in C#, initial load, profile configuration, launcher validation, and tests; the fixture method names match the binding/lifecycle invocations in Task 2.

## Execution Handoff

Plan complete and saved to `design/88_M8_ELEVATOR_NATIVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`. Execute it now using the `subagent-driven-development` skill: one connected writer for fixture/config/profile/launcher changes, then one independent post-write review. Do not execute the live preflight or mutation until the offline gates and review are green.
