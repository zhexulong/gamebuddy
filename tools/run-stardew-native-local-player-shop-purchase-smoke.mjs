// Stardew-local shop_purchase smoke.
//
// Scope (owner decision): this action BUYS and nothing else. It does not walk — if the
// shop owner is outside the native interaction radius it refuses with
// shop_counter_out_of_reach and the Agent moves first. So this runner's job is to prove
// the TRANSACTION, and it proves the three things a receipt alone cannot:
//
//   1. the terminal is the native item_purchased;
//   2. the purse really paid — money_after == money_before - purchased * unit_price;
//   3. the goods really arrived — the item count in the inventory went up by `purchased`.
//
// The fixture establishes only the declared Given (clock inside trading hours, the owner
// present in the location, the actor one step away). Shop identity, eligibility, stock and
// price are all read from the game by the Mod at admission.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  waitForActionable,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "shop_purchase"];
const SCENARIO = "native_shop_purchase_v1";
const TERMINAL_REASON = "item_purchased";

/**
 * This runner's declared cases, and the fixture world each one is armed by.
 *
 * Two cases because a world cannot stand in two shops: the published gate arms `native_shop_purchase_v1` (Pierre's
 * counter in the SeedShop) and its second gate arms `native_shop_tool_upgrade_v1` (the blacksmith's counter with one
 * copper hoe). The tally below names the case that this launch did NOT arm, so a run never reads as "both proved".
 */
export const SHOP_PURCHASE_CASES = Object.freeze({
  item_purchase: "native_shop_purchase_v1",
  clint_upgrade: "native_shop_tool_upgrade_v1",
});

/**
 * The terminal a tool upgrade earns, and the number of days the engine sets for a fresh one
 * (`Tool.cs:890`: `Game1.player.daysLeftForToolUpgrade.Value = 2`).
 */
export const TOOL_UPGRADE_TERMINAL = "tool_upgrade_purchased";
export const TOOL_UPGRADE_DAYS = 2;

/** The shop id the engine's own upgrade branch answers to (`Tool.cs:875`). */
export const TOOL_UPGRADE_SHOP_ID = "ClintUpgrade";

/** The item the fixture makes buyable and the runner asks for. */
// Taken from the shop's own advertised stock, never guessed: discovery publishes what a
// shop can sell right now, and asking for anything else is legitimately refused with
// item_not_sold_here (which is exactly how the first successful dispatch ended).
const TARGET_ITEM_ID = null;
const QUANTITY = 1;

/**
 * The sale this case buys, as an index into the shop's advertised stock.
 *
 * THE FIFTH, not the first, and that is the point. `ShopMenu` draws four rows at a time and resolves a clicked button
 * as `forSale[currentItemIndex + k]` (ShopMenu.cs:1096-1102), so a sale at index four is the first one that only exists
 * once the menu's own pager has moved the cursor - `receiveScrollWheelAction(-1)` (:933-951). Measured 2026-11-13: the
 * translation without the pager refused every purchase past the fourth with `button=-1`. Buying `stockItemIds[0]` -
 * what this runner used to do - never pressed that pager, so no live run could tell the paging half from the half that
 * already worked.
 */
export const PAGER_SALE_INDEX = 4;

/**
 * The runner's entry: pick the case this launch armed, run it, and report the whole tally beside its verdict.
 *
 * A case that is not armed is NAMED with the scenario it needs rather than quietly absent, and the run is still
 * non-zero on anything but a pass - a case that silently skips is worse than a missing one. A scenario this runner
 * does not declare falls to the ordinary case, whose own validation refuses it by the name it always had.
 */
export async function runShopPurchaseSmoke(client, config, options = {}) {
  const armedScenario = config?.NativeLocalPlayerFixture?.FixtureScenario ?? null;
  const armedCase = armedScenario === SHOP_PURCHASE_CASES.clint_upgrade ? "clint_upgrade" : "item_purchase";
  const result =
    armedCase === "clint_upgrade"
      ? await runToolUpgradeCase(client, config, options)
      : await runItemPurchaseCase(client, config, options);
  return withCaseTally(result, armedCase);
}

