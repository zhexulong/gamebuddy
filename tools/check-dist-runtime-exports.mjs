import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const vendorPluginDist = resolve(repoRoot, "vendor/magic-context/packages/pi-plugin/dist");

async function main() {
  console.log("Checking dist runtime exports...");
  const errors = [];

  // 1. Check dist/index.js (Package Root)
  try {
    const rootUrl = pathToFileURL(resolve(vendorPluginDist, "index.js")).href;
    const rootModule = await import(rootUrl);
    // Root must NOT leak Memory facade or capability minting
    if (typeof rootModule.createGameBuddyPlayerMemoryCrudFacade !== "undefined") {
      errors.push("root dist leaks createGameBuddyPlayerMemoryCrudFacade");
    }
    if (typeof rootModule.publishGameBuddyAuthoredStableCatalog !== "undefined") {
      errors.push("root dist leaks publishGameBuddyAuthoredStableCatalog");
    }
    console.log("  [PASS] root dist export boundaries verified");
  } catch (err) {
    errors.push(`failed to load root dist: ${err.message}`);
  }

  // 2. Check dist/tavern/index.js (Tavern Subpath)
  try {
    const tavernUrl = pathToFileURL(resolve(vendorPluginDist, "tavern/index.js")).href;
    const tavernModule = await import(tavernUrl);

    // Required functions for Host construction and gate observation
    const requiredTavernFunctions = [
      "publishGameBuddyAuthoredStableCatalog",
      "replaceGameBuddyAuthoredStableCatalog",
      "registerTavernNarrativeGateMarker",
      "clearTavernNarrativeGateMarker",
      "registerGameOperationalGateMarker",
      "registerTavernProviderStartObserver",
      "validateTavernNarrativeGateMarkerConfig",
    ];

    for (const fnName of requiredTavernFunctions) {
      if (typeof tavernModule[fnName] !== "function") {
        errors.push(`dist/tavern/index.js missing required export: ${fnName} (got ${typeof tavernModule[fnName]})`);
      }
    }

    // Prohibited: raw prompt renderers should stay engine-internal
    if (typeof tavernModule.renderGameBuddyVolatileContextBlock !== "undefined") {
      errors.push("dist/tavern/index.js inappropriately exports raw renderer: renderGameBuddyVolatileContextBlock");
    }
    if (typeof tavernModule.renderGameBuddyStableContextBlock !== "undefined") {
      errors.push("dist/tavern/index.js inappropriately exports raw renderer: renderGameBuddyStableContextBlock");
    }

    if (!errors.some(e => e.includes("dist/tavern"))) {
      console.log("  [PASS] tavern dist export closure verified");
    }
  } catch (err) {
    errors.push(`failed to load tavern dist: ${err.message}`);
  }

  // 3. Check dist/memory/index.js (Memory Subpath)
  try {
    const memoryUrl = pathToFileURL(resolve(vendorPluginDist, "memory/index.js")).href;
    const memoryModule = await import(memoryUrl);

    const requiredMemoryFunctions = [
      "createGameBuddyPlayerMemoryCrudFacade",
      "createGameBuddyPlayerMemoryReadProjection",
      "validateMemoryProfileBinding",
      "assertMemoryProfileMatch",
      "resolveGameBuddyMemoryProjectPath",
    ];

    for (const fnName of requiredMemoryFunctions) {
      if (typeof memoryModule[fnName] !== "function") {
        errors.push(`dist/memory/index.js missing required export: ${fnName} (got ${typeof memoryModule[fnName]})`);
      }
    }

    if (!errors.some(e => e.includes("dist/memory"))) {
      console.log("  [PASS] memory dist export closure verified");
    }
  } catch (err) {
    errors.push(`failed to load memory dist: ${err.message}`);
  }

  if (errors.length > 0) {
    console.error("\n[FAIL] Dist runtime export checks failed with violations:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log("\n[SUCCESS] All dist runtime exports match Host contracts exactly with 0 violations.");
}

main().catch((err) => {
  console.error("Unexpected failure:", err);
  process.exit(1);
});
