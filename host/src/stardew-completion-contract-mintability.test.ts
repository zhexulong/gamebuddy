import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  hasStardewCompletionEvidence,
  STARDEW_COMPLETION_CONTRACTS,
  STARDEW_SETTLEMENT_ENVELOPE_FIELDS,
} from "./stardew-completion-contracts.js";

/**
 * `a_completion_contract_names_what_the_action_answers:<action>` - does each row read a receipt its action's
 * producers actually mint?
 *
 * WHY. `host/src/stardew-live-receipt-parity.test.ts` asks this of the recorded corpus, receipt by receipt, and it
 * passed while `move_to_tile` answered nothing for a whole day of walking: the corpus holds ONE move receipt (an
 * `arrival=exact` walk) and no substituted arrival, so the corpus comparison had nothing to say about the shape
 * round77 produced seven times. A receipt-level comparison can only see the shapes it was given; the question that
 * catches the class is asked per ACTION - "what does this action answer, and does the row read every answer it has
 * been seen to give?" - and an action nobody recorded an answer for is a hole in the corpus, which is a different
 * statement from a contract that reads its action correctly.
 *
 * POPULATION. The rows themselves - `Object.keys(STARDEW_COMPLETION_CONTRACTS)`, imported rather than parsed, so a
 * row added tomorrow is examined without touching this file. The WITNESSES are the two places real receipts live in
 * this tree: the recorded corpus (`host/src/test-fixtures/stardew-live-receipts.json`, produced from run artifacts by
 * `tools/record-stardew-live-receipts.mjs`) and round77's second day, declared below with the timeline index of each
 * receipt so a reader can open the fact log it came from.
 *
 * PROPERTY, in three parts:
 *
 *   1. every recorded success the action's own declaration calls its postcondition is READ by its row. A shape that
 *      is refused while another shape is read is `contract_shape_not_read:<action>:<reasonCode>` and names the keys
 *      the accepted shapes carry that the refused one lacks - which is the row's requirement, in its own words;
 *   2. an action with recorded shapes and none of them read is `contract_unsatisfiable:<action>`: the row demands a
 *      postcondition no producer minted, so nothing the action has ever answered can complete it;
 *   3. a recorded success this tree declares a NO-OP is REFUSED - `no_op_claimed_a_completion:<action>:<reasonCode>`.
 *      A no-op is a success whose terminal names that there was nothing to do (`nothing_to_dismiss` / `modal=none`),
 *      so reading it as the action's postcondition would report a change the world did not make.
 *
 * WHAT IT DOES NOT READ, stated rather than implied: an action with no recorded success at all is counted
 * `unwitnessed` and printed. It is not green - nothing here says the row is right - and it is not a failure of the
 * row either; closing it means recording a real run, not writing a fixture by hand.
 *
 * PRINT. `contracts examined C · mintable M · unsatisfiable U · unwitnessed W`, then one line per finding. An empty
 * population is refused: a floor over no rows agrees with itself.
 *
 * red-proof: history  with the rule as it stood before this file (a required `tile`/`target`/`arrival`/`path` shape
 *                   and `arrival=exact`), the same run prints
 *                   `contract_shape_not_read:move_to_tile:target_reached missing [tile,target,arrival,path]` for the
 *                   seven `reached=adjacent` successes and
 *                   `no_op_claimed_a_completion:dismiss_modal:nothing_to_dismiss` is absent because that row already
 *                   refused it - the pair is why both halves are asserted here: one row was too narrow, and the other
 *                   was right for a reason nobody had written down
 *                   (host/src/stardew-completion-contract-mintability.test.ts)
 */