/** The tally every verdict carries: what ran, what did not, and the scenario the missing half needs. */
function withCaseTally(result, armedCase) {
  const names = Object.keys(SHOP_PURCHASE_CASES);
  const unarmed = names.filter((name) => name !== armedCase).map((name) => `${name}:${SHOP_PURCHASE_CASES[name]}`);
  return {
    ...result,
    caseName: armedCase,
    tally: {
      cases: names.length,
      passed: result.state === "passed" ? 1 : 0,
      failed: result.state === "passed" ? 0 : 1,
      unarmed,
    },
  };
}

/** The published purchase case: goods that arrive, money that moves, unchanged from its own live proof. */
async function runItemPurchaseCase(client, config, { timeoutMs = 30_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateNativeLocalFixtureConfig(config);

    // The fixture warps the actor next to the counter, and the warp is ASYNC: observing immediately can catch
    // `player_cannot_move` and end the run with `native_snapshot_not_actionable`. Wait for the ability to act
    // rather than treating a warp in flight as a shop that cannot be opened.
    const before = await waitForActionable(client, await observeFresh(client), 30_000).catch(() =>
      observeFresh(client, { actionable: true }),
    );
    // Record what was actually observed before any assertion can throw: an empty trace
    // with a bare reasonCode cannot distinguish a missing capability from a dead pipe.
    trace.push({
      phase: "observed",
      actionableAfterWait: before.actionable,
      revision: before.revision,
      location: before.location,
      tile: before.tile ?? null,
      actionable: before.actionable,
      activeExecution: before.activeExecution ?? null,
      capabilities: Array.isArray(before.capabilities) ? [...before.capabilities] : null,
      shopTargetCount: Array.isArray(before.shopTargets) ? before.shopTargets.length : null,
    });
    if (!Array.isArray(before.capabilities?.slice?.() ?? before.capabilities)) {
      throw new Error("shop_capabilities_not_an_array");
    }
    {
      const missing = EXPECTED_CAPABILITIES.filter((c) => !before.capabilities.includes(c));
      trace.push({ phase: "capability_check", missing, expected: [...EXPECTED_CAPABILITIES] });
      if (missing.length > 0) throw new Error(`shop_missing_capabilities:${missing.join(",")}`);
    }
    assertRequiredCapabilities(before, EXPECTED_CAPABILITIES);

    const shops = readShopTargets(before);
    trace.push({
      phase: "shop_target_shape",
      // The raw keys the Mod actually sent, so a stale artifact or a renamed field is
      // visible instead of presenting as an undefined property.
      rawKeys:
        Array.isArray(before?.shopTargets) && before.shopTargets.length > 0
          ? Object.keys(before.shopTargets[0] ?? {}).sort()
          : null,
      sample:
        Array.isArray(before?.shopTargets) && before.shopTargets.length > 0
          ? Object.fromEntries(
              Object.entries(before.shopTargets[0] ?? {}).map(([k, v]) => [
                k,
                Array.isArray(v) ? `array(${v.length})` : typeof v === "object" ? "object" : String(v),
              ]),
            )
          : null,
    });
    if (shops.length === 0) throw new Error(`shop_no_targets_advertised:location=${before.location}`);
    // Prefer a shop that can actually sell something: an advertised shop with empty stock
    // cannot demonstrate a purchase, and that is a finding, not a failure of the action.
    // Read defensively on purpose: a raw TypeError here would erase the very evidence
    // needed to tell a stale artifact from a dropped field. The trace below carries the
    // real keys either way.
    // Prefer a stall that can actually be bought from AND is not a seasonal one. Discovery
    // advertises every shop whose owner entry is currently eligible, and the live run picked
    // DesertFestival_Pierre — a festival stall — because the content data happens to list it
    // first. Demonstrating "buy something" must not depend on that ordering.
    const seasonal = (id) => /Festival|Fair|Carnival|NightMarket/i.test(id);
    const buyable = shops.filter((s) => s.ownerInReach && (s.stockItemIds?.length ?? 0) > 0);
    const shop = buyable.find((s) => !seasonal(s.shopId)) ?? buyable[0] ?? null;
    if (!shop)
      throw new Error(
        `shop_owner_out_of_reach:${shops.map((s) => `${s.shopId}@${s.ownerTileX},${s.ownerTileY}`).join("/")}`,
      );

    const targetItemId = TARGET_ITEM_ID ?? shop.stockItemIds?.[PAGER_SALE_INDEX];
    if (typeof targetItemId !== "string" || targetItemId.length === 0)
      throw new Error(
        `shop_pager_sale_not_advertised:stock=${shop.stockItemIds?.length ?? 0};need_at_least=${PAGER_SALE_INDEX + 1}`,
      );
    const requestId = `native_local_shop_purchase_${Date.now()}`;
    const receipt = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "shop_purchase",
      args: {
        expectedTargetId: shop.targetId,
        expectedQualifiedItemId: targetItemId,
        quantity: QUANTITY,
      },
      snapshot: before,
      timeoutMs,
    });
    trace.push({ phase: "purchase", requestId, receipt: summarizeReceipt(receipt) });

    // Parse and record the evidence BEFORE judging the terminal. Otherwise a refusal throws
    // first and the receipt's own facts — including the per-click diagnostics — never reach
    // the report, which is how a real cause stays invisible across rounds.
    let evidence = null;
    let evidenceProblem = null;
    try {
      evidence = parseStrictEvidence(evidenceText(receipt));
    } catch (error) {
      evidenceProblem = String(error instanceof Error ? error.message : error);
    }
    trace.push({
      phase: "receipt_evidence",
      state: receipt.state,
      reasonCode: receipt.reasonCode,
      // The raw string as well as the parsed fields: a shape change would otherwise look
      // like missing keys rather than a malformed payload.
      raw: evidenceText(receipt),
      fields: evidence,
      problem: evidenceProblem,
    });

    if (receipt.state !== "succeeded" || receipt.reasonCode !== TERMINAL_REASON) {
      throw new Error(
        `shop_terminal_mismatch:state=${receipt.state};reason=${receipt.reasonCode}` +
          (evidence ? `;evidence=${evidenceText(receipt)}` : ";evidence=unparseable"),
      );
    }
    if (evidence === null) throw new Error(`shop_evidence_unparseable:${evidenceProblem}`);
    // The recorded evidence rides on its own trace step that also names the action, because this runner's other
    // steps carry only a `phase`. tools/record-stardew-live-receipts.mjs reads exactly this shape for clear_fish_pond.
    trace.push({ phase: "observed_evidence", action: "shop_purchase", evidence });
    const after = await waitForFreshSnapshot(client, { minRevision: receipt.revision });

    const moneyBefore = Number.parseInt(evidence.money_before ?? "", 10);
    const moneyAfter = Number.parseInt(evidence.money_after ?? "", 10);
    const purchased = Number.parseInt(evidence.purchased ?? "", 10);
    const unitPrice = Number.parseInt(evidence.unit_price ?? "", 10);
    const ownedBefore = Number.parseInt(evidence.owned_before ?? "", 10);
    const ownedAfter = Number.parseInt(evidence.owned_after ?? "", 10);

    const detail = {
      reasonCode: TERMINAL_REASON,
      shopId: evidence.shop,
      owner: evidence.owner,
      item: evidence.item,
      quantity: QUANTITY,
      purchased,
      unitPrice,
      moneyBefore,
      moneyAfter,
      ownedBefore,
      ownedAfter,
      targetItemId,
      gained: Number.parseInt(evidence.gained ?? "", 10),
      pager: clickRows(evidence).at(-1) ?? null,
      ownerTile: evidence.owner_tile ?? null,
      menuClosed: evidence.menu_closed === "true",
      shopTargetsBefore: shops.map((s) => s.shopId).join("/"),
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
      trace,
      durationMs: Date.now() - startedAt,
    };
    assertShopPurchasePostconditions(detail);
    return { state: "passed", ...detail, latestReceipt: summarizeReceipt(receipt) };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 512),
      // The trace is the evidence: without it a bare reasonCode cannot say whether the
      // capability was absent, the snapshot was empty, or the pipe really closed.
      lastObservation: trace.filter((e) => e.phase === "observed").at(-1) ?? null,
      receiptEvidence: trace.filter((e) => e.phase === "receipt_evidence").at(-1) ?? null,
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The SECOND case: the tool upgrade.
 *
 * The same action, the same route through the shop's own menu, and the opposite shape: the goods never enter the pack.
 * The engine records the upgrade in two of the farmer's own fields and takes the tool that upgrades instead
 * (`Tool.cs:875-895`), so the three world facts a receipt cannot invent are read from the Mod, which read them from
 * the game at the moment it minted the receipt:
 *
 *   1. `tool_upgraded` is the tool in `Farmer.toolBeingUpgraded.Value`, and it is the entry that was bought;
 *   2. `days_left` is that fresh upgrade's 2 days (`Tool.cs:890`);
 *   3. `required_tool` left the pack by exactly one (`Tool.cs:879-888`);
 *   4. and the purse paid the entry's own price.
 *
 * NOT proved here, by design: the RETURN. The tool comes back only after two night rollovers and a visit to the
 * counter (`GameLocation.cs:10961-10981`), and this case does not advance a day - the initial state IS the assertion.
 * `returnPathVerified: false` is carried in the result so nobody reads a pass as "the whole cycle".
 */
