import assert from "node:assert/strict";
import test from "node:test";
import { createStardewInstallationDiscoveryProvider, type StardewVerifiedSteamRegistry } from "./index.js";

const manifest = '"appid" "413150" "installdir" "Stardew Valley"';
const vdf = '"libraryfolders" { "0" { "path" "C:\\\\Good" } "1" { "path" "C:\\\\Bad" } }';
test("binds each VDF root to its own manifest and only publishes valid roots", async () => {
  const files = new Map([["vdf", vdf], ["C:\\Good\\steamapps\\appmanifest_413150.acf", manifest], ["C:\\Bad\\steamapps\\appmanifest_413150.acf", '"appid" "1"']]);
  const provider = createStardewInstallationDiscoveryProvider({ libraryFoldersVdfPath: "vdf", readFile: async (path) => files.get(path) ?? Promise.reject(new Error("missing")) });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 1);
   assert.equal(result.diagnostics.includes("invalid-app-manifest"), true);
  assert.equal(Object.keys(result.candidates[0] ?? {}).includes("root"), false);
});

test("reports unreadable VDF and registry manifest failures without exposing locators", async () => {
  const registry = { brand: Symbol("forged"), steamLibraryRoot: "C:\\Steam" } as unknown as StardewVerifiedSteamRegistry;
  const provider = createStardewInstallationDiscoveryProvider({ registry, libraryFoldersVdfPath: "missing", readFile: async (path) => { if (path === "missing") throw new Error("unreadable"); throw new Error("manifest missing"); } });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.includes("vdf-unreadable"), true);
   assert.equal(result.diagnostics.includes("registry-unavailable"), true);
   assert.equal(result.diagnostics.includes("invalid-app-manifest"), false);
});
