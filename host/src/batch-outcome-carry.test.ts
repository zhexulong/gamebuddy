/**
 * THE PER-ROW OUTCOME OF A BATCH, CARRIED END TO END.
 *
 * <p>
 * A `for_each` node settles SIXTY tiles as ONE node. The Mod writes the whole pass into
 * `BodyProgramJournalNode.Evidence` (its sixty-row table) and `PostconditionVerification` (its
 * `for_each_pass:decided=…:succeeded=…` verdict line). Both fields existed in the journal and neither reached the model:
 * `round63`'s `plan_239_2793c52c60b8cadf` node `n02` settled `succeeded` with fifteen `soil_tilled` receipts in the run's
 * log, and every artifact the run kept says
 * </p>
 *
 * <pre>
 * {"nodeId":"n02","actionId":"for_each","state":"succeeded"}
 * </pre>
 *
 * <p>
 * - `for_each_pass` appears ZERO times in `tools/_multiday_routine-round63-live-runner.log` and in
 * `tools/_multiday_routine-round63.result.json`, and `postconditionVerification` zero times, while `plan_239` itself
 * appears fourteen times. **Those artifacts cannot be replayed for this gate**: the bundle never carried the journal
 * payload (`admissionAttempt`, `canonicalBoundArguments` and `postconditionVerification` are all zero hits), so there is no
 * status snapshot in it to feed through the real reader. The red below therefore comes from a FIXTURE of the Mod's own
 * aggregate shape, and the shape's authority is the producer
 * (`RouteReenteringBodyProgramExecutor.Aggregate` / `RowJson`), not this file.
 * </p>
 *
 * <p>
 * THE GATE IS THE POPULATION, NOT THE FIXTURE. `batchOutcomeCarry` derives its population from the frame it is given -
 * every node that REPORTED either field - so a node added tomorrow is examined without this file being edited, and the
 * verdict names the node and the field that was dropped rather than counting.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeFactBrief } from "./fact-brief.js";
import { settledProgramFact } from "./program-settlement-digest.js";
import { planBatchAnswer, type PlanAnswerNode } from "./program-status-wait.js";

/** The program round63 actually submitted, so the failure text names something a reader can grep for. */
const PROGRAM_ID = "plan_239_2793c52c60b8cadf";

/** The strip round63's `till_soil` pass covered: a 20 x 3 patch with its north-west corner at (60,18). */
const AREA = Object.freeze({ x: 60, y: 18, width: 20, height: 3 });

/** One row of a pass's own table, in the shape `RouteReenteringBodyProgramExecutor.RowJson` writes. */
interface PassRow {
  readonly x: number;
  readonly y: number;
  readonly action: string;
  readonly state: string;
  readonly reasonCode: string | null;
  readonly healed: string | null;
}

/** Every tile of {@link AREA}, in the walk order the aggregate sorts its table into (row, then column). */
function areaTiles(): readonly Readonly<{ x: number; y: number }>[] {
  const tiles: { x: number; y: number }[] = [];
  for (let row = 0; row < AREA.height; row += 1)
    for (let column = 0; column < AREA.width; column += 1)
      tiles.push(Object.freeze({ x: AREA.x + column, y: AREA.y + row }));
  return Object.freeze(tiles);
}

/** The ticks that are `stone`. Deterministic, so the fifteen are the same fifteen every run. */
const BLOCKED_TILE_INDEXES: ReadonlySet<number> = new Set([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56]);

/**
 * The pass's own table: forty-five tilled tiles and fifteen the rule refused, each refused row naming the tile AND what
 * is on it (`no_rule_matched:stone@61,18` is `FarmhandForEachRules.NoRuleMatchedReasonCode`'s own spelling).
 */
