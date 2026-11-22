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
 *   - an unpublished count is asserted to say it was never counted and NOT `0`: a zero derived from an absence is the
 *     defect class this month keeps paying for;
 *   - EVERY fact is asserted to carry no machine token - no `affordability_unknown`, no `price=`, no `时段=`, no
 *     snake_case code - because the sentence is read by her, and a token is a fact she cannot use (`round89`);
 *   - an unread wallet and a read one are asserted against each other, because `snapshot.money` is on the wire now and
 *     the line must carry the number instead of the gap (`host/src/fact-brief.ts` `readOwnMoney`);
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
  // This world publishes no balance, so the affordability half is the named gap - in her words, which is what the
  // `round89` test below asserts the wallet-observed half of.
  for (const fragment of ["任务 60 格", "手上 2 颗", "差 58 颗", "兜里的钱没看过"])
    assert.ok(fact.text.includes(fragment), `the fact states "${fragment}": ${fact.text}`);
});

test("the shop, the price and the window in the fact are the row's own, not the module's", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([parsnip]), locale: "zh" });
  for (const fragment of [
    parsnip.shopId,
    parsnip.shopDisplayName,
    parsnip.ownerName,
    `一颗 ${String(parsnip.price)} 金币`,
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
  assert.ok(other.text.includes("一颗 25 金币"), other.text);
  assert.ok(!other.text.includes("一颗 20 金币"), `nothing of the first world survives: ${other.text}`);
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

test("a task that declares no patch has no tile count to state", () => {
  assert.equal(taskPatchTiles("till_and_sow"), null, "a criterion made of steps declares no tile count");
  assert.equal(taskPatchTiles(TASK), TILES);
});

/**
 * THE CRITERION WITH NO PATCH IS NOT A REASON TO WITHHOLD THE FACT.
 *
 * <p>
 * Measured on `round67` (2026-11-18): the day's task was a criterion of steps, `seedSupplyTargets` was populated
 * EIGHTEEN times - `heldCount:2, price:80, shopId:"SeedShop", openNow:false, hoursCondition:"TIME 0000 1659"` - and
 * this module composed nothing at all, because `taskPatchTiles` answers `null` for a criterion and the composition
 * treated that as "there is nothing to say". Zero `shortage`, zero `no_known_supply`, zero `affordability_unknown` in
 * fifty-seven turns, while the one fact she needed (the seed she holds is sold in town, for that price, shut until
 * tomorrow) sat in the observation unread.
 * </p>
 * <p>
 * A criterion with no declared shape asks for no NUMBER of tiles, so there is no SHORTFALL to state - but the supply
 * half does not need a shape: the seeds she holds and where more of them are sold are facts about the world. The
 * population that decides whether a task wants a seed at all is `TASK_PURPOSE_CRITERIA`: a criterion whose steps include
 * `plant_seed` sows, and a task whose purpose is to fish or to talk does not.
 * </p>
 */
test("a criterion that plants carries the supply even though it declares no tile count", () => {
  const fact = seedShortageFact({ taskId: "till_and_sow", snapshot: snapshotWith([parsnip]), locale: "zh" });

  assert.notEqual(fact, null, "a planting day with a measured supply has something to hand over");
  assert.equal(fact.reasonCode, "seed_supply", "a supply with no declared patch is not a shortage claim");
  assert.equal(fact.tiles, null, "a criterion of steps declares no tile count, and none is invented");
  assert.equal(fact.shortfall, null, "no shape, no shortfall: the number would be ours, not the task's");
  assert.equal(fact.held, 2);
  for (const fragment of [
    "任务没说几格",
    "手上 2 颗",
    parsnip.shopId,
    `一颗 ${String(parsnip.price)} 金币`,
    "兜里的钱没看过",
  ])
    assert.ok(fact.text.includes(fragment), `the fact states "${fragment}": ${fact.text}`);
  assert.ok(!fact.text.includes("差 "), `there is no shortfall to state: ${fact.text}`);
});

/** The same day in a world where she holds no plantable seed: still a fact, and no number of tiles beside it. */
test("a planting criterion with no seed held is a supply fact, not a shortage of an unstated number", () => {
  const fact = seedShortageFact({ taskId: "clear_and_cultivate", snapshot: snapshotWith([]), locale: "zh" });

  assert.equal(fact.reasonCode, "no_known_supply");
  assert.ok(fact.text.includes("手上没有可种的种子"), fact.text);
  assert.ok(fact.text.includes("兜里的钱没看过"), fact.text);
  assert.ok(!/差 \d/u.test(fact.text), `no shortfall is invented for a task with no declared shape: ${fact.text}`);
});

/**
 * THE FALSIFIER DIRECTION: a day that sows nothing gets no seed fact, however full the supply family is.
 *
 * Without this, "compose for a criterion" would be "compose for every task", and a fishing day would be handed a seed
 * shop. The membership is read off the criteria table, not off a list written here.
 */
test("a day that plants nothing is handed no seed fact at all", () => {
  for (const taskId of ["forage_and_trees", "town_market", "town_visit", "tend_the_animals", "run_the_machines"])
    assert.equal(
      seedShortageFact({ taskId, snapshot: snapshotWith([parsnip]), locale: "zh" }),
      null,
      `"${taskId}" does not sow, so its supply half is not news`,
    );
});

/** `round67`'s own row, verbatim from that run's observation. */
const round67 = Object.freeze({
  qualifiedItemId: "(O)470",
  displayName: "Rare Seed",
  heldCount: 2,
  shopId: "SeedShop",
  hoursCondition: "TIME 0000 1659",
  price: 80,
  currency: 0,
  openNow: false,
});

test("round67's row: 80g at a shut SeedShop, and the fact says where, when and at what price", () => {
  const fact = seedShortageFact({ taskId: "clear_and_cultivate", snapshot: snapshotWith([round67]), locale: "zh" });

  assert.notEqual(fact, null, "this is the run whose day composed nothing");
  for (const fragment of ["SeedShop", "一颗 80 金币", "开门时间 TIME 0000 1659", "现在关着门", "手上 2 颗"])
    assert.ok(fact.text.includes(fragment), `round67's own value "${fragment}": ${fact.text}`);
  assert.doesNotMatch(fact.text, /price=|时段=|affordability_unknown/u, `no machine token: ${fact.text}`);
  assert.equal(fact.seedQualifiedItemId, "(O)470");
  assert.equal(fact.held, 2);
});

test("a seed she holds that no shop stocks answers no_known_supply with the item", () => {
  const unsold = Object.freeze({
    qualifiedItemId: "(O)745",
    displayName: "Strawberry Seeds",
    heldCount: 1,
  });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([unsold]), locale: "zh" });

  assert.equal(fact.reasonCode, "no_known_supply:(O)745");
  assert.match(fact.text, /镇上没查到有店卖 .*\(O\)745/u, fact.text);
  assert.equal(fact.held, 1);
});

