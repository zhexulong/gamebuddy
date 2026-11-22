/**
 * The shortage fact: how many tiles the day's task asks for, how many seeds she actually holds, and where the missing
 * seed is sold - as numbers and a source, never as an instruction.
 *
 * MEASURED, 2026-11-09. A day whose task was `clear_and_plant_long_patch` (three wide, twenty long) began with two seed
 * stacks in the pack. She planted four tiles, said "种子就这些了，想铺满二十格还得再买种", and stopped. Asked afterwards
 * whether she had thought of buying seed: "没有想过买种子。整趟只想着把铜敲够、木头攒够，压根没冒出『去镇上皮埃尔那儿
 * 买种子』这个念头。" In the whole run `shop_purchase` was called zero times and `look_up` was asked about crops,
 * inventory and chests - never about a shop.
 *
 * The fix is not a stronger instruction and not a harness that buys for her: her autonomy is the product. The fix is
 * that a shortage and its supply are WORLD FACTS she is handed, the same way a weed in front of her is a fact. So this
 * module states five things and stops: the task's tile count (from the task's own declared shape), the number of
 * plantable seeds she holds, the shortfall between them, what the missing seed costs where it is sold, and how the
 * money she carries stands against that cost. What to do about any of it is hers.
 *
 * WHAT THIS MODULE REFUSES TO SAY.
 *
 *   - No imperative. The fact carries numbers and a source; it never says "go buy" or "you should". A test asserts the
 *     absence of the words, because a fact that instructs is the instruction this design exists to avoid.
 *   - No invented supply. The shop, the price and the trading window come from `seedSupplyTargets`, which the Mod
 *     projects from `Data/Shops` and `ShopBuilder.GetCurrentOwners` - the same reader the shop targets use. Nothing
 *     here knows a shop name, an item id or a price.
 *   - No invented count. `heldCount` is absent when the published stack rows did not cover the holding slots, and the
 *     fact then says it was never counted rather than "0". A zero derived from an absence would tell her she has none
 *     of a seed nobody counted.
 *   - No invented affordability. `snapshot.money` carries her purse (`host/src/protocol.ts`), so a shortage is priced
 *     against the money she actually has: what is missing costs this much, the purse holds that much, and the sentence
 *     says which side is short. Only a snapshot that published no readable balance says, in words, that the cost cannot
 *     be worked out - a balance is a WIRE decision (the Mod publishes one, or nobody does), so it is never a zero and
 *     never "she can afford it".
 *
 * HER WORDS, NOT THE MACHINE'S. Measured `round89`: the day prompt carried two of this module's lines, and both ended
 * `affordability_unknown` beside `price=80 money 时段=未声明` while `snapshot.money` held the balance the whole time.
 * Every clause is therefore a sentence she can read - `一颗 80 金币`, `现在关着门`, `兜里 500 金币` - and the codes live
 * in `reasonCode`, which is the run artifact's channel. A code that reaches her is a fact she cannot act on.
 *
 * THE FOUR STATES THAT MUST NOT READ ALIKE, because they answer "is walking to town worth it" differently:
 *
 *   - `seed_supply_not_measured` - `plant_seed` was not advertised, so nothing looked. This is our gap.
 *   - `no_known_supply` - measured, and she holds no plantable seed at all.
 *   - `no_known_supply:<item>` - measured, she holds that seed, and no shop in `Data/Shops` stocks it.
 *   - `seed_supply` - measured, she holds at least one, and a shop sells it. The day asks for no NUMBER of tiles, so
 *     there is no shortfall to state: this is the supply, and the number is hers to decide.
 *
 * THE WALLET IS READ WITH `fact-brief.ts`'s RULE. `readOwnMoney` here answers the question the function of that name in
 * `host/src/fact-brief.ts` answers: a safe, non-negative integer is a balance, and anything else is an unread wallet.
 * The tools layer may not import Host production sources (`.dependency-cruiser.tools.cjs`), so the rule is restated
 * rather than shared - and the test pins every boundary of it (absent, negative, fractional, non-numeric, past the safe
 * range) so a drift on this side reads as a behaviour change instead of as a quiet second opinion.
 *
 * A TASK WITH NO DECLARED SHAPE IS NOT A REASON TO WITHHOLD THE FACT. Measured 2026-11-18 (`round67`): the day's task
 * was a criterion of steps, `seedSupplyTargets` was populated eighteen times, and this module composed nothing - the
 * `null` from `taskPatchTiles` was read as "nothing to say" instead of "no tile count to say it against". The supply
 * half never needed a shape.
 */

