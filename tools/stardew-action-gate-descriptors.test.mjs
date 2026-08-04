import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("published action descriptors are complete, unique, and point to declared runner contracts", async () => {
  const gates = STARDEW_PUBLISHED_ACTION_GATES;
  assert.equal(gates.length, 15);
  assert.equal(new Set(gates.map((gate) => gate.actionId)).size, gates.length);

  for (const gate of gates) {
    assert.match(gate.actionId, /^[a-z][a-z0-9_]{1,127}$/);
    assert.match(gate.terminalReasonCode, /^[a-z][a-z0-9_]{1,127}$/);
    assert.match(gate.runner, /^run-stardew-[a-z0-9-]+\.mjs$/);
    if (gate.fixtureScenario !== null) assert.match(gate.fixtureScenario, /^native_[a-z0-9_]+_v\d+$/);

    const runnerPath = resolve(ROOT, "tools", gate.runner);
    await access(runnerPath, constants.R_OK);
    const source = await readFile(runnerPath, "utf8");
    assert.ok(source.includes(gate.terminalReasonCode), `${gate.actionId} runner must assert ${gate.terminalReasonCode}`);
  }
});

test("fixture-backed descriptor coverage is explicit rather than inferred", () => {
  const fixtureBacked = STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario !== null);
  assert.deepEqual(fixtureBacked.map((gate) => gate.actionId), [
    "till_soil", "pickup_forage", "pickup_item", "water_crop", "plant_seed", "fertilize_tile",
    "machine_inspect", "collect_animal_product", "feed_animal", "use_item", "harvest_crop",
  ]);
  assert.deepEqual(
    STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario === null).map((gate) => gate.actionId),
    ["move_to_tile", "equip_tool", "travel", "enter_exit"],
  );
});
