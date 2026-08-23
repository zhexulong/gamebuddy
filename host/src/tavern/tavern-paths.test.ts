import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveTavernPaths, tavernRevisionPath, tavernThreadPath } from "./tavern-paths.js";

test("tavern paths derive opaque partitions and reject traversal", () => {
  const paths = resolveTavernPaths(
    {
      root: "C:/runtime",
      runtimeCwd: "C:/runtime/contexts/x",
      agentDir: "x",
      sessionDir: "x",
      identityProfilePath: "x",
      identityProfileBindingPath: "x",
      runManifestPath: "x",
    },
    { playerId: "player", companionId: "companion", continuityId: "continuity" },
  );
  assert.match(paths.playerRoot, /players/);
  assert.match(tavernThreadPath(paths, "thread", "thread.json"), /threads/);
  assert.throws(() => tavernThreadPath(paths, "../bad", "thread.json"));
  assert.equal(tavernRevisionPath(paths.root, 1), join(paths.root, "revisions", "1.json"));
  assert.throws(() => tavernRevisionPath("/tmp/not-tavern-v1", 1), /unsafe_tavern_path/);
});
