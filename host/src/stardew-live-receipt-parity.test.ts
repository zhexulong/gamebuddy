import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hasStardewCompletionEvidence } from "./stardew-game-integration-adapter.js";

/**
 * The Host must recognise the receipt its OWN producer emitted.
 *
 * WHY THIS TEST EXISTS: the Mod's evidence fields and the Host's expected key list are written in different languages,
 * in different files, by different lanes, and nothing compared them. A field added on one side has silently broken a
 * live gate at least twice - `leftover_returned` (the Host listed ten keys while the Mod emitted eleven, so a successful
 * `chest_retrieve` could never count as complete) and the `tailoringTargets` snapshot (a predicate that could not accept
 * what the Mod published, which disconnected the bridge). A live runner cannot catch either, because it drives the Mod
 * directly and the Host's rule never runs.
 *
 * WHAT MAKES IT TRUSTWORTHY: the corpus is not hand-written - `tools/record-stardew-live-receipts.mjs` extracts the
 * terminal receipt from the artifacts of real live runs, including the evidence object in the Mod's own field order,
 * which is turned back into the wire's `key=value;` detail string here. So this asserts the producer against the
 * consumer using the producer's own output.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CORPUS = JSON.parse(readFileSync(join(ROOT, "host", "src", "test-fixtures", "stardew-live-receipts.json"), "utf8"));
const ADAPTER = readFileSync(join(ROOT, "host", "src", "stardew-game-integration-adapter.ts"), "utf8");

/** The detail string the Mod emits: `key=value` joined by `;`, in the order it wrote them. */
function wireDetail(evidence: Record<string, string>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

/** Every action the completion switch names, read from the source so a new rule is covered without editing a list. */
function actionsWithARule(): string[] {
  const actions = new Set<string>();
  for (const match of ADAPTER.matchAll(/case "([a-z_]+)":/g)) {
    const action = match[1];
    if (action !== undefined) actions.add(action);
  }
  return [...actions];
}

const receipts = CORPUS.receipts as Array<{ actionId: string; state: string; reasonCode: string; evidence: Record<string, string> }>;
const withRule = new Set(actionsWithARule());

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
    if (!withRule.has(entry.actionId)) {
      withoutRule.push(entry.actionId);
      continue;
    }
    const recognised = hasStardewCompletionEvidence(entry.actionId, {
      state: entry.state,
      reasonCode: entry.reasonCode,
      evidence: { detail: wireDetail(entry.evidence) },
    } as never);
    if (!recognised) {
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