function passRows(blockedIndexes: ReadonlySet<number>): readonly PassRow[] {
  return Object.freeze(
    areaTiles().map((tile, index) =>
      Object.freeze(
        blockedIndexes.has(index)
          ? Object.freeze({
              x: tile.x,
              y: tile.y,
              action: "till_soil",
              // A tile the `where` clause does not match is NOT dispatched at all, which is `not_matched` - not `refused`.
              state: "not_matched",
              reasonCode: `no_rule_matched:stone@${String(tile.x)},${String(tile.y)}`,
              healed: null,
            })
          : Object.freeze({
              x: tile.x,
              y: tile.y,
              action: "till_soil",
              state: "succeeded",
              reasonCode: null,
              healed: null,
            }),
      ),
    ),
  );
}

/**
 * A pass's aggregate, in the shape `RouteReenteringBodyProgramExecutor.Aggregate` writes it: the counts, then the rows in
 * walk order. Key order is the producer's, so this is comparable byte for byte with a real frame.
 */
function passTable(state: string, rows: readonly PassRow[]): string {
  const count = (match: string): number => rows.filter((row) => row.state === match).length;
  return JSON.stringify({
    state,
    succeeded: count("succeeded"),
    failed: count("failed"),
    refused: count("refused"),
    left_alone: count("left_alone"),
    not_matched: count("not_matched"),
    deferred: 0,
    omitted: 0,
    healed: 0,
    rowsOmitted: 0,
    rows,
  });
}

/** The `PostconditionVerification` line the producer writes for a pass that succeeded in full. */
function settledVerdict(rows: readonly PassRow[]): string {
  return `for_each_pass:decided=${String(rows.length)}:succeeded=${String(rows.filter((row) => row.state === "succeeded").length)}:left_alone=0:omitted=0`;
}

/** The same line for a pass that did part of its work. */
function partialVerdict(rows: readonly PassRow[]): string {
  const count = (match: string): number => rows.filter((row) => row.state === match).length;
  return `for_each_pass:partially_succeeded:decided=${String(rows.length)}:succeeded=${String(count("succeeded"))}:failed=${String(count("failed"))}:refused=${String(count("refused"))}`;
}

/** One node row of a status snapshot, in the shape `validateBodyProgramStatusResult` accepts. */
function wireNode(
  nodeId: string,
  actionId: string,
  state: string,
  proof: Readonly<Record<string, string>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({ nodeId, actionId, state, nodeAttempt: 1, admissionAttempt: 1, ...proof });
}

/** A `found` status snapshot carrying the given rows. */
function snapshotOf(
  state: string,
  nodes: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    programId: PROGRAM_ID,
    state,
    catalogRevision: 1,
    stopEpoch: 0,
    eventHighWater: 12,
    nodes: Object.freeze(nodes),
  });
}

/** The two nodes round63 submitted: the tool change, then the pass. */
const COMPILED: readonly PlanAnswerNode[] = Object.freeze([
  Object.freeze({ nodeId: "n01", actionId: "equip_tool", arguments: Object.freeze({}) }),
  Object.freeze({ nodeId: "n02", actionId: "for_each", arguments: Object.freeze({}) }),
]);

/** THE TEXT THE MODEL IS HANDED for a settled program: the assembler's own output, not a second rendering of it. */
function modelText(snapshot: Readonly<Record<string, unknown>>): string {
  const settled = settledProgramFact({
    programId: PROGRAM_ID,
    settledAtMs: 1_000,
    compiled: COMPILED,
    status: Object.freeze({ code: "found", snapshot }),
  });
  assert.ok(settled !== undefined, "a terminal snapshot always mints one settlement fact");
  return composeFactBrief({
    inputs: Object.freeze([]),
    snapshot: undefined,
    events: Object.freeze([settled.fact]),
    locale: "zh",
  });
}

interface BatchOutcomeReading {
  /** Every node that REPORTED `evidence` or `postconditionVerification` - the population, from the frame itself. */
  readonly examined: number;
  /** How many of those had every one of their rows in the model's text. */
  readonly carried: number;
  readonly dropped: number;
  /** One entry per drop, `batch_outcome_dropped:<program>:<node>:<field>`, with what it was. */
  readonly faults: readonly string[];
  /** The text, so a caller can assert what it says rather than only that nothing was dropped. */
  readonly text: string;
}

