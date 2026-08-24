import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const initialLoadPath = new URL("../integrations/stardew/PortfolioInitialNativeLoad.cs", import.meta.url);
const integrationPath = new URL("../integrations/stardew/PortfolioIntegration.cs", import.meta.url);
const entryPath = new URL("../integrations/stardew/ModEntry.cs", import.meta.url);
const configPath = new URL("../integrations/stardew/ModConfig.cs", import.meta.url);
const fixturePath = new URL("../integrations/stardew/PortfolioMineEntryGivenFixture.cs", import.meta.url);
const skipEventAdapterPath = new URL("../integrations/stardew/PortfolioSkipEventSemanticAdapter.cs", import.meta.url);

test("M8 one-shot initial native load opens a binding only after exact successful completion", async () => {
  const [initialLoad, integration, entry, config, fixture, skipEventAdapter] = await Promise.all([
    readFile(initialLoadPath, "utf8"),
    readFile(integrationPath, "utf8"),
    readFile(entryPath, "utf8"),
    readFile(configPath, "utf8"),
    readFile(fixturePath, "utf8"),
    readFile(skipEventAdapterPath, "utf8"),
  ]);
  assert.match(initialLoad, /private bool portfolioInitialNativeLoadSucceeded;/);
  const completion = initialLoad.slice(
    initialLoad.indexOf("private PortfolioInitialNativeLoadCompletion TryCompletePortfolioInitialNativeLoad"),
    initialLoad.indexOf("private enum PortfolioInitialNativeLoadCompletion"),
  );
  const success = completion.indexOf("this.portfolioInitialNativeLoadSucceeded = true;");
  const terminal = completion.lastIndexOf("this.portfolioInitialNativeLoadTerminal = true;");
  assert.ok(
    success >= 0 && terminal > success,
    "only the accepted completion may set successful before terminal state",
  );

  const binding = integration.slice(
    integration.indexOf("private void TryInitializePortfolioBinding"),
    integration.indexOf("private void UpdatePortfolioBridge"),
  );
  assert.match(
    binding,
    /config\.InitialNativeLoad is \{ Enable: true \} \|\|\s*\(this\.portfolioInitialNativeLoadTerminal && !this\.portfolioInitialNativeLoadSucceeded\)/,
  );

  const saveLoaded = entry.slice(
    entry.indexOf("private void OnSaveLoaded"),
    entry.indexOf("private void TryInitializeNativeLocalPlayerFixture"),
  );
  const initialBranch = saveLoaded.slice(saveLoaded.indexOf("InitialNativeLoad is { Enable: true }"));
  assert.ok(
    initialBranch.indexOf("PortfolioInitialNativeLoadCompletion.Succeeded") <
      initialBranch.indexOf("this.TryInitializePortfolioBinding();"),
  );
  assert.match(config, /return value\.Length is >= 21 and <= 179/);
  assert.match(config, /value\[\.\.separator\]\.All\(IsAsciiObservedSlotCharacter\)/);
  assert.match(config, /private static bool IsAsciiObservedSlotCharacter\(char character\) =>/);
  const ticked = entry.slice(
    entry.indexOf("private void OnUpdateTicked"),
    entry.indexOf("private void TryStartHostAutomation"),
  );
  const initialLoadTick = ticked.slice(ticked.indexOf("Portfolio?.InitialNativeLoad is { Enable: true }"));
  assert.match(
    initialLoadTick,
    /this\.TryLoadPortfolioInitialNativeSave\(\);\s*\/\/ An armed one-shot loader[\s\S]*?return;/,
  );

  const portfolioConfig = config.slice(config.indexOf("public sealed class PortfolioConfig"));
  assert.match(
    portfolioConfig,
    /public PortfolioMineEntryGivenFixtureConfig\?? MineEntryGivenFixture \{ get; init; \}/,
  );
  assert.match(portfolioConfig, /MineEntryGivenFixture is null \|\| !MineEntryGivenFixture\.Enable/);
  assert.match(
    portfolioConfig,
    /public PortfolioMineLadderGivenFixtureConfig\? MineLadderGivenFixture \{ get; init; \}/,
  );
  assert.match(portfolioConfig, /MineLadderGivenFixture is null \|\| !MineLadderGivenFixture\.Enable/);
  assert.match(completion, /MineLadderGivenFixture = portfolio\.MineLadderGivenFixture/);
  assert.match(
    portfolioConfig,
    /public PortfolioMineElevatorGivenFixtureConfig\? MineElevatorGivenFixture \{ get; init; \}/,
  );
  assert.match(portfolioConfig, /MineElevatorGivenFixture is null \|\| !MineElevatorGivenFixture\.Enable/);
  assert.match(completion, /MineElevatorGivenFixture = portfolio\.MineElevatorGivenFixture/);
  assert.match(fixture, /PortfolioMineEntryGivenFixtureState\.Pending/);
  assert.match(
    fixture,
    /Game1\.warpFarmer\("Mine", 23, 8, false\)/,
    "the bridge-before-binding Given must use the native Game1 warp seam; Farmer.warpFarmer is a no-op while the native skip_event Event is active",
  );
  assert.doesNotMatch(fixture, /player\.warpFarmer\(new StardewValley\.Warp\(/);
  const warpedCallback = fixture.slice(
    fixture.indexOf("private void ObservePortfolioMineEntryGivenWarped"),
    fixture.indexOf("private static string ReadPortfolioMineEntryAction"),
  );
  const settleCall = warpedCallback.indexOf("this.TrySettlePortfolioMineEntryGivenFixture()");
  const settleMethod = fixture.slice(
    fixture.indexOf("private bool TrySettlePortfolioMineEntryGivenFixture"),
    fixture.indexOf("private bool IsBlockingForCurrentProfile"),
  );
  assert.ok(settleCall >= 0, "Mine Given must settle only from the fresh native Warped callback");
  assert.doesNotMatch(
    fixture,
    /\.Position\s*=|\.faceDirection\(|GetGrabTile\(|TilePoint/,
    "Mine-exterior setup must not mutate or require an interaction pose",
  );
  assert.match(settleMethod, /IsBlockingForCurrentProfile\(player\)[\s\S]*?TryReadPortfolioMineEntryGiven\(player\)/);
  assert.doesNotMatch(fixture, /IsAwaitingSkippablePortfolioMineEntryEvent|CurrentEvent\?\.skippable != true/);
  assert.match(fixture, /return !isSkipEventCombo\s*\|\|\s*!Game1\.eventUp\s*\|\|\s*Game1\.CurrentEvent is null;/);
  assert.match(fixture, /return Game1\.dialogueUp \|\| Game1\.activeClickableMenu is not null \|\| !player\.CanMove;/);
  const succeededFixture = fixture.slice(
    fixture.indexOf("if (this.portfolioMineEntryGivenFixtureState == PortfolioMineEntryGivenFixtureState.Succeeded)"),
    fixture.indexOf("if (this.portfolioMineEntryGivenFixtureState == PortfolioMineEntryGivenFixtureState.Pending)"),
  );
  assert.match(succeededFixture, /PortfolioMineEntryGivenFixtureState\.Succeeded\)[\s\S]*?return true;/);
  assert.doesNotMatch(
    succeededFixture,
    /IsBlockingForCurrentProfile|portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState\.Rejected/,
  );
  assert.ok(
    binding.indexOf("this.TryPreparePortfolioMineEntryGivenFixture()") < binding.indexOf("this.portfolioBinding ="),
    "fixture preparation must complete before binding ownership in the lifecycle slice",
  );
  assert.ok(
    binding.indexOf("this.TryPreparePortfolioMineLadderGivenFixture()") < binding.indexOf("this.portfolioBinding ="),
    "ladder Given preparation must complete before binding ownership in the lifecycle slice",
  );
  assert.ok(
    binding.indexOf("this.TryPreparePortfolioMineElevatorGivenFixture()") < binding.indexOf("this.portfolioBinding ="),
    "elevator Given preparation must complete before binding ownership in the lifecycle slice",
  );
  assert.doesNotMatch(
    fixture,
    /PortfolioBridgeSession|PortfolioLocalPipeBridge|Portfolio\w*Receipt|Portfolio\w*Evidence|HandlePortfolio\w+/,
  );
  const postSkipObservation = skipEventAdapter.slice(
    skipEventAdapter.indexOf("internal void ObserveAfterEventUpdate()"),
    skipEventAdapter.indexOf("internal void DiscardPendingForInvalidation()"),
  );
  assert.match(postSkipObservation, /if \(!eventCleared\)\s*return;[\s\S]*?if \(!stateClean\)\s*return;/);
  assert.ok(
    postSkipObservation.indexOf("if (!stateClean)") <
      postSkipObservation.indexOf("this.observePostcondition(postcondition)"),
    "a transient native UI/action lock must remain pending before any skip_event terminal postcondition is emitted",
  );
  assert.ok(
    postSkipObservation.indexOf("if (!stateClean)") <
      postSkipObservation.indexOf("long revision = this.nextRevision()"),
    "the dirty transient branch must return before creating a terminal postcondition observation",
  );
});
