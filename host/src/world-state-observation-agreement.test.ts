/**
 * GATE `a_field_contradicts_its_own_observation:<field>`.
 *
 * <p>
 * ONE BLOCK, TWO LINES, OPPOSITE ANSWERS. Measured 2026-11-18 (`round76`, on her own session): the FarmHouse observation
 * carried `本图箱子: 0（物品 0）` three lines above `可交互的物件 宝箱 (2,10) 宝箱 (3,10) 宝箱 (4,10)`, and the Farm
 * observation labelled (65,20) (64,19) (65,19)... `已播种的地` in turns 3-4 while the same session's rectangle read
 * answered `hoed=yes watered=no crop=no` for those tiles. Two of those are wrong answers to a question the block asks
 * itself, and a reader cannot tell which line to believe - so the block spends a turn being doubted.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE BLOCK'S OWN FIELDS: the count line `composeWorldState` renders from `chestsSummary`, and every
 * label in `TARGET_FAMILY_LABELS` - the table the wire's row families are named from. Neither is a list in this file, so
 * a family added tomorrow is measured without anyone remembering this test; the state vocabulary below is what a label
 * may CLAIM, and a claim its own rows deny fails here by name.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeWorldState } from "./fact-brief.js";
import { observationChestTiles, TARGET_FAMILY_LABELS } from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

/**
 * The FarmHouse observation of `round76` line 197, as the wire carried it: three chests one tile away, and a container
 * summary that counted none of them.
 */
function farmhouseWithThreeChests(): Snapshot {
  return {
    revision: 325,
    location: "FarmHouse",
    tile: { x: 3, y: 11 },
    stamina: 196,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 2020,
    dayOfMonth: 6,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Axe",
    currentToolSlot: 0,
    toolSlots: [{ slot: 0, label: "(T)Axe", category: "axe", upgradeLevel: 0 }],
    inventoryItemFacts: [],
    // The Mod's own scan counted nothing here, which is what the line said.
    chestsSummary: { chestCount: 0, itemCount: 0, fullCount: 0 },
    chests: [],
    colorTargets: [],
    worldObjectTargets: [
      {
        targetId: "chest_1",
        kind: "Chest",
        location: "FarmHouse",
        x: 2,
        y: 10,
        slot: 0,
        qualifiedItemId: "(BC)130",
        displayName: "宝箱",
        rotation: null,
        rotations: null,
      },
      {
        targetId: "chest_2",
        kind: "Chest",
        location: "FarmHouse",
        x: 3,
        y: 10,
        slot: 0,
        qualifiedItemId: "(BC)130",
        displayName: "宝箱",
        rotation: null,
        rotations: null,
      },
      {
        targetId: "chest_3",
        kind: "Chest",
        location: "FarmHouse",
        x: 4,
        y: 10,
        slot: 0,
        qualifiedItemId: "(BC)130",
        displayName: "宝箱",
        rotation: null,
        rotations: null,
      },
      {
        targetId: "plant_1",
        kind: "Furniture",
        location: "FarmHouse",
        x: 1,
        y: 10,
        slot: 0,
        qualifiedItemId: "(F)1365",
        displayName: "家居植物",
        rotation: null,
        rotations: null,
      },
    ],
    doorTargets: [
      {
        targetId: "door_1",
        location: "FarmHouse",
        sourceX: 3,
        sourceY: 12,
        targetLocation: "Farm",
        targetX: 64,
        targetY: 15,
      },
    ],
  } as unknown as Snapshot;
}

/**
 * The Farm observation of `round76` turns 3-4, as the wire carried it: tilled ground paired with a held seed, and no
 * crop on any of it.
 */
function freshlyTilledFarm(): Snapshot {
  const tile = (
    x: number,
    y: number,
  ): Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    canPlantThisSeedHere: boolean;
    crop: boolean;
  }> =>
    Object.freeze({
      targetId: `soil_${String(x)}_${String(y)}`,
      slot: 8,
      x,
      y,
      qualifiedItemId: "(O)474",
      displayName: "花椰菜种子",
      canPlantThisSeedHere: true,
      crop: false,
    });
  return {
    revision: 46,
    location: "Farm",
    tile: { x: 65, y: 20 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 720,
    dayOfMonth: 5,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(W)47",
    currentToolSlot: 4,
    toolSlots: [{ slot: 4, label: "(W)47", category: "scythe", upgradeLevel: 0 }],
    inventoryItemFacts: [{ slot: 8, qualifiedItemId: "(O)474", displayName: "花椰菜种子", stack: 2 }],
    seedTargets: [tile(65, 20), tile(64, 19), tile(65, 19), tile(65, 21), tile(66, 19), tile(66, 20)],
    fertilizerTargets: [],
    // The ripe half of the same block: the family whose rows state whether the crop is ready, so the label has a state
    // it could get wrong (`可收的作物` claims none, and this check is what would notice if it did).
    harvestTargets: [
      {
        targetId: "crop_1",
        x: 64,
        y: 20,
        cropId: "24",
        qualifiedHarvestItemId: "(O)190",
        displayName: "花椰菜",
        regrowsAfterHarvest: false,
        readyForHarvest: true,
      },
    ],
    cropTargets: [],
  } as unknown as Snapshot;
}