async function runToolUpgradeCase(client, config, { timeoutMs = 30_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateNativeLocalFixtureConfig(config, SHOP_PURCHASE_CASES.clint_upgrade);
    const before = await waitForActionable(client, await observeFresh(client), 30_000).catch(() =>
      observeFresh(client, { actionable: true }),
    );
    trace.push({
      phase: "observed",
      actionableAfterWait: before.actionable,
      revision: before.revision,
      location: before.location,
      tile: before.tile ?? null,
      capabilities: Array.isArray(before.capabilities) ? [...before.capabilities] : null,
      shopTargetCount: Array.isArray(before.shopTargets) ? before.shopTargets.length : null,
    });
    assertRequiredCapabilities(before, EXPECTED_CAPABILITIES);

    const shops = readShopTargets(before);
    trace.push({ phase: "shop_targets", advertised: shops.map((entry) => `${entry.shopId}@${entry.ownerName}`) });
    const shop = shops.find((entry) => entry.shopId === TOOL_UPGRADE_SHOP_ID && entry.ownerInReach) ?? null;
    if (shop === null)
      throw new Error(
        `shop_upgrade_counter_not_advertised:location=${before.location};` +
          `advertised=${shops.map((entry) => entry.shopId).join("/") || "none"}`,
      );

    // Exactly one entry: the fixture leaves one upgradable tool in the pack and the shop derives its tool rows from
    // what the pack can upgrade, so a second row would make "the entry" a guess.
    const stock = shop.stockItemIds ?? [];
    trace.push({ phase: "upgrade_offer", shopId: shop.shopId, offerCount: shop.stockCount, stockItemIds: stock });
    if (stock.length !== 1) throw new Error(`shop_upgrade_entry_ambiguous:${stock.join("/") || "none"}`);
    const targetItemId = stock[0];

    const requestId = `native_local_shop_tool_upgrade_${Date.now()}`;
    const receipt = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "shop_purchase",
      args: {
        expectedTargetId: shop.targetId,
        expectedQualifiedItemId: targetItemId,
        quantity: 1,
      },
      snapshot: before,
      timeoutMs,
    });
    trace.push({ phase: "purchase", requestId, receipt: summarizeReceipt(receipt) });

    let evidence = null;
    let evidenceProblem = null;
    try {
      evidence = parseStrictEvidence(evidenceText(receipt));
    } catch (error) {
      evidenceProblem = String(error instanceof Error ? error.message : error);
    }
    trace.push({
      phase: "receipt_evidence",
      state: receipt.state,
      reasonCode: receipt.reasonCode,
      raw: evidenceText(receipt),
      fields: evidence,
      problem: evidenceProblem,
    });

    if (receipt.state !== "succeeded" || receipt.reasonCode !== TOOL_UPGRADE_TERMINAL)
      throw new Error(
        `shop_terminal_mismatch:state=${receipt.state};reason=${receipt.reasonCode}` +
          (evidence ? `;evidence=${evidenceText(receipt)}` : ";evidence=unparseable"),
      );
    if (evidence === null) throw new Error(`shop_evidence_unparseable:${evidenceProblem}`);
    trace.push({ phase: "observed_evidence", action: "shop_purchase", evidence });
    const after = await waitForFreshSnapshot(client, { minRevision: receipt.revision });

    const detail = {
      reasonCode: TOOL_UPGRADE_TERMINAL,
      shopId: evidence.shop,
      owner: evidence.owner,
      item: evidence.item,
      targetItemId,
      purchased: Number.parseInt(evidence.purchased ?? "", 10),
      unitPrice: Number.parseInt(evidence.unit_price ?? "", 10),
      moneyBefore: Number.parseInt(evidence.money_before ?? "", 10),
      moneyAfter: Number.parseInt(evidence.money_after ?? "", 10),
      toolUpgraded: evidence.tool_upgraded ?? null,
      daysLeftForToolUpgrade: Number.parseInt(evidence.days_left ?? "", 10),
      requiredTool: evidence.required_tool ?? null,
      requiredBefore: Number.parseInt(evidence.required_before ?? "", 10),
      requiredAfter: Number.parseInt(evidence.required_after ?? "", 10),
      gained: Number.parseInt(evidence.gained ?? "", 10),
      menuClosed: evidence.menu_closed === "true",
      purchaseDialogue: evidence.purchase_dialogue ?? null,
      // The half this case deliberately does not exercise: the tool coming back after two nights.
      returnPathVerified: false,
      ownerTile: evidence.owner_tile ?? null,
      shopTargetsBefore: shops.map((entry) => entry.shopId).join("/"),
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
      trace,
      durationMs: Date.now() - startedAt,
    };
    assertToolUpgradePostconditions(detail);
    return { state: "passed", ...detail, latestReceipt: summarizeReceipt(receipt) };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 512),
      lastObservation: trace.filter((entry) => entry.phase === "observed").at(-1) ?? null,
      receiptEvidence: trace.filter((entry) => entry.phase === "receipt_evidence").at(-1) ?? null,
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * What a tool upgrade must actually have done, fact by fact.
 *
 * Factored out for the same reason the ordinary contract is: a negative test can prove each clause, and the clauses
 * are the reason the case exists - a receipt that says "upgrade" while the farmer is still holding the hoe, or while
 * the pack never lost it, or while the purse never paid, is not an upgrade however good its reasonCode looks.
 */
