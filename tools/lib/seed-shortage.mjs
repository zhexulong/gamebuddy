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
 * module states four things and stops: the task's tile count (from the task's own declared shape), the number of
 * plantable seeds she holds, the shortfall between them, and - when the world publishes one - the shop that sells the
 * seed, what the menu charges, and whether that shop's own hours query says it is open. What to do about any of it is
 * hers.
 *
 * WHAT THIS MODULE REFUSES TO SAY.
 *
 *   - No imperative. The fact carries numbers and a source; it never says "go buy" or "you should". A test asserts the
 *     absence of the words, because a fact that instructs is the instruction this design exists to avoid.
 *   - No invented supply. The shop, the price and the trading window come from `seedSupplyTargets`, which the Mod
 *     projects from `Data/Shops` and `ShopBuilder.GetCurrentOwners` - the same reader the shop targets use. Nothing
 *     here knows a shop name, an item id or a price.
 *   - No invented count. `heldCount` is absent when the published stack rows did not cover the holding slots, and the
 *     fact then says `seed_count_unknown` rather than "0". A zero derived from an absence would tell her she has none
 *     of a seed nobody counted.
 *   - No invented affordability. The projection publishes no money field at all, so the fact always ends
 *     `affordability_unknown`: that is a named gap, and it is different from "she can afford it".
 *
 * THE THREE STATES THAT MUST NOT READ ALIKE, because they answer "is walking to town worth it" differently:
 *
 *   - `seed_supply_not_measured` - `plant_seed` was not advertised, so nothing looked. This is our gap.
 *   - `no_known_supply` - measured, and she holds no plantable seed at all.
 *   - `no_known_supply:<item>` - measured, she holds that seed, and no shop in `Data/Shops` stocks it.
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
 */
export function taskPatchTiles(taskId) {
  const declared = TASK_PURPOSE_CRITERIA[taskId]?.patch;
  if (declared === undefined) return null;
  if (!Number.isInteger(declared.width) || !Number.isInteger(declared.height)) return null;
  if (declared.width <= 0 || declared.height <= 0) return null;
  return declared.width * declared.height;
}

/** The currency a shop charges in, as the menu's own words: only `money` is gold. */
function currencyName(currency) {
  if (currency === 0) return "money";
  return `currency_${String(currency)}`;
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
  const head = zh ? "卖点" : "sold at";
  if (typeof row.shopId !== "string" || row.shopId.length === 0) {
    return `${head} ${seedName(seed)} @ ${zh ? "未知" : "unknown"}:no_known_supply:${seed.qualifiedItemId}`;
  }
  const parts = [`${seedName(seed)} @ ${shopName(row)}`];
  parts.push(`price=${String(row.price)}`);
  parts.push(currencyName(row.currency));
  // Two numbers that disagree today are a disagreement scheduled for later: when the shop row declares a different
  // number than the menu charges, both are printed and the reader can see which one the game will take.
  if (Number.isInteger(row.declaredPrice) && row.declaredPrice !== row.price)
    parts.push(zh ? `(标价 ${String(row.declaredPrice)})` : `(declared ${String(row.declaredPrice)})`);
  parts.push(
    row.hoursCondition === undefined
      ? zh
        ? "时段=未声明"
        : "hours=undeclared"
      : zh
        ? `时段=${row.hoursCondition}`
        : `hours=${row.hoursCondition}`,
  );
  if (row.openNow === true) parts.push(zh ? "现在=营业" : "now=open");
  else if (row.openNow === false) parts.push(zh ? "现在=关门" : "now=closed");
  else
    parts.push(zh ? `现在=未测(${row.openNowReason ?? "unknown"})` : `now=unknown(${row.openNowReason ?? "unknown"})`);
  return `${head} ${parts.join(" ")}`;
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

/**
 * The fact, or null when there is nothing to hand over.
 *
 * `snapshot` is the last observed projection: `seedSupplyTargets` is the Mod's own answer, and its ABSENCE is a fact
 * of its own (`seed_supply_not_measured`), never an empty world. `taskId` names the day's task, whose declared shape
 * decides the tile count. `locale` picks the wording; the numbers and codes are the same in both.
 */
export function seedShortageFact({ taskId, snapshot, locale = "zh" }) {
  const zh = locale === "zh";
  const tiles = taskPatchTiles(taskId);
  if (tiles === null) return null;
  const rows = snapshot?.seedSupplyTargets;
  if (!Array.isArray(rows)) {
    return Object.freeze({
      reasonCode: "seed_supply_not_measured",
      text: zh
        ? `种子: 任务 ${String(tiles)} 格, 供应未测量(seed_supply_not_measured)`
        : `seed: task ${String(tiles)} tiles, supply not measured (seed_supply_not_measured)`,
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
      text: zh
        ? `种子: 任务 ${String(tiles)} 格, 手上没有可种的种子, 差 ${String(tiles)} 颗; 卖点 未知:no_known_supply; affordability_unknown`
        : `seed: task ${String(tiles)} tiles, no plantable seed held, short ${String(tiles)}; sold at: no_known_supply; affordability_unknown`,
    });
  }
  const held = totalHeld(groups);
  // No shortfall to state: the pack covers the patch, so there is nothing here she needs. Silence is the answer, and a
  // fact that appeared anyway would be a shortage claim she could act on wrongly.
  if (held !== null && held >= tiles) return null;

  const seed = preferredSeed(groups);
  const supply = preferredSupply(seed.rows);
  const shortfall = held === null ? null : tiles - held;
  const segments = [];
  segments.push(zh ? `种子: 任务 ${String(tiles)} 格` : `seed: task ${String(tiles)} tiles`);
  segments.push(
    held === null
      ? zh
        ? "手上 未知(seed_count_unknown)"
        : "held unknown (seed_count_unknown)"
      : zh
        ? `手上 ${String(held)} 颗`
        : `held ${String(held)}`,
  );
  segments.push(
    shortfall === null
      ? zh
        ? "差 未知"
        : "short unknown"
      : zh
        ? `差 ${String(shortfall)} 颗`
        : `short ${String(shortfall)}`,
  );
  segments.push(supplyClause(seed, supply, locale));
  // The projection publishes no money field, so affordability is a named gap rather than a silence or a guess.
  segments.push("affordability_unknown");
  const text = segments.join(zh ? "; " : "; ");
  const bounded =
    Array.from(text).length > MAX_SEED_SHORTAGE_FACT_CHARS
      ? Array.from(text)
          .slice(0, MAX_SEED_SHORTAGE_FACT_CHARS - 1)
          .join("") + "…"
      : text;
  return Object.freeze({
    reasonCode:
      typeof supply.shopId === "string" && supply.shopId.length > 0
        ? "seed_shortage"
        : `no_known_supply:${seed.qualifiedItemId}`,
    text: bounded,
    seedQualifiedItemId: seed.qualifiedItemId,
    tiles,
    held,
    shortfall,
  });
}
