import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsSteamInstallationSource } from "./index.js";

const registryRoots = ["C:\\Steam 中文", "D:\\Steam32", "D:\\Steam32"] as const;
const libraryFolders = '"libraryfolders" { "0" { "path" "E:\\\\Library 中文" } }';

test("non-Windows source is unavailable without querying registry or files", async () => {
  let queried = false;
  let read = false;
  const source = createWindowsSteamInstallationSource({
    platform: "linux",
    readRegistryRoots: async () => { queried = true; return registryRoots; },
    readFile: async () => { read = true; return libraryFolders; },
  });
  assert.deepEqual(await source.read(), { roots: [], diagnostics: ["source-unavailable"] });
  assert.equal(queried, false);
  assert.equal(read, false);
});

test("Windows source reads bounded registry roots and library folders with stable deduplication", async () => {
  const read: string[] = [];
  const source = createWindowsSteamInstallationSource({
    platform: "win32",
    readRegistryRoots: async () => registryRoots,
    readFile: async (path) => { read.push(path); return libraryFolders; },
  });
  const result = await source.read();
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.roots, [
    ["steam-registry", "C:\\Steam 中文"],
    ["steam-registry", "D:\\Steam32"],
    ["steam-vdf", "E:\\Library 中文"],
  ]);
  assert.deepEqual(read, [
    "C:\\Steam 中文\\steamapps\\libraryfolders.vdf",
    "D:\\Steam32\\steamapps\\libraryfolders.vdf",
  ]);
});

test("Windows source reports registry unavailable, permission failure, and malformed metadata", async () => {
  const unavailable = createWindowsSteamInstallationSource({ platform: "win32", readRegistryRoots: async () => { throw new Error("access denied"); } });
  assert.deepEqual(await unavailable.read(), { roots: [], diagnostics: ["registry-unavailable", "source-unavailable"] });

  const unreadable = createWindowsSteamInstallationSource({
    platform: "win32",
    readRegistryRoots: async () => ["C:\\Steam"],
    readFile: async () => { throw new Error("access denied"); },
  });
  assert.deepEqual(await unreadable.read(), { roots: [["steam-registry", "C:\\Steam"]], diagnostics: ["vdf-unreadable", "source-unavailable"] });

  const malformed = createWindowsSteamInstallationSource({
    platform: "win32",
    readRegistryRoots: async () => ["C:\\Steam"],
    readFile: async () => '"libraryfolders" { "0" { "path" "not-a-windows-path" } }',
  });
  assert.deepEqual(await malformed.read(), { roots: [["steam-registry", "C:\\Steam"]], diagnostics: ["vdf-malformed", "source-unavailable"] });
});

test("Windows source smoke is skipped outside Windows", { skip: process.platform !== "win32" }, async () => {
  const result = await createWindowsSteamInstallationSource().read();
  assert.ok(result.diagnostics.every((diagnostic) => ["registry-unavailable", "vdf-unreadable", "vdf-malformed", "source-unavailable"].includes(diagnostic)));
  assert.ok(result.roots.every(([, root]) => /^[A-Z]:\\/.test(root)));
});