import { TASK_PURPOSE_CRITERIA } from "./task-purpose.mjs";

/**
 * The longest fact this module will hand over, in characters.
 *
 * A day prompt already carries the task sentence, and a fact that grows with the number of shops would push the task
 * itself out of the model's attention. One line is the whole budget; the row set is bounded to eight by the Mod for
 * the same reason.
 */
export const MAX_SEED_SHORTAGE_FACT_CHARS = 320;

/**
 * The tile count the task itself declares, or null when it declares no shape.
 *
 * The population is `TASK_PURPOSE_CRITERIA` - the one place a task's purpose is declared - so a task whose shape
 * changes, or a new shape task, is covered without editing this module. A criterion made of steps declares no tiles
 * (there is no count to make short), and a `gap` declares none either: those tasks have no patch to fall short of.
 * `null` is therefore the answer for both, and it decides the SHORTFALL half alone - see `taskSowsSeed` for the half
 * that survives it.
 */
export function taskPatchTiles(taskId) {
  const declared = TASK_PURPOSE_CRITERIA[taskId]?.patch;
  if (declared === undefined) return null;
  if (!Number.isInteger(declared.width) || !Number.isInteger(declared.height)) return null;
  if (declared.width <= 0 || declared.height <= 0) return null;
  return declared.width * declared.height;
}

/**
 * Whether the day's task puts a seed in the ground at all - the population that decides whether a supply fact is due.
 *
 * Read from the same declaration `taskPatchTiles` reads, so a new criterion is covered by what it says its purpose is:
 * a patch task sows the whole way, and a criterion sows when one of its admitted steps is `plant_seed`. A `gap` sows
 * nothing it can prove, and a `town_visit` sows nothing at all - handing a fishing day a seed shop would be a fact
 * about a task nobody was given.
 */
export function taskSowsSeed(taskId) {
  const entry = TASK_PURPOSE_CRITERIA[taskId];
  if (entry === undefined) return false;
  if (entry.patch !== undefined) return true;
  return (entry.steps ?? []).some(
    (candidate) => candidate.actionId === "plant_seed" || (candidate.anyOf ?? []).includes("plant_seed"),
  );
}

/**
 * Her purse as the wire published it, or `null` when it published no readable balance.
 *
 * The rule is `host/src/fact-brief.ts`'s `readOwnMoney`: a safe, non-negative integer is a balance, and everything else
 * - absent, `null`, a negative, a fraction, a string - is an unread wallet, which is a different statement from "she
 * has none". The tools layer may not import Host production sources (`.dependency-cruiser.tools.cjs`), so the rule is
 * restated rather than shared, and the test pins each of its boundaries.
 */
function readOwnMoney(snapshot) {
  const money = snapshot?.money;
  return typeof money === "number" && Number.isSafeInteger(money) && money >= 0 ? money : null;
}

/**
 * Her words for what the purse says about the shortage: the cost of what is missing against the balance, or - only
 * when the snapshot published no readable balance - that the cost cannot be worked out.
 *
 * The cost is computable only when three readings are all present: a shortfall to buy for, an integer price, and gold
 * as the shop's currency. Without any of them the purse is still worth stating; the comparison is not invented.
 */
