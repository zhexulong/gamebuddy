import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixturePath = new URL("../integrations/stardew/PortfolioMineElevatorGivenFixture.cs", import.meta.url);
const integrationPath = new URL("../integrations/stardew/PortfolioIntegration.cs", import.meta.url);
const entryPath = new URL("../integrations/stardew/ModEntry.cs", import.meta.url);
const configPath = new URL("../integrations/stardew/ModConfig.cs", import.meta.url);
const initialLoadPath = new URL("../integrations/stardew/PortfolioInitialNativeLoad.cs", import.meta.url);

test("M8 elevator Given is a closed pre-binding native facility observer", async () => {
  const [fixture, integration, entry, config, initialLoad] = await Promise.all([
    readFile(fixturePath, "utf8"),
    readFile(integrationPath, "utf8"),
    readFile(entryPath, "utf8"),
    readFile(configPath, "utf8"),
    readFile(initialLoadPath, "utf8"),
  ]);
  const arm = fixture.slice(
    fixture.indexOf("private bool TryPreparePortfolioMineElevatorGivenFixture"),
    fixture.indexOf("private void ObservePortfolioMineElevatorGivenNativeWarp"),
  );
  const nativeObserver = fixture.slice(
    fixture.indexOf("private void ObservePortfolioMineElevatorGivenNativeWarp"),
    fixture.indexOf("private void ObservePortfolioMineElevatorGivenWarped"),
  );
  const playerObserver = fixture.slice(
    fixture.indexOf("private void ObservePortfolioMineElevatorGivenWarped"),
    fixture.indexOf("private bool TrySettlePortfolioMineElevatorGivenFixture"),
  );
  const settle = fixture.slice(
    fixture.indexOf("private bool TrySettlePortfolioMineElevatorGivenFixture"),
    fixture.indexOf("private bool HasPortfolioMineElevatorGivenFacility"),
  );
  const facility = fixture.slice(
    fixture.indexOf("private bool HasPortfolioMineElevatorGivenFacility"),
    fixture.indexOf("private bool IsPortfolioMineElevatorGivenFixtureSafe"),
  );

  assert.match(config, /public PortfolioMineElevatorGivenFixtureConfig\? MineElevatorGivenFixture \{ get; init; \}/);
  assert.match(config, /MineElevatorGivenFixture is null \|\| !MineElevatorGivenFixture\.Enable/);
  assert.match(config, /internal bool IsMineElevatorActionSequence => this\.EnabledActions\.Count == 1/);
  assert.match(initialLoad, /MineElevatorGivenFixture = portfolio\.MineElevatorGivenFixture/);
  const binding = integration.slice(
    integration.indexOf("private void TryInitializePortfolioBinding"),
    integration.indexOf("private void UpdatePortfolioBridge"),
  );
  assert.ok(
    binding.indexOf("this.TryPreparePortfolioMineElevatorGivenFixture()") < binding.indexOf("this.portfolioBinding ="),
  );

  assert.match(arm, /Game1\.warpFarmer\("UndergroundMine5", 6, 6, 2\)/);
  assert.equal((arm.match(/Game1\.warpFarmer\(/g) ?? []).length, 1);
  assert.match(arm, /request\.Name != "UndergroundMine5"/);
  assert.match(arm, /mine\.mineLevel != 5/);
  assert.match(arm, /request\.OnWarp \+= handler/);
  assert.doesNotMatch(fixture, /setMapTile\(|createLadderDown\(|Game1\.enterMine\(/);
  assert.doesNotMatch(fixture, /GetGrabTile\(|PathFindController|MineElevatorMenu|checkAction\(/);
  assert.doesNotMatch(fixture, /\.Tile|new Vector2\(6, 6\)/);
  assert.doesNotMatch(
    fixture,
    /PortfolioBridgeSession|PortfolioLocalPipeBridge|Portfolio\w*Receipt|Portfolio\w*Evidence|HandlePortfolio\w+/,
  );

  assert.match(nativeObserver, /ReferenceEquals\(Game1\.locationRequest, request\)/);
  assert.match(nativeObserver, /portfolioMineElevatorGivenFixtureNativeWarpObserved = true/);
  assert.match(playerObserver, /portfolioMineElevatorGivenFixtureNativeWarpObserved/);
  assert.match(
    playerObserver,
    /ReferenceEquals\(e\.OldLocation, this\.portfolioMineElevatorGivenFixtureSourceLocation\)/,
  );
  assert.match(playerObserver, /portfolioMineElevatorGivenFixturePlayerWarpObserved = true/);
  assert.match(
    settle,
    /!this\.portfolioMineElevatorGivenFixtureNativeWarpObserved\s*\|\|\s*!this\.portfolioMineElevatorGivenFixturePlayerWarpObserved/,
  );
  assert.match(settle, /mine\.NameOrUniqueName != "UndergroundMine5" \|\| mine\.mineLevel != 5/);
  assert.match(settle, /MineShaft\.lowestLevelReached < 10/);
  assert.match(settle, /fixture_elevator_not_observed/);
  assert.match(facility, /mine\.getTileIndexAt\(new Location\(x, y\), "Buildings"\) == 112/);
  assert.match(fixture, /NotArmed,[\s\S]*AwaitingSafeTick,[\s\S]*Pending,[\s\S]*Succeeded,[\s\S]*Rejected/);
  assert.match(entry, /this\.ObservePortfolioMineElevatorGivenWarped\(e\)/);
  assert.match(entry, /this\.ResetPortfolioMineElevatorGivenFixture\("saving"\)/);
  assert.match(entry, /this\.ResetPortfolioMineElevatorGivenFixture\("returned_to_title"\)/);
});
