import assert from "node:assert/strict";
import test from "node:test";

import { parseStardewLauncherConfig } from "./stardew-integration-launcher.js";

const base = { pipeName: "gamebuddy_fixture", bridgeToken: "a".repeat(32) };

test("Stardew launcher config rejects malformed knowledge before any bridge connection", () => {
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, gameVersion: "1.6.15", knowledge: { bundleVersion: 1 } }),
    /invalid_knowledge_bundle/,
  );
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, knowledge: { bundleVersion: 1 } }),
    /invalid_stardew_launcher_config/,
  );
  assert.throws(
    () => parseStardewLauncherConfig({ ...base, unexpected: true }),
    /invalid_stardew_launcher_config/,
  );
});

test("Stardew launcher config keeps a version-bound validated knowledge bundle", () => {
  const config = parseStardewLauncherConfig({
    ...base,
    gameVersion: "1.6.15",
    knowledge: {
      bundleVersion: 1,
      integrationId: "stardew",
      gameVersion: "1.6.15",
      rules: [{ id: "fixture_rule", integrationId: "stardew", gameVersion: "1.6.15", capability: "move_to_tile", text: "Use the current authoritative snapshot." }],
    },
  });
  assert.equal(config.knowledge?.rules.length, 1);
  assert.equal(config.knowledge?.gameVersion, "1.6.15");
});