/** The block the model is handed for one snapshot: the real composer, not a rendering written for this test. */
function blockOf(snapshot: Snapshot): string {
  return composeWorldState({ snapshot, revision: snapshot.revision, ageTurns: 0, ageMs: 0, contentAgeMs: 0 });
}

/**
 * One check's verdict: the field, the two lines that disagree, and whether there was anything to check.
 *
 * `checked: false` is a field this snapshot published nothing for - not a pass. The gate's own line counts them
 * separately so `contradictory 0` can never be read as "everything was verified".
 */
type FieldVerdict = Readonly<{
  field: string;
  line: string;
  checked: boolean;
  contradicts: readonly string[];
}>;

/**
 * The state a family label CLAIMS, and what its own rows answer instead.
 *
 * These are the words that assert a tile state is already DONE. A label naming one of them promises each row carries
 * that state, so a row whose own field denies it is the block disagreeing with itself. The population is
 * `TARGET_FAMILY_LABELS` - every family the wire publishes - so a new label is measured without this file changing.
 */
const LABEL_STATE_WORDS: readonly Readonly<{
  word: string;
  field: string;
  denies: (row: Readonly<Record<string, unknown>>) => boolean;
}>[] = [
  // `crop` false is the wire saying the tile is empty, and `canPlantThisSeedHere` true is it saying the seed would go in.
  { word: "已播种", field: "crop", denies: (row) => row.crop !== true || row.canPlantThisSeedHere === true },
  { word: "已浇水", field: "watered", denies: (row) => row.watered === false },
  { word: "已施肥", field: "fertilized", denies: (row) => row.fertilized === false },
  { word: "已成熟", field: "readyForHarvest", denies: (row) => row.readyForHarvest === false },
];

/** Every row the snapshot published for one family, as the wire's own objects. */
function rowsOf(snapshot: Snapshot, family: string): readonly Readonly<Record<string, unknown>>[] {
  const value = (snapshot as unknown as Record<string, unknown>)[family];
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Readonly<Record<string, unknown>> => row !== null && typeof row === "object");
}

/**
 * Whether one family's label survives its own rows.
 *
 * `checked` is the family whose rows STATE something one of those words could claim - so `contradictory 0` is backed
 * by families that had a state to disagree about, not by families with nothing to say.
 */
function checkLabelStateWord(
  family: string,
  label: string,
  rows: readonly Readonly<Record<string, unknown>>[],
): FieldVerdict {
  const carried = LABEL_STATE_WORDS.filter((word) => rows.some((row) => word.field in row));
  if (carried.length === 0) return Object.freeze({ field: family, line: label, checked: false, contradicts: [] });
  for (const { word, denies } of carried) {
    if (!label.includes(word)) continue;
    const denied = rows.find((row) => denies(row));
    if (denied !== undefined)
      return Object.freeze({
        field: `${family}:${word}`,
        line: `${label} …`,
        checked: true,
        contradicts: [JSON.stringify(denied)],
      });
  }
  return Object.freeze({ field: family, line: label, checked: true, contradicts: [] });
}

/**
 * Whether the count line agrees with the chests the SAME observation published.
 *
 * The count is read from the block's own text, so this measures what the model was handed rather than what the renderer
 * intended, and the chests are read from the snapshot through the one function the renderer also uses.
 */
function checkChestCount(countedLine: string, snapshot: Snapshot): FieldVerdict {
  const counted = Number(/本图箱子: (\d+)/u.exec(countedLine)?.[1] ?? "-1");
  assert.ok(counted >= 0, `the count line carries no number this gate can read: ${countedLine}`);
  // THE ROWS THE COUNT DID NOT INCLUDE MAY BE NAMED INSTEAD OF ADDED: the summary is the Mod's measure of the location
  // and the rows are its own discovery, so the line's job is to stop being silent about the difference - not to
  // quietly adopt the larger number as the total.
  const uncounted = observationChestTiles(snapshot).slice(counted);
  const unnamed = uncounted.filter((tile) => !countedLine.includes(`(${String(tile.x)},${String(tile.y)})`));
  return Object.freeze({
    field: "本图箱子",
    line: countedLine,
    checked: true,
    contradicts: unnamed.map((tile) => `(${String(tile.x)},${String(tile.y)})`),
  });
}

