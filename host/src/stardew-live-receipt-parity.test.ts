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
 * The Host must recognise the receipt its OWN producer emitted.
 *
 * WHY THIS TEST EXISTS: the Mod's evidence fields and the Host's expected key list are written in different languages,
 * in different files, by different lanes, and nothing compared them. A field added on one side has silently broken a
 * live gate at least four times - `leftover_returned` (the Host listed ten keys while the Mod emitted eleven, so a
 * successful `chest_retrieve` could never count as complete), the `tailoringTargets` snapshot (a predicate that could
 * not accept what the Mod published, which disconnected the bridge), and the settlement envelope on `round73`
 * (`chore`/`steps`/`folded`/`held_ms`: 65 `succeeded` receipts, ten world-changing actions, `admittedActionIds: []`).
 * A live runner cannot catch any of them, because it drives the Mod directly and the Host's rule never runs.
 *
 * WHAT MAKES IT TRUSTWORTHY: the corpus is not hand-written - `tools/record-stardew-live-receipts.mjs` extracts the
 * terminal receipt from the artifacts of real live runs, including the evidence object in the Mod's own field order,
 * which is turned back into the wire's `key=value;` detail string here. So this asserts the producer against the
 * consumer using the producer's own output.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CORPUS = JSON.parse(
  readFileSync(join(ROOT, "host", "src", "test-fixtures", "stardew-live-receipts.json"), "utf8"),
);

/** The detail string the Mod emits: `key=value` joined by `;`, in the order it wrote them. */
function wireDetail(evidence: Record<string, string>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

/**
 * Whether the Host declares a rule for this action - read off the contract TABLE, which is the authority.
 *
 * It used to be a regex over the adapter's `case "<action>":` arms. That switch became a table, the regex kept
 * matching nothing, and this file's central assertion then compared `[]` to `[]` for every entry: the corpus test was
 * green while its population was EMPTY, and the two published actions whose real receipts the Host could not read
 * (`accept_daily_quest`, `clear_fish_pond`) sat in the "no rule, unpublished, expected" list it printed at the bottom.
 */
function hasRule(actionId: string): boolean {
  return Object.hasOwn(STARDEW_COMPLETION_CONTRACTS, actionId);
}

const receipts = CORPUS.receipts as Array<{
  actionId: string;
  state: string;
  reasonCode: string;
  evidence: Record<string, string>;
}>;
const ENVELOPE = new Set(Object.keys(STARDEW_SETTLEMENT_ENVELOPE_FIELDS));

/** Whether the Host's rule for this action recognises this field set as a completed postcondition. */
function recognised(actionId: string, reasonCode: string, evidence: Record<string, string>): boolean {
  return hasStardewCompletionEvidence(actionId, {
    state: "succeeded",
    reasonCode,
    evidence: { detail: wireDetail(evidence) },
  } as never);
}

test("the corpus is read from real runs, not written by hand", () => {
  assert.ok(receipts.length >= 5, `expected several recorded receipts, found ${receipts.length}`);
  for (const entry of receipts) {
    assert.equal(entry.state, "succeeded", `${entry.actionId} was recorded from a succeeded terminal`);
    assert.ok(Object.keys(entry.evidence).length > 0, `${entry.actionId} recorded no evidence`);
  }
});

test("every recorded success is recognised as complete by its own action's rule", () => {
  const unrecognised: string[] = [];
  const withoutRule: string[] = [];
  for (const entry of receipts) {
    if (!hasRule(entry.actionId)) {
      withoutRule.push(entry.actionId);
      continue;
    }
    if (!recognised(entry.actionId, entry.reasonCode, entry.evidence)) {
      unrecognised.push(
        `${entry.actionId}: the rule refused a real ${entry.reasonCode} carrying ${Object.keys(entry.evidence).length} fields [${Object.keys(entry.evidence).join(",")}]`,
      );
    }
  }
  assert.deepEqual(
    unrecognised,
    [],
    "a rule that refuses its own producer's success means the two sides of the contract have drifted apart",
  );
  // An action with no rule is not a failure by itself - an unpublished action legitimately has none - but it must be
  // NAMED rather than silently skipped, because a PUBLISHED action without a rule is exactly the defect that made
  // forty-four actions' receipts count as zero typed transitions.
  const PUBLISHED_GATE_TABLE = readFileSync(join(ROOT, "tools", "stardew-action-gate-descriptors.mjs"), "utf8");
  const publishedWithoutRule = withoutRule.filter((action) => PUBLISHED_GATE_TABLE.includes(`gate("${action}"`));
  assert.deepEqual(
    publishedWithoutRule,
    [],
    `a published action whose receipt the Host cannot recognise: ${publishedWithoutRule.join(", ")}`,
  );
  if (withoutRule.length > 0) {
    console.log("recorded receipts with no completion rule (unpublished, expected): " + withoutRule.join(", "));
  }
});

/**
 * AN UNDECLARED RECEIPT FIELD MUST REFUSE A REAL RECEIPT - the gate for the whole drift class, not one instance.
 *
 * The defect this exists for happened four times and cost a run each: the Mod gained a field, the Host's declaration
 * did not, and NOTHING FAILED. The receipt was refused, the action never counted as complete, `admittedActionIds`
 * stayed `[]`, and a companion who had cut 93 weeds looked exactly like one who had done nothing.
 *
 * THE POPULATION IS THE PRODUCER'S OWN OUTPUT (the corpus above, now including the world-changing actions), and the
 * property is asked in two directions for every recorded receipt, because either direction alone is vacuous:
 *
 *   1. the receipt AS THE MOD WROTE IT is accepted - so every field the Mod wrote is a field the Host declares
 *      (or the settlement envelope, which is declared once in `STARDEW_SETTLEMENT_ENVELOPE_FIELDS`);
 *   2. the SAME receipt carrying one field nobody declared is refused - so acceptance means "I know this field",
 *      not "I did not look". A rule that tolerated unknowns would make (1) prove nothing, which is precisely how
 *      `chore` rode along unread.
 *
 * A refusal names the field: the fields whose removal alone turns the verdict are exactly the ones the rule does not
 * recognise, so the failure says which field and which action instead of printing a key count.
 */
test("an_undeclared_receipt_field_refuses_a_real_receipt", (t) => {
  const failures: string[] = [];
  let written = 0;
  let declared = 0;
  /** The fields whose removal alone makes a refused receipt acceptable: the ones nobody declared. */
  function undeclaredFields(entry: (typeof receipts)[number]): string[] {
    return Object.keys(entry.evidence).filter(
      (field) => !ENVELOPE.has(field) && recognised(entry.actionId, entry.reasonCode, without(entry.evidence, field)),
    );
  }
  for (const entry of receipts) {
    if (!hasRule(entry.actionId)) continue;
    const fields = Object.keys(entry.evidence);
    written += fields.length;
    if (!recognised(entry.actionId, entry.reasonCode, entry.evidence)) {
      const undeclared = undeclaredFields(entry);
      failures.push(
        undeclared.length > 0
          ? `${entry.actionId}: the Mod wrote a field the Host does not declare: ${undeclared.join(", ")}`
          : `${entry.actionId}: refused, and no single field explains it - the rule and the recorded shape disagree [${fields.join(",")}]`,
      );
      continue;
    }
    declared += fields.length;
    if (recognised(entry.actionId, entry.reasonCode, { ...entry.evidence, undeclared_field_probe: "1" })) {
      failures.push(
        `${entry.actionId}: the rule accepts a field nobody declared (undeclared_field_probe), so a real producer field would ride along unread`,
      );
    }
  }
  // Zero population is BLOCKED, never green: a corpus with nothing to read would make both counts agree.
  assert.ok(written > 0, "blocked: no recorded receipt carries a completion rule, so no field set could be judged");
  t.diagnostic(
    `receipts ${String(receipts.length)} · fields written ${String(written)} · declared ${String(declared)} · undeclared ${String(failures.length)}`,
  );
  assert.deepEqual(failures, []);
});

/** The receipt's field set minus one field, in the Mod's own order. */
function without(evidence: Record<string, string>, field: string): Record<string, string> {
  const remaining: Record<string, string> = {};
  for (const [key, value] of Object.entries(evidence)) if (key !== field) remaining[key] = value;
  return remaining;
}

/**
 * A window of source lines starting at the first line containing `marker`, as long as the clause it must contain.
 */
function windowAt(source: string, marker: string, lines: number): string {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `blocked: the Mod source no longer contains ${marker}, so the envelope declaration is unchecked`);
  return source.slice(at).split("\n").slice(0, lines).join("\n");
}

function fieldsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/([a-z_]+)=\{/gu)].map((match) => match[1] as string))];
}

/**
 * The clause's field name as the catalog itself spells it: the chore entry is `$"{ChoreField}={family}"`, so the
 * constant's VALUE is the field the settlement carries. A gate that read the constant's NAME would watch nothing.
 */
function choreFieldName(source: string): string {
  const match = /ChoreField = "([A-Za-z_]+)"/u.exec(source);
  assert.ok(
    match?.[1] !== undefined,
    "blocked: FarmhandActionCatalog.ChoreField no longer declares the chore clause's field name",
  );
  return match[1] as string;
}

/**
 * EVERY FIELD THE MOD MINTS AT A SETTLEMENT SEAM IS DECLARED HERE, derived from the Mod's own mint sites.
 *
 * The three seams are the Mod's, not a list this file invents: each one is located by the symbol that composes the
 * clause, and a seam that stops matching is BLOCKED rather than silently skipped - a declaration that outlives its
 * producer would keep passing while the wire moved on. The Host's side is one frozen declaration
 * (`STARDEW_SETTLEMENT_ENVELOPE_FIELDS`), so a new clause on any seam fails here by name, before a run can spend an
 * hour refusing receipts over it.
 */
test("every settlement field the Mod mints is declared by the Host", (t) => {
  const definitions = readFileSync(
    join(ROOT, "integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"),
    "utf8",
  );
  const controller = readFileSync(join(ROOT, "integrations", "stardew", "farmhandexecutioncontroller.cs"), "utf8");
  const seams = [
    {
      seam: "ExecutionManager.RememberTerminal (chore clause)",
      fields: [choreFieldName(definitions)],
    },
    {
      seam: "ExecutionManager.FoldedTraceSteps.Render (fold clause)",
      fields: fieldsIn(windowAt(controller, "internal string Render()", 12)),
    },
    {
      seam: "ExecutionManager.AddTrace (hold annotation)",
      fields: fieldsIn(windowAt(controller, "TryGetHeldMs(receipt.RequestId", 8)),
    },
  ];
  const undeclared: string[] = [];
  let minted = 0;
  for (const { seam, fields } of seams) {
    assert.ok(
      fields.length > 0,
      `blocked: ${seam} no longer shows a clause this gate could read, so it examined nothing`,
    );
    minted += fields.length;
    for (const field of fields)
      if (!ENVELOPE.has(field))
        undeclared.push(`${seam} mints "${field}", which STARDEW_SETTLEMENT_ENVELOPE_FIELDS does not declare`);
  }
  t.diagnostic(
    `seams ${String(seams.length)} · fields minted ${String(minted)} · declared ${String(minted - undeclared.length)} · undeclared ${String(undeclared.length)}`,
  );
  assert.deepEqual(undeclared, []);
});
