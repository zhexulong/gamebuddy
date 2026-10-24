import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_ACTION_FAMILIES, isStardewActionFamily } from "./stardew-action-families.js";

/**
 * The derivation lives here rather than in the settings module so the list has
 * exactly one owner: the Mod's catalog. The Mod refuses the WHOLE action policy
 * when one name is not a family it declares, so a stale entry here would silently
 * disable the player's entire policy rather than one checkbox.
 */
const MOD_CATALOG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "integrations",
  "stardew",
  "src",
  "Core",
  "Policy",
  "FarmhandActionDefinitions.cs",
);

/** Every family id the Mod's own registration list names, as written. */
async function readModFamilies(): Promise<readonly string[]> {
  const source = await readFile(MOD_CATALOG, "utf8");
  const body = source.match(/\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/u)?.[1];
  assert.ok(body !== undefined, "the Mod's registration list must be readable from its own source");
  const families = new Set<string>();
  for (const entry of body.split(/(?=\b(?:E|R|Registration)\()/u)) {
    const match = entry.match(/\b(?:E|R|Registration)\(\s*"([a-z][a-z0-9_]{1,127})",\s*"([a-z][a-z0-9_]{1,127})"/u);
    if (match?.[2] !== undefined) families.add(match[2]);
  }
  return [...families].sort();
}

test("the offered families are exactly the ones the Mod catalog declares", async () => {
  const declared = await readModFamilies();
  assert.ok(declared.length > 0, "reading the Mod catalog must find registrations");
  assert.deepEqual(
    [...STARDEW_ACTION_FAMILIES].sort(),
    declared,
    "a family this surface offers that the Mod does not declare would make the Mod refuse the whole action policy",
  );
  assert.equal(new Set(STARDEW_ACTION_FAMILIES).size, STARDEW_ACTION_FAMILIES.length, "no family is offered twice");
});

test("only a declared family is accepted as a denial", () => {
  assert.equal(isStardewActionFamily("farming_crops"), true);
  assert.equal(isStardewActionFamily("world_perception"), true);
  assert.equal(isStardewActionFamily("Farming_Crops"), false);
  assert.equal(isStardewActionFamily("farming"), false);
  assert.equal(isStardewActionFamily(""), false);
  assert.equal(isStardewActionFamily(7), false);
});

test("items the surface lists first are the everyday farm work", () => {
  // The settings list is ordered for a reader, not by registration order; this
  // pins the head so a reshuffle is a deliberate edit rather than a side effect.
  assert.deepEqual(STARDEW_ACTION_FAMILIES.slice(0, 4), [
    "farming_crops",
    "resource_gathering",
    "animals_pets",
    "machines_processing",
  ]);
});

test("the path helper resolves under the runtime root", async () => {
  const { stardewPlayerSettingsPath } = await import("./stardew-player-settings.js");
  assert.equal(stardewPlayerSettingsPath("C:\\runtime").endsWith(join("stardew", "player-settings.json")), true);
});
