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
 * THE COUNT HALF IS A POPULATION QUESTION, NOT A WORDING ONE. A count and a list beside it are two readings of ONE set,
 * so the count must count at least what the block's own rows name; a line that instead explains the difference is the
 * block narrating its own disagreement. That narration was shipped for 171 turns (`本图箱子: 0（物品 0） · 这次观察还列出
 * 1 个箱子 (3,7)，本图的计数没算它们`, the FarmHouse) and this gate reads the NUMBER against the ROWS, so prose cannot
 * satisfy it. The two sides are computed by one predicate in the Mod (`TryDescribePlacedChest`), which is what makes the
 * rows a subset of the count rather than a second opinion about it.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE BLOCK'S OWN FIELDS: the count line the vocabulary renders from `chestsSummary`, read out of the
 * block under the spelling the renderer itself uses (`CHEST_COUNT_FIELD_ZH`), and every label in
 * `TARGET_FAMILY_LABELS` - the table the wire's row families are named from. Neither is a list in this file, so a
 * family added tomorrow is measured without anyone remembering this test; the state vocabulary below is what a label
 * may CLAIM, and a claim its own rows deny fails here by name.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeWorldState } from "./fact-brief.js";
import { CHEST_COUNT_FIELD_ZH, observationChestTiles, TARGET_FAMILY_LABELS } from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

