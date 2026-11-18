import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planSettlementNote } from "./body-program-script.js";
import { settledProgramAnswer, MAX_SETTLED_FAILURE_CHARS } from "./program-settlement-digest.js";
import { type PlanAnswerNode, planBatchAnswer } from "./program-status-wait.js";
import { BODY_PROGRAM_NODE_STATE_VERDICTS } from "./protocol.js";
import { readSourceShape } from "./test-support/source-shape.test-support.js";

/**
 * `a_receipt_reads_like_the_harness_it_runs_in:<site>`.
 *
 * <p>
 * THE PRODUCT OWNER'S OWN WORDS: *"body-program receipts should follow pi-aft - ideally almost exactly the same, only a
 * few words swapped."* The harness's receipts say `Applied 1 edit to src/foo.ts` and `Error: oldString not found in x.ts`
 * - one line, what happened, to what, and how much, and nothing else. The plan tool used to answer with a paragraph: *"3
 * nodes, and the settlement arrives as its own message - a fact - once the last node reaches a terminal state, the same
 * answer comes back until then, and `stardew_action_program_status` `waitMs` only holds a turn until that moment."* It
 * answered a question nobody asked, described the delivery of a message instead of the outcome of the call, and told her
 * to stop and wait. A settled plan then reported `2 of 3 done, 1 rejected`: a count with no name under it, so "which
 * seed on which tile, and what did the game say" lived only in twenty rows nobody was handed.
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED, NOT LISTED. Every node state the wire declares (`BODY_PROGRAM_NODE_STATES`) is driven through
 * the settlement reader the status tool answers from (`planBatchAnswer` -> `settledProgramAnswer`), so a state added on
 * the game side is examined here without anyone editing this frame; the accepted answer is produced by the product's own
 * `planSettlementNote`; and the long plan (a failure past the row bound) is derived from `MAX_SETTLED_DIGEST_NODES`.
 * </p>
 *
 * <p>
 * THE THREE PROPERTIES, one per answer: it states what happened and to what and how much (its head names the population
 * and its target, and every step that did not do what it was told is named under it), it is ONE LINE, and it contains no
 * sentence about a message, a turn, or a wait. The verdict line is `answers examined A · one-line O · names-failures F ·
 * tells-her-to-wait W`; `W > 0` fails naming the answer and the sentence, and a zero population is blocked, never green.
 * </p>
 *
 * <p>
 * WHAT IT DOES NOT EXAMINE, stated rather than implied: the observation tools' answers (`stardew_observe`,
 * `stardew_look_up`, the world map) are JSON of the world with no sentence this Host authored, and the world book's are
 * JSON of the book, so the class this gate covers - a sentence about a future message - cannot appear in them. The two
 * answers that DO carry Host prose about a plan are the accepted answer and the settled ledger, and both are here.
 * `plan-wired-below` asserts the two are still the answers the mounted tools return, so this gate cannot pass because
 * its subject left the surface.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const materializerPath =
  "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts";

/** What a receipt may never say: a sentence about the future, about a message, about a turn, or about waiting. */
const TELLS_HER_TO_WAIT =
  /\b(?:messages?|facts?|turns?|waitMs|wait|waits|waiting|polls?|polling|later|soon|arrives?|arriving|until|eventually|comes back)\b/iu;

/** One step that did not do what it was told, as the answer's own rows state it - what a receipt must NAME. */
type NotDone = Readonly<{ actionId: string; reasonCode: string }>;

/** One answer the Game surface writes, and the failures it is owed. */
type Receipt = Readonly<{
  /** `<tool>:<what the answer is>` - the name a failure prints. */
  site: string;
  /** The text the model reads. */
  text: string;
  /** The steps that did not do what they were told, taken from the rows the answer was composed over. */
  notDone: readonly NotDone[];
  /** The failures the answer itself names. */
  named: readonly string[];
}>;