export function assertToolUpgradePostconditions(detail) {
  if (detail.reasonCode !== TOOL_UPGRADE_TERMINAL) throw new Error(`shop_reason:${detail.reasonCode}`);
  if (detail.shopId !== TOOL_UPGRADE_SHOP_ID) throw new Error(`shop_upgrade_shop_mismatch:${detail.shopId}`);

  // 1. The engine's own field names the upgraded tool, and it is the entry that was bought.
  if (!detail.toolUpgraded) throw new Error("shop_upgrade_tool_absent");
  if (detail.toolUpgraded !== detail.item)
    throw new Error(`shop_upgrade_tool_mismatch:${detail.toolUpgraded}!=${detail.item}`);
  if (detail.toolUpgraded !== detail.targetItemId)
    throw new Error(`shop_upgrade_tool_not_the_entry:${detail.toolUpgraded}!=${detail.targetItemId}`);

  // 2. A fresh upgrade is due back in two days; anything else is a different world state.
  if (detail.daysLeftForToolUpgrade !== TOOL_UPGRADE_DAYS)
    throw new Error(`shop_upgrade_days_not_fresh:${detail.daysLeftForToolUpgrade}`);

  // 3. The tool the upgrade consumes LEFT the pack, by exactly one.
  if (!detail.requiredTool) throw new Error("shop_upgrade_required_tool_absent");
  if (detail.requiredTool === detail.item)
    throw new Error(`shop_upgrade_required_tool_is_the_entry:${detail.requiredTool}`);
  if (detail.requiredBefore - detail.requiredAfter !== 1)
    throw new Error(`shop_upgrade_tool_not_consumed:${detail.requiredBefore}->${detail.requiredAfter}`);

  // 4. The purse paid the entry's own price.
  if (!Number.isSafeInteger(detail.purchased) || detail.purchased < 1)
    throw new Error(`shop_purchased_invalid:${detail.purchased}`);
  if (!Number.isSafeInteger(detail.unitPrice) || detail.unitPrice < 1)
    throw new Error(`shop_unit_price_invalid:${detail.unitPrice}`);
  if (detail.moneyBefore - detail.moneyAfter !== detail.purchased * detail.unitPrice)
    throw new Error(
      `shop_purse_not_charged:${detail.moneyBefore}->${detail.moneyAfter} for ${detail.purchased}@${detail.unitPrice}`,
    );

  // The body must be free afterwards, including the notice the upgrade window mounts.
  if (detail.menuClosed !== true) throw new Error("shop_menu_left_open");
  if (detail.purchaseDialogue !== "closed" && detail.purchaseDialogue !== "none")
    throw new Error(`shop_upgrade_notice_not_settled:${detail.purchaseDialogue}`);
  if (!detail.trace?.some((entry) => entry.phase === "purchase")) throw new Error("shop_trace");
  return detail;
}

