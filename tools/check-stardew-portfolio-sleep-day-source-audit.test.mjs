import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkStardewPortfolioSleepDaySourceAudit,
  validateStardewPortfolioSleepDaySourceAudit,
} from "./check-stardew-portfolio-sleep-day-source-audit.mjs";

const auditPath = new URL("./stardew-portfolio-sleep-day-source-audit.json", import.meta.url);

async function loadAudit() {
  return JSON.parse(await readFile(auditPath, "utf8"));
}

test("sleep/day audit freezes the target-version normal-player path and exact missing seam", async () => {
  assert.deepEqual(await checkStardewPortfolioSleepDaySourceAudit(auditPath), {
    action: "single_player_sleep_and_advance_day",
    topology: "single_player_native_companion",
    sourceIngress: "unavailable",
    state: "BLOCKED",
    code: "native_sleep_ingress_unavailable",
    requiredSeam:
      "A separately approved source-owned typed semantic sleep entrypoint that preserves the complete normal-player decision and lifecycle without invoking a private confirmation continuation or raw save/day API.",
  });
});

test("sleep/day audit rejects a synthetic ingress, altered normal path, and weakened prohibition", async () => {
  const synthetic = await loadAudit();
  synthetic.sourceOwnedMissingSeam.status = "available";
  assert.throws(() => validateStardewPortfolioSleepDaySourceAudit(synthetic), /Expected values to be strictly equal/);

  const alteredPath = await loadAudit();
  alteredPath.normalPlayerPath[4] = "typed bridge ingress";
  assert.throws(() => validateStardewPortfolioSleepDaySourceAudit(alteredPath), /normalPlayerPath/);

  const weakened = await loadAudit();
  weakened.prohibitedAlternatives = weakened.prohibitedAlternatives.filter((entry) => entry !== "Game1.NewDay");
  assert.throws(() => validateStardewPortfolioSleepDaySourceAudit(weakened), /prohibitedAlternatives/);
});
