import assert from "node:assert/strict";
import test from "node:test";
import { createStardewInstallationDiscoveryProvider } from "./index.js";
import type { StardewSteamSource } from "./index.js";

const manifest = '"appid" "413150" "installdir" "Stardew Valley"';

function source(roots: readonly (readonly ["steam-registry" | "steam-vdf", string])[]): StardewSteamSource {
  return Object.freeze({ read: async () => Object.freeze({ roots, diagnostics: [] as const }) });
}

test("binds each source root to its own manifest and only publishes valid roots", async () => {
  const files = new Map([
    ["C:\\Good\\steamapps\\appmanifest_413150.acf", manifest],
    ["C:\\Bad\\steamapps\\appmanifest_413150.acf", '"appid" "1"'],
  ]);
  const provider = createStardewInstallationDiscoveryProvider({
    source: source([["steam-vdf", "C:\\Good"], ["steam-vdf", "C:\\Bad"]]),
    readFile: async (path) => files.get(path) ?? Promise.reject(new Error("missing")),
  });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.includes("invalid-app-manifest"), true);
  assert.equal(Object.keys(result.candidates[0] ?? {}).includes("root"), false);
});

test("reads manifests from the canonical normalized source root", async () => {
  const paths: string[] = [];
  const provider = createStardewInstallationDiscoveryProvider({
    source: source([["steam-vdf", "c:\\Steam"]]),
    readFile: async (path) => { paths.push(path); return manifest; },
  });
  const result = await provider.discover();
  assert.deepEqual(paths, ["C:\\Steam\\steamapps\\appmanifest_413150.acf"]);
  assert.equal(result.candidates.length, 1);
});

test("does not read manifests for invalid source roots", async () => {
  const paths: string[] = [];
  const provider = createStardewInstallationDiscoveryProvider({
    source: source([["steam-vdf", "C:\\Steam\\..\\Other"], ["steam-vdf", "relative"], ["steam-vdf", "C:\\Steam\\"]]),
    readFile: async (path) => { paths.push(path); return manifest; },
  });
  const result = await provider.discover();
  assert.deepEqual(paths, []);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic === "invalid-app-manifest").length, 3);
});

test("empty source roots produce no candidates without reading manifests", async () => {
  let reads = 0;
  const provider = createStardewInstallationDiscoveryProvider({ source: source([]), readFile: async () => { reads += 1; return manifest; } });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, ["no-candidates"]);
  assert.equal(reads, 0);
});

test("fails closed on oversized app manifests", async () => {
  const provider = createStardewInstallationDiscoveryProvider({ source: source([["steam-registry", "C:\\Steam"]]), readFile: async () => "x".repeat(4 * 1024 * 1024 + 1) });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.diagnostics, ["invalid-app-manifest", "no-candidates"]);
});

test("reports source diagnostics and manifest failures without exposing locators", async () => {
  const provider = createStardewInstallationDiscoveryProvider({
    source: source([["steam-registry", "C:\\Steam"]]),
    readFile: async () => { throw new Error("manifest missing"); },
  });
  const result = await provider.discover();
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.includes("invalid-app-manifest"), true);
  assert.equal(Object.keys(result.candidates).includes("root"), false);
});


test("maps a source failure to unavailable and no-candidates without reading manifests", async () => {
  let read = false;
  const provider = createStardewInstallationDiscoveryProvider({
    source: { read: async () => { throw new Error("source failure"); } },
    readFile: async () => { read = true; return manifest; },
  });
  const result = await provider.discover();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, ["source-unavailable", "no-candidates"]);
  assert.equal(read, false);
});
