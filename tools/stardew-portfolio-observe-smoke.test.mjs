import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(new URL("./run-stardew-portfolio-observe-smoke.mjs", import.meta.url), "utf8");

test("P1c runner is an observe-only live gate and fails closed before P0b; it does not expose mutation", () => {
  assert.match(runner, /P1c_live_observe_only/);
  assert.match(runner, /portfolio_p0b_not_passed/);
  assert.match(runner, /PortfolioStardewBridgeClient\.connect/);
  assert.match(runner, /client\.observe\(\)/);
  assert.match(runner, /mutationSurface: "absent"/);
  assert.match(runner, /portfolio_lifecycle_event_required/);
  assert.doesNotMatch(runner, /\.execute\(/);
  assert.doesNotMatch(runner, /SaveGame\.Save/);
  assert.doesNotMatch(runner, /HostFarmhandProvisioner|FarmhandProvisioner|joinManifest|readyToPlay/);
});

test("P1c runner records title and disconnect invalidation as required live evidence", () => {
  assert.match(runner, /title_invalidation/);
  assert.match(runner, /disconnect_invalidation/);
});

test("P1c runner requires the exact native local-player binding rather than selecting a target", () => {
  assert.match(runner, /GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID/);
  assert.match(runner, /GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT/);
  assert.match(runner, /observedSaveSlot: process\.env\.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT/);
  assert.match(runner, /computePortfolioBindingHash/);
  assert.match(runner, /portfolio_observe_scope_mismatch/);
  assert.doesNotMatch(runner, /manualTargetSelection/);
});
