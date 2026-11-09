/**
 * The shortage fact's gate: `tools/lib/seed-shortage.mjs`.
 *
 * WHAT THIS PROTECTS. Measured 2026-11-09: a sixty-tile patch day began with two seed stacks, four tiles were planted,
 * and the companion said "种子就这些了，想铺满二十格还得再买种" and stopped - having never considered that seed is sold
 * in town. The fact this suite pins is the one that would have been in front of her: the tile count, the count she
 * holds, the shortfall, and where the missing seed is sold.
 *
 * The assertions are shaped so they cannot pass by accident:
 *
 *   - the shop, the price and the trading window are asserted to be the ROW's own values, and the module's source is
 *     scanned for a shop name, an item id or a price literal - a fact that hardcodes "Pierre" would pass a
 *     contains-check and fail here;
 *   - the three states that must not read alike (`not measured` / `no seed held` / `holds it, nobody sells it`) are
 *     asserted against each other, because "is walking to town worth it" is answered differently by each;
 *   - an unpublished count is asserted to say `seed_count_unknown` and NOT `0`: a zero derived from an absence is the
 *     defect class this month keeps paying for;
 *   - the absence of an imperative is asserted directly, because a fact that says "go buy" is the instruction this
 *     design exists to avoid.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_SEED_SHORTAGE_FACT_CHARS, dayPromptWithFact, seedShortageFact, taskPatchTiles } from "./seed-shortage.mjs";

const TASK = "clear_and_plant_long_patch";
const TILES = 60;

/** One row as the Mod projects it: a `Data/Shops` entry joined to the stacks in the pack. */
const parsnip = Object.freeze({
  qualifiedItemId: "(O)472",
  displayName: "Parsnip Seeds",
  heldCount: 2,
  shopId: "SeedShop",
  shopDisplayName: "皮埃尔的杂货店",
  ownerName: "Pierre",
  hoursCondition: "TIME 900 2100",
  price: 20,
  declaredPrice: 20,
  currency: 0,
  openNow: true,
});

const snapshotWith = (rows) => Object.freeze({ seedSupplyTargets: rows });

test("a sixty-tile task with two seeds hands over the shortage once, with its source", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([parsnip]), locale: "zh" });

  assert.notEqual(fact, null, "two seeds against sixty tiles is a shortage, and silence is the defect being fixed");
  assert.equal(fact.reasonCode, "seed_shortage");
  assert.equal(fact.tiles, TILES);
  assert.equal(fact.held, 2);
  assert.equal(fact.shortfall, 58);
  for (const fragment of ["任务 60 格", "手上 2 颗", "差 58 颗", "affordability_unknown"])
    assert.ok(fact.text.includes(fragment), `the fact states "${fragment}": ${fact.text}`);
});

test("the shop, the price and the window in the fact are the row's own, not the module's", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([parsnip]), locale: "zh" });
  for (const fragment of [
    parsnip.shopId,
    parsnip.shopDisplayName,
    parsnip.ownerName,
    `price=${String(parsnip.price)}`,
    parsnip.hoursCondition,
  ])
    assert.ok(fact.text.includes(fragment), `the fact carries the row's own "${fragment}": ${fact.text}`);

  // A second world with a different shop, a different price and a different window: if any of the numbers above were
  // written into the module instead of read from the row, this one would still say the first world's.
  const joja = Object.freeze({
    ...parsnip,
    shopId: "JojaMart",
    shopDisplayName: "Joja 超市",
    ownerName: "",
    hoursCondition: "TIME 900 2300",
    price: 25,
    declaredPrice: 25,
  });
  const other = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([joja]), locale: "zh" });
  assert.ok(other.text.includes("JojaMart"), other.text);
  assert.ok(other.text.includes("price=25"), other.text);
  assert.ok(!other.text.includes("price=20"), `nothing of the first world survives: ${other.text}`);
  assert.ok(other.text.includes("TIME 900 2300"), other.text);
});

test("the module names no shop, no item id and no price of its own", () => {
  const source = readFileSync(fileURLToPath(new URL("./seed-shortage.mjs", import.meta.url)), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const literal of ["SeedShop", "Joja", "Pierre", "(O)472", "price=20", "Marnie"])
    assert.ok(!code.includes(literal), `the fact's source must not carry "${literal}": it comes from the row`);
});

test("a pack that already covers the patch produces no fact at all", () => {
  const enough = Object.freeze({ ...parsnip, heldCount: TILES });
  assert.equal(seedShortageFact({ taskId: TASK, snapshot: snapshotWith([enough]), locale: "zh" }), null);

  // And one seed more than enough, across two stacks: the total is what covers the patch.
  const split = Object.freeze({ ...parsnip, qualifiedItemId: "(O)473", displayName: "Bean Starter", heldCount: 30 });
  const both = Object.freeze({ ...parsnip, heldCount: 30 });
  assert.equal(seedShortageFact({ taskId: TASK, snapshot: snapshotWith([both, split]), locale: "zh" }), null);
});

test("a task that declares no patch has no shortage to state", () => {
  assert.equal(taskPatchTiles("till_and_sow"), null, "a criterion made of steps declares no tile count");
  assert.equal(taskPatchTiles(TASK), TILES);
  assert.equal(seedShortageFact({ taskId: "till_and_sow", snapshot: snapshotWith([parsnip]), locale: "zh" }), null);
});

test("a seed she holds that no shop stocks answers no_known_supply with the item", () => {
  const unsold = Object.freeze({
    qualifiedItemId: "(O)745",
    displayName: "Strawberry Seeds",
    heldCount: 1,
  });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([unsold]), locale: "zh" });

  assert.equal(fact.reasonCode, "no_known_supply:(O)745");
  assert.ok(fact.text.includes("no_known_supply:(O)745"), fact.text);
  assert.equal(fact.held, 1);
});