/**
 * The gate: every row a batch node PROVED must reach the text the model is handed.
 *
 * <p>
 * The population is derived, never listed. A node counts when its own frame carries `evidence` or
 * `postconditionVerification`; the property is that each of those, and each ROW inside the table, arrives in the composed
 * text under its own name and its own bytes. A projection that carried the field and re-rendered it into a count would
 * fail the row arm - which is the whole point, because a count is the fourth drop and it is the one that looks like
 * progress.
 * </p>
 */
function batchOutcomeCarry(snapshot: Readonly<Record<string, unknown>>): BatchOutcomeReading {
  const answer = planBatchAnswer(COMPILED, snapshot);
  const text = modelText(snapshot);
  const rows = Array.isArray(snapshot.nodes) ? (snapshot.nodes as readonly Readonly<Record<string, unknown>>[]) : [];
  const reported = rows.filter(
    (node) => typeof node.evidence === "string" || typeof node.postconditionVerification === "string",
  );
  const faults: string[] = [];
  let carried = 0;
  for (const node of reported) {
    const nodeId = typeof node.nodeId === "string" ? node.nodeId : "(unnamed)";
    const index = COMPILED.findIndex((candidate) => candidate.nodeId === nodeId);
    const answerRow = index < 0 ? undefined : answer.nodes[index];
    let intact = true;
    for (const field of ["evidence", "postconditionVerification"] as const) {
      const reportedValue = node[field];
      if (typeof reportedValue !== "string") continue;
      if (answerRow?.[field] !== reportedValue) {
        faults.push(`batch_outcome_dropped:${PROGRAM_ID}:${nodeId}:${field} (the plan answer lost it)`);
        intact = false;
        continue;
      }
      if (!text.includes(reportedValue)) {
        faults.push(`batch_outcome_dropped:${PROGRAM_ID}:${nodeId}:${field} (the composed text lost it)`);
        intact = false;
      }
    }
    if (typeof node.evidence === "string") {
      const table = JSON.parse(node.evidence) as { rows?: readonly unknown[] };
      for (const row of table.rows ?? []) {
        if (text.includes(JSON.stringify(row))) continue;
        faults.push(
          `batch_outcome_dropped:${PROGRAM_ID}:${nodeId}:evidence (row ${JSON.stringify(row)} is not in the text)`,
        );
        intact = false;
      }
    }
    if (intact) carried += 1;
  }
  return Object.freeze({
    examined: reported.length,
    carried,
    dropped: faults.length,
    faults: Object.freeze(faults),
    text,
  });
}

test("every row a batch node proved reaches the text the model reads", () => {
  const rows = passRows(BLOCKED_TILE_INDEXES);
  const snapshot = snapshotOf("succeeded", [
    wireNode("n01", "equip_tool", "succeeded"),
    wireNode("n02", "for_each", "succeeded", {
      evidence: passTable("succeeded", rows),
      postconditionVerification: settledVerdict(rows),
    }),
  ]);
  const reading = batchOutcomeCarry(snapshot);
  // Printed, because "0 dropped" means nothing without the population it was counted over - and an empty population agrees
  // with itself.
  console.log(
    `batch nodes examined ${String(reading.examined)} · carried ${String(reading.carried)} · dropped ${String(reading.dropped)}`,
  );
  assert.ok(reading.examined > 0, "the gate examined nothing, so it proves nothing");
  assert.deepEqual(reading.faults, [], `dropped rows: ${reading.faults.join(" | ")}`);
  assert.equal(reading.carried, reading.examined, "every reporting node carried all of its rows");
});

/**
 * THE FALSIFIER, and the shape the brief exists for: sixty tiles, fifteen blocked.
 *
 * <p>
 * A count would answer `60 decided, 45 succeeded` and leave her to discover the fifteen. What she needs is the FIFTEEN -
 * which tile, and what was on it - because that is the difference between "hoe elsewhere" and "hoe this patch again".
 * </p>
 */
