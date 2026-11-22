#!/usr/bin/env node
/**
 * Gate: a purchase receipt never spends money without goods.
 *
 * WHY. Measured 2026-11-14 at HEAD, in the Mod's own purchase path: `ShopPurchaseCapacity` had no inventory term, so a
 * purchase the pack could not hold was admitted, the engine's click charged the purse (`ShopMenu.tryToPurchaseItem`,
 * ShopMenu.cs:1364) and left the stack on the cursor (:1352), and the handler then called the engine's close -
 * `Game1.exitActiveMenu()` IS `activeClickableMenu = null` (Game1.cs:6128-6131) - which discarded the `ShopMenu` that
 * held the goods. The player paid and the goods evaporated. The player's own path never does that: the menu refuses to
 * close while it holds goods (`ShopMenu.readyToClose`, :1255-1262) and the close its menu key performs hands them to
 * `Utility.CollectOrDrop` (:965-978 -> Utility.cs:2092-2112), which puts them in the pack or on the ground.
 *
 * THE INVARIANT, stated over the receipt fields the Mod already emits (farmhandexecutioncontroller.shopactions.cs
 * `ShopPurchaseReceipt`, :1350-1351, and `ShopToolUpgradeEvidence`, :814):
 *
 *     money_after < money_before  =>  gained > 0  or  tool_upgraded is present
 *
 * A tool upgrade is the one purchase whose goods never reach the pack: the engine sets `Farmer.toolBeingUpgraded` and
 * takes the tool it upgrades (Tool.cs:875-895), and the receipt states that in `tool_upgraded`. Every other receipt that
 * moved the purse has to have moved goods into it.
 *
 * THE POPULATION is not a list: it is every purchase receipt the Stardew Integration suite produces, written to
 * `tools/fixtures/stardew-shop-purchase-receipts.json` by
 * `ShopSaleReachTests.EveryPurchaseReceiptTheSuiteProducesPaysForItsGoods`. That test drives the engine's real charge and
 * the production seam's own calls (`ShopPackPurchases`, `ShopPurchaseCapacity`, `ShopPurchaseOutcomeFor`,
 * `ShopPurchaseReceipt`), so a scenario added there is judged here without an edit, and the receipt text is the Mod's.
 *
 * THE PARSER is the shop runner's `parseStrictEvidence` - the same split-on-`;` the live smoke uses - so a receipt this
 * gate cannot read is a receipt the live runner could not read either.
 *
 * THREE ZEROES, told apart:
 *   not_measured  the corpus is absent, unreadable or empty (exit 2) - the suite that produces it did not run
 *   blocked       no receipt carries `money_before`/`money_after`, so nothing about a spend was stated (exit 2)
 *   green         every receipt that moved the purse also moved goods (exit 0), printed with `examined N`
 * A receipt without the purse pair is counted as `unjudged` and printed: silently skipping it is how a refusal that
 * never states its money hides inside a green run.
 *
 * red-proof: history  the corpus entry `bag_full_of_other_goods` produced at HEAD states `money_before=500;money_after=480;
 *             gained=0` with no `tool_upgraded` -> `spent_without_goods:bag_full_of_other_goods:500->480`, exit 1
 *             (tools/check-stardew-shop-purchase-pays-for-goods.test.mjs)
 */

export const gateDeclaration = {
  id: "check-stardew-shop-purchase-pays-for-goods",
  domain: "stardew",
  tier: "l1",
  kind: "totality",
};

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseStrictEvidence } from "../../tools/run-stardew-native-local-player-shop-purchase-smoke.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const GATE = "stardew_shop_purchase_pays_for_goods/v1";

/** The corpus the Integration suite writes: one `{ scenario, detail }` per purchase receipt it produced. */
export const CORPUS_RELATIVE_PATH = "tools/fixtures/stardew-shop-purchase-receipts.json";

/** The two money fields, and the two ways a purchase can honestly have spent it. */
const MONEY_BEFORE = "money_before";
const MONEY_AFTER = "money_after";
const GAINED = "gained";
const TOOL_UPGRADED = "tool_upgraded";

/** A field that states a fact, as opposed to one the Mod spells `none` when the fact is absent. */
function stated(fields, key) {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 && value !== "none";
}

/**
 * The invariant over one receipt's fields, or `null` when the receipt states nothing about the purse.
 *
 * Returning `null` rather than `false` is the difference between "this receipt did not move money" and "this receipt
 * never said what its money did" - the second is a hole in the population, not a pass.
 */