test("a measured world where she holds no plantable seed is a different answer from 'nobody sells it'", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([]), locale: "zh" });

  assert.equal(fact.reasonCode, "no_known_supply");
  assert.ok(fact.text.includes("no_known_supply"), fact.text);
  assert.ok(!fact.text.includes("no_known_supply:"), `there is no item to name: ${fact.text}`);
  assert.ok(fact.text.includes("任务 60 格"), fact.text);
});

test("a world that never looked is named, and is not an empty world", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: Object.freeze({}), locale: "zh" });

  assert.equal(fact.reasonCode, "seed_supply_not_measured");
  assert.ok(fact.text.includes("seed_supply_not_measured"), fact.text);
  assert.ok(!fact.text.includes("no_known_supply"), "not measured is not 'nothing there': " + fact.text);
});

test("an unpublished seed count says seed_count_unknown instead of zero", () => {
  const uncounted = Object.freeze({ ...parsnip, heldCount: undefined });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([uncounted]), locale: "zh" });

  assert.equal(fact.held, null, "a count nobody published is not a count of zero");
  assert.ok(fact.text.includes("seed_count_unknown"), fact.text);
  assert.ok(!/手上 0/u.test(fact.text), `the fact must not claim she holds none: ${fact.text}`);
  // The supply half is still a fact about the world, and it is still worth stating.
  assert.ok(fact.text.includes(parsnip.shopId), fact.text);
});

test("a shop the game says is shut at this hour says so, with the hours that explain it", () => {
  const closed = Object.freeze({ ...parsnip, openNow: false });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([closed]), locale: "zh" });

  assert.ok(fact.text.includes("现在=关门"), fact.text);
  assert.ok(fact.text.includes("时段=TIME 900 2100"), `closed without the window is unexplainable: ${fact.text}`);
});

test("an unanswerable open-now is not 'closed'", () => {
  const unknown = Object.freeze({ ...parsnip, openNow: undefined, openNowReason: "owner_condition_unreadable" });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([unknown]), locale: "zh" });

  assert.ok(fact.text.includes("现在=未测(owner_condition_unreadable)"), fact.text);
  assert.ok(!fact.text.includes("现在=关门"), `an unasked question is not a shut shop: ${fact.text}`);
});

test("a shop whose row declares a different price than the menu charges states both", () => {
  const disagreed = Object.freeze({ ...parsnip, price: 24, declaredPrice: 20 });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([disagreed]), locale: "zh" });

  assert.ok(fact.text.includes("price=24"), fact.text);
  assert.ok(fact.text.includes("标价 20"), `the declared number is named rather than dropped: ${fact.text}`);
});

test("an open shop is preferred over a closed one, and the cheapest over the dearest", () => {
  const closedAndCheap = Object.freeze({
    ...parsnip,
    shopId: "SeedShop",
    shopDisplayName: "皮埃尔的杂货店",
    price: 10,
    declaredPrice: 10,
    openNow: false,
  });
  const openAndDear = Object.freeze({
    ...parsnip,
    shopId: "JojaMart",
    shopDisplayName: "Joja 超市",
    price: 30,
    declaredPrice: 30,
    openNow: true,
  });
  const fact = seedShortageFact({
    taskId: TASK,
    snapshot: snapshotWith([closedAndCheap, openAndDear]),
    locale: "zh",
  });

  assert.ok(fact.text.includes("JojaMart"), `a shop she can walk into now outranks a cheaper shut one: ${fact.text}`);
  assert.ok(fact.text.includes("现在=营业"), fact.text);
});

test("the fact never exceeds its character budget, however many shops the world names", () => {
  const many = Array.from({ length: 8 }, (_, index) =>
    Object.freeze({
      ...parsnip,
      qualifiedItemId: `(O)${String(470 + index)}`,
      displayName: `A Rather Long Seed Name Number ${String(index)}`,
      shopId: `SomeLongShopIdentifier${String(index)}`,
      shopDisplayName: `一个相当长的商店名字 ${String(index)}`,
      hoursCondition: "TIME 900 2100,DAY_OF_WEEK Mon Tue Wed Thu Fri Sat Sun,SEASON spring summer fall winter",
      price: 100 + index,
    }),
  );
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith(many), locale: "zh" });

  assert.ok(Array.from(fact.text).length <= MAX_SEED_SHORTAGE_FACT_CHARS, `bounded at ${MAX_SEED_SHORTAGE_FACT_CHARS}`);
});

test("the fact carries no imperative, in either locale", () => {
  for (const locale of ["zh", "en"]) {
    const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([parsnip]), locale });
    for (const word of ["买", "去买", "应该", "记得", "should", "must", "go buy", "remember to"])
      assert.ok(!fact.text.includes(word), `the fact must not instruct ("${word}"): ${fact.text}`);
  }
});

test("the fact is appended to the day's prompt once, and the prompt is untouched without one", () => {
  const prompt = "门前横着开一条长地，三格宽、二十格长，清出来种上。";
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([parsnip]), locale: "zh" });
  const withFact = dayPromptWithFact(prompt, fact, "zh");

  assert.ok(withFact.startsWith(prompt), "the task sentence stays whole and first");
  assert.equal(withFact.split(fact.text).length, 2, "the fact appears exactly once");
  // No fact (a covered patch, or a task with no shape) leaves the prompt exactly as it was: nothing is added.
  assert.equal(dayPromptWithFact(prompt, null, "zh"), prompt);
});
