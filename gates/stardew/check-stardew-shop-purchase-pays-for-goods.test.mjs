import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CORPUS_RELATIVE_PATH,
  GATE,
  judgeCorpus,
  judgeReceipt,
  readCorpus,
  run,
  verdictLine,
} from "./check-stardew-shop-purchase-pays-for-goods.mjs";

/** A receipt the Mod emits for a purchase that worked: the purse paid and the goods arrived. */
const PAID_WITH_GOODS =
  "shop=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=1;purchased=1;unit_price=20;" +
  "money_before=500;money_after=480;owned_before=0;owned_after=1;gained=1;stock_before=5;stock_after=4;" +
  "owner_tile=5,16;menu_closed=true;clicks=1[click0:row=0|cursor=0];drops=1[drop0:slot=0]";

/**
 * THE DEFECT, as the receipt this tree produced before the fix: the purse paid 20g, no slot could take the goods, and
 * the menu's close deleted them. `gained=0` and no `tool_upgraded` is the whole finding.
 */
const PAID_WITHOUT_GOODS =
  "shop=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=1;purchased=1;unit_price=20;" +
  "money_before=500;money_after=480;owned_before=0;owned_after=0;gained=0;stock_before=5;stock_after=4;" +
  "owner_tile=5,16;menu_closed=true;clicks=1[click0:row=0|cursor=0];drops=1[drop0:slot=-1]";

/** The one purchase whose goods never reach the pack: the engine records the upgrade and takes the tool. */
const PAID_FOR_AN_UPGRADE =
  "shop=ClintUpgrade;owner=Clint;entry=npc_owner;item=(T)SteelHoe;requested=1;purchased=1;unit_price=5000;" +
  "money_before=5000;money_after=0;owned_before=0;owned_after=0;gained=0;stock_before=1;stock_after=1;" +
  "owner_tile=9,5;menu_closed=true;clicks=1[click0:row=0|cursor=0];drops=0[];" +
  "tool_upgraded=(T)SteelHoe;days_left=2;required_tool=(T)CopperHoe;required_before=1;required_after=0;" +
  "purchase_dialogue=closed";

/** A refusal that states no purse: counted as unjudged, never as a pass. */
const AFFORDABILITY_REFUSAL = "shop=SeedShop;item=(O)474;price=80;currency=money;available=20;held=20;short=60";

function corpus(...details) {
  return { receipts: details.map((detail, index) => ({ scenario: `case_${index}`, detail })) };
}