test("a sixty-tile pass with fifteen blocked tiles names the fifteen and what is on them", () => {
  const rows = passRows(BLOCKED_TILE_INDEXES);
  const snapshot = snapshotOf("partially_succeeded", [
    wireNode("n01", "equip_tool", "succeeded"),
    wireNode("n02", "for_each", "partially_succeeded", {
      evidence: passTable("partially_succeeded", rows),
      postconditionVerification: partialVerdict(rows),
    }),
  ]);
  const reading = batchOutcomeCarry(snapshot);
  assert.deepEqual(reading.faults, [], `dropped rows: ${reading.faults.join(" | ")}`);
  const blocked = rows.filter((row) => row.state === "not_matched");
  assert.equal(blocked.length, 15, "the fixture is the fifteen-of-sixty case");
  for (const row of blocked) {
    assert.ok(
      reading.text.includes(JSON.stringify(row)),
      `the text names the blocked tile (${String(row.x)},${String(row.y)}) and what is on it: ${reading.text}`,
    );
    assert.ok(
      reading.text.includes(row.reasonCode ?? "no_reason"),
      `the text says what is ON (${String(row.x)},${String(row.y)}): ${row.reasonCode ?? "no_reason"}`,
    );
  }
  // And the pass's own verdict line says the pass was PARTIAL rather than done: `partially_succeeded` is the only place a
  // batch node distinguishes "all sixty" from "forty-five of sixty" on its own row.
  assert.ok(
    reading.text.includes("for_each_pass:partially_succeeded:decided=60:succeeded=45"),
    `the verdict line travels verbatim: ${reading.text}`,
  );
});

/**
 * The other half of the falsifier: a pass in which every tile was blocked is NOT a success.
 *
 * <p>
 * The Mod stores no `Evidence`/`PostconditionVerification` for a `failed` node at all (ADR-006: a node that claims no
 * effect must not present proof of one), so this case cannot be a proof-carrying one - what it pins is that the settlement
 * line still refuses to read as work done, and still names the reason. It is a NON-REGRESSION PIN rather than a guard for
 * this change: it was green before the change and is green after, and saying so is more useful than implying a red that
 * never happened.
 * </p>
 */
test("a pass whose every tile was blocked is not reported as success", () => {
  const rows = passRows(new Set(areaTiles().map((_tile, index) => index)));
  const snapshot = snapshotOf("failed", [
    wireNode("n01", "equip_tool", "succeeded"),
    wireNode("n02", "for_each", "failed", {
      failureCode: "no_rule_matched",
      hint: "succeeded=0;not_matched=60",
      refusalDetail: "succeeded=0;not_matched=60;no_rule_matched:stone@60,18",
    }),
  ]);
  const text = modelText(snapshot);
  assert.equal(rows.filter((row) => row.state === "succeeded").length, 0, "the fixture has no working tile");
  assert.match(text, /1\/2 步做成了/u, "only the equip step is done");
  assert.ok(!text.includes("2/2 步做成了"), `a wholly blocked pass is not a success: ${text}`);
  assert.ok(text.includes("no_rule_matched"), `the refusal is named: ${text}`);
});

/**
 * The ADR-006 arm at the answer's own level: a node that proved nothing carries NO `evidence` key.
 *
 * Absent, never null - the same rule `reasonCode` follows - so a reader can tell "the Mod proved nothing here" from "the
 * Mod proved something and the answer blanked it".
 */
test("a node that proved nothing carries no row table, and says so by absence", () => {
  const answer = planBatchAnswer(COMPILED, snapshotOf("failed", [wireNode("n02", "for_each", "failed")]));
  const row = answer.nodes[1];
  assert.ok(row !== undefined, "the answered node is the one the journal described");
  assert.deepEqual(
    Object.keys(row).filter((key) => key === "evidence" || key === "postconditionVerification"),
    [],
  );
});
