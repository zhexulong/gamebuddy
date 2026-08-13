import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const initialLoadPath = new URL("../integrations/stardew/PortfolioInitialNativeLoad.cs", import.meta.url);
const integrationPath = new URL("../integrations/stardew/PortfolioIntegration.cs", import.meta.url);
const entryPath = new URL("../integrations/stardew/ModEntry.cs", import.meta.url);
const configPath = new URL("../integrations/stardew/ModConfig.cs", import.meta.url);

test("M8 one-shot initial native load opens a binding only after exact successful completion", async () => {
  const [initialLoad, integration, entry, config] = await Promise.all([
    readFile(initialLoadPath, "utf8"),
    readFile(integrationPath, "utf8"),
    readFile(entryPath, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  assert.match(initialLoad, /private bool portfolioInitialNativeLoadSucceeded;/);
  const completion = initialLoad.slice(
    initialLoad.indexOf("private PortfolioInitialNativeLoadCompletion TryCompletePortfolioInitialNativeLoad"),
    initialLoad.indexOf("private enum PortfolioInitialNativeLoadCompletion"),
  );
  const success = completion.indexOf("this.portfolioInitialNativeLoadSucceeded = true;");
  const terminal = completion.lastIndexOf("this.portfolioInitialNativeLoadTerminal = true;");
  assert.ok(success >= 0 && terminal > success, "only the accepted completion may set successful before terminal state");

  const binding = integration.slice(integration.indexOf("private void TryInitializePortfolioBinding"), integration.indexOf("private void UpdatePortfolioBridge"));
  assert.match(binding, /config\.InitialNativeLoad is \{ Enable: true \} \|\|\s*\(this\.portfolioInitialNativeLoadTerminal && !this\.portfolioInitialNativeLoadSucceeded\)/);

  const saveLoaded = entry.slice(entry.indexOf("private void OnSaveLoaded"), entry.indexOf("private void TryInitializeNativeLocalPlayerFixture"));
  const initialBranch = saveLoaded.slice(saveLoaded.indexOf("InitialNativeLoad is { Enable: true }"));
  assert.ok(initialBranch.indexOf("PortfolioInitialNativeLoadCompletion.Succeeded") < initialBranch.indexOf("this.TryInitializePortfolioBinding();"));
  assert.match(config, /return value\.Length is >= 21 and <= 179/);
  assert.match(config, /value\[\.\.separator\]\.All\(IsAsciiObservedSlotCharacter\)/);
  assert.match(config, /private static bool IsAsciiObservedSlotCharacter\(char character\) =>/);
  const ticked = entry.slice(entry.indexOf("private void OnUpdateTicked"), entry.indexOf("private void TryStartHostAutomation"));
  const initialLoadTick = ticked.slice(ticked.indexOf("Portfolio?.InitialNativeLoad is { Enable: true }"));
  assert.match(initialLoadTick, /this\.TryLoadPortfolioInitialNativeSave\(\);\s*\/\/ An armed one-shot loader[\s\S]*?return;/);
});