/** The sentences of one line of text, so a paragraph is countable and not a matter of taste. */
function sentencesOf(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** The sentence that tells her about a future message, a turn or a wait, or `null` when the answer has none. */
export function tellsHerToWait(text: string): string | null {
  return sentencesOf(text).find((sentence) => TELLS_HER_TO_WAIT.test(sentence)) ?? null;
}

/** The failure a receipt owes and does not name, or `null` when every one of them is on it. */
function unnamedFailure(receipt: Receipt): string | null {
  if (receipt.named.length !== receipt.notDone.length)
    return (
      `${String(receipt.named.length)} of ${String(receipt.notDone.length)} named, ` +
      "so a step that did not happen is only a number"
    );
  for (const step of receipt.notDone) {
    const named = receipt.named.some(
      (line) => line.includes(step.actionId) && (step.reasonCode === "" || line.includes(step.reasonCode)),
    );
    if (!named) return `${step.actionId}:${step.reasonCode === "" ? "no_code" : step.reasonCode} is not named`;
  }
  return null;
}

/**
 * How long one line of a receipt may be.
 *
 * The bound is the digest's own (`MAX_SETTLED_FAILURE_CHARS`, the widest single line the product composes: an action, a
 * tile and a reason). A line past it is not a receipt any more - it is the paragraph this gate was written for (258
 * characters about a message that would arrive), which is exactly what has to be red here.
 */
const MAX_RECEIPT_LINE_CHARS = MAX_SETTLED_FAILURE_CHARS;

/** One line, in the harness's register: no field of the answer is a paragraph. */
function isOneLine(text: string): boolean {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .every((line) => line.length <= MAX_RECEIPT_LINE_CHARS && sentencesOf(line).length === 1);
}

/** A plan node as the compiler writes it: the action, and the tile its arguments name. */
function planNode(position: number, actionId = "till_soil", x = 60, y = 18): PlanAnswerNode {
  return {
    nodeId: `n${String(position).padStart(2, "0")}`,
    actionId,
    arguments: {
      x: { type: "integer", canonicalValue: String(x) },
      y: { type: "integer", canonicalValue: String(y) },
    },
  };
}

/** One journal row: the Mod's own state, and the code it refuses or fails under. */
type JournalRow = Readonly<{
  nodeId: string;
  state: string;
  rejectionCode?: string;
  failureCode?: string;
  recoveryDiagnostic?: string;
}>;

/**
 * The reason a row of a given state carries, in the field the Mod writes it in.
 *
 * `rejectionCode` and `failureCode` are two fields for one question (`plan-status-wait.ts` reads both), so a state is
 * given the code its own layer would write rather than one code for all of them.
 */
function rowReason(state: string): Readonly<{ rejectionCode?: string; failureCode?: string }> {
  if (state === "rejected") return { rejectionCode: "seed_not_owned_in_slot" };
  if (state === "failed") return { failureCode: "no_native_path" };
  return {};
}

/** The settled answer for a plan whose middle step is in `state`, read through the reader the status tool answers from. */
function settledReceipt(state: string): Receipt {
  const compiled = [planNode(0), planNode(1, "plant_seed", 61, 19), planNode(2, "water_crop", 62, 20)];
  const rows: JournalRow[] = compiled.map((node, index) => ({
    nodeId: node.nodeId,
    state: index === 1 ? state : "succeeded",
    ...(index === 1 ? rowReason(state) : {}),
  }));
  return settledFrom("plan_receipt", state, compiled, rows);
}

/**
 * The settled answer for a journal that says NOTHING about a step: the Host's own unreadable row.
 *
 * Derived rather than written down - the row is absent from the journal, so the state the digest reports for it is the
 * digest's own answer, and this frame never spells it.
 */
function settledUnreadableReceipt(): Receipt {
  const compiled = [planNode(0), planNode(1, "plant_seed", 61, 19)];
  return settledFrom("plan_unreadable", "succeeded", compiled, [{ nodeId: "n00", state: "succeeded" }]);
}

/** One settled answer and the rows it was composed over, as the gate's `Receipt`. */
function settledFrom(
  programId: string,
  state: string,
  compiled: readonly PlanAnswerNode[],
  rows: readonly JournalRow[],
): Receipt {
  const answer = settledProgramAnswer(
    planBatchAnswer(compiled, { programId, state, catalogRevision: 3, stopEpoch: 0, nodes: rows }),
  );
  // THE STEPS THIS PLAN DID NOT GET DONE, from the two things the answer was composed over: the nodes the caller wrote
  // and the rows the journal holds. A node the journal does not mention is one the digest answers as unreadable, so it
  // is in this population too - derived from the join, never from a list of states written here.
  const journal = new Map(rows.map((row) => [row.nodeId, row] as const));
  const notDone = compiled.flatMap((node) => {
    const row = journal.get(node.nodeId);
    const settled = row?.state ?? "unreadable";
    if (settled === "succeeded") return [];
    return [Object.freeze({ actionId: node.actionId, reasonCode: row?.rejectionCode ?? row?.failureCode ?? "" })];
  });
  return Object.freeze({
    site: `stardew_action_program_status:settled:${programId}`,
    text: [answer.summary, ...answer.failures].join("\n"),
    notDone: Object.freeze(notDone),
    named: answer.failures,
  });
}

/** A plan longer than the row bound whose LAST step failed: the failure the twenty shown rows cannot carry. */
function settledPastTheRowBoundReceipt(): Receipt {
  const compiled = Array.from({ length: 25 }, (_unused, index) => planNode(index, "harvest_crop"));
  const rows: JournalRow[] = compiled.map((node) => ({ nodeId: node.nodeId, state: "succeeded" }));
  rows[24] = { nodeId: compiled[24]!.nodeId, state: "failed", failureCode: "crop_not_ready" };
  return settledFrom("plan_long", "failed", compiled, rows);
}

/** The accepted plan answer, in both sizes a singular/plural count can be wrong about. */
function acceptedReceipt(nodeCount: number): Receipt {
  return Object.freeze({
    site: `stardew_plan_work:accepted:${String(nodeCount)}_nodes`,
    text: planSettlementNote(nodeCount, "plan_2f9c41ab"),
    notDone: Object.freeze([]),
    named: Object.freeze([]),
  });
}

/** Every answer this gate examines, derived from the wire's own declaration of what a settled node can be. */
function receipts(): readonly Receipt[] {
  // A settlement only exists for a node that STOPPED: the "moving" states are what a running plan looks like, and the
  // digest never renders one. The filter is the declaration's own verdict, so a state added on the game side arrives
  // here with its verdict rather than needing this line edited.
  const stopped = Object.entries(BODY_PROGRAM_NODE_STATE_VERDICTS)
    .filter(([, verdict]) => verdict !== "moving")
    .map(([state]) => state);
  return Object.freeze([
    acceptedReceipt(1),
    acceptedReceipt(16),
    ...stopped.map(settledReceipt),
    settledUnreadableReceipt(),
    settledPastTheRowBoundReceipt(),
  ]);
}

type ReceiptVerdict = Readonly<{
  examined: number;
  oneLine: number;
  namesFailures: number;
  tellsHerToWait: number;
  findings: readonly string[];
  report: string;
}>;

function receiptVerdict(population: readonly Receipt[] = receipts()): ReceiptVerdict {
  const findings: string[] = [];
  let oneLine = 0;
  let namesFailures = 0;
  let waits = 0;
  for (const receipt of population) {
    if (isOneLine(receipt.text)) oneLine += 1;
    else findings.push(`a_receipt_reads_like_the_harness_it_runs_in:${receipt.site} - it is a paragraph`);
    const unnamed = unnamedFailure(receipt);
    if (unnamed === null) namesFailures += 1;
    else findings.push(`a_receipt_reads_like_the_harness_it_runs_in:${receipt.site} - ${unnamed}`);
    const sentence = tellsHerToWait(receipt.text);
    if (sentence === null) continue;
    waits += 1;
    findings.push(`a_receipt_reads_like_the_harness_it_runs_in:${receipt.site} - it tells her to wait: ${sentence}`);
  }
  return Object.freeze({
    examined: population.length,
    oneLine,
    namesFailures,
    tellsHerToWait: waits,
    findings: Object.freeze(findings),
    report: `answers examined ${String(population.length)} · one-line ${String(oneLine)} · names-failures ${String(
      namesFailures,
    )} · tells-her-to-wait ${String(waits)}`,
  });
}

test("a_receipt_reads_like_the_harness_it_runs_in: every plan answer is one line and names what did not happen", () => {
  const verdict = receiptVerdict();
  // A gate whose population is empty agrees with itself: the state union, the bound and the accepted answer are all
  // derived, so a zero here means a derivation broke rather than that there was nothing to check.
  // A gate whose population is empty agrees with itself: every state the wire calls STOPPED is examined, plus the
  // accepted answer, the unreadable row and the plan past the row bound, so a population at the bare state count means a
  // derivation broke rather than that there was nothing to check.
  const stoppedStates = Object.values(BODY_PROGRAM_NODE_STATE_VERDICTS).filter(
    (verdict) => verdict !== "moving",
  ).length;
  assert.ok(verdict.examined > stoppedStates, `blocked: ${verdict.report}`);
  assert.deepEqual(verdict.findings, [], verdict.report);
  assert.equal(verdict.tellsHerToWait, 0, verdict.report);
  assert.equal(verdict.oneLine, verdict.examined, verdict.report);
  assert.equal(verdict.namesFailures, verdict.examined, verdict.report);
  assert.match(verdict.report, /^answers examined \d+ · one-line \d+ · names-failures \d+ · tells-her-to-wait \d+$/u);
});

/**
 * THE RED CASE, KEPT: the paragraph this gate was written for.
 *
 * Verbatim from `planSettlementNote` before this change (`host/src/body-program-script.ts`), which is what the accepted
 * answer said on every plan the surface accepted. It is here as the guard's own falsifier - if the words of this
 * sentence stop making the gate red, the gate has stopped reading the property it claims.
 */
const THE_PARAGRAPH_THIS_REPLACED =
  "3 nodes, and the settlement arrives as its own message - a fact - once the last node reaches a terminal state, the " +
  "same answer comes back until then, and `stardew_action_program_status` `waitMs` only holds a turn until that moment.";

test("the answer that describes a message arriving is RED, naming the sentence", () => {
  const verdict = receiptVerdict([
    Object.freeze({
      site: "stardew_plan_work:accepted:before_this_change",
      text: THE_PARAGRAPH_THIS_REPLACED,
      notDone: Object.freeze([]),
      named: Object.freeze([]),
    }),
  ]);
  assert.equal(verdict.tellsHerToWait, 1, verdict.report);
  assert.equal(verdict.oneLine, 0, "and it was a paragraph, which the one-line count says too");
  assert.deepEqual(verdict.findings, [
    "a_receipt_reads_like_the_harness_it_runs_in:stardew_plan_work:accepted:before_this_change - it is a paragraph",
    `a_receipt_reads_like_the_harness_it_runs_in:stardew_plan_work:accepted:before_this_change - it tells her to wait: ${THE_PARAGRAPH_THIS_REPLACED}`,
  ]);
});

test("a settled answer that counts a failure without naming it is RED, and the missing step is the one printed", () => {
  const settled = settledReceipt("rejected");
  const verdict = receiptVerdict([
    Object.freeze({ ...settled, site: "stardew_action_program_status:settled:unnamed", named: Object.freeze([]) }),
  ]);
  assert.equal(verdict.namesFailures, 0, verdict.report);
  assert.deepEqual(verdict.findings, [
    "a_receipt_reads_like_the_harness_it_runs_in:stardew_action_program_status:settled:unnamed - 0 of 1 named, so a step that did not happen is only a number",
  ]);
});

test("a settled answer that re-learns to describe the future is RED", () => {
  const settled = settledReceipt("failed");
  const verdict = receiptVerdict([
    Object.freeze({
      ...settled,
      site: "stardew_action_program_status:settled:future",
      text: `${settled.text}\nThe rest arrives as a message.`,
    }),
  ]);
  assert.equal(verdict.tellsHerToWait, 1, verdict.report);
  assert.match(verdict.findings.join("\n"), /it tells her to wait: The rest arrives as a message\./u);
});

/**
 * THE SUBJECT IS STILL ON THE SURFACE.
 *
 * A gate that passes because the answer it watches disappeared is the failure mode it exists to prevent: the accepted
 * answer must still carry `planSettlementNote`, and a stopped programme must still be answered from the ledger the
 * digest minted (`settledProgramAnswer`), not from a second rendering written at the tool.
 */
test("plan answers are still the ones the mounted tools return", () => {
  const { shape } = readSourceShape(resolve(hostRoot, "src", materializerPath));
  assert.match(shape, /settlementNote: planSettlementNote\(nodes\.length, programId\)/u);
  assert.match(shape, /settlement\.settled\(params\.programId\)/u);
});