test("a measured world where she holds no plantable seed is a different answer from 'nobody sells it'", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([]), locale: "zh" });

  assert.equal(fact.reasonCode, "no_known_supply");
  assert.ok(fact.text.includes("手上没有可种的种子"), fact.text);
  assert.ok(fact.text.includes("卖点: 手上没有种子"), `the supply half says why it cannot be named: ${fact.text}`);
  assert.ok(!fact.text.includes("no_known_supply"), `the state is not a word she reads: ${fact.text}`);
  assert.ok(fact.text.includes("任务 60 格"), fact.text);
});

test("a world that never looked is named, and is not an empty world", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: Object.freeze({}), locale: "zh" });

  assert.equal(fact.reasonCode, "seed_supply_not_measured");
  assert.ok(fact.text.includes("还没查过镇上有谁卖种子"), fact.text);
  assert.ok(!fact.text.includes("seed_supply_not_measured"), `a code is not a sentence she reads: ${fact.text}`);
  assert.ok(!fact.text.includes("no_known_supply"), "not measured is not 'nothing there': " + fact.text);
});

/**
 * THE WALLET IS ON THE WIRE, AND A TOKEN IS NOT A WORD SHE CAN USE.
 *
 * <p>
 * Measured `round89`: the day prompt carried two of this module's lines and both ended `affordability_unknown` beside
 * `price=80 money 时段=未声明`, while `snapshot.money` held the balance the whole time. `price=80 money` is a machine's
 * report of a shop row and `affordability_unknown` is a machine's report of its own gap: neither is a fact she can use.
 * The line carries the number and prices the shortage against it.
 * </p>
 */
