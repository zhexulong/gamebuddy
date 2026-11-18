import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
    // A FIELD WITH NO VALUE IS NOT A READING: this Mod spells absent `none` (`phase_after=none`, `held_after=none`,
    // `owner=none`), and the shared parser refuses an empty value because that is how it rejects junk. Measured
    // `round73`: `quality_counts_before=` made every harvest from an empty pack unreadable while the same harvest from
    // a non-empty pack read fine - the shape that hides, because the ordinary case passes.
    const empty = fields.filter((field) => entry.evidence[field] === "");
    if (empty.length > 0) {
      failures.push(
        `${entry.actionId}: the Mod wrote a field with no value: ${empty.join(", ")} - absent is spelled \`none\``,
      );
      continue;
    }
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

/**
 * A price read AFTER the call it prices is a guess about what the call charged.
 *
 * MEASURED `round73`. `break_rock` computed `expected_stamina_cost = 2 - Mining*0.1` after `UseNativeToolOnTile`, so
 * the swing that earned a mining level printed the NEW level's price while the engine charged the one the actor swung
 * with: 270 -> 268 charged 2.0 against a printed 1.9, and 266.1 -> 264.2 charged 1.9 against a printed 1.8. Two of
 * sixteen receipts were refused by the Host's conservation guard, and the guard was right both times - `|−delta −
 * expected| <= 0.011` is arithmetic, not an opinion. The same shape sat in five other handlers of the two files this
 * unit was allowed to edit, and in two more it still does.
 *
 * THE POPULATION IS EVERY HANDLER THAT PUBLISHES `expected_stamina_cost` AND DRIVES A NATIVE TOOL, read out of the
 * Mod's own sources. The property is the ordering: no player skill level may be read after the first tool dispatch in
 * such a handler, because the dispatch is what can change that level.
 *
 * THE TWO EXEMPTIONS ARE DEBT, NOT APPROVAL, and each is checked in both directions: a handler that starts pricing
 * late fails as undeclared, and an exemption whose handler is no longer late fails as stale - so an entry cannot
 * outlive the thing it exempts.
 */
const LATE_LEVEL_READ_DEBT: Readonly<Record<string, string>> = Object.freeze({
  "farmhandexecutioncontroller.petbowlactions.cs:ExecuteWaterPetBowl":
    "outside this unit's approved files; the same one-line defect, measured here and not edited here",
  "farmhandexecutioncontroller.slimehutchtroughactions.cs:ExecuteWaterSlimeHutchTrough":
    "outside this unit's approved files; the same one-line defect, measured here and not edited here",
});

/** The calls that mean "this handler has spent the tool", so the levels they can raise are already committed. */
const TOOL_DISPATCH = /(?:UseNativeToolOnTile\(|\.DoFunction\(|performToolAction\(|BeginUsingTool\()/u;
const SKILL_LEVEL_READ =
  /Game1\.player\.(?:MiningLevel|ForagingLevel|FarmingLevel|FishingLevel|CombatLevel|LuckLevel)/u;
const HANDLER_START = /^ {4}(?:public|private|internal)[^\n]*LocalExecutionReceipt (\w+)\(/u;

test("a receipt's expected stamina cost is read before the native call it prices", (t) => {
  const directory = join(ROOT, "integrations", "stardew");
  const files = readdirSync(directory).filter((name) => name.endsWith(".cs"));
  let examined = 0;
  let publishing = 0;
  const measured: string[] = [];
  for (const name of files) {
    const lines = readFileSync(join(directory, name), "utf8").split("\n");
    const starts: number[] = [];
    for (const [index, line] of lines.entries()) if (HANDLER_START.test(line)) starts.push(index);
    for (const [position, start] of starts.entries()) {
      const body = lines.slice(start, starts[position + 1] ?? lines.length);
      examined += 1;
      if (!body.join("\n").includes("expected_stamina_cost")) continue;
      publishing += 1;
      const dispatch = body.findIndex((line) => TOOL_DISPATCH.test(line));
      if (dispatch < 0) continue;
      const handler = HANDLER_START.exec(body[0] ?? "")?.[1] ?? "unknown";
      if (body.slice(dispatch).some((line) => SKILL_LEVEL_READ.test(line))) measured.push(`${name}:${handler}`);
    }
  }
  assert.ok(
    publishing > 0,
    "blocked: no handler in the Mod's sources publishes an expected stamina cost, so no ordering could be judged",
  );
  const declared = new Set(Object.keys(LATE_LEVEL_READ_DEBT));
  const undeclared = measured.filter((site) => !declared.has(site));
  const stale = [...declared].filter((site) => !measured.includes(site));
  t.diagnostic(
    `handlers examined ${String(examined)} · publish an expected cost ${String(publishing)} · priced after the call ${String(measured.length)} · declared debt ${String(declared.size)}`,
  );
  assert.deepEqual(
    undeclared,
    [],
    "a handler prices its swing from a skill level read AFTER the native call: the engine charged the level the actor held when it swung, so the price must be read before the dispatch",
  );
  assert.deepEqual(
    stale,
    [],
    "a declared late-read exemption no longer applies - remove it rather than leaving it green",
  );
});
