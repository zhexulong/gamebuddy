/**
 * GATE `a_place_the_observation_names_is_a_place_the_search_finds:<word>`.
 *
 * <p>
 * ONE PLACE, ONE WORD, AND THE WORD IS THE WORLD'S. MEASURED `round77`, day 2: `<world-state>` printed
 * 「矿洞入口 (…)」 over the mine entrance, she copied the place word out of it as `stardew_find_destination("矿洞")`, and
 * the only answer was `乔迪，肯特和山姆的家` - a villager's house, whose residents sell the cave carrot - so a day that
 * asked for the mine went elsewhere. The game calls that place 矿井 (`Data/Locations["Mine"].DisplayName`,
 * `StringsFromCSFiles:MapPage.cs.11098`), which is the name the Mod's destination directory publishes as that place's
 * canonical label and the name `位置:` prints when she is standing in it; 矿洞 was the Host's own word, and no
 * derivation from location data produces it. So the defect was not the search - the search answers the names the
 * directory declares - it was that the block taught her one word for a place whose name is another.
 * </p>
 *
 * <p>
 * WHAT IS MEASURED, AND WHY IT IS A DECLARATION RATHER THAN A LIST. `矿井入口` and `可锄的地块` are both just strings,
 * so nothing in the text says which one is the name of a place a person would carry to `find_destination`. The
 * vocabulary states it instead: `TARGET_FAMILY_PLACES` says which families name a place, which map that place is and
 * which role word follows the name - and the label table is built from it, so the two cannot disagree by construction.
 * This gate therefore examines the words the COMPOSED BLOCK actually prints (the rendering path, not the table), one
 * block per declared family, and holds each one against `LOCATION_NAMES_ZH` - the table `位置:` renders from, whose
 * values are `Data/Locations`' own display names, the field the destination index holds as a place's canonical label.
 * A family declared here with no label, a label spelled by hand, and a label that names the wrong place all fail with
 * the word and the place named.
 * </p>
 *
 * <p>
 * THE PRINT IS THE POPULATION: `words examined W · findable F · orphaned O`. W comes from `TARGET_FAMILY_PLACES`, so a
 * place-naming family added tomorrow is measured without anybody remembering this file, and zero of them is blocked
 * rather than green.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeWorldState } from "./fact-brief.js";
import {
  gameLocationName,
  LOCATION_NAMES_ZH,
  TARGET_FAMILY_LABELS,
  TARGET_FAMILY_PLACES,
} from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

/** The tile the fixture's one row stands on, spelled as the block spells it so the word beside it can be found. */
const ROW_TILE = "(3,9)";

/** One row of a declared family, carrying the fields that family publishes: the elevator also says which floor it is. */
function publishedRow(family: string): Readonly<Record<string, unknown>> {
  const tile = { x: 3, y: 9 };
  return family === "mineElevatorFloorTargets"
    ? { targetId: "floor_1", ...tile, floor: 5, isCurrentFloor: false, isMineEntrance: false }
    : { targetId: "entrance_1", ...tile };
}

/**
 * A world carrying one row of one declared family - the block a turn is handed when that place is the only thing the
 * observation published. The map she stands on is the place the row is at, so the block names it on both lines.
 */
function observing(location: string, family: string): Snapshot {
  return {
    revision: 731,
    location,
    tile: { x: 3, y: 8 },
    stamina: 240,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 780,
    dayOfMonth: 3,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Pickaxe",
    currentToolSlot: 0,
    toolSlots: [{ slot: 0, label: "(T)Pickaxe", category: "pickaxe", upgradeLevel: 0 }],
    inventoryItemFacts: [],
    [family]: [publishedRow(family)],
  } as unknown as Snapshot;
}

/** The block the model is handed: the real composer, not a rendering written for this test. */
function blockOf(snapshot: Snapshot): string {
  return composeWorldState({ snapshot, revision: snapshot.revision, ageTurns: 0, ageMs: 0, contentAgeMs: 0 });
}

/**
 * The word the block printed for the row at `ROW_TILE`, read out of the block itself.
 *
 * That is the whole point of reading it here rather than from the label table: what she copies into a search is the
 * word on the line, so a renderer that spells a family its own way is measured too.
 */