test("round89's two lines carry the wallet and lose the machine tokens", () => {
  const row = Object.freeze({
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    heldCount: 2,
    shopId: "SeedShop",
    ownerName: "Pierre",
    price: 80,
    currency: 0,
    openNow: true,
  });
  const snapshot = Object.freeze({ seedSupplyTargets: [row], money: 500 });
  const lines = [TASK, "till_and_sow"].map((taskId) => seedShortageFact({ taskId, snapshot, locale: "zh" }));

  assert.equal(lines[0].reasonCode, "seed_shortage", "the first line is the shortage");
  assert.equal(lines[1].reasonCode, "seed_supply", "the second is a planting day that declares no tile count");
  for (const fact of lines) {
    assert.ok(!fact.text.includes("affordability_unknown"), `the gap is not hers to read: ${fact.text}`);
    assert.ok(fact.text.includes("兜里 500 金币"), `the balance the wire published: ${fact.text}`);
    assert.doesNotMatch(fact.text, /price=|时段=|\bmoney\b/u, `no machine token in her sentence: ${fact.text}`);
  }
  // 58 missing seeds at 80 gold is 4640 against 500 in the purse: the shortage is PRICED, not shrugged at.
  assert.ok(lines[0].text.includes("要 4640 金币"), lines[0].text);
  assert.ok(lines[0].text.includes("还差 4140"), lines[0].text);
  // And the line she reads is the composed prompt, not the module's object.
  const prompt = dayPromptWithFact("门前横着开一条长地，三格宽、二十格长，清出来种上。", lines[0], "zh");
  assert.ok(prompt.includes("兜里 500 金币"), prompt);
  assert.ok(!prompt.includes("affordability_unknown"), prompt);
});

/**
 * AN UNREAD WALLET IS OUR GAP, AND SAYING SO IN WORDS IS NOT A SHRUG.
 *
 * <p>
 * `round67` is what an absent balance cost: she priced copper at 75 g and concluded 「I have little money」 with nothing
 * to read. So the fact says the cost cannot be worked out - and it says it in words, because the sentence is hers.
 * `host/src/fact-brief.ts`'s `readOwnMoney` is the one spelling of "is the wallet observed"; this module asks the same
 * question of the same snapshot field.
 * </p>
 */
test("with no wallet on the wire the shortage says in words that it cannot be priced", () => {
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([parsnip]), locale: "zh" });

  assert.ok(!fact.text.includes("affordability_unknown"), `a code is not a sentence: ${fact.text}`);
  assert.ok(fact.text.includes("兜里的钱没看过"), fact.text);
  assert.ok(!/兜里 \d/u.test(fact.text), `no balance is invented from an absence: ${fact.text}`);
  assert.ok(!fact.text.includes("还差"), `no deficit is claimed: ${fact.text}`);
  assert.ok(!/颗要 \d+/u.test(fact.text), `nor a cost the wallet was needed to compare: ${fact.text}`);
});

/**
 * WHAT COUNTS AS A BALANCE IS `readOwnMoney`'s RULE, AND ITS BOUNDARIES ARE WHERE A MIRROR DRIFTS.
 *
 * <p>
 * The tools layer may not import Host production sources (`.dependency-cruiser.tools.cjs`), so the rule - a safe,
 * non-negative integer - is restated in the module. Each boundary is pinned here, because a mirrored predicate that is
 * never tested from its own edges is two opinions waiting to disagree: a string, a negative, a fraction, a value past
 * the safe range and `NaN` are all an UNREAD wallet, never "she has none".
 * </p>
 */
test("a balance that is not a non-negative safe integer reads as an unread wallet", () => {
  for (const money of ["500", -1, 1.5, null, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
    const fact = seedShortageFact({
      taskId: TASK,
      snapshot: Object.freeze({ seedSupplyTargets: [parsnip], money }),
      locale: "zh",
    });
    assert.ok(fact.text.includes("兜里的钱没看过"), `${String(money)} is not a balance: ${fact.text}`);
  }
  const empty = seedShortageFact({
    taskId: TASK,
    snapshot: Object.freeze({ seedSupplyTargets: [parsnip], money: 0 }),
    locale: "zh",
  });
  assert.ok(empty.text.includes("兜里 0 金币"), `zero is a balance, and it is not an absence: ${empty.text}`);
});

/**
 * A PRICE IN AN UNSTATED CURRENCY IS NOT A GOLD PRICE.
 *
 * <p>
 * `currency` is optional on the row (`protocol.ts`), and comparing a number that may not be gold with a gold balance
 * would be a comparison of two different things. The price is still the row's own number; what it is counted in is
 * simply not said.
 * </p>
 */
test("a row that does not say what its shop charges in names no currency and is not compared with the purse", () => {
  const unclear = Object.freeze({ ...parsnip, currency: undefined });
  const bare = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([unclear]), locale: "zh" });

  assert.ok(bare.text.includes("一颗 20"), bare.text);
  assert.ok(!bare.text.includes("金币"), `no currency is invented for a price that names none: ${bare.text}`);

  const priced = seedShortageFact({
    taskId: TASK,
    snapshot: Object.freeze({ seedSupplyTargets: [unclear], money: 500 }),
    locale: "zh",
  });
  assert.ok(!priced.text.includes("还差"), `a price in an unstated currency is not compared with gold: ${priced.text}`);
  assert.ok(priced.text.includes("兜里 500 金币"), `the purse is still a fact about the world: ${priced.text}`);
});

