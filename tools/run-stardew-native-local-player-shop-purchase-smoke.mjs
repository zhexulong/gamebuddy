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
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "shop_purchase"];
const SCENARIO = "native_shop_purchase_v1";
const TERMINAL_REASON = "item_purchased";

/** The item the fixture makes buyable and the runner asks for. */
// Taken from the shop's own advertised stock, never guessed: discovery publishes what a
// shop can sell right now, and asking for anything else is legitimately refused with
// item_not_sold_here (which is exactly how the first successful dispatch ended).
const TARGET_ITEM_ID = null;
const QUANTITY = 1;

export async function runShopPurchaseSmoke(client, config, { timeoutMs = 30_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateNativeLocalFixtureConfig(config);

    const before = await observeFresh(client, { actionable: true });
    // Record what was actually observed before any assertion can throw: an empty trace
    // with a bare reasonCode cannot distinguish a missing capability from a dead pipe.
    trace.push({
      phase: "observed",
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
      rawKeys: Array.isArray(before?.shopTargets) && before.shopTargets.length > 0
        ? Object.keys(before.shopTargets[0] ?? {}).sort()
        : null,
      sample: Array.isArray(before?.shopTargets) && before.shopTargets.length > 0
        ? Object.fromEntries(
            Object.entries(before.shopTargets[0] ?? {}).map(([k, v]) => [
              k,
              Array.isArray(v) ? `array(${v.length})` : typeof v === "object" ? "object" : String(v),
            ]),
          )
        : null,
    });
    if (shops.length === 0)
      throw new Error(`shop_no_targets_advertised:location=${before.location}`);
    // Prefer a shop that can actually sell something: an advertised shop with empty stock
    // cannot demonstrate a purchase, and that is a finding, not a failure of the action.
    // Read defensively on purpose: a raw TypeError here would erase the very evidence
    // needed to tell a stale artifact from a dropped field. The trace below carries the
    // real keys either way.
    const shop = shops.find((s) => s.ownerInReach && (s.stockItemIds?.length ?? 0) > 0) ?? null;
    if (!shop)
      throw new Error(
        `shop_owner_out_of_reach:${shops.map((s) => `${s.shopId}@${s.ownerTileX},${s.ownerTileY}`).join("/")}`,
      );

    const targetItemId = TARGET_ITEM_ID ?? shop.stockItemIds[0];
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

    if (receipt.state !== "succeeded" || receipt.reasonCode !== TERMINAL_REASON)
      throw new Error(`shop_terminal_mismatch:state=${receipt.state};reason=${receipt.reasonCode}`);

    const evidence = parseStrictEvidence(evidenceText(receipt));
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
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
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
  if (detail.gained !== detail.purchased)
    throw new Error(`shop_gained_mismatch:${detail.gained}!=${detail.purchased}`);

  // The body must be free afterwards, so the next action can run.
  if (detail.menuClosed !== true) throw new Error("shop_menu_left_open");
  if (!detail.shopId) throw new Error("shop_id_missing");
  if (!detail.ownerTile) throw new Error("shop_owner_tile_missing");
  if (!detail.trace?.some((entry) => entry.phase === "purchase")) throw new Error("shop_trace");
  return detail;
}

/** Only this scenario, and only an isolated topology. */
export function validateNativeLocalFixtureConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const scenario = config.NativeLocalPlayerFixture.FixtureScenario;
  if (scenario !== SCENARIO) throw new Error(`native_local_fixture_scenario_mismatch:${scenario ?? "missing"}`);
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
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