function affordabilityClause({ money, shortfall, price, currency }, zh) {
  if (money === null)
    return zh
      ? "兜里的钱没看过，这些种子够不够算不出来"
      : "the purse was not read, so whether she can afford it cannot be worked out";
  const cost = shortfall !== null && Number.isInteger(price) && currency === 0 ? shortfall * price : null;
  if (cost === null || !Number.isSafeInteger(cost))
    return zh ? `兜里 ${String(money)} 金币` : `purse ${String(money)} gold`;
  if (cost <= money)
    return zh
      ? `差的那 ${String(shortfall)} 颗要 ${String(cost)} 金币，兜里 ${String(money)} 金币，够`
      : `the missing ${String(shortfall)} come to ${String(cost)} gold, purse ${String(money)} gold - enough`;
  return zh
    ? `差的那 ${String(shortfall)} 颗要 ${String(cost)} 金币，兜里 ${String(money)} 金币，还差 ${String(cost - money)}`
    : `the missing ${String(shortfall)} come to ${String(cost)} gold, purse ${String(money)} gold - ${String(
        cost - money,
      )} short`;
}

/** What the menu charges for the seed, in her words: only currency 0 is gold, and an unstated one names no currency. */
function priceClause(row, zh) {
  if (!Number.isInteger(row.price)) return zh ? "价钱没说" : "price not stated";
  if (row.currency === 0) return zh ? `一颗 ${String(row.price)} 金币` : `${String(row.price)} gold each`;
  if (!Number.isInteger(row.currency)) return zh ? `一颗 ${String(row.price)}` : `${String(row.price)} each`;
  return zh
    ? `一颗 ${String(row.price)}（这家店收的不是金币）`
    : `${String(row.price)} each (this shop does not take gold)`;
}

/** The trading window the shop's own query declares, printed verbatim, or the fact that it declares none. */
function hoursClause(row, zh) {
  if (row.hoursCondition === undefined) return zh ? "开门时间没写" : "no opening hours stated";
  return zh ? `开门时间 ${row.hoursCondition}` : `opening hours ${row.hoursCondition}`;
}

/** Whether the shop says it is open now: only an explicit `true` is open, and an unasked question is neither. */
function openNowClause(row, zh) {
  if (row.openNow === true) return zh ? "现在开着门" : "open now";
  if (row.openNow === false) return zh ? "现在关着门" : "closed now";
  return zh ? "现在开不开不知道" : "whether it is open was not read";
}

/** The name a shop is called by: the game's own localized name, else the shop id. */
function shopName(row) {
  const display = typeof row.shopDisplayName === "string" ? row.shopDisplayName : "";
  return display.length > 0
    ? `${row.shopId}(${display}/${row.ownerName || "?"})`
    : `${row.shopId}(${row.ownerName || "?"})`;
}

/** Whether a shop row says it is open: only an explicit `true` is open. */
function isOpenNow(row) {
  return row.openNow === true;
}

/**
 * The one shop row worth naming: open before closed, cheapest before dearest, then by shop id so the same world always
 * produces the same sentence.
 *
 * A shop whose `openNow` is absent (the question could not be asked) sorts with the closed ones rather than with the
 * open ones: preferring an unanswerable row over a shop the game says is open would be a guess dressed as a ranking.
 */
function preferredSupply(rows) {
  return [...rows].sort((left, right) => {
    const openOrder = Number(isOpenNow(right)) - Number(isOpenNow(left));
    if (openOrder !== 0) return openOrder;
    const priceOrder = (left.price ?? Number.MAX_SAFE_INTEGER) - (right.price ?? Number.MAX_SAFE_INTEGER);
    if (priceOrder !== 0) return priceOrder;
    return String(left.shopId).localeCompare(String(right.shopId));
  })[0];
}