/**
 * THE DEFECT CLASS, NOT THE INSTANCE: no fact this module composes may put a machine token in the sentence she reads.
 *
 * <p>
 * The population is every world shape and both locales, so a clause added later is covered without editing this test.
 * `hoursCondition` is the row's own string and is printed verbatim, so the worlds here carry the game's ordinary
 * `TIME 900 2100` rather than a condition full of its own delimiters.
 * </p>
 */
test("no fact this module composes carries a machine token", () => {
  const worlds = {
    shortage: snapshotWith([parsnip]),
    priced: Object.freeze({ seedSupplyTargets: [parsnip], money: 500 }),
    empty: snapshotWith([]),
    unmeasured: Object.freeze({}),
    unsold: snapshotWith([Object.freeze({ ...parsnip, shopId: undefined, price: undefined })]),
    uncounted: snapshotWith([Object.freeze({ ...parsnip, heldCount: undefined })]),
    closed: snapshotWith([Object.freeze({ ...parsnip, openNow: false })]),
    undeclaredHours: snapshotWith([Object.freeze({ ...parsnip, hoursCondition: undefined })]),
    unanswerableOpen: snapshotWith([Object.freeze({ ...parsnip, openNow: undefined })]),
  };
  let examined = 0;
  for (const locale of ["zh", "en"])
    for (const taskId of [TASK, "till_and_sow"])
      for (const [label, snapshot] of Object.entries(worlds)) {
        const fact = seedShortageFact({ taskId, snapshot, locale });
        if (fact === null) continue;
        examined += 1;
        assert.doesNotMatch(
          fact.text,
          /[a-z]+_[a-z]+/u,
          `a snake_case code reached her sentence (${label}/${locale}): ${fact.text}`,
        );
        assert.doesNotMatch(
          fact.text,
          /(?:^|[\s(（;,])[a-z]+=/u,
          `a machine assignment reached her sentence (${label}/${locale}): ${fact.text}`,
        );
      }
  assert.ok(examined >= 10, `the population must not be empty: examined ${String(examined)}`);
});

test("an unpublished seed count says it was never counted instead of zero", () => {
  const uncounted = Object.freeze({ ...parsnip, heldCount: undefined });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([uncounted]), locale: "zh" });

  assert.equal(fact.held, null, "a count nobody published is not a count of zero");
  assert.ok(fact.text.includes("手上多少颗没数过"), fact.text);
  assert.ok(!/手上 0/u.test(fact.text), `the fact must not claim she holds none: ${fact.text}`);
  // The supply half is still a fact about the world, and it is still worth stating.
  assert.ok(fact.text.includes(parsnip.shopId), fact.text);
});

test("a shop the game says is shut at this hour says so, with the hours that explain it", () => {
  const closed = Object.freeze({ ...parsnip, openNow: false });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([closed]), locale: "zh" });

  assert.ok(fact.text.includes("现在关着门"), fact.text);
  assert.ok(fact.text.includes("开门时间 TIME 900 2100"), `closed without the window is unexplainable: ${fact.text}`);
});

test("an unanswerable open-now is not 'closed'", () => {
  const unknown = Object.freeze({ ...parsnip, openNow: undefined, openNowReason: "owner_condition_unreadable" });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([unknown]), locale: "zh" });

  assert.ok(fact.text.includes("现在开不开不知道"), fact.text);
  assert.ok(!fact.text.includes("现在关着门"), `an unasked question is not a shut shop: ${fact.text}`);
});

test("a shop whose row declares a different price than the menu charges states both", () => {
  const disagreed = Object.freeze({ ...parsnip, price: 24, declaredPrice: 20 });
  const fact = seedShortageFact({ taskId: TASK, snapshot: snapshotWith([disagreed]), locale: "zh" });

  assert.ok(fact.text.includes("一颗 24 金币"), fact.text);
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
  assert.ok(fact.text.includes("现在开着门"), fact.text);
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

test("new concrete strip and shop-and-plot tasks carry seed shortage and supply facts", () => {
  const stripFact = seedShortageFact({ taskId: "plant_market_strip", snapshot: snapshotWith([parsnip]), locale: "zh" });
  assert.equal(taskPatchTiles("plant_market_strip"), 36);
  assert.equal(stripFact.reasonCode, "seed_shortage");
  assert.equal(stripFact.shortfall, 34);
  assert.ok(stripFact.text.includes("任务 36 格"), stripFact.text);

  const expandFact = seedShortageFact({
    taskId: "buy_seeds_and_expand_plot",
    snapshot: snapshotWith([parsnip]),
    locale: "zh",
  });
  assert.equal(expandFact.reasonCode, "seed_supply");
  assert.ok(expandFact.text.includes("SeedShop"), expandFact.text);
});