/** A repository root with one corpus at the path the gate reads. */
function rootWith(corpusText) {
  const root = mkdtempSync(path.join(tmpdir(), "shop-purchase-gate-"));
  const file = path.join(root, CORPUS_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  if (corpusText !== null) writeFileSync(file, corpusText);
  return root;
}

const silence = { log: () => {} };

test("the invariant holds over a purchase that paid and received", () => {
  const reading = judgeCorpus(corpus(PAID_WITH_GOODS));

  assert.equal(reading.examined, 1);
  assert.equal(reading.judgeable, 1);
  assert.deepEqual(reading.violations, []);
  assert.match(verdictLine(reading), /^purchases examined 1 · spent without goods 0/u);
});

test("the loss is named, with the purse and the scenario that produced it", () => {
  // THE RED CASE. This is the receipt the tree produced before the pack was a term: the engine charged, the goods were
  // stranded, the menu's close deleted them. A gate that passed here would be decoration.
  const reading = judgeCorpus({
    receipts: [{ scenario: "bag_full_of_other_goods", detail: PAID_WITHOUT_GOODS }],
  });

  assert.equal(reading.violations.length, 1, "money left the purse and no goods arrived");
  assert.equal(
    reading.violations[0].finding,
    "spent_without_goods:bag_full_of_other_goods:500->480",
    "the finding names the receipt's own scenario and both sides of the move",
  );
  assert.match(verdictLine(reading), /purchases examined 1 · spent without goods 1/u);
});

test("a paid-for tool upgrade is a purchase whose goods are the farmer's field, not the pack", () => {
  const reading = judgeCorpus(corpus(PAID_FOR_AN_UPGRADE));

  assert.equal(reading.judgeable, 1);
  assert.deepEqual(reading.violations, [], "tool_upgraded is the effect the engine recorded (Tool.cs:875-895)");
});

test("a tool_upgraded the Mod spells none is not an upgrade", () => {
  const reading = judgeCorpus(corpus(`${PAID_WITHOUT_GOODS};tool_upgraded=none`));

  assert.equal(reading.violations.length, 1, "the field's absence is what matters, not its name appearing");
});

test("a purchase that paid nothing did not spend, whether or not it gained", () => {
  const free = "shop=SeedShop;item=(O)472;money_before=500;money_after=500;gained=1";
  const refused = "shop=SeedShop;item=(O)472;money_before=500;money_after=500;gained=0";

  assert.deepEqual(judgeCorpus(corpus(free)).violations, []);
  assert.deepEqual(judgeCorpus(corpus(refused)).violations, []);
  assert.equal(
    judgeCorpus(corpus(free, refused)).judgeable,
    2,
    "both are judged: the purse is what the invariant moves",
  );
});

test("a receipt that states no purse is unjudged and printed, not silently passed", () => {
  const reading = judgeCorpus(corpus(AFFORDABILITY_REFUSAL));

  assert.equal(reading.examined, 1);
  assert.equal(reading.judgeable, 0);
  assert.deepEqual(reading.unjudged, ["case_0:no_purse"]);
  assert.deepEqual(reading.violations, []);
});

test("a renamed money field is a hole in the population, not a green receipt", () => {
  const renamed = PAID_WITHOUT_GOODS.replace("money_after=480", "currency_after=480");
  const reading = judgeCorpus(corpus(renamed));

  assert.equal(reading.judgeable, 0);
  assert.deepEqual(reading.unjudged, ["case_0:no_purse"]);

  const unparseable = judgeCorpus(corpus("shop=SeedShop;money_before=500;money_after"));
  assert.deepEqual(unparseable.unjudged, ["case_0:unparseable:shop_evidence_malformed:money_after"]);
});

test("an absent, empty or unjudgeable corpus is blocked rather than green", () => {
  const absent = run(rootWith(null), silence);
  assert.equal(absent.status, "not_measured");
  assert.equal(absent.exit, 2);
  assert.match(absent.message, /corpus_absent/u);

  const corrupt = run(rootWith("{ not json"), silence);
  assert.equal(corrupt.status, "not_measured");
  assert.equal(corrupt.exit, 2);
  assert.match(corrupt.message, /corpus_unreadable/u);

  const empty = run(rootWith(JSON.stringify({ receipts: [] })), silence);
  assert.equal(empty.status, "not_measured");
  assert.equal(empty.exit, 2);
  assert.match(empty.message, /corpus_empty/u);

  const noPurse = run(rootWith(JSON.stringify(corpus(AFFORDABILITY_REFUSAL))), silence);
  assert.equal(noPurse.status, "not_measured");
  assert.match(noPurse.message, /no_receipt_states_the_purse/u);
});

test("the gate prints its population and the finding, and exits non-zero on the loss", () => {
  const lines = [];
  const failed = run(rootWith(JSON.stringify(corpus(PAID_WITH_GOODS, PAID_WITHOUT_GOODS))), {
    log: (line) => lines.push(line),
  });

  assert.equal(failed.exit, 1);
  assert.match(lines[0], /^purchases examined 2 · spent without goods 1/u);
  assert.equal(lines[1], "  spent_without_goods:case_1:500->480");

  const passed = run(rootWith(JSON.stringify(corpus(PAID_WITH_GOODS, PAID_FOR_AN_UPGRADE))), silence);
  assert.equal(passed.exit, 0);
  assert.equal(passed.status, "passed");
  assert.equal(passed.reading.examined, 2);
});

test("the committed corpus is the suite's own receipts, and every one of them parses", () => {
  // The population this gate runs against in the tree. It is not asserted green here - the gate's own exit code is the
  // verdict - but it must exist and be readable as receipts: a corpus of unparseable text would make the gate's
  // `unjudged` count the only number it could print.
  const read = readCorpus();
  assert.notEqual(read, null, `the suite's corpus is committed at ${CORPUS_RELATIVE_PATH}`);
  assert.notEqual(read.corpus, null, "and it is valid JSON");

  const reading = judgeCorpus(read.corpus);
  assert.equal(reading.examined, read.corpus.receipts.length);
  assert.deepEqual(reading.unjudged, [], "every scenario the suite produces states its purse");
  assert.equal(reading.violations.length, 0, `${GATE}: the tree's receipts pay for their goods`);
});
