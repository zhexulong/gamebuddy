import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { identityKey, resolveRuntimePaths } from "./runtime-identity.js";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(hostRoot, "src");

async function sourceOf(relativePath: string): Promise<string> {
  return await readFile(resolve(sourceRoot, relativePath), "utf8");
}

test("runtime-identity leaf carries no project imports or runtime facade dependency", async () => {
  const source = await sourceOf("runtime-identity.ts");
  assert.match(source, /^import \{ createHash \} from "node:crypto";$/m);
  assert.match(source, /^import \{ homedir \} from "node:os";$/m);
  assert.match(source, /^import \{ join, resolve \} from "node:path";$/m);
  const imports = source
    .split("\n")
    .filter((line) => line.startsWith("import ") || line.startsWith("export "));
  for (const line of imports) assert.doesNotMatch(line, /from "\.\.?\//u);
  assert.doesNotMatch(source, /from "\.\.?\/\.\./u);
});

test("Chat construction no longer imports the runtime facade or runtime core", async () => {
  const source = await sourceOf(
    "continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.ts",
  );
  assert.doesNotMatch(source, /from "\.\.\/runtime\.js"/u);
  assert.doesNotMatch(source, /from "\.\.\/runtime-core\.internal\.js"/u);
  assert.match(source, /from "\.\.\/runtime-identity\.js"/u);
});

test("tavern-paths derives identity and paths from the leaf, not the runtime facade", async () => {
  const source = await sourceOf("tavern/tavern-paths.ts");
  assert.doesNotMatch(source, /from "\.\.\/runtime\.js"/u);
  assert.doesNotMatch(source, /from "\.\.\/runtime-core\.internal\.js"/u);
  assert.match(source, /from "\.\.\/runtime-identity\.js"/u);
});

test("identityKey is stable and partitions by continuityId over save/world", () => {
  const continuity = Object.freeze({
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
  });
  const first = identityKey(continuity);
  const second = identityKey({ ...continuity });
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.notEqual(
    identityKey({
      playerId: "player_01",
      companionId: "companion_01",
      saveId: "save_01",
      worldId: "world_01",
    }),
    identityKey({
      playerId: "player_01",
      companionId: "companion_01",
      saveId: "save_02",
      worldId: "world_01",
    }),
  );
});

test("resolveRuntimePaths derives the same deterministic partition layout", () => {
  const identity = Object.freeze({
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
  });
  const paths = resolveRuntimePaths(identity, "C:\\roots\\gamedir");
  const repeated = resolveRuntimePaths(identity, "C:\\roots\\gamedir");
  assert.deepEqual(paths, repeated);
  assert.equal(paths.agentDir, resolve(resolve("C:\\roots\\gamedir"), "contexts", identityKey(identity), "pi-agent"));
  assert.equal(paths.runManifestPath, resolve(resolve("C:\\roots\\gamedir"), "contexts", identityKey(identity), "companion-run-manifest.json"));

  // Surface session paths stay under the surface-sessions partition.
  const surfaced = resolveRuntimePaths(identity, "C:\\roots\\gamedir", "surface_01");
  assert.equal(surfaced.surfaceSessionId, "surface_01");
  assert.equal(
    surfaced.runManifestPath,
    resolve(
      resolve("C:\\roots\\gamedir"),
      "contexts",
      identityKey(identity),
      "surface-sessions",
      "surface_01",
      "companion-run-manifest.json",
    ),
  );
});