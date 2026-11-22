import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  judgeStardewCompletionEvidence,
  MAX_ACTION_RECEIPT_EVIDENCE_LENGTH,
  parseStardewEvidenceDetail,
  STARDEW_COMPLETION_CONTRACTS,
} from "./stardew-completion-contracts.js";

/**
 * `a_receipt_that_parsed_to_nothing_says_why:<action>` - the reader every contract shares either reads a receipt's
 * evidence or names what it refused; it never answers "there was nothing to read".
 *
 * WHY. The reader used to answer a bare `null` for every one of its reasons at once, and one of those reasons was a
 * length: every field's value had to be at most 512 characters. That number is not a fact about any field, so it
 * refused work that had happened. `round84` measured it at the SeedShop, from Pierre: ten parsnip seeds bought in two
 * purchases, `money_before=500 -> 400 -> 300`, `gained=5` both times, the seeds in the pack - and BOTH receipts were
 * filed `succeeded_receipt_without_its_own_postcondition`, because `shop_purchase`'s `clicks` is 731 characters at
 * five units and the whole detail parsed to nothing.
 *
 * POPULATION. `Object.keys(STARDEW_COMPLETION_CONTRACTS)`, imported from the table rather than listed here, so a row
 * added tomorrow is examined without touching this file. The WITNESS for a row is its own recorded receipt where the
 * host corpus holds one (`host/src/test-fixtures/stardew-live-receipts.json`, the producer's own output); a row with no
 * recorded receipt is driven with a detail whose one field is named for the reader's own grammar, which is what is
 * under test here - the row's KEY LIST is `stardew-completion-evidence-coverage.test.ts`'s question and this file does
 * not ask it a second time. `witnessed W of C` prints how many rows had a real one, because "examined 102" without
 * that reading would claim the corpus says more than it does.
 *
 * PROPERTY, two arms per row, differing only in length:
 *   1. a detail as long as the producer may print for one receipt (`MAX_ACTION_RECEIPT_EVIDENCE_LENGTH`) with one field
 *      carrying the bulk of it. The reader must PARSE it - a value that long is legal for the Mod to write, so
 *      refusing it is a real receipt proved as nothing, which is the defect;
 *   2. the same detail one character longer. The fold must REFUSE it by naming the bound it exceeded, and never by
 *      reading the receipt as one that parsed to nothing.
 * `parsed P` counts rows whose long-field detail was read; `refused-with-a-name R` counts rows whose over-bound detail
 * was refused by a name a caller can act on; `silent-null N` counts rows refused by no name at all, and `N>0` fails
 * naming the action and the field.
 *
 * PRINT. `contracts C · witnessed W · parsed P · refused-with-a-name R · silent-null N`, then one line per finding. An
 * empty population, or a corpus that could not be read, is BLOCKED rather than green: a fold over no rows agrees with
 * itself.
 *
 * WHAT IT DOES NOT READ, stated rather than implied. Whether the row's own predicate HOLDS for a real receipt is the
 * coverage and mintability files' question; this one is only about what the shared reader does with a detail's shape.
 *
 * red-proof: round84     with the per-field 512 as it stood, arm 1 of every row fails: the 4,096-character detail comes
 *                        back `evidence_field_...`-free but `fields: null` - the reader had no name for it - and arm 2's
 *                        fold answered a bare `false`. Measured on the run's own receipt in the falsifier below, whose
 *                        `clicks` field is 731 characters and whose two purchases were both refused
 *                        (host/src/stardew-completion-evidence-parse.test.ts)
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The detail the Mod emits: `key=value` joined by `;`, in the order it wrote them. */
function wireDetail(evidence: Readonly<Record<string, string>>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

/** One recorded success, per action, as the producer wrote it. */
function recordedDetails(): ReadonlyMap<string, string> {
  const corpus = JSON.parse(
    readFileSync(join(ROOT, "host", "src", "test-fixtures", "stardew-live-receipts.json"), "utf8"),
  ) as {
    receipts: Array<{
      actionId: string;
      state: string;
      evidence: Record<string, string>;
    }>;
  };
  const details = new Map<string, string>();
  for (const entry of corpus.receipts) {
    if (entry.state !== "succeeded") continue;
    if (!details.has(entry.actionId)) details.set(entry.actionId, wireDetail(entry.evidence));
  }
  return details;
}

/**
 * The witness detail grown to exactly `total` characters by ONE more field.
 *
 * The field is named `trace` because that is what the field which broke `shop_purchase` is: a diagnostic trace whose
 * length is the number of things the action did, and which no clause of any row reads. A row's own receipt keeps every
 * field it was recorded with; nothing is replaced.
 */
function grownTo(detail: string, total: number): string {
  const head = `${detail};trace=`;
  return `${head}${"x".repeat(total - head.length)}`;
}

/** The refusal codes the fold and the reader answer with: what a caller can act on. A name, not a silence. */
const NAMED_REFUSAL = /^(?:evidence_|receipt_not_succeeded|no_completion_contract)/u;

test("a_receipt_that_parsed_to_nothing_says_why:<action>", () => {
  const rows = Object.keys(STARDEW_COMPLETION_CONTRACTS);
  const recorded = recordedDetails();

  const findings: string[] = [];
  let witnessed = 0;
  let parsed = 0;
  let refusedWithName = 0;
  let silentNull = 0;

  for (const actionId of rows) {
    const witness = recorded.get(actionId);
    if (witness !== undefined) witnessed += 1;
    // A row with no recorded receipt is driven with its own name as the field, so a finding still names something.
    const base = witness ?? `${actionId}=0`;

    const legal = grownTo(base, MAX_ACTION_RECEIPT_EVIDENCE_LENGTH);
    const readerVerdict = parseStardewEvidenceDetail(legal);
    if (readerVerdict.refusal === null) {
      parsed += 1;
    } else if (NAMED_REFUSAL.test(readerVerdict.refusal)) {
      findings.push(
        `a_legal_length_field_was_refused:${actionId}:trace:${readerVerdict.refusal} - ${String(
          MAX_ACTION_RECEIPT_EVIDENCE_LENGTH,
        )} characters is what the producer may print for one receipt, so this refusal proves a real receipt as nothing (${witness === undefined ? "no recorded receipt" : "recorded receipt"})`,
      );
    } else {
      silentNull += 1;
      findings.push(`parsed_to_nothing:${actionId}:trace - the reader refused the detail and named no reason`);
    }

    const overBound = `${legal}x`;
    const verdict = judgeStardewCompletionEvidence(actionId, {
      state: "succeeded",
      reasonCode: "any",
      evidence: { detail: overBound },
    });
    if (verdict.refusal !== null && NAMED_REFUSAL.test(verdict.refusal)) {
      refusedWithName += 1;
      const expected = `evidence_too_long:${String(overBound.length)}:${String(MAX_ACTION_RECEIPT_EVIDENCE_LENGTH)}`;
      if (verdict.refusal !== expected)
        findings.push(
          `over_bound_refused_by_another_name:${actionId}:trace:${verdict.refusal} - expected ${expected}, the bound the producer's journal enforces`,
        );
    } else if (verdict.refusal !== null && verdict.refusal.length > 0) {
      silentNull += 1;
      findings.push(`parsed_to_nothing:${actionId}:trace:${verdict.refusal} - a refusal no caller can name`);
    } else {
      silentNull += 1;
      findings.push(
        `parsed_to_nothing:${actionId}:trace - ${String(overBound.length)} characters, over the producer's own bound, and the fold answered nothing`,
      );
    }
  }

  console.log(
    `contracts ${String(rows.length)} · witnessed ${String(witnessed)} · parsed ${String(parsed)} · refused-with-a-name ${String(refusedWithName)} · silent-null ${String(silentNull)}`,
  );
  assert.ok(rows.length > 0, "an empty contract table reads no receipt and would agree with itself");
  assert.ok(
    recorded.size > 0,
    "blocked: the recorded corpus could not be read, so no row was driven with a receipt the Mod actually minted",
  );
  assert.deepEqual(findings, [], "a receipt the producer can print must be read or refused by name, never as nothing");
});

/**
 * THE FALSIFIER IS THE RUN. `round84`'s two purchases, from
 * `.live-runs/game-ladder/2026-11-20T13-52-51-386Z-multiday_routine/result.json` (`execution_receipt`, reasonCode
 * `item_purchased`, requests `f02aa7ed38b94ee4a200660003b91a4c` and `6fd9b5b443494070aa95f8e64cf6b268`), carrying the
 * `location` the producer was amended to write after `round92`: a receipt of a tile-bearing action that names the counter
 * and never the map said nothing about where it happened, and a purchase of this shape now states both.
 *
 * Both receipts carry the whole truth: the purse moved 500 -> 400 -> 300, `owned_after` moved 0 -> 5 -> 10, the menu
 * closed, and the pack held ten parsnip seeds afterwards. The `clicks` field is 731 characters - the click loop's
 * trace, five entries at ~146 characters - and the reader's 512 turned BOTH of them into nothing. This test holds the
 * number that made it happen beside the verdict, so a later reader cannot raise 512 to 1,024 and call it fixed: the
 * field's length is not a fact about the field, and the receipt's own bound is what must answer.
 *
 * THE FIXTURE IS THE RUN, SO ITS SIZE IS NOT A POPULATION. `assert.equal(SHOP_PURCHASE_ROUND84.length, 2)` compared the
 * array literal above to a number typed by the same hand: a purchase dropped from the fixture would have looped just as
 * happily. What the run recorded is the purse moving 500 -> 400 -> 300, so that is what the test compares - read out of
 * the receipts by the reader under test, so a missing purchase is a member the failure prints.
 */
const SHOP_PURCHASE_ROUND84: readonly string[] = [
  "shop=SeedShop;location=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=5;purchased=5;unit_price=20;money_before=500;money_after=400;owned_before=0;owned_after=5;gained=5;stock_before=2147483647;stock_after=2147483647;owner_tile=4,17;menu_closed=true;clicks=5[click0:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=500->480|stock=2147483647->2147483647|held_after=(O)472||click1:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=480->460|stock=2147483647->2147483647|held_after=(O)472||click2:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=460->440|stock=2147483647->2147483647|held_after=(O)472||click3:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=440->420|stock=2147483647->2147483647|held_after=(O)472||click4:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=420->400|stock=2147483647->2147483647|held_after=(O)472];drops=5[drop0:slot=11|at=1856,984|held=(O)472->none||drop1:slot=11|at=1856,984|held=(O)472->none||drop2:slot=11|at=1856,984|held=(O)472->none||drop3:slot=11|at=1856,984|held=(O)472->none||drop4:slot=11|at=1856,984|held=(O)472->none]",
  "shop=SeedShop;location=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=5;purchased=5;unit_price=20;money_before=400;money_after=300;owned_before=5;owned_after=10;gained=5;stock_before=2147483647;stock_after=2147483647;owner_tile=4,17;menu_closed=true;clicks=5[click0:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=400->380|stock=2147483647->2147483647|held_after=(O)472||click1:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=380->360|stock=2147483647->2147483647|held_after=(O)472||click2:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=360->340|stock=2147483647->2147483647|held_after=(O)472||click3:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=340->320|stock=2147483647->2147483647|held_after=(O)472||click4:row=0|cursor=0|at=1380,531|addressed=True|safety_before=0|held_null=True|currency=320->300|stock=2147483647->2147483647|held_after=(O)472];drops=5[drop0:slot=11|at=1856,984|held=(O)472->none||drop1:slot=11|at=1856,984|held=(O)472->none||drop2:slot=11|at=1856,984|held=(O)472->none||drop3:slot=11|at=1856,984|held=(O)472->none||drop4:slot=11|at=1856,984|held=(O)472->none]",
];

test("round84: ten parsnip seeds, two purchases, both receipts prove the purchase", () => {
  assert.deepEqual(
    SHOP_PURCHASE_ROUND84.map((detail) => {
      const { fields } = parseStardewEvidenceDetail(detail);
      return fields === null ? "unreadable" : `${String(fields.money_before)}->${String(fields.money_after)}`;
    }),
    ["500->400", "400->300"],
    "the run made two purchases: the purse moved 500 -> 400 -> 300, and each receipt is the one that moved it",
  );
  for (const detail of SHOP_PURCHASE_ROUND84) {
    const clicks = detail.split(";").find((clause) => clause.startsWith("clicks=")) as string;
    const clicksLength = clicks.length - "clicks=".length;
    assert.equal(clicksLength, 731, "the field that broke the receipt is measured here, not described");
    assert.ok(
      clicksLength > 512,
      "the per-field ceiling is why it broke: 731 > 512, so the whole detail parsed to nothing",
    );
    assert.deepEqual(
      parseStardewEvidenceDetail(detail),
      {
        fields: Object.fromEntries(
          detail.split(";").map((clause) => {
            const separator = clause.indexOf("=");
            return [clause.slice(0, separator), clause.slice(separator + 1)];
          }),
        ),
        refusal: null,
      },
      "every clause of the receipt is readable: the trace is one field, and its length is the click loop's",
    );
    assert.deepEqual(
      judgeStardewCompletionEvidence("shop_purchase", {
        state: "succeeded",
        reasonCode: "item_purchased",
        evidence: { detail },
      }),
      { accepted: true, refusal: null },
      `the money moved, five seeds arrived and the menu closed; a purchase is not unproven because its trace is long`,
    );
  }

  // AND THE OTHER SIDE OF THE SAME LINE: past the bound the producer itself enforces, the answer is a NAME.
  const overBound = `${SHOP_PURCHASE_ROUND84[0] as string}${"x".repeat(MAX_ACTION_RECEIPT_EVIDENCE_LENGTH)}`;
  const verdict = judgeStardewCompletionEvidence("shop_purchase", {
    state: "succeeded",
    reasonCode: "item_purchased",
    evidence: { detail: overBound },
  });
  assert.equal(
    verdict.refusal,
    `evidence_too_long:${String(overBound.length)}:${String(MAX_ACTION_RECEIPT_EVIDENCE_LENGTH)}`,
    "a detail the journal would never carry is refused by naming the bound, which is a different fact from parsing",
  );
  assert.equal(verdict.accepted, false);
});

/**
 * The reader's own refusals, each by name. These are the shapes that used to be one `null`, and a caller that only
 * sees `null` cannot tell the producer "your clause has no `=`" from "your clause repeats a key".
 */
test("a_refused_detail_names_the_field_it_refused", () => {
  assert.deepEqual(parseStardewEvidenceDetail("a=1;b=2"), {
    fields: { a: "1", b: "2" },
    refusal: null,
  });
  assert.deepEqual(parseStardewEvidenceDetail("a=1;no-separator;c=3"), {
    fields: null,
    refusal: "evidence_field_unnamed:2",
  });
  assert.deepEqual(parseStardewEvidenceDetail("=1"), { fields: null, refusal: "evidence_field_unnamed:1" });
  assert.deepEqual(parseStardewEvidenceDetail("a=1;a="), { fields: null, refusal: "evidence_field_valueless:a" });
  assert.deepEqual(parseStardewEvidenceDetail("a=1;a=2"), { fields: null, refusal: "evidence_field_duplicate:a" });
  assert.deepEqual(parseStardewEvidenceDetail("a=1;9b=2"), {
    fields: null,
    refusal: "evidence_field_name_invalid:9b",
  });
  // An empty detail is one unnamed clause, not a field set with nothing in it.
  assert.deepEqual(parseStardewEvidenceDetail(""), { fields: null, refusal: "evidence_field_unnamed:1" });
});