/** The seed whose supply is named: the one she holds most of, and by id when the counts are unknown. */
function preferredSeed(groups) {
  return [...groups].sort((left, right) => {
    const leftCount = left.heldCount;
    const rightCount = right.heldCount;
    const leftKnown = Number.isInteger(leftCount);
    const rightKnown = Number.isInteger(rightCount);
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && leftCount !== rightCount) return rightCount - leftCount;
    return left.qualifiedItemId.localeCompare(right.qualifiedItemId);
  })[0];
}

/** The held total across every plantable seed she holds, or null when any of them is uncounted. */
function totalHeld(groups) {
  let total = 0;
  for (const group of groups) {
    if (!Number.isInteger(group.heldCount)) return null;
    total += group.heldCount;
  }
  return total;
}

/** The seed as the fact names it: the game's own display name and the id a purchase would name. */
function seedName(group) {
  return `${group.displayName}(${group.qualifiedItemId})`;
}

/** One row's supply half, or the reason there is none. */
function supplyClause(seed, row, locale) {
  const zh = locale === "zh";
  if (typeof row.shopId !== "string" || row.shopId.length === 0)
    return zh
      ? `卖点: 镇上没查到有店卖 ${seedName(seed)}`
      : `sold at: no shop in town was found selling ${seedName(seed)}`;
  const parts = [
    zh ? `卖点: ${shopName(row)} 卖 ${seedName(seed)}` : `sold at: ${shopName(row)} sells ${seedName(seed)}`,
    priceClause(row, zh),
  ];
  // Two numbers that disagree today are a disagreement scheduled for later: when the shop row declares a different
  // number than the menu charges, both are printed and the reader can see which one the game will take.
  if (Number.isInteger(row.declaredPrice) && row.declaredPrice !== row.price)
    parts.push(zh ? `（标价 ${String(row.declaredPrice)}）` : `(declared ${String(row.declaredPrice)})`);
  parts.push(hoursClause(row, zh));
  parts.push(openNowClause(row, zh));
  return parts.join(zh ? "，" : ", ");
}

/**
 * The day's prompt with the fact appended, or the prompt alone.
 *
 * A separate function because the ONCE-PER-DAY property is a property of this composition: a caller that appends on
 * every turn has turned the fact into an instruction by repetition, and the test can only see that difference if the
 * composition is a thing it can call.
 */
export function dayPromptWithFact(prompt, fact, locale = "zh") {
  if (fact === null || fact === undefined) return prompt;
  return `${prompt}\n${locale === "zh" ? `（地里的事实：${fact.text}）` : `(world fact: ${fact.text})`}`;
}

/** The task half of the sentence: how many tiles it asks for, or the fact that it asks for no number. */
function taskClause(tiles, zh) {
  if (tiles !== null) return zh ? `种子: 任务 ${String(tiles)} 格` : `seed: task ${String(tiles)} tiles`;
  return zh ? "种子: 任务没说几格" : "seed: the task names no tile count";
}

/** How many plantable seeds she holds, or the fact that nobody counted them. */
function heldClause(held, zh) {
  if (held !== null) return zh ? `手上 ${String(held)} 颗` : `held ${String(held)}`;
  return zh ? "手上多少颗没数过" : "held: never counted";
}

/** The shortfall, or nothing at all when the task declared no shape to fall short of. */
function shortfallClause(shortfall, zh) {
  if (shortfall === null) return null;
  return zh ? `差 ${String(shortfall)} 颗` : `short ${String(shortfall)}`;
}

/** The fact's text, bounded: one line is the whole budget, so a long shop name costs a shop rather than the task. */
function boundedText(segments) {
  const text = segments.filter((segment) => segment !== null).join("; ");
  return Array.from(text).length > MAX_SEED_SHORTAGE_FACT_CHARS
    ? Array.from(text)
        .slice(0, MAX_SEED_SHORTAGE_FACT_CHARS - 1)
        .join("") + "…"
    : text;
}