/** The block's facts are joined with `；` and its lines with `\n`, so a "line" is one of either. */
function factSegments(block: string): readonly string[] {
  return block
    .split(/[\n；]/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** One target-family row, as `worldObjectTargets` publishes a house's chest. */
function chestRow(targetId: string, x: number, y: number): Readonly<Record<string, unknown>> {
  return {
    targetId,
    kind: "Chest",
    location: "FarmHouse",
    x,
    y,
    slot: 0,
    qualifiedItemId: "(BC)130",
    displayName: "宝箱",
    rotation: null,
    rotations: null,
  };
}

/**
 * The FarmHouse as the Mod publishes it: ONE chest at (3,7) - the starter gift chest, holding the parsnip seeds - and a
 * summary that counts it.
 *
 * This is the wire that used to print the ghost: `本图箱子: 0（物品 0） · 这次观察还列出 1 个箱子 (3,7)，本图的计数没算
 * 它们`. Both halves are now the same predicate, so the count is the room's and the rows are a subset of it.
 */
function farmhouseWithAGiftChest(): Snapshot {
  return {
    revision: 631,
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
    chestsSummary: { chestCount: 1, itemCount: 15, fullCount: 0 },
    chests: [
      {
        chestId: "chest_8f21ac",
        x: 3,
        y: 7,
        displayName: "宝箱",
        isFridge: false,
        items: [{ slot: 0, qualifiedItemId: "(O)472", displayName: "防风草种子", stack: 15 }],
      },
    ],
    colorTargets: [{ targetId: "color_4b90de", location: "FarmHouse", x: 3, y: 7, color: "119,191,255" }],
    worldObjectTargets: [chestRow("chest_1", 3, 7)],
  } as unknown as Snapshot;
}

/**
 * The same room with the summary and the row families replaced, so one fixture describes the wire and each case varies
 * only the numbers a publisher would vary.
 */
function withChests(
  summary: Readonly<{ chestCount: number; itemCount: number; fullCount: number }>,
  rows: readonly Readonly<Record<string, unknown>>[],
): Snapshot {
  return {
    ...farmhouseWithAGiftChest(),
    chestsSummary: summary,
    chests: [],
    colorTargets: [],
    worldObjectTargets: rows,
  } as unknown as Snapshot;
}

/**
 * The FarmHouse observation of `round76` line 197, as the wire carried it: three chests one tile away, and a container
 * summary that counted none of them. Kept as the gate's own falsifier - a wire that still disagrees must be refused.
 */
function farmhouseThatCountedNothing(): Snapshot {
  return withChests({ chestCount: 0, itemCount: 0, fullCount: 0 }, [
    chestRow("chest_1", 2, 10),
    chestRow("chest_2", 3, 10),
    chestRow("chest_3", 4, 10),
  ]);
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
 * One check's verdict: the field, the line that makes the claim, the line that denies it, and whether there was anything
 * to check.
 *
 * `checked: false` is a field this snapshot published nothing for - not a pass. The gate's own line counts them
 * separately so `contradictory 0` can never be read as "everything was verified".
 */
type FieldVerdict = Readonly<{
  field: string;
  line: string;
  deniesWith: readonly string[];
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
  if (carried.length === 0)
    return Object.freeze({ field: family, line: label, deniesWith: [], checked: false, contradicts: [] });
  for (const { word, denies } of carried) {
    if (!label.includes(word)) continue;
    const denied = rows.find((row) => denies(row));
    if (denied !== undefined)
      return Object.freeze({
        field: `${family}:${word}`,
        line: `${label} …`,
        deniesWith: [JSON.stringify(denied)],
        checked: true,
        contradicts: [JSON.stringify(denied)],
      });
  }
  return Object.freeze({ field: family, line: label, deniesWith: [], checked: true, contradicts: [] });
}

/**
 * Whether the count line agrees with the chests the SAME block lists.
 *
 * The count is read from the block's own text under the label the renderer itself uses, so this measures what the model
 * was handed rather than what the renderer intended; the chests are the tiles the same observation published, through
 * the one function `observationChestTiles` that also defines what "the observation names this chest" means. A count
 * smaller than that set is the count denying a row three lines above it - and no wording in the block can repair it,
 * because the two numbers are what a reader compares.
 */
function checkChestCount(block: string, snapshot: Snapshot): FieldVerdict {
  const pattern = new RegExp(`${CHEST_COUNT_FIELD_ZH}: (\\d+)`, "u");
  const line = factSegments(block).find((segment) => pattern.test(segment));
  if (line === undefined)
    return Object.freeze({ field: CHEST_COUNT_FIELD_ZH, line: "", deniesWith: [], checked: false, contradicts: [] });
  const counted = Number(pattern.exec(line)?.[1] ?? "-1");
  assert.ok(counted >= 0, `the count line carries no number this gate can read: ${line}`);
  const observed = observationChestTiles(snapshot);
  const contradicts = observed.slice(counted).map((tile) => `(${String(tile.x)},${String(tile.y)})`);
  const deniesWith = factSegments(block).filter((segment) => contradicts.some((tile) => segment.includes(tile)));
  return Object.freeze({
    field: CHEST_COUNT_FIELD_ZH,
    line,
    deniesWith,
    checked: true,
    contradicts,
  });
}

test("a_field_contradicts_its_own_observation: the chest count never disputes the chests beside it", () => {
  // THE POPULATION IS THE WIRE SHAPES A ROOM CAN HAVE: one chest counted and named at the same tile, a measured zero
  // with nothing named, and a location-wide count over a radius-bounded row list (the distinction the summary exists
  // for). Each is one reading of the block's count field.
  const observations = [
    farmhouseWithAGiftChest(),
    withChests({ chestCount: 0, itemCount: 0, fullCount: 0 }, []),
    withChests({ chestCount: 3, itemCount: 41, fullCount: 2 }, [chestRow("chest_1", 3, 7)]),
  ];
  const verdicts = observations.map((snapshot) => checkChestCount(blockOf(snapshot), snapshot));
  const checked = verdicts.filter((verdict) => verdict.checked).length;
  const contradictory = verdicts.filter((verdict) => verdict.contradicts.length > 0);
  console.log(
    `a_field_contradicts_its_own_observation:${CHEST_COUNT_FIELD_ZH} · fields examined ${String(verdicts.length)} · checked ${String(checked)} · contradictory ${String(contradictory.length)}`,
  );
  assert.ok(checked > 0, "no observation in the fixtures published a count line, so this gate would agree with itself");
  assert.deepEqual(
    contradictory.map((verdict) => verdict.field),
    [],
    `the count line and the rows beside it disagree: ${contradictory
      .map((verdict) => `"${verdict.line}" vs ${verdict.deniesWith.join(" / ")} (${verdict.contradicts.join(" ")})`)
      .join(" | ")}`,
  );
  // AND THE ROWS ARE STILL PRINTED: the fix is agreement between two published readings, never the removal of one.
  const block = blockOf(farmhouseWithAGiftChest());
  assert.match(
    block,
    new RegExp(`${CHEST_COUNT_FIELD_ZH}: 1（物品 15）`, "u"),
    `the room's count is the room's: ${block}`,
  );
  assert.match(block, /可染色处 \(3,7\)|箱子 \(3,7\)/u, `the chest the count includes is still named: ${block}`);
  assert.equal(block.includes("本图的计数没算它们"), false, `no line narrates a disagreement: ${block}`);
});

test("a_field_contradicts_its_own_observation: a wire that still disagrees is REFUSED by that check", () => {
  // THE FALSIFIER, quoting `round76` line 197 verbatim: three chests published, a count of zero. A check the shipped
  // block passes has to reject the wire this repository shipped, or it is decoration.
  const snapshot = farmhouseThatCountedNothing();
  const verdict = checkChestCount(blockOf(snapshot), snapshot);
  assert.equal(verdict.checked, true, "the falsifier's block carries a count line, so this is a measured verdict");
  assert.deepEqual(
    verdict.contradicts,
    ["(2,10)", "(3,10)", "(4,10)"],
    `a zero over three published chests must not read as agreement: ${verdict.line}`,
  );
  assert.ok(verdict.deniesWith.length > 0, "the refusal names the lines that deny the count");
});

test("a_field_contradicts_its_own_observation: no family label claims a state its own rows deny", () => {
  const observations = [freshlyTilledFarm(), farmhouseWithAGiftChest()];
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