type MintedShape = Readonly<{
  actionId: string;
  reasonCode: string;
  /** The receipt's evidence in the wire's own `key=value;` spelling. */
  detail: string;
  /** Where the receipt came from, so a reader can open it. */
  from: string;
  /**
   * What this tree declares the terminal to be: `completion` when the action's own descriptor says it is the
   * postcondition, `no-op` when the terminal says there was nothing to do.
   */
  answers: "completion" | "no-op";
}>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The detail string the Mod emits: `key=value` joined by `;`, in the order it wrote them. */
function wireDetail(evidence: Readonly<Record<string, string>>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

/**
 * The recorded corpus, read the way `stardew-live-receipt-parity.test.ts` reads it: the producer's own output, with
 * the run that produced it. Every entry in it is a success the Host already calls a postcondition (that file asserts
 * exactly that), which is why they are witnesses of `completion` and not of `no-op`.
 */
function recordedCorpus(): MintedShape[] {
  const corpus = JSON.parse(
    readFileSync(join(ROOT, "host", "src", "test-fixtures", "stardew-live-receipts.json"), "utf8"),
  ) as {
    receipts: Array<{
      fromRun: string;
      actionId: string;
      state: string;
      reasonCode: string;
      evidence: Record<string, string>;
    }>;
  };
  return corpus.receipts
    .filter((entry) => entry.state === "succeeded")
    .map((entry) => ({
      actionId: entry.actionId,
      reasonCode: entry.reasonCode,
      detail: wireDetail(entry.evidence),
      from: `recorded corpus, run ${entry.fromRun}`,
      answers: "completion",
    }));
}

/**
 * ROUND77'S SECOND DAY, receipt for receipt.
 *
 * `2026-11-19T04-46-54-502Z-multiday_routine`'s day 2 is the timeline slice `[275, 469)` - the indices the runner
 * recorded for it. Seven `move_to_tile` successes carried the substituted arrival and one `dismiss_modal` answered
 * that there was nothing to dismiss; the corpus above holds neither, and both were read as nothing at all.
 *
 * The duplicated details are kept, with their own indices, because they are separate dispatches: a reading that
 * de-duplicated them would report six substituted arrivals where the run made seven.
 */
const ROUND77_DAY_TWO: readonly MintedShape[] = [
  ["move_to_tile", "target_reached", "reached=adjacent;requested=14,40;actor=14,39;within_range_of_request=true", 306],
  ["move_to_tile", "target_reached", "reached=adjacent;requested=80,16;actor=79,16;within_range_of_request=true", 310],
  ["move_to_tile", "target_reached", "reached=adjacent;requested=15,41;actor=15,40;within_range_of_request=true", 321],
  ["move_to_tile", "target_reached", "reached=adjacent;requested=14,40;actor=14,39;within_range_of_request=true", 330],
  ["move_to_tile", "target_reached", "reached=adjacent;requested=3,12;actor=3,11;within_range_of_request=true", 453],
  ["move_to_tile", "target_reached", "reached=adjacent;requested=63,14;actor=64,15;within_range_of_request=true", 459],
  ["move_to_tile", "target_reached", "reached=adjacent;requested=64,14;actor=64,15;within_range_of_request=true", 460],
  ["dismiss_modal", "nothing_to_dismiss", "modal=none", 302],
].map(([actionId, reasonCode, detail, index]) => ({
  actionId: actionId as string,
  reasonCode: reasonCode as string,
  detail: detail as string,
  from: `2026-11-19T04-46-54-502Z-multiday_routine timeline index ${String(index)}`,
  answers: actionId === "dismiss_modal" ? ("no-op" as const) : ("completion" as const),
}));

/**
 * ROUND81'S SETTLEMENTS, receipt for receipt: the Mod's second way to say "this is done".
 *
 * `2026-11-20T07-30-03-036Z-multiday_routine` is the run in which the Mod learned to settle and the Host's table had
 * never been told: thirty-seven `succeeded` terminals, every one filed by `tools/lib/task-purpose.mjs` as
 * `succeeded_receipt_without_its_own_postcondition`, which is what ruled `clear_and_plant_long_patch` unproven.
 *
 * The details are the wire's own text, taken from the run's `timeline.jsonl` at the index beside each one, including the
 * `chore=` the settlement envelope appends (`STARDEW_SETTLEMENT_ENVELOPE_FIELDS`) so the row is driven with the receipt
 * the Mod actually wrote and not with a trimmed copy of it. Three distinct shapes are here - the engine's own soil flag,
 * and the two `consumes` families - and the duplicated tiles are kept as separate dispatches, because a reading that
 * de-duplicated them would report one `soil_already_tilled` where the run paid for thirty-one.
 */
const ROUND81_SETTLEMENTS: readonly MintedShape[] = [
  [
    "till_soil",
    "soil_already_tilled",
    "target=69,20;before=HoeDirt;settled_by=engine_flag:hoedirt=present",
    17,
  ],
  [
    "till_soil",
    "soil_already_tilled",
    "target=68,18;before=HoeDirt;settled_by=engine_flag:hoedirt=present",
    19,
  ],
  [
    "cut_weeds",
    "weed_target_gone",
    "target=weed_54f7c4ad3be682f4;named_tile=76,31;tile=none;settled_by=consumes:weedTargets;chore=weedTargets",
    277,
  ],
  [
    "break_rock",
    "rock_source_gone",
    "target=rock_source_9a2b9a1dfa8a045b;named_tile=76,28;tile=none;settled_by=consumes:rockSourceTargets;chore=rockSourceTargets",
    278,
  ],
].map(([actionId, reasonCode, detail, index]) => ({
  actionId: actionId as string,
  reasonCode: reasonCode as string,
  detail: detail as string,
  from: `2026-11-20T07-30-03-036Z-multiday_routine timeline index ${String(index)}`,
  answers: "completion" as const,
}));

/** Whether the Host's row for this action calls this receipt a completion. */
function reads(row: string, shape: MintedShape): boolean {
  return hasStardewCompletionEvidence(row, {
    state: "succeeded",
    reasonCode: shape.reasonCode,
    evidence: { detail: shape.detail },
  });
}

/**
 * The evidence keys a ROW sees, in the order the receipt wrote them: the settlement envelope
 * (`STARDEW_SETTLEMENT_ENVELOPE_FIELDS`) is removed before a row runs, so counting it here would name a requirement no
 * row makes.
 */
function evidenceKeys(detail: string): string[] {
  return detail
    .split(";")
    .map((clause) => clause.slice(0, Math.max(clause.indexOf("="), 0)))
    .filter((key) => key.length > 0 && !Object.hasOwn(STARDEW_SETTLEMENT_ENVELOPE_FIELDS, key));
}

test("a_completion_contract_names_what_the_action_answers:<action>", () => {
  const rows = Object.keys(STARDEW_COMPLETION_CONTRACTS);
  const witnesses = [...recordedCorpus(), ...ROUND77_DAY_TWO, ...ROUND81_SETTLEMENTS].sort((left, right) =>
    left.actionId.localeCompare(right.actionId),
  );

  const findings: string[] = [];
  let mintable = 0;
  let unsatisfiable = 0;
  let unwitnessed = 0;

  for (const actionId of rows) {
    const shapes = witnesses.filter((shape) => shape.actionId === actionId);
    const completions = shapes.filter((shape) => shape.answers === "completion");
    for (const shape of shapes.filter((candidate) => candidate.answers === "no-op")) {
      if (reads(actionId, shape))
        findings.push(
          `no_op_claimed_a_completion:${actionId}:${shape.reasonCode} (${shape.detail}; ${shape.from}) - a terminal that says there was nothing to do is not the action's postcondition`,
        );
    }
    if (completions.length === 0) {
      unwitnessed += 1;
      continue;
    }
    const read = completions.filter((shape) => reads(actionId, shape));
    const refused = completions.filter((shape) => !reads(actionId, shape));
    if (read.length === 0) {
      unsatisfiable += 1;
      findings.push(
        `contract_unsatisfiable:${actionId}: no recorded success is read, so the row demands a postcondition no producer minted: ${refused
          .map((shape) => `${shape.reasonCode} [${evidenceKeys(shape.detail).join(",")}] (${shape.from})`)
          .join("; ")}`,
      );
      continue;
    }
    mintable += 1;
    // The requirement the row actually states is what its ACCEPTED shapes carry: a refused shape lacking one of
    // those keys is the row asking for a fact this receipt does not publish, and the key is named rather than
    // counted.
    const acceptedKeys = new Set(read.flatMap((shape) => evidenceKeys(shape.detail)));
    for (const shape of refused) {
      const carried = new Set(evidenceKeys(shape.detail));
      const missing = [...acceptedKeys].filter((key) => !carried.has(key));
      findings.push(
        `contract_shape_not_read:${actionId}:${shape.reasonCode} carrying [${[...carried].join(",")}] misses [${missing.join(",")}] (${shape.from}) - the row reads another of this action's successes and not this one`,
      );
    }
  }

  for (const shape of witnesses) {
    if (!rows.includes(shape.actionId))
      findings.push(`contract_missing_row:${shape.actionId}:${shape.reasonCode} (${shape.from})`);
  }

  console.log(
    `contracts examined ${String(rows.length)} · mintable ${String(mintable)} · unsatisfiable ${String(unsatisfiable)} · unwitnessed ${String(unwitnessed)}`,
  );
  assert.ok(rows.length > 0, "an empty contract table reads nothing and would report every action as unwitnessed");
  assert.ok(
    witnesses.length > 0,
    "no recorded success at all: the corpus or the run this file reads has gone, and the verdict is not measured",
  );
  assert.deepEqual(findings, [], "an action whose real success its own contract cannot read proves nothing");
});

/**
 * THE OTHER HALF OF THE SAME QUESTION, for the shapes a row must REFUSE, held here so a later lane cannot
 * widen the row into them while this file stays silent.
 *
 * `modal=none` is not a dismissal: `farmhandexecutioncontroller.modalactions.cs` answers a dismiss that finds no
 * modal with `nothing_to_dismiss`, and the action's own descriptor declares `modal_dismissed` beside `WRITES_EFFECT`
 * (`action-registry.ts`, MOD_DESCRIPTOR_REQUIREMENTS). The terminal therefore keeps its own name - "no modal was up"
 * - and this asserts the row does not read it as the postcondition, in the shape the run actually produced.
 *
 * AND THE SETTLEMENT THAT IS THE REQUEST'S END STATE. `round80` counted three of these as succeeded receipts that
 * proved nothing. A dismiss that finds nothing is an answer the caller can act on only when the receipt says WHAT
 * makes the absence the outcome - the engine's own field, printed through the settlement vocabulary as
 * `settled_by=engine_flag:activeClickableMenu=none` - so the warrant is what the row reads, and the shape without it
 * (`round77`'s) stays refused. Both directions are asserted: the absence alone is still the absence being used as its
 * own evidence.
 */
test("dismiss_modal: a dismissal that found nothing is a settlement, and only with its warrant", () => {
  assert.equal(
    hasStardewCompletionEvidence("dismiss_modal", {
      state: "succeeded",
      reasonCode: "nothing_to_dismiss",
      evidence: { detail: "modal=none" },
    }),
    false,
    "no close ran, and an absence is not the evidence for itself - this is `round77`'s published shape",
  );
  assert.equal(
    hasStardewCompletionEvidence("dismiss_modal", {
      state: "succeeded",
      reasonCode: "nothing_to_dismiss",
      evidence: { detail: "modal=none;settled_by=engine_flag:activeClickableMenu=none" },
    }),
    true,
    "the engine reports no modal and the receipt names that field: the state the request asked for already holds",
  );
  assert.equal(
    hasStardewCompletionEvidence("dismiss_modal", {
      state: "succeeded",
      reasonCode: "nothing_to_dismiss",
      evidence: { detail: "modal=none;settled_by=engine_flag:activeClickableMenu=some" },
    }),
    false,
    "a warrant whose value says a modal IS up contradicts the terminal that carried it",
  );
  assert.equal(
    hasStardewCompletionEvidence("dismiss_modal", {
      state: "succeeded",
      reasonCode: "nothing_to_dismiss",
      evidence: {
        detail: "modal_type=DialogueBox;dismissed=true;cleared_modal=DialogueBox;close_effect=native_dialogue_close",
      },
    }),
    false,
    "the terminal names a no-op whatever shape it carries, so a dismissal-shaped body under it is still not read",
  );
});
