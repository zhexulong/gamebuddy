import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as V from "../src/stardew-source-analysis-vocabulary.mjs";

/**
 * The vocabulary module is the single home for Stardew-specific names used by source
 * analysis. Two things must hold:
 *   1. every exported value is usable by the tools that consume it
 *   2. the tools no longer carry their own copies (otherwise the module is decorative)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");

test("exports the vocabulary the source-analysis tools consume", () => {
  for (const name of [
    "STARDEW_INTERACTION_SHAPES",
    "STARDEW_GAMEPLAY_SHAPES",
    "STARDEW_INGRESS_ROOT_GROUPS",
    "STARDEW_MENU_FIELDS",
    "STARDEW_MENU_CONSTRUCTOR",
    "STARDEW_MENU_OPENERS",
    "STARDEW_GAMEPLAY_MUTATIONS",
    "STARDEW_MENU_UI_EXITS",
    "STARDEW_EVENT_DIALOGUE_EXITS",
    "STARDEW_QUERY_HELPER_FILES",
    "STARDEW_SEMANTIC_EQUIVALENT_EXITS",
    "STARDEW_NON_GAMEPLAY_FIELDS",
  ])
    assert.ok(name in V, `must export ${name}`);

  /*
   * Three names that used to be listed here - STARDEW_COSMETIC_FIELDS, STARDEW_COST_FIELDS and
   * STARDEW_MP_REJECT_PATTERN - are gone, and this list was the only thing that ever named them.
   * `4e8001d2` (chore(knip)) had already removed their `export` because nothing imported them; they
   * stayed behind as private constants defined once and read nowhere, and this assertion is what kept
   * them from being noticed as dead. Deleting them is the honest end state: a vocabulary entry that no
   * tool consults is not a vocabulary, it is a spare part.
   *
   * What they encoded did not vanish with them - `stardew-branch-writeset.mjs` classifies cost fields
   * and the reconciliation tool classifies cosmetic ones - but the two lists are NOT the same as these
   * were (the branch-writeset cost regex adds waterCanMax/durability/ammo/magazine/usesLeft/fuel and
   * omits health). Which of the two is right is a question about the game, not about tidiness, so it is
   * left where it is rather than merged here by guess.
   */
});

test("the leftClick family is present — the menu-free shipping entry point", () => {
  // ShippingBin.leftClicked() is reached from Game1.pressUseToolButton via
  // GameLocation.leftClick; a shape list without it silently loses that path.
  for (const shape of ["leftClick", "leftClicked", "clicked"])
    assert.ok(V.STARDEW_INTERACTION_SHAPES.includes(shape), `${shape} must be a known shape`);
});

test("Utility.TryOpenShopMenu is a menu signal — it has no Menu suffix", () => {
  assert.ok(
    V.STARDEW_MENU_OPENERS.includes("Utility.TryOpenShopMenu"),
    "a `new *Menu(` scan alone misses every shop; the opener must be listed by name",
  );
});

test("placement fields are gameplay, not noise", () => {
  // For placementAction, `Location = location` / `TileLocation = ...` IS the terminal.
  for (const field of ["Location", "TileLocation", "Position"])
    assert.equal(
      V.STARDEW_NON_GAMEPLAY_FIELDS.test(field),
      false,
      `${field} must not be classified as non-gameplay`,
    );
  assert.equal(V.STARDEW_NON_GAMEPLAY_FIELDS.test("NeedsUpdate"), true);
  assert.equal(V.STARDEW_NON_GAMEPLAY_FIELDS.test("freezePause"), true);
});

test("the nine ingress roots are all present", () => {
  assert.equal(Object.keys(V.STARDEW_INGRESS_ROOT_GROUPS).length, 9);
  assert.deepEqual(V.STARDEW_INGRESS_ROOT_GROUPS.world_action_interaction, ["pressActionButton", "tryToCheckAt"]);
  // reachable only through the menu root — this is why all nine matter
  assert.ok(V.STARDEW_INGRESS_ROOT_GROUPS.menu_semantic_selection.includes("clickCraftingRecipe"));
});

test("every semantic-equivalence entry carries its own reason", () => {
  for (const [exit, entry] of Object.entries(V.STARDEW_SEMANTIC_EQUIVALENT_EXITS)) {
    assert.ok(entry.actions.length > 0, `${exit} must name an action`);
    assert.ok(entry.why.length > 20, `${exit} must state a self-contained reason`);
  }
});

test("the tools import the vocabulary instead of carrying their own copy", async () => {
  const CONSUMERS = [
    "src/analysis/stardew-action-candidates.mjs",
    "src/analysis/stardew-player-reachable-exits.mjs",
    "src/analysis/stardew-reachable-exit-reconciliation.mjs",
    "src/analysis/stardew-remaining-actions-report.mjs",
  ];
  for (const rel of CONSUMERS) {
    const text = await readFile(path.join(PACKAGE_ROOT, rel), "utf8");
    assert.ok(
      text.includes("stardew-source-analysis-vocabulary.mjs"),
      `${rel} must import the shared vocabulary rather than defining its own`,
    );
  }
});
