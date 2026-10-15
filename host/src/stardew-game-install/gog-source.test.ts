import assert from "node:assert/strict";
import test from "node:test";

import { createWindowsGogInstallationSource, parseGogGalaxyLibraryRoots, parseGogRegistryGames } from "./index.js";

test("a non-Windows GOG source is unavailable without reading metadata", async () => {
  let read = false;
  let registry = false;
  const source = createWindowsGogInstallationSource({
    platform: "linux",
    readFile: async () => {
      read = true;
      return "";
    },
    readRegistryGames: async () => {
      registry = true;
      return [];
    },
  });
  assert.deepEqual(await source.read(), { roots: [], diagnostics: ["gog-unavailable"] });
  assert.equal(read, false);
  assert.equal(registry, false);
});

test("a GOG Galaxy library setting is normalized and malformed metadata is rejected", () => {
  assert.deepEqual(parseGogGalaxyLibraryRoots('{"libraryPath":"d:/GOG-Games"}'), ["D:\\GOG-Games"]);
  assert.deepEqual(parseGogGalaxyLibraryRoots("{}"), []);
  assert.deepEqual(parseGogGalaxyLibraryRoots('{"libraryPath":null}'), []);
  assert.equal(parseGogGalaxyLibraryRoots('{"libraryPath":12}'), undefined);
  assert.equal(parseGogGalaxyLibraryRoots('{"libraryPath":"relative"}'), undefined);
  assert.equal(parseGogGalaxyLibraryRoots("not json"), undefined);
  assert.equal(parseGogGalaxyLibraryRoots("[]"), undefined);
});

test("a GOG registry with one game and with several games both parse", () => {
  const single = { gameName: "Stardew Valley", path: "C:\\GOG Games\\Stardew Valley" };
  assert.deepEqual(parseGogRegistryGames(single), [single]);
  assert.deepEqual(parseGogRegistryGames([single, { gameName: 7, path: "x" }]), [single]);
  assert.equal(parseGogRegistryGames("nonsense"), undefined);
  assert.equal(parseGogRegistryGames(7), undefined);
});

test("a Windows GOG source combines the defaults, the Galaxy library, and the game registry", async () => {
  const reads: string[] = [];
  const source = createWindowsGogInstallationSource({
    platform: "win32",
    programDataRoot: "C:\\ProgramData",
    readFile: async (path) => {
      reads.push(path);
      return '{"libraryPath":"E:\\\\Library 中文"}';
    },
    readRegistryGames: async () => [
      { gameName: "Stardew Valley", path: "D:\\GOG Library\\Stardew Valley" },
      { gameName: "Cyberpunk 2077", path: "D:\\GOG Library\\Cyberpunk 2077" },
      { gameName: "Stardew Valley", path: "d:\\gog library\\stardew valley" },
    ],
  });
  const result = await source.read();
  assert.deepEqual(reads, ["C:\\ProgramData\\GOG.com\\Galaxy\\config\\config.json"]);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.roots, [
    "C:\\Program Files (x86)\\GOG Galaxy\\Games\\Stardew Valley",
    "C:\\GOG Games\\Stardew Valley",
    "E:\\Library 中文\\Stardew Valley",
    "D:\\GOG Library\\Stardew Valley",
  ]);
});

test("a Windows GOG source names unreadable and malformed metadata without dropping the defaults", async () => {
  const unreadableConfig = createWindowsGogInstallationSource({
    platform: "win32",
    readFile: async () => {
      throw new Error("access denied");
    },
    readRegistryGames: async () => {
      throw new Error("access denied");
    },
  });
  assert.deepEqual(await unreadableConfig.read(), {
    roots: ["C:\\Program Files (x86)\\GOG Galaxy\\Games\\Stardew Valley", "C:\\GOG Games\\Stardew Valley"],
    diagnostics: ["gog-metadata-unreadable"],
  });

  const malformedConfig = createWindowsGogInstallationSource({
    platform: "win32",
    readFile: async () => "{not json",
    readRegistryGames: async () => [],
  });
  assert.deepEqual(await malformedConfig.read(), {
    roots: ["C:\\Program Files (x86)\\GOG Galaxy\\Games\\Stardew Valley", "C:\\GOG Games\\Stardew Valley"],
    diagnostics: ["gog-metadata-malformed"],
  });
});
