import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM2CropActionContract } from "./stardew-portfolio-m2-crop-action-contract.mjs";
const load = async () => JSON.parse(await readFile("tools/stardew-portfolio-m2-crop-action-contract.json", "utf8"));
test("M2 BDD batch binds exact finite primitives to its fail-closed source blocker", async () => {
  assert.deepEqual(validatePortfolioM2CropActionContract(await load()), { primitives: ["till", "plant", "water", "harvest"], state: "blocked", liveClosure: "none" });
});
test("M2 contract rejects generic crop action, day ownership, and weakened blocker", async () => {
  const generic = await load(); generic.primitives[0] = "crop_action";
  assert.throws(() => validatePortfolioM2CropActionContract(generic), /exactly till/);
  const day = await load(); day.scenario.and = "M2 advances the day";
  // Scenario wording alone is not relied on; the controlled blocker keeps no day edge available.
  day.blocker.consumer = "sleep_day_coordinator";
  assert.throws(() => validatePortfolioM2CropActionContract(day), /blocker handoff/);
});