/**
 * What a purchase must actually have done. Factored out so a negative test can prove each
 * clause instead of trusting the happy path.
 *
 * The two clauses that matter are the WORLD ones: money left the purse by exactly the
 * amount purchased, and the inventory gained exactly that many units. A receipt claiming a
 * purchase while the purse is untouched, or while the goods never arrived, is not a
 * purchase however good its reasonCode looks.
 */
export function assertShopPurchasePostconditions(detail) {
  if (detail.reasonCode !== TERMINAL_REASON) throw new Error(`shop_reason:${detail.reasonCode}`);
  if (!Number.isSafeInteger(detail.purchased) || detail.purchased < 1)
    throw new Error(`shop_purchased_invalid:${detail.purchased}`);
  if (!Number.isSafeInteger(detail.unitPrice) || detail.unitPrice < 1)
    throw new Error(`shop_unit_price_invalid:${detail.unitPrice}`);

  if (detail.moneyBefore - detail.moneyAfter !== detail.purchased * detail.unitPrice)
    throw new Error(
      `shop_purse_not_charged:${detail.moneyBefore}->${detail.moneyAfter} for ${detail.purchased}@${detail.unitPrice}`,
    );
  if (detail.ownedAfter - detail.ownedBefore !== detail.purchased)
    throw new Error(`shop_goods_not_received:${detail.ownedBefore}->${detail.ownedAfter} for ${detail.purchased}`);
  if (detail.gained !== detail.purchased) throw new Error(`shop_gained_mismatch:${detail.gained}!=${detail.purchased}`);

  // The pager half: the sale this case bought only exists once the menu's own cursor moved, and the receipt states the
  // row it clicked and the cursor the page started at. A receipt whose sale index is still inside the first page means
  // this run never exercised the paging the action needs to reach the fifth sale at all.
  assertPagerSaleWasReached(detail.pager);

  // The body must be free afterwards, so the next action can run.
  if (detail.menuClosed !== true) throw new Error("shop_menu_left_open");
  if (!detail.shopId) throw new Error("shop_id_missing");
  if (!detail.ownerTile) throw new Error("shop_owner_tile_missing");
  if (!detail.trace?.some((entry) => entry.phase === "purchase")) throw new Error("shop_trace");
  return detail;
}

