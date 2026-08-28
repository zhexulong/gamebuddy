import assert from "node:assert/strict";
import test from "node:test";

import { parseDialogueLaunchMode } from "./dialogue-launch-mode.js";

test("dialogue launch mode defaults to fresh and permits only an explicit Host recovery flag", () => {
  assert.deepEqual(parseDialogueLaunchMode([]), { mode: "fresh", profile: "reference" });
  assert.deepEqual(parseDialogueLaunchMode(["C:/synthetic/manifest.json"]), {
    mode: "fresh",
    profile: "reference",
    manifestPath: "C:/synthetic/manifest.json",
  });
  assert.deepEqual(parseDialogueLaunchMode(["--known-root-recovery", "C:/synthetic/manifest.json"]), {
    mode: "known",
    profile: "reference",
    manifestPath: "C:/synthetic/manifest.json",
  });
  assert.deepEqual(parseDialogueLaunchMode(["--tavern-management", "C:/synthetic/manifest.json"]), {
    mode: "fresh",
    profile: "management",
    manifestPath: "C:/synthetic/manifest.json",
  });
  assert.deepEqual(parseDialogueLaunchMode(["--reference-game", "C:/synthetic/manifest.json"]), {
    mode: "fresh",
    profile: "reference-game",
    manifestPath: "C:/synthetic/manifest.json",
  });
  assert.deepEqual(
    parseDialogueLaunchMode([
      `--tavern-narrative-gate-nonce-sha256=${"a".repeat(64)}`,
      "C:/synthetic/manifest.json",
    ]),
    {
      mode: "fresh",
      profile: "reference",
      manifestPath: "C:/synthetic/manifest.json",
      tavernNarrativeGateNonceSha256: "a".repeat(64),
    },
  );
});

test("dialogue launch mode rejects duplicate, unknown, and malformed process arguments", () => {
  for (const args of [
    ["--known-root-recovery", "--known-root-recovery"],
    ["--tavern-management", "--tavern-management"],
    ["--reference-game", "--reference-game"],
    ["--reference-game", "--tavern-management"],
    ["--reference-game", `--tavern-narrative-gate-nonce-sha256=${"a".repeat(64)}`],
    ["--tavern-narrative-gate-nonce-sha256=invalid"],
    [`--tavern-narrative-gate-nonce-sha256=${"a".repeat(64)}`, "--tavern-management"],
    ["--unknown"],
    ["manifest.json", "other.json"],
    [""],
    [1] as unknown as string[],
  ])
    assert.throws(() => parseDialogueLaunchMode(args), /dialogue_launch_mode_rejected/);
});