/** The chest line one block carries, or `undefined` when the snapshot published no summary at all. */
function chestCountLineOf(block: string): string | undefined {
  return /本图箱子: [^；\n]*/u.exec(block)?.[0];
}

test("a_field_contradicts_its_own_observation: the chest count never disputes the chests beside it", () => {
  const snapshot = farmhouseWithThreeChests();
  const block = blockOf(snapshot);
  const line = chestCountLineOf(block);
  assert.ok(line !== undefined, `the block published no chest line to check: ${block}`);
  const verdict = checkChestCount(line, snapshot);
  const examined = observationChestTiles(snapshot).length;
  console.log(
    `a_field_contradicts_its_own_observation:本图箱子 · fields examined 1 · checked 1 · contradictory ${String(verdict.contradicts.length === 0 ? 0 : 1)} · chests observed ${String(examined)}`,
  );
  assert.deepEqual(
    verdict.contradicts,
    [],
    `the count line and the rows beside it disagree: "${verdict.line}" vs ${verdict.contradicts.join(" / ")}`,
  );
  // AND THE COUNT IS STILL THE MOD'S. The line may not quietly adopt the rows as its total: it says which measure
  // counted nothing and which rows it did not include.
  assert.match(line, /本图箱子: 0（物品 0）/u, `the summary's own number is what the line leads with: ${line}`);
  assert.match(
    line,
    /这次观察还列出 3 个箱子 \(2,10\) \(3,10\) \(4,10\)/u,
    `the rows the count missed are named: ${line}`,
  );
});

test("a_field_contradicts_its_own_observation: the shipped count line is REFUSED by that check", () => {
  // THE FALSIFIER, quoting `round76` line 197 verbatim. A gate that the current line passes has to reject the line this
  // repository shipped, or it is decoration.
  const verdict = checkChestCount("本图箱子: 0（物品 0）", farmhouseWithThreeChests());
  assert.ok(
    verdict.contradicts.length > 0,
    `a zero over three published chests must not read as agreement: ${verdict.line}`,
  );
});

test("a_field_contradicts_its_own_observation: no family label claims a state its own rows deny", () => {
  const observations = [freshlyTilledFarm(), farmhouseWithThreeChests()];
  const verdicts: FieldVerdict[] = [];
  for (const [family, label] of Object.entries(TARGET_FAMILY_LABELS)) {
    for (const snapshot of observations) verdicts.push(checkLabelStateWord(family, label, rowsOf(snapshot, family)));
  }
  const examined = verdicts.length;
  const checked = verdicts.filter((verdict) => verdict.checked).length;
  const contradictory = verdicts.filter((verdict) => verdict.contradicts.length > 0);
  console.log(
    `a_field_contradicts_its_own_observation:label · fields examined ${String(examined)} · checked ${String(checked)} · contradictory ${String(contradictory.length)}`,
  );
  assert.ok(examined > 0, "zero labels examined is blocked, never green: the label table is the population");
  assert.ok(checked > 0, "no family in the fixtures carries a state word, so this gate would agree with itself");
  assert.deepEqual(
    contradictory.map((verdict) => verdict.field),
    [],
    `a label claims a state its own rows deny: ${contradictory
      .map((verdict) => `${verdict.field} → "${verdict.line}" vs ${verdict.contradicts.join(" / ")}`)
      .join(" | ")}`,
  );
});

test("a_field_contradicts_its_own_observation: the shipped seed label is REFUSED by that check", () => {
  // THE FALSIFIER, quoting the word `round76` turns 3-4 carried over empty tilled ground: 「已播种的地 (65,20) (64,19)
  // …」 beside a rectangle read of `hoed=yes watered=no crop=no` for those very tiles.
  const verdict = checkLabelStateWord("seedTargets", "已播种的地", rowsOf(freshlyTilledFarm(), "seedTargets"));
  assert.equal(verdict.checked, true, "the fixture publishes seed rows, so this is a measured verdict");
  assert.equal(verdict.contradicts.length, 1, `the shipped label must fail its own rows: ${verdict.line}`);
});

test("a_field_contradicts_its_own_observation: the seed family is named for what its rows are", () => {
  // The wire's own words for this family are "nearby EMPTY HoeDirt targets paired with a live inventory seed slot", so
  // the label may name the ground as sowable and may not name it as sown.
  const label = TARGET_FAMILY_LABELS.seedTargets;
  assert.equal(label, "可播种的地", `the label states the land, not a planting that has not happened: ${label}`);
  const block = blockOf(freshlyTilledFarm());
  assert.match(block, /可播种的地 \(65,20\)/u, `the family reaches the block under its own name: ${block}`);
  assert.equal(block.includes("已播种"), false, `no line claims a sowing this observation denies: ${block}`);
});