/**
 * The clicks a receipt's `clicks=` diagnostic records, as row/cursor pairs.
 *
 * The Mod emits ONE field whose entries are separated by `||` and whose parts are separated by `|`
 * (farmhandexecutioncontroller.shopactions.cs, the `clicks={count}[{...}]` field), so this reads the same text a live run
 * prints rather than a second, friendlier spelling of it.
 */
export function clickRows(evidence) {
  const raw = evidence?.clicks;
  if (typeof raw !== "string") return [];
  const inside = raw.slice(raw.indexOf("[") + 1, raw.lastIndexOf("]"));
  if (inside.length === 0) return [];
  return inside.split("||").map((entry) => ({
    row: Number.parseInt(/row=(-?\d+)/u.exec(entry)?.[1] ?? "", 10),
    cursor: Number.parseInt(/cursor=(-?\d+)/u.exec(entry)?.[1] ?? "", 10),
  }));
}

/**
 * The purchase reached the sale that only a paged menu can show.
 *
 * A sale index is `cursor + row`: the engine resolves a clicked button as `forSale[currentItemIndex + k]`
 * (ShopMenu.cs:1096-1102), so the same sale has a different row at every scroll position and the ROW alone cannot say
 * which sale was bought. `cursor > 0` is therefore the direct witness that the pager really moved, and the index it adds
 * up to is the sale the receipt claims.
 */
