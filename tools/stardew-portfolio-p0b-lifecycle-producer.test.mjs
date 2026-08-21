import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const producerPath = new URL("../integrations/stardew/PortfolioP0bLifecycleProducer.cs", import.meta.url);
const configPath = new URL("../integrations/stardew/ModConfig.cs", import.meta.url);
const entryPath = new URL("../integrations/stardew/ModEntry.cs", import.meta.url);

test("P0b producer is default-disabled and emits a signed native start manifest", async () => {
  const [producer, config, entry] = await Promise.all([
    readFile(producerPath, "utf8"),
    readFile(configPath, "utf8"),
    readFile(entryPath, "utf8"),
  ]);
  assert.match(config, /public PortfolioP0bLifecycleProducerConfig\? P0bLifecycleProducer/);
  assert.match(config, /public bool Enable \{ get; init; \}/);
  assert.match(config, /public string StartManifestPath \{ get; init; \}/);
  assert.match(config, /public string SigningKeyEnvironmentVariableName \{ get; init; \}/);
  assert.doesNotMatch(config, /public string SigningKey \{ get; init; \}/);
  assert.match(config, /Path\.IsPathFullyQualified\(StartManifestPath\)/);
  assert.match(config, /IsValidEnvironmentVariableName\(SigningKeyEnvironmentVariableName\)/);
  assert.match(producer, /Environment\.GetEnvironmentVariable\(producer\.SigningKeyEnvironmentVariableName\)/);
  assert.match(producer, /signingKey is null \|\| signingKey\.Length is < 16 or > 256/);
  assert.doesNotMatch(producer, /Log\([^\n]*signingKey/);
  assert.match(producer, /producer is not \{ Enable: true \}/);
  assert.match(producer, /this\.config\.IsP0bExclusiveConfigurationValid/);
  assert.match(producer, /p0b_exclusive_configuration_invalid/);
  assert.match(producer, /this\.config\.Portfolio\?\.Bootstrap is \{ Enable: true \}/);
  assert.match(config, /IsP0bExclusiveConfigurationValid/);
  assert.match(config, /NativeLocalPlayerFixture\?\.Bootstrap\?\.Enable != true/);
  for (const mode of [
    "NativeLocalPlayerFixture",
    "HostAutomation",
    "HostFarmhandProvisioning",
    "FarmhandProvisioner",
    "FarmhandProvisioningProbe",
  ]) {
    assert.match(config, new RegExp(`this\\.${mode}\\?\\.Enable != true`));
  }
  assert.match(
    entry,
    /P0b requires every fixture, bootstrap, automation, and provisioning mode to be explicitly disabled/,
  );
  const saveLoadedHandler = entry.slice(
    entry.indexOf("private void OnSaveLoaded"),
    entry.indexOf("private void TryInitializeNativeLocalPlayerFixture"),
  );
  const updateTickedHandler = entry.slice(
    entry.indexOf("private void OnUpdateTicked"),
    entry.indexOf("private void OnWarped"),
  );
  assert.match(saveLoadedHandler, /if \(this\.provisioningConfigurationRejected\)\s*return;/);
  assert.match(updateTickedHandler, /if \(this\.provisioningConfigurationRejected\)\s*return;/);
  assert.ok(
    updateTickedHandler.indexOf("provisioningConfigurationRejected") <
      updateTickedHandler.indexOf("TryInitializePortfolioBinding"),
  );
  assert.ok(
    updateTickedHandler.indexOf("provisioningConfigurationRejected") <
      updateTickedHandler.indexOf("UpdatePortfolioP0bLifecycleProducer"),
  );
  assert.ok(
    updateTickedHandler.indexOf("provisioningConfigurationRejected") <
      updateTickedHandler.indexOf("UpdatePortfolioBridge"),
  );
  assert.match(
    producer,
    /!Context\.IsWorldReady \|\| !Game1\.hasLoadedGame \|\| Game1\.player is null \|\| this\.portfolioBinding is null/,
  );
  assert.match(producer, /Game1\.GetSaveGameName\(set_value: false\)/);
  assert.match(config, /LogicalSaveName\.All\(IsAsciiSaveNameCharacter\)/);
  assert.match(config, /public string ObservedSaveSlot \{ get; init; \}/);
  assert.match(config, /IsObservedSaveSlotForLogicalName\(ObservedSaveSlot, LogicalSaveName\)/);
  assert.match(producer, /value\.All\(IsAsciiSaveNameCharacter\)/);
  assert.match(config, /character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-'/);
  assert.match(producer, /character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-'/);
  const producerLogicalNameValidator =
    producer.match(
      /private static bool IsPortfolioP0bLogicalSaveName[\s\S]*?private static bool IsPortfolioP0bObservedSaveSlot/,
    )?.[0] ?? "";
  assert.match(producerLogicalNameValidator, /!value\.EndsWith\("_", StringComparison\.Ordinal\)/);
  assert.doesNotMatch(producerLogicalNameValidator, /char\.IsLetterOrDigit/);
  assert.match(producer, /string observedSaveSlot = \$"\{logicalSaveName\}_\{Game1\.uniqueIDForThisGame\}"/);
  assert.match(producer, /SaveGame\.Load\(producer\.ObservedSaveSlot\);/);
  assert.match(producer, /PortfolioP0bLifecycleStage\.AwaitingInitialLoad/);
  assert.match(producer, /SaveGame\.Load\(this\.portfolioP0bObservedSaveSlot\)/);
  assert.doesNotMatch(producer, /SaveGame\.Load\(this\.portfolioP0bLogicalSaveName\)/);
  assert.match(producer, /Game1\.ExitToTitle\(\)/);
  assert.match(producer, /Game1\.exitActiveMenu\(\)/);
  assert.doesNotMatch(producer, /CleanupReturningToTitle\(\)/);
  assert.match(producer, /artifactKind"] = "portfolio_start_manifest"/);
  assert.match(producer, /HMACSHA256/);
  assert.match(producer, /CanonicalJson/);
  assert.match(producer, /HashFile\(savePath\)/);
  assert.match(producer, /HashFile\(saveGameInfoPath\)/);
  assert.match(producer, /HashFile\(dllPath\)/);
  assert.match(producer, /File\.Move\(temporary, outputPath\);/);
  assert.doesNotMatch(producer, /File\.Move\(temporary, outputPath, overwrite:/);
  assert.match(producer, /manifest_output_path_must_use_dedicated_external_evidence_parent/);
  assert.match(producer, /PathsOverlap\(outputDirectory, saveRoot\)/);
  assert.match(producer, /PathsOverlap\(outputPath, savePath\)/);
  assert.match(producer, /PathsOverlap\(outputPath, saveGameInfoPath\)/);
  assert.match(producer, /manifest_output_parent_or_destination_changed/);
  assert.match(producer, /manifest_output_post_publish_reparse/);
  assert.doesNotMatch(producer, /unsigned-native-lifecycle-trace/);
  assert.doesNotMatch(producer, /explicitlyNotStartManifest/);
});

test("P0b producer preserves required event sequencing and records distinct initial and reloaded bindings", async () => {
  const producer = await readFile(producerPath, "utf8");
  const saving = producer.indexOf('this.portfolioP0bEvents.Add("Saving")');
  const saved = producer.indexOf('this.portfolioP0bEvents.Add("Saved")');
  const exit = producer.indexOf("Game1.ExitToTitle()");
  const title = producer.indexOf('this.portfolioP0bEvents.Add("ReturnedToTitle")');
  const load = producer.indexOf("SaveGame.Load(this.portfolioP0bObservedSaveSlot)");
  const loaded = producer.indexOf('this.portfolioP0bEvents.Add("SaveLoaded")');
  assert.ok(saving < saved && saved < exit && exit < title && title < load && load < loaded);
  assert.match(producer, /PortfolioLocalPlayerBinding\? portfolioP0bInitialBinding/);
  assert.match(producer, /PortfolioLocalPlayerBinding\? portfolioP0bReloadedBinding/);
  assert.match(producer, /reloaded\.BindingGeneration <= initial\.BindingGeneration/);
  assert.doesNotMatch(producer, /nativeScope = new/);
  assert.match(producer, /artifactKind"] = "portfolio_start_manifest"/);
  assert.match(producer, /signatureAlgorithm"] = "hmac-sha256"/);
  assert.match(producer, /checkedMilestones"] = Enumerable\.Range\(1, 10\)/);
  assert.match(producer, /reopenVerified"] = true/);
  assert.match(producer, /\["nativePlayerScope"\] = ToPortfolioP0bNativePlayerScope\(reloaded\)/);
});

test("P0b clears live bindings before producer callbacks and rejects reparse trace paths", async () => {
  const [producer, entry] = await Promise.all([readFile(producerPath, "utf8"), readFile(entryPath, "utf8")]);
  const savingHandler = entry.slice(entry.indexOf("private void OnSaving"), entry.indexOf("private void OnSaved"));
  const titleHandler = entry.slice(
    entry.indexOf("private void OnReturnedToTitle"),
    entry.indexOf("private void TraceCommand"),
  );
  assert.ok(
    savingHandler.indexOf('this.InvalidatePortfolioState("portfolio_saving")') <
      savingHandler.indexOf("this.OnPortfolioP0bSaving()"),
  );
  assert.ok(
    titleHandler.indexOf('this.InvalidatePortfolioState("portfolio_returned_to_title")') <
      titleHandler.indexOf("this.OnPortfolioP0bReturnedToTitle()"),
  );
  assert.match(entry, /this\.TryInitializePortfolioBinding\(\);\s*this\.OnPortfolioP0bSaveLoaded\(\);/);
  assert.match(producer, /initial_loaded_save_identity_mismatch/);
  assert.match(producer, /FileAttributes\.ReparsePoint/);
  assert.match(producer, /IsExistingNonReparseDirectoryTree\(outputDirectory\)/);
  assert.match(producer, /IsExistingNonReparseDirectoryTree\(saveRoot\)/);
  assert.match(producer, /IsExistingNonReparseDirectoryTree\(saveDirectory\)/);
  assert.match(producer, /IsRegularNonReparseFileTree\(savePath\)/);
  assert.match(producer, /IsRegularNonReparseFileTree\(saveGameInfoPath\)/);
  assert.match(producer, /IsRegularNonReparseFileTree\(dllPath\)/);
  assert.match(producer, /IsRegularNonReparseFileTree\(temporary\)/);
  assert.match(producer, /PathExists\(outputPath\)/);
  assert.match(producer, /!IsExistingNonReparseDirectoryTree\(outputDirectory\)/);
});

test("P0b publication boundaries invoke recursive ancestor reparse checks for all authority paths", async () => {
  const producer = await readFile(producerPath, "utf8");
  // Structural-only proof: this test verifies source wiring, not Windows filesystem behavior.
  const writeMethod = producer.slice(
    producer.indexOf("private bool WritePortfolioP0bStartManifest"),
    producer.indexOf("private static string HashFile"),
  );
  assert.match(writeMethod, /IsExistingNonReparseDirectoryTree\(outputDirectory\)/);
  assert.match(writeMethod, /IsExistingNonReparseDirectoryTree\(saveRoot\)/);
  assert.match(writeMethod, /IsExistingNonReparseDirectoryTree\(saveDirectory\)/);
  assert.match(writeMethod, /IsRegularNonReparseFileTree\(savePath\)/);
  assert.match(writeMethod, /IsRegularNonReparseFileTree\(saveGameInfoPath\)/);
  assert.match(writeMethod, /IsRegularNonReparseFileTree\(dllPath\)/);
  assert.match(producer, /private static bool IsNonReparsePathTree\(string path\)/);
  assert.match(producer, /Directory\.GetParent\(current\)/);
  assert.match(producer, /IsNonReparsePathTree\(path\)/);
});
