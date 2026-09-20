import assert from "node:assert/strict";
import test from "node:test";
import { parseAppManifest, parseLibraryFoldersVdf } from "./internal.js";
import { createStardewInstallationDiscoveryProvider } from "./index.js";

test("public index does not expose internal discovery helpers", async () => {
  const publicModule = await import("./index.js");
  assert.equal("discoverCandidates" in publicModule, false);
  assert.equal("parseAppManifest" in publicModule, false);
   assert.equal("parseLibraryFoldersVdf" in publicModule, false);
   assert.equal("normalizeBoundCandidates" in publicModule, false);
});

test("provider returns opaque candidates without locators", async () => {
  const provider = createStardewInstallationDiscoveryProvider({ source: { read: async () => ({ roots: [["steam-vdf", "C:\\Steam"]], diagnostics: [] }) }, readFile: async () => '"appid" "413150" "installdir" "Stardew Valley"' });
  const result = await provider.discover();
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.displayPath, "Detected installation (path hidden)");
  assert.equal(Object.keys(candidate).includes("root"), false);
});

test("provider reports unavailable when no source producer is composed", async () => {
   const result = await createStardewInstallationDiscoveryProvider({}).discover();
   assert.deepEqual(result.candidates, []);
   assert.ok(result.diagnostics.includes("source-unavailable"));
   assert.ok(result.diagnostics.includes("no-candidates"));
});

test("provider rejects discovery without a valid Stardew manifest", async () => {
  const provider = createStardewInstallationDiscoveryProvider({ source: { read: async () => ({ roots: [["steam-vdf", "C:\\Steam"]], diagnostics: [] }) }, readFile: async () => '"appid" "1"' });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.ok(result.diagnostics.includes("invalid-app-manifest"));
});


test("parses Steam metadata", () => {
  assert.deepEqual(parseLibraryFoldersVdf('"libraryfolders" { "0" { "path" "C:\\\\Steam" } }'), ["C:\\Steam"]);
  assert.equal(parseAppManifest('"appid" "413150" "installdir" "Stardew Valley"'), "Stardew Valley");
});
