import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixturePath = new URL("../integrations/stardew/PortfolioMineLadderGivenFixture.cs", import.meta.url);
const integrationPath = new URL("../integrations/stardew/PortfolioIntegration.cs", import.meta.url);
const entryPath = new URL("../integrations/stardew/ModEntry.cs", import.meta.url);
const configPath = new URL("../integrations/stardew/ModConfig.cs", import.meta.url);
const initialLoadPath = new URL("../integrations/stardew/PortfolioInitialNativeLoad.cs", import.meta.url);

test("M8 ladder Given fixture is fixed, pre-binding, and only settles from both native edges", async () => {
  const [fixture, integration, entry, config, initialLoad] = await Promise.all([
    readFile(fixturePath, "utf8"),
    readFile(integrationPath, "utf8"),
    readFile(entryPath, "utf8"),
    readFile(configPath, "utf8"),
    readFile(initialLoadPath, "utf8"),
  ]);

  const executable = fixture.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.match(executable, /Game1\.warpFarmer\("UndergroundMine2", 6, 6, 2\)/);
  assert.equal((executable.match(/Game1\.warpFarmer\(/g) ?? []).length, 1);
  assert.equal((executable.match(/\.createLadderDown\(/g) ?? []).length, 1);
  assert.match(executable, /private bool TryCreatePortfolioMineLadderGivenFacility\(MineShaft mine\)/);
  assert.match(executable, /mine\.isTileClearForMineObjects\(x, y\)/);
  assert.match(executable, /mine\.createLadderDown\(x, y\)/);
  assert.doesNotMatch(executable, /createLadderDown\([^)]*,[^)]*,/);
  assert.doesNotMatch(executable, /setMapTile\(/);
  assert.doesNotMatch(executable, /Game1\.enterMine\(/);
  assert.doesNotMatch(
    fixture,
    /\b(?:PortfolioMineLadderActionCoordinator|PortfolioMineLadderSemanticAdapter|PortfolioBridgeSession|PortfolioLocalPipeBridge)\b/,
  );
  assert.doesNotMatch(fixture, /\bHandlePortfolio\w+/);
  assert.doesNotMatch(fixture, /GetGrabTile\(|PathFindController|MineElevatorMenu/);
  assert.doesNotMatch(fixture, /\b(?:Game1\.)?player\.Position\s*=|\.faceDirection\s*\(/);

  assert.match(fixture, /NotArmed,\s*AwaitingSafeTick,\s*Pending,\s*Succeeded,\s*Rejected/s);
  assert.match(fixture, /LocationRequest\? request = Game1\.locationRequest/);
  assert.match(fixture, /request\.OnWarp \+= handler/);
  const nativeObserver = fixture.slice(
    fixture.indexOf("private void ObservePortfolioMineLadderGivenNativeWarp"),
    fixture.indexOf("private void ObservePortfolioMineLadderGivenWarped"),
  );
  assert.match(nativeObserver, /ReferenceEquals\(Game1\.locationRequest, request\)/);
  assert.match(nativeObserver, /ReferenceEquals\(Game1\.player\?\.currentLocation, request\.Location\)/);
  assert.match(nativeObserver, /portfolioMineLadderGivenFixtureNativeWarpObserved = true/);
  const playerObserver = fixture.slice(
    fixture.indexOf("private void ObservePortfolioMineLadderGivenWarped"),
    fixture.indexOf("private bool TrySettlePortfolioMineLadderGivenFixture"),
  );
  assert.match(playerObserver, /portfolioMineLadderGivenFixtureNativeWarpObserved/);
  assert.match(
    playerObserver,
    /ReferenceEquals\(e\.OldLocation, this\.portfolioMineLadderGivenFixtureSourceLocation\)/,
  );
  assert.match(playerObserver, /ReferenceEquals\(e\.NewLocation, request\.Location\)/);
  assert.match(playerObserver, /ReferenceEquals\(e\.Player, Game1\.player\)/);
  assert.match(playerObserver, /portfolioMineLadderGivenFixturePlayerWarpObserved = true/);
  const settle = fixture.slice(
    fixture.indexOf("private bool TrySettlePortfolioMineLadderGivenFixture"),
    fixture.indexOf("private bool TryCreatePortfolioMineLadderGivenFacility"),
  );
  assert.match(
    settle,
    /!this\.portfolioMineLadderGivenFixtureNativeWarpObserved\s*\|\|\s*!this\.portfolioMineLadderGivenFixturePlayerWarpObserved/,
  );
  assert.match(settle, /Game1\.locationRequest is not null/);
  assert.match(settle, /mine\.NameOrUniqueName != "UndergroundMine2" \|\| mine\.mineLevel != 2/);
  assert.doesNotMatch(settle, /player\.Tile|freshPlayer\.Tile|new Vector2\(6, 6\)/);
  assert.match(settle, /MineShaft\.lowestLevelReached != 2/);
  assert.match(settle, /!this\.portfolioMineLadderGivenFixtureLadderCreationIssued/);
  assert.match(settle, /TryCreatePortfolioMineLadderGivenFacility\(mine\)/);
  assert.match(settle, /portfolioMineLadderGivenFixtureLadderCreationIssued = true/);
  assert.match(settle, /return false;/);
  assert.match(settle, /portfolioMineLadderGivenFixtureLadderCreationPoint is not Point point/);
  assert.match(settle, /freshMine\.getTileIndexAt\(new Location\(point\.X, point\.Y\), "Buildings"\) != 173/);
  assert.match(fixture, /fixture_ladder_tile_unavailable/);
  assert.match(fixture, /fixture_ladder_creation_exception/);
  assert.match(fixture, /fixture_ladder_not_observed/);
  assert.match(fixture, /portfolioMineLadderGivenFixtureLadderCreationPoint = new Point\(x, y\)/);
  assert.match(fixture, /request\.OnWarp -= handler/);
  assert.match(fixture, /portfolioMineLadderGivenFixtureLadderCreationIssued = false/);
  assert.match(fixture, /PortfolioMineLadderGivenFixtureState\.Rejected/);
  const reset = fixture.slice(
    fixture.indexOf("private void ResetPortfolioMineLadderGivenFixture"),
    fixture.indexOf("private void DetachPortfolioMineLadderGivenFixtureRequestHandler"),
  );
  assert.match(reset, /portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState\.NotArmed/);
  assert.doesNotMatch(reset, /PortfolioMineLadderGivenFixtureState\.Succeeded/);

  const binding = integration.slice(
    integration.indexOf("private void TryInitializePortfolioBinding"),
    integration.indexOf("private void UpdatePortfolioBridge"),
  );
  assert.ok(
    binding.indexOf("this.TryPreparePortfolioMineLadderGivenFixture()") < binding.indexOf("this.portfolioBinding ="),
  );
  assert.match(entry, /this\.ObservePortfolioMineLadderGivenWarped\(e\)/);
  assert.match(entry, /this\.ResetPortfolioMineLadderGivenFixture\("saving"\)/);
  assert.match(entry, /this\.ResetPortfolioMineLadderGivenFixture\("returned_to_title"\)/);
  assert.match(config, /public PortfolioMineLadderGivenFixtureConfig\? MineLadderGivenFixture \{ get; init; \}/);
  assert.match(config, /IsMineLadderActionSequence/);
  assert.match(initialLoad, /MineLadderGivenFixture = portfolio\.MineLadderGivenFixture/);
});