export function assertPagerSaleWasReached(click) {
  if (click === null || click === undefined) throw new Error("shop_pager_click_missing");
  if (!Number.isSafeInteger(click.row) || !Number.isSafeInteger(click.cursor))
    throw new Error(`shop_pager_click_malformed:row=${click.row};cursor=${click.cursor}`);
  if (click.cursor <= 0) throw new Error(`shop_pager_not_exercised:row=${click.row};cursor=${click.cursor}`);
  if (click.cursor + click.row < PAGER_SALE_INDEX)
    throw new Error(
      `shop_pager_sale_not_reached:sale=${click.cursor + click.row};row=${click.row};cursor=${click.cursor}`,
    );
  return click;
}

export function validateNativeLocalFixtureConfig(config, expectedScenario = SCENARIO) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const scenario = config.NativeLocalPlayerFixture.FixtureScenario;
  if (scenario !== expectedScenario) throw new Error(`native_local_fixture_scenario_mismatch:${scenario ?? "missing"}`);
}

/** The wire carries evidence as an object; the Mod's string form arrives as `{ detail }`. */
function evidenceText(receipt) {
  const evidence = receipt?.evidence;
  if (typeof evidence === "string") return evidence;
  return typeof evidence?.detail === "string" ? evidence.detail : null;
}

export function parseStrictEvidence(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("shop_evidence_missing");
  const fields = {};
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error(`shop_evidence_malformed:${part}`);
    // Evidence keys are camelCase-tolerant (the frozen pickup_forage contract needs it),
    // so this parse must not assume lower case either.
    fields[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return fields;
}

function readShopTargets(snapshot) {
  const raw = snapshot?.shopTargets;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    targetId: entry.targetId,
    shopId: entry.shopId,
    ownerName: entry.ownerName,
    location: entry.location,
    ownerTileX: entry.ownerTileX,
    ownerTileY: entry.ownerTileY,
    ownerInReach: entry.ownerInReach === true,
    closedMessage: entry.closedMessage ?? null,
    stockCount: entry.stockCount,
    // Present only when the running Mod build really carries it; the shape trace above
    // is what distinguishes "old artifact" from "field dropped".
    stockItemIds: Array.isArray(entry.stockItemIds) ? [...entry.stockItemIds] : undefined,
  }));
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runShopPurchaseSmoke(session.client, config);
    console.log(JSON.stringify(result));
    const tally = result.tally ?? {};
    console.log(
      `shop_purchase smoke: ${tally.cases ?? 0} cases · ${tally.passed ?? 0} passed · ${tally.failed ?? 0} failed · ` +
        `${(tally.unarmed ?? []).length} not_armed`,
    );
    for (const entry of tally.unarmed ?? []) console.log(`  not_armed: ${entry}`);
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