function printedWord(block: string): string {
  const segments = block
    .split(/[\n；]/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.includes(ROW_TILE));
  assert.equal(segments.length, 1, `the block names no row at ${ROW_TILE}, so there is no word to read: ${block}`);
  const segment = segments[0] as string;
  return segment.slice(0, segment.indexOf(ROW_TILE)).trim();
}

/**
 * One verdict: the word the block printed, the place word it TAUGHT, the place it is about, and the name that place
 * has.
 *
 * `taught` is the place part of the printed word - the label minus the role word the table declares - because that is
 * the string a reader carries away: `矿洞入口` teaches `矿洞`, and `矿井入口` teaches `矿井`. Findable means the two are
 * the same word.
 */
type PlaceWordVerdict = Readonly<{
  family: string;
  word: string;
  taught: string;
  place: string;
  placeName: string;
  findable: boolean;
}>;

function placeWordVerdict(
  family: string,
  word: string,
  place: Readonly<{ map: string; role: string }>,
): PlaceWordVerdict {
  const placeName = gameLocationName(place.map, true);
  const taught = word.endsWith(place.role) ? word.slice(0, word.length - place.role.length) : word;
  return Object.freeze({ family, word, taught, place: place.map, placeName, findable: taught === placeName });
}

/** What a failure says: the word, the place word it taught, and the name the place actually has. */
function orphanLine(verdict: PlaceWordVerdict): string {
  return `${verdict.word} (${verdict.family}) teaches ${verdict.taught}, and ${verdict.place} is ${verdict.placeName}`;
}

test("a_place_the_observation_names_is_a_place_the_search_finds: every place word the block prints is the world's name for that place", () => {
  const verdicts = Object.entries(TARGET_FAMILY_PLACES).map(([family, place]) => {
    assert.ok(
      Object.hasOwn(LOCATION_NAMES_ZH, place.map),
      `${family} names ${place.map}, which the world's own vocabulary gives no name for`,
    );
    assert.ok(
      Object.hasOwn(TARGET_FAMILY_LABELS, family),
      `${family} is declared as a place but has no label for the block to print`,
    );
    return placeWordVerdict(family, printedWord(blockOf(observing(place.map, family))), place);
  });
  const findable = verdicts.filter((verdict) => verdict.findable);
  const orphaned = verdicts.filter((verdict) => !verdict.findable);
  console.log(
    `a_place_the_observation_names_is_a_place_the_search_finds:${verdicts.map((verdict) => verdict.word).join(",")} · ` +
      `words examined ${String(verdicts.length)} · findable ${String(findable.length)} · orphaned ${String(orphaned.length)}`,
  );
  assert.ok(
    verdicts.length > 0,
    "zero place words examined is blocked, never green: TARGET_FAMILY_PLACES is the population",
  );
  assert.deepEqual(
    orphaned.map(orphanLine),
    [],
    `the block teaches a word the world does not call the place: ${orphaned.map(orphanLine).join(" | ")}`,
  );
});

test("a_place_the_observation_names_is_a_place_the_search_finds: the word round77 measured is an orphan", () => {
  // THE FALSIFIER, quoting the block `round77` day 2 carried over the mine entrance: a check the shipped label passes
  // has to refuse the word this repository shipped, or it is decoration.
  const verdict = placeWordVerdict("mineEntranceTargets", "矿洞入口", TARGET_FAMILY_PLACES.mineEntranceTargets);
  assert.equal(verdict.findable, false, `the shipped word passed as ${verdict.placeName}: ${orphanLine(verdict)}`);
  assert.equal(verdict.taught, "矿洞", `the orphan word is the place part she carried away: ${orphanLine(verdict)}`);
  assert.equal(
    verdict.placeName,
    "矿井",
    `the place's own name is the game's: ${orphanLine(verdict)}`,
  );
});

test("a_place_the_observation_names_is_a_place_the_search_finds: the mine reaches her as the word she can search for", () => {
  // AND THE WORDS ARE NOT DROPPED: the fix is agreement between what the block says and what the world is called, never
  // the removal of one of them. Both labels carry the mine's own name, and nothing spells it the old way.
  for (const [family, place] of Object.entries(TARGET_FAMILY_PLACES)) {
    const block = blockOf(observing(place.map, family));
    assert.equal(
      printedWord(block),
      `${gameLocationName(place.map, true)}${place.role}`,
      `the family reaches the block under the place's own name: ${block}`,
    );
    assert.equal(block.includes("矿洞"), false, `no line coins a word for the mine: ${block}`);
  }
});