export function judgeReceipt(fields) {
  if (!stated(fields, MONEY_BEFORE) || !stated(fields, MONEY_AFTER)) return null;
  const before = Number.parseInt(fields[MONEY_BEFORE], 10);
  const after = Number.parseInt(fields[MONEY_AFTER], 10);
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after))
    return {
      judgeable: false,
      reason: `unparseable_money:${fields[MONEY_BEFORE] ?? ""}->${fields[MONEY_AFTER] ?? ""}`,
    };
  if (after >= before) return { judgeable: true, violation: null, before, after };
  const gained = Number.parseInt(fields[GAINED] ?? "0", 10);
  const gainedGoods = Number.isSafeInteger(gained) && gained > 0;
  const upgraded = stated(fields, TOOL_UPGRADED);
  return {
    judgeable: true,
    before,
    after,
    gained: Number.isSafeInteger(gained) ? gained : null,
    violation: gainedGoods || upgraded ? null : "spent_without_goods",
  };
}

/**
 * The whole reading: every receipt in the corpus, the ones it could judge, and every receipt that spent without goods.
 *
 * `unjudged` carries the scenario names, because a population that quietly shrinks is the failure this gate exists to
 * catch in the other direction (a receipt whose money fields were renamed would otherwise read as "no money moved").
 */
export function judgeCorpus(corpus) {
  const receipts = Array.isArray(corpus?.receipts) ? corpus.receipts : [];
  const violations = [];
  const unjudged = [];
  let judgeable = 0;

  for (const receipt of receipts) {
    const scenario = typeof receipt?.scenario === "string" ? receipt.scenario : "(unnamed)";
    const detail = receipt?.detail;
    let fields;
    try {
      fields = parseStrictEvidence(detail);
    } catch (error) {
      unjudged.push(`${scenario}:unparseable:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const reading = judgeReceipt(fields);
    if (reading === null || reading.judgeable === false) {
      unjudged.push(`${scenario}:no_purse`);
      continue;
    }
    judgeable += 1;
    if (reading.violation !== null)
      violations.push({
        scenario,
        finding: `${reading.violation}:${scenario}:${reading.before}->${reading.after}`,
        detail,
      });
  }

  return { examined: receipts.length, judgeable, unjudged, violations };
}

/** Read the corpus, or `null` when it is not there - the caller decides what an absent population means. */
export function readCorpus(root = REPOSITORY_ROOT) {
  const file = path.join(root, CORPUS_RELATIVE_PATH);
  if (!existsSync(file)) return null;
  try {
    return { file, corpus: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { file, corpus: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The one line the gate prints, with its population: `purchases examined N · spent without goods K`. */
export function verdictLine(reading) {
  return (
    `purchases examined ${reading.examined} · spent without goods ${reading.violations.length}` +
    ` · judged ${reading.judgeable} · unjudged ${reading.unjudged.length}`
  );
}

export function run(root = REPOSITORY_ROOT, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const read = readCorpus(root);
  if (read === null) {
    return {
      status: "not_measured",
      exit: 2,
      message:
        `${GATE}_not_measured:corpus_absent: expected ${CORPUS_RELATIVE_PATH}, written by ` +
        "`dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests " +
        "--filter EveryPurchaseReceiptTheSuiteProducesPaysForItsGoods`",
    };
  }
  if (read.corpus === null) {
    return { status: "not_measured", exit: 2, message: `${GATE}_not_measured:corpus_unreadable: ${read.problem}` };
  }
  const reading = judgeCorpus(read.corpus);
  log(verdictLine(reading));
  for (const entry of reading.unjudged) log(`  unjudged: ${entry}`);
  if (reading.examined === 0) {
    return { status: "not_measured", exit: 2, message: `${GATE}_not_measured:corpus_empty`, reading };
  }
  if (reading.judgeable === 0) {
    return { status: "not_measured", exit: 2, message: `${GATE}_not_measured:no_receipt_states_the_purse`, reading };
  }
  if (reading.violations.length > 0) {
    for (const violation of reading.violations) log(`  ${violation.finding}`);
    return {
      status: "failed",
      exit: 1,
      message: `${GATE}: money left the purse for goods that never arrived`,
      reading,
    };
  }
  return {
    status: "passed",
    exit: 0,
    message: `${GATE}: every purchase that spent its purse moved goods or a tool`,
    reading,
  };
}

if (import.meta.main) {
  const result = run();
  process.stdout.write(`${result.message}\n`);
  process.exitCode = result.exit;
}