/**
 * The fact, or null when there is nothing to hand over.
 *
 * `snapshot` is the last observed projection: `seedSupplyTargets` is the Mod's own answer, and its ABSENCE is a fact
 * of its own (`seed_supply_not_measured`), never an empty world; `money` is her purse, read with `readOwnMoney`'s rule
 * so that the shortage is priced against the money she has rather than against nothing. `taskId` names the day's task:
 * its declared shape decides the tile count and therefore the shortfall, and its own steps decide whether a supply fact
 * is due at all (`taskSowsSeed`) - which is the half `round67` needed and did not get.
 *
 * `locale` picks the wording; the numbers and the reasonCode are the same in both.
 */
export function seedShortageFact({ taskId, snapshot, locale = "zh" }) {
  const zh = locale === "zh";
  const tiles = taskPatchTiles(taskId);
  if (tiles === null && !taskSowsSeed(taskId)) return null;
  const task = taskClause(tiles, zh);
  const money = readOwnMoney(snapshot);
  const rows = snapshot?.seedSupplyTargets;
  if (!Array.isArray(rows)) {
    return Object.freeze({
      reasonCode: "seed_supply_not_measured",
      text: boundedText([
        task,
        zh ? "卖点: 还没查过镇上有谁卖种子" : "sold at: nothing has looked in town yet",
        affordabilityClause({ money, shortfall: null, price: null, currency: null }, zh),
      ]),
    });
  }
  // Grouped by seed, because the shortage is about the seeds she holds while the supply is about one seed at a time.
  const groups = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.qualifiedItemId !== "string" || row.qualifiedItemId.length === 0) continue;
    const existing = groups.find((group) => group.qualifiedItemId === row.qualifiedItemId);
    if (existing === undefined) {
      groups.push({
        qualifiedItemId: row.qualifiedItemId,
        displayName: typeof row.displayName === "string" ? row.displayName : row.qualifiedItemId,
        heldCount: Number.isInteger(row.heldCount) ? row.heldCount : null,
        rows: [row],
      });
      continue;
    }
    existing.rows.push(row);
  }
  if (groups.length === 0) {
    // Measured, and she holds no plantable seed: a different answer from "nothing looked", and a different answer from
    // "she holds one and nobody sells it".
    return Object.freeze({
      reasonCode: "no_known_supply",
      text: boundedText([
        task,
        zh ? "手上没有可种的种子" : "no plantable seed held",
        shortfallClause(tiles, zh),
        zh ? "卖点: 手上没有种子，无从查起" : "sold at: with no seed held there is none to trace",
        affordabilityClause({ money, shortfall: null, price: null, currency: null }, zh),
      ]),
      tiles,
      held: 0,
      shortfall: tiles,
    });
  }
  const held = totalHeld(groups);
  // No shortfall to state: the pack covers the patch, so there is nothing here she needs. Silence is the answer, and a
  // fact that appeared anyway would be a shortage claim she could act on wrongly. There is no such answer without a
  // declared shape: a criterion that plants asks for no count, so nothing can cover it.
  if (tiles !== null && held !== null && held >= tiles) return null;

  const seed = preferredSeed(groups);
  const supply = preferredSupply(seed.rows);
  const shortfall = tiles === null || held === null ? null : tiles - held;
  const sellsIt = typeof supply.shopId === "string" && supply.shopId.length > 0;
  return Object.freeze({
    // A shortfall claim needs a shape to be short of. Without one this is the supply, and what to do about it is hers.
    reasonCode: !sellsIt ? `no_known_supply:${seed.qualifiedItemId}` : tiles === null ? "seed_supply" : "seed_shortage",
    text: boundedText([
      task,
      heldClause(held, zh),
      shortfallClause(shortfall, zh),
      supplyClause(seed, supply, locale),
      // Answered from the wallet the wire publishes, and named as a gap in words only while there is none to read.
      affordabilityClause({ money, shortfall, price: supply.price, currency: supply.currency }, zh),
    ]),
    seedQualifiedItemId: seed.qualifiedItemId,
    tiles,
    held,
    shortfall,
  });
}
